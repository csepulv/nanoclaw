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
  return {
    name: folder,
    folder,
    trigger: '@Andy',
    added_at: new Date().toISOString(),
  };
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
    mockSpawnWarm.mockReturnValue({
      process: proc,
      containerName: 'c1',
      group: groupA,
    });
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
    mockSpawnWarm.mockReturnValue({
      process: proc,
      containerName: 'c1',
      group: groupA,
    });
    vi.mocked(getMostRecentlyActiveGroups).mockReturnValue([{ jid: 'a@g.us' }]);

    const pool = new WarmPool();
    await pool.start({ 'a@g.us': groupA });

    expect(pool.claim('b@g.us')).toBeNull();
    pool.stop();
  });
});

describe('WarmPool.replenish', () => {
  it('spawns a warm container when pool has capacity', async () => {
    mockSpawnWarm.mockReturnValue({
      process: makeProcess(),
      containerName: 'c1',
      group: groupA,
    });

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
      () =>
        new Promise((r) => {
          resolveSpawn = r;
        }),
    );

    const pool = new WarmPool();
    await pool.start({});
    pool.updateRegisteredGroups({ 'a@g.us': groupA });

    pool.replenish('a@g.us');
    pool.replenish('a@g.us');

    expect(mockSpawnWarm).toHaveBeenCalledTimes(1);

    resolveSpawn({
      process: makeProcess(),
      containerName: 'c1',
      group: groupA,
    });
    pool.stop();
  });

  it('evicts LRU pool entry when pool is full and incoming group is more recent', async () => {
    const procA = makeProcess();
    // Seed pool with groupA (pool size 2, but we only have 1 registered group here)
    // Fill pool to capacity by starting with 1 group (WARM_POOL_SIZE is mocked to 2,
    // so we use a single-slot scenario by starting fresh and manually filling)
    vi.mocked(getMostRecentlyActiveGroups).mockReturnValue([{ jid: 'a@g.us' }]);
    mockSpawnWarm.mockReturnValueOnce({
      process: procA,
      containerName: 'c1',
      group: groupA,
    });

    const pool = new WarmPool();
    await pool.start({ 'a@g.us': groupA });
    pool.updateRegisteredGroups({ 'a@g.us': groupA, 'b@g.us': groupB });

    // Manually fill the second slot so pool is at capacity (size 2)
    const procA2 = makeProcess();
    mockSpawnWarm.mockReturnValueOnce({
      process: procA2,
      containerName: 'c2',
      group: groupA,
    });
    // Claim slot 1 and replenish it — but first let's simulate full pool differently:
    // directly: claim a@g.us (frees slot), then replenish fills it back,
    // then claim again to get to 0, fill both with different groups.
    // Simpler: use WARM_POOL_SIZE=1 by starting with a pre-filled 1-slot scenario.

    // Alternative direct approach: claim a@g.us to remove it, then
    // replenish b@g.us (pool has capacity). Then replenish a@g.us — now pool is full.
    pool.claim('a@g.us');
    vi.clearAllMocks();

    // Pool is empty, size 2. Replenish b@g.us (more recent) then a@g.us — fills pool.
    vi.mocked(getMostRecentlyActiveGroups).mockReturnValue([
      { jid: 'b@g.us' },
      { jid: 'a@g.us' },
    ]);
    mockSpawnWarm
      .mockReturnValueOnce({
        process: makeProcess(),
        containerName: 'c3',
        group: groupB,
      })
      .mockReturnValueOnce({
        process: makeProcess(),
        containerName: 'c4',
        group: groupA,
      });
    pool.replenish('b@g.us');
    pool.replenish('a@g.us');
    await vi.waitFor(() => expect(mockSpawnWarm).toHaveBeenCalledTimes(2));

    vi.clearAllMocks();

    // Pool is full (a@g.us, b@g.us). Now replenish c@g.us which is more recent than a@g.us.
    const groupC = makeGroup('group-c');
    pool.updateRegisteredGroups({
      'a@g.us': groupA,
      'b@g.us': groupB,
      'c@g.us': groupC,
    });
    vi.mocked(getMostRecentlyActiveGroups).mockReturnValue([
      { jid: 'c@g.us' }, // most recent
      { jid: 'b@g.us' },
      { jid: 'a@g.us' }, // LRU — should be evicted
    ]);
    mockSpawnWarm.mockReturnValue({
      process: makeProcess(),
      containerName: 'c5',
      group: groupC,
    });

    pool.replenish('c@g.us');

    await vi.waitFor(() => expect(mockSpawnWarm).toHaveBeenCalledOnce());
    // a@g.us should have been evicted, c@g.us should now be warm
    expect(pool.claim('a@g.us')).toBeNull();
    expect(pool.claim('c@g.us')).not.toBeNull();
    pool.stop();
  });

  it('skips when pool already has entry for jid', async () => {
    const proc = makeProcess();
    mockSpawnWarm.mockReturnValue({
      process: proc,
      containerName: 'c1',
      group: groupA,
    });
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
      .mockReturnValueOnce({
        process: makeProcess(),
        containerName: 'c1',
        group: groupA,
      })
      .mockReturnValueOnce({
        process: makeProcess(),
        containerName: 'c2',
        group: groupB,
      });

    const pool = new WarmPool();
    await pool.start(registeredGroups);

    expect(mockSpawnWarm).toHaveBeenCalledTimes(2);
    expect(pool.claim('a@g.us')).not.toBeNull();
    expect(pool.claim('b@g.us')).not.toBeNull();
    pool.stop();
  });

  it('skips jids not in registeredGroups', async () => {
    vi.mocked(getMostRecentlyActiveGroups).mockReturnValue([
      { jid: 'unknown@g.us' },
    ]);

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
      .mockReturnValueOnce({
        process: proc,
        containerName: 'c1',
        group: groupA,
      })
      .mockReturnValue({
        process: makeProcess(),
        containerName: 'c2',
        group: groupA,
      });
    vi.mocked(getMostRecentlyActiveGroups).mockReturnValue([{ jid: 'a@g.us' }]);

    const pool = new WarmPool();
    await pool.start({ 'a@g.us': groupA });

    expect(mockSpawnWarm).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();

    // Simulate premature exit before claim
    mockSpawnWarm.mockReturnValue({
      process: makeProcess(),
      containerName: 'c3',
      group: groupA,
    });
    proc.emit('exit', 1);

    await vi.waitFor(() => expect(mockSpawnWarm).toHaveBeenCalledOnce());
    pool.stop();
  });
});
