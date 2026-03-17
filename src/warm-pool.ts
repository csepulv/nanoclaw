import { getMostRecentlyActiveGroups } from './db.js';
import { spawnWarmContainer, WarmContainerHandle } from './container-runner.js';
import { WARM_IDLE_MAX_MS, WARM_POOL_SIZE } from './config.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export type WarmEntry = WarmContainerHandle & { idleSince: number };

export class WarmPool {
  private pool = new Map<string, WarmEntry>();
  private registeredGroups: Record<string, RegisteredGroup> = {};
  private replenishing = new Set<string>();
  private healthTimer: NodeJS.Timeout | null = null;

  /** Seed pool from most recently active groups and start health-check timer. */
  async start(
    registeredGroups: Record<string, RegisteredGroup>,
  ): Promise<void> {
    this.registeredGroups = registeredGroups;

    const recent = getMostRecentlyActiveGroups(WARM_POOL_SIZE);
    for (const { jid } of recent) {
      if (registeredGroups[jid] && this.pool.size < WARM_POOL_SIZE) {
        await this.spawnWarm(registeredGroups[jid], jid);
      }
    }

    this.startHealthCheck();
  }

  /** Update the registered groups map (called when groups change at runtime). */
  updateRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
    this.registeredGroups = groups;
  }

  /**
   * Claim a warm container for groupJid. Removes it from the pool.
   * Returns null if no warm container is available for this group.
   */
  claim(groupJid: string): WarmEntry | null {
    const entry = this.pool.get(groupJid);
    if (!entry) return null;
    this.pool.delete(groupJid);
    logger.info({ groupJid }, '[warm-pool] claimed warm container');
    return entry;
  }

  /**
   * Called after a container exits for groupJid.
   * Spawns a replacement if there is pool capacity.
   */
  replenish(groupJid: string): void {
    if (this.replenishing.has(groupJid)) return;
    if (this.pool.has(groupJid)) return;

    const group = this.registeredGroups[groupJid];
    if (!group) return;

    this.replenishing.add(groupJid);

    if (this.pool.size < WARM_POOL_SIZE) {
      this.spawnWarm(group, groupJid).finally(() =>
        this.replenishing.delete(groupJid),
      );
      return;
    }

    // Pool full — evict LRU entry if groupJid is more recently active
    const lru = this.findLeastRecentEntry();
    if (lru && this.isMoreRecentThan(groupJid, lru.groupJid)) {
      lru.entry.process.kill();
      this.pool.delete(lru.groupJid);
      logger.info(
        { evicted: lru.groupJid, replacing: groupJid },
        '[warm-pool] evicted LRU entry to make room',
      );
      this.spawnWarm(group, groupJid).finally(() =>
        this.replenishing.delete(groupJid),
      );
    } else {
      this.replenishing.delete(groupJid);
    }
  }

  /** Kill all warm containers and stop the health-check timer. */
  stop(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    for (const [groupJid, entry] of this.pool) {
      logger.info(
        { groupJid },
        '[warm-pool] killing warm container on shutdown',
      );
      entry.process.kill();
    }
    this.pool.clear();
  }

  private async spawnWarm(
    group: RegisteredGroup,
    groupJid: string,
  ): Promise<void> {
    try {
      const handle = spawnWarmContainer(group);
      const entry: WarmEntry = { ...handle, idleSince: Date.now() };

      // If container dies before it's claimed, remove from pool and replenish
      handle.process.once('exit', () => {
        if (this.pool.get(groupJid) === entry) {
          logger.warn(
            { groupJid },
            '[warm-pool] warm container died before claim, replacing',
          );
          this.pool.delete(groupJid);
          this.replenish(groupJid);
        }
      });

      this.pool.set(groupJid, entry);
      logger.info(
        { groupJid, containerName: handle.containerName },
        '[warm-pool] warm container ready',
      );
    } catch (err) {
      logger.error(
        { groupJid, err },
        '[warm-pool] failed to spawn warm container',
      );
    }
  }

  private startHealthCheck(): void {
    this.healthTimer = setInterval(() => {
      const cutoff = Date.now() - WARM_IDLE_MAX_MS;
      const stale = [...this.pool.entries()].filter(([, e]) => e.idleSince < cutoff);
      for (const [groupJid, entry] of stale) {
        logger.info({ groupJid }, '[warm-pool] replacing stale container');
        entry.process.kill();
        this.pool.delete(groupJid);
        this.replenish(groupJid);
      }
    }, 60_000);
  }

  private findLeastRecentEntry(): {
    groupJid: string;
    entry: WarmEntry;
  } | null {
    let lruJid: string | null = null;
    let lruSince = Infinity;
    for (const [groupJid, entry] of this.pool) {
      if (entry.idleSince < lruSince) {
        lruSince = entry.idleSince;
        lruJid = groupJid;
      }
    }
    if (!lruJid) return null;
    return { groupJid: lruJid, entry: this.pool.get(lruJid)! };
  }

  /**
   * Returns true if groupJid has more recent activity than otherJid.
   * Uses the chats table order from getMostRecentlyActiveGroups.
   */
  private isMoreRecentThan(groupJid: string, otherJid: string): boolean {
    try {
      const recent = getMostRecentlyActiveGroups(100);
      const jids = recent.map((r) => r.jid);
      const idxA = jids.indexOf(groupJid);
      const idxB = jids.indexOf(otherJid);
      if (idxA === -1) return false;
      if (idxB === -1) return true;
      return idxA < idxB; // lower index = more recent
    } catch (err) {
      logger.warn({ groupJid, err }, '[warm-pool] isMoreRecentThan DB query failed, skipping eviction');
      return false;
    }
  }
}
