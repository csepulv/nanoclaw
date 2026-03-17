import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./config.js', () => ({
  WARM_POOL_SIZE: 2,
  WARM_IDLE_MAX_MS: 600_000,
}));

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./db.js', () => ({
  getMostRecentlyActiveGroups: vi.fn(() => []),
}));

const mockSpawnWarm = vi.fn();
vi.mock('./container-runner.js', () => ({
  spawnWarmContainer: (...args: unknown[]) => mockSpawnWarm(...args),
}));

import { WarmPool } from './warm-pool.js';
import { getMostRecentlyActiveGroups } from './db.js';
import type { RegisteredGroup } from './types.js';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

function makeProcess() {
  const p = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
  };
  p.stdin = new PassThrough();
  p.kill = vi.fn();
  p.killed = false;
  return p;
}

function makeGroup(folder: string): RegisteredGroup {
  return { name: folder, folder, trigger: '@Andy', added_at: new Date().toISOString() };
}

const groupA = makeGroup('group-a');
const groupB = makeGroup('group-b');

const registeredGroups: Record<string, RegisteredGroup> = {
  'a@g.us': groupA,
  'b@g.us': groupB,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('WarmPool.claim', () => {
  it('returns null when pool is empty', async () => {
    const pool = new WarmPool();
    await pool.start({});
    expect(pool.claim('a@g.us')).toBeNull();
    pool.stop();
  });

  it('returns the warm entry and removes it from pool', async () => {
    const proc = makeProcess();
    mockSpawnWarm.mockReturnValue({ process: proc, containerName: 'c1', group: groupA });
    vi.mocked(getMostRecentlyActiveGroups).mockReturnValue([{ jid: 'a@g.us' }]);

    const pool = new WarmPool();
    await pool.start({ 'a@g.us': groupA });

    const entry = pool.claim('a@g.us');
    expect(entry).not.toBeNull();
    expect(entry!.containerName).toBe('c1');
    // Claimed — no longer in pool
    expect(pool.claim('a@g.us')).toBeNull();
    pool.stop();
  });

  it('returns null for a different group than the one warmed', async () => {
    const proc = makeProcess();
    mockSpawnWarm.mockReturnValue({ process: proc, containerName: 'c1', group: groupA });
    vi.mocked(getMostRecentlyActiveGroups).mockReturnValue([{ jid: 'a@g.us' }]);

    const pool = new WarmPool();
    await pool.start({ 'a@g.us': groupA });

    expect(pool.claim('b@g.us')).toBeNull();
    pool.stop();
  });
});

describe('WarmPool.replenish', () => {
  it('spawns a warm container when pool has capacity', async () => {
    mockSpawnWarm.mockReturnValue({ process: makeProcess(), containerName: 'c1', group: groupA });

    const pool = new WarmPool();
    await pool.start({});
    pool.updateRegisteredGroups({ 'a@g.us': groupA });
    pool.replenish('a@g.us');

    await vi.waitFor(() => expect(mockSpawnWarm).toHaveBeenCalledOnce());
    pool.stop();
  });

  it('does not spawn twice for same jid when already replenishing', async () => {
    let resolveSpawn!: (v: unknown) => void;
    mockSpawnWarm.mockImplementation(
      () => new Promise((r) => { resolveSpawn = r; }),
    );

    const pool = new WarmPool();
    await pool.start({});
    pool.updateRegisteredGroups({ 'a@g.us': groupA });

    pool.replenish('a@g.us');
    pool.replenish('a@g.us');

    expect(mockSpawnWarm).toHaveBeenCalledTimes(1);

    resolveSpawn({ process: makeProcess(), containerName: 'c1', group: groupA });
    pool.stop();
  });

  it('skips when pool already has entry for jid', async () => {
    const proc = makeProcess();
    mockSpawnWarm.mockReturnValue({ process: proc, containerName: 'c1', group: groupA });
    vi.mocked(getMostRecentlyActiveGroups).mockReturnValue([{ jid: 'a@g.us' }]);

    const pool = new WarmPool();
    await pool.start({ 'a@g.us': groupA });

    vi.clearAllMocks();
    pool.replenish('a@g.us'); // already warm

    expect(mockSpawnWarm).not.toHaveBeenCalled();
    pool.stop();
  });
});

describe('WarmPool startup seeding', () => {
  it('seeds warm containers for recently active registered groups', async () => {
    vi.mocked(getMostRecentlyActiveGroups).mockReturnValue([
      { jid: 'a@g.us' },
      { jid: 'b@g.us' },
    ]);
    mockSpawnWarm
      .mockReturnValueOnce({ process: makeProcess(), containerName: 'c1', group: groupA })
      .mockReturnValueOnce({ process: makeProcess(), containerName: 'c2', group: groupB });

    const pool = new WarmPool();
    await pool.start(registeredGroups);

    expect(mockSpawnWarm).toHaveBeenCalledTimes(2);
    expect(pool.claim('a@g.us')).not.toBeNull();
    expect(pool.claim('b@g.us')).not.toBeNull();
    pool.stop();
  });

  it('skips jids not in registeredGroups', async () => {
    vi.mocked(getMostRecentlyActiveGroups).mockReturnValue([{ jid: 'unknown@g.us' }]);

    const pool = new WarmPool();
    await pool.start(registeredGroups);

    expect(mockSpawnWarm).not.toHaveBeenCalled();
    pool.stop();
  });
});

describe('WarmPool premature exit', () => {
  it('removes dead container from pool and triggers replenish', async () => {
    const proc = makeProcess();
    mockSpawnWarm
      .mockReturnValueOnce({ process: proc, containerName: 'c1', group: groupA })
      .mockReturnValue({ process: makeProcess(), containerName: 'c2', group: groupA });
    vi.mocked(getMostRecentlyActiveGroups).mockReturnValue([{ jid: 'a@g.us' }]);

    const pool = new WarmPool();
    await pool.start({ 'a@g.us': groupA });

    expect(mockSpawnWarm).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();

    // Simulate premature exit before claim
    mockSpawnWarm.mockReturnValue({ process: makeProcess(), containerName: 'c3', group: groupA });
    proc.emit('exit', 1);

    await vi.waitFor(() => expect(mockSpawnWarm).toHaveBeenCalledOnce());
    pool.stop();
  });
});
