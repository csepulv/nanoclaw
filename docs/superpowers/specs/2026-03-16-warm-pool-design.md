# Warm Container Pool Design

**Date:** 2026-03-16
**Status:** Approved

## Problem

Container cold starts on Raspberry Pi 5 take ~4 seconds per message. Warm/IPC starts (container already running) take ~550ms. The goal is to eliminate cold starts for the first message in a conversation by maintaining a pool of pre-warmed idle containers.

## Approach

Per-group pre-warming with a global cap (`WARM_POOL_SIZE`, default 2). After each container exits for a group, the pool immediately spawns a replacement for that group if a slot is available. A generic pool was considered but rejected because Docker mounts are fixed at container creation time — per-group isolation cannot be maintained without group-specific mounts.

## Architecture

One new file: `src/warm-pool.ts`. Four existing files touched: `src/container-runner.ts`, `src/index.ts`, `src/config.ts`, `src/db.ts`. `GroupQueue` is not changed.

```
Message arrives for group X
       │
       ▼
warmPool.claim(groupJid)
       │
  warm? ──yes──▶ route through runAgent with pre-spawned process
       │
   no (pool miss or pool empty)
       │
       ▼
cold-start as today (queue.enqueueMessageCheck)
       │
       ▼
container exits (onExit callback in index.ts)
       │
       ▼
warmPool.replenish(groupJid)
```

## WarmPool Class

```typescript
interface WarmEntry {
  process: ChildProcess;
  containerName: string;
  group: RegisteredGroup;   // full group record (includes groupFolder, jid)
  idleSince: number;        // Date.now() when agent-runner compile completed
}

class WarmPool {
  private pool = new Map<string, WarmEntry>();        // groupJid → entry
  private registeredGroups: Record<string, RegisteredGroup> = {};
  private healthTimer: NodeJS.Timeout | null = null;
  private replenishing = new Set<string>();           // guards concurrent replenish calls

  async start(registeredGroups: Record<string, RegisteredGroup>): Promise<void>
  claim(groupJid: string): WarmEntry | null
  replenish(groupJid: string): void
  stop(): void
}
```

`registeredGroups` is stored as an instance variable so `replenish()` and the health-check timer can call `spawnWarm()` without requiring the caller to pass the group record every time.

## Pool Capacity Logic (replenish)

`replenishing` guards against a race where two concurrent calls for the same `groupJid` each see `pool.size < WARM_POOL_SIZE` and both spawn:

```typescript
replenish(groupJid: string): void {
  if (this.replenishing.has(groupJid)) return;
  if (this.pool.has(groupJid)) return;     // already warm
  this.replenishing.add(groupJid);

  const group = this.registeredGroups[groupJid];
  if (!group) { this.replenishing.delete(groupJid); return; }

  if (this.pool.size < WARM_POOL_SIZE) {
    this.spawnWarm(group).finally(() => this.replenishing.delete(groupJid));
    return;
  }

  // Pool full — evict least-recently-active group if groupJid is more recent
  const lru = this.findLeastRecentEntry();
  if (lru && lastMessageTime(group) > lastMessageTime(lru.group)) {
    lru.entry.process.kill();
    this.pool.delete(lru.groupJid);
    this.spawnWarm(group).finally(() => this.replenishing.delete(groupJid));
  } else {
    this.replenishing.delete(groupJid);
  }
}
```

## Startup Seeding

On startup, query SQLite for the N most recently active groups. The existing `getAllChats()` returns chats ordered by `last_message_time DESC`; we filter to registered groups and take the first N:

```typescript
async start(registeredGroups: Record<string, RegisteredGroup>): Promise<void> {
  this.registeredGroups = registeredGroups;
  const recent = await db.getMostRecentlyActiveGroups(WARM_POOL_SIZE);
  for (const { jid } of recent) {
    if (registeredGroups[jid]) await this.spawnWarm(registeredGroups[jid]);
  }
  this.startHealthCheck();
}
```

`db.getMostRecentlyActiveGroups(limit)` is a new function added to `db.ts`:

```typescript
export async function getMostRecentlyActiveGroups(limit: number): Promise<{ jid: string }[]> {
  return db.prepare(
    `SELECT jid FROM chats WHERE is_group = 1 ORDER BY last_message_time DESC LIMIT ?`
  ).all(limit) as { jid: string }[];
}
```

## How Warm Containers Wait

Containers are spawned with `spawnWarmContainer()` (see below) — same Docker args, same group-specific mounts — but stdin is not written or closed. `idleSince` is set at spawn time (`Date.now()`). The agent-runner inside the container will be compiling TypeScript for ~2–3 seconds before it begins reading stdin; if a claim arrives during that window the stdin write is buffered by the OS pipe and will be read once the agent-runner is ready, so no special readiness handshake is required. The 10-minute health-check threshold makes a few seconds of timing variance in `idleSince` irrelevant.

## Integration with runAgent

The claim path must go through `runAgent` in `index.ts` to preserve snapshot writes (`writeTasksSnapshot`, `writeGroupsSnapshot`) and session-ID persistence. `runAgent` is extended with an optional `preSpawned` parameter:

```typescript
async function runAgent(
  group: RegisteredGroup,
  messages: FormattedMessage[],
  preSpawned?: WarmEntry   // new optional parameter
): Promise<void>
```

Inside `runAgent`, the existing `runContainerAgent(group, input, onProcess, onOutput)` call becomes:

```typescript
if (preSpawned) {
  // Set active state so queue protects against concurrent execution
  queue.setActive(chatJid, true);
  queue.registerProcess(chatJid, preSpawned.process, preSpawned.containerName, group.folder);
  await runWarmContainerAgent(preSpawned, input, onOutput);
} else {
  await runContainerAgent(group, input, onProcess, onOutput);  // cold start, unchanged
}
```

`queue.setActive(groupJid, active)` is a minimal new method on GroupQueue that sets `state.active`:

```typescript
setActive(groupJid: string, active: boolean): void {
  const state = this.groups.get(groupJid);
  if (state) state.active = active;
}
```

The call site in `index.ts` before `queue.enqueueMessageCheck`:

```typescript
const warm = warmPool.claim(chatJid);
if (warm) {
  log.info('[warm-pool] claimed warm container for', chatJid);
  await runAgent(group, messages, warm);
} else {
  queue.enqueueMessageCheck(chatJid);  // cold start, unchanged
}
```

## container-runner.ts Changes

Three new exported functions alongside the existing `runContainerAgent`:

```typescript
// Spawns a container but does not write stdin or wait for output.
// Resolves once the agent-runner is ready (first stdout byte).
export async function spawnWarmContainer(
  group: RegisteredGroup,
  deps?: ContainerDeps
): Promise<{ process: ChildProcess; containerName: string }>

// Writes input JSON to an already-running container's stdin, closes it,
// and streams output identically to runContainerAgent.
export async function runWarmContainerAgent(
  warm: WarmEntry,
  input: ContainerInput,
  onOutput: OutputCallback,
  deps?: ContainerDeps
): Promise<void>
```

`spawnWarmContainer` reuses the existing `buildVolumeMounts` and `buildContainerArgs` helpers. Only the stdin write and stdout-waiting logic differ.

## Health Check

Timer fires every 60 seconds inside `WarmPool.start()`. Any container idle longer than `WARM_IDLE_MAX_MS` (default 10 minutes) is killed and replaced with a fresh container for the same group.

```typescript
private startHealthCheck(): void {
  this.healthTimer = setInterval(() => {
    const cutoff = Date.now() - WARM_IDLE_MAX_MS;
    for (const [groupJid, entry] of this.pool) {
      if (entry.idleSince < cutoff) {
        log.info('[warm-pool] replacing stale container for', groupJid);
        entry.process.kill();
        this.pool.delete(groupJid);
        this.replenish(groupJid);
      }
    }
  }, 60_000);
}
```

## Error Handling

**Warm container dies before claim:** `spawnWarm` attaches an `exit` listener on the process. If the entry is still in the pool at exit: remove, log warning, call `replenish()`.

**spawnWarm fails:** Log error, don't add to pool. No retry loop — next `replenish()` call (triggered by the next message event) retries naturally.

**Claimed container fails:** Once handed to `queue.registerProcess()` and active state is set, the existing GroupQueue error/retry machinery handles it. WarmPool does not track claimed containers.

**Shutdown:** `warmPool.stop()` kills all warm containers (they hold no in-progress user work) and clears the health timer. This is asymmetric with `queue.shutdown()`, which deliberately does not kill active containers. Called in the existing `SIGINT`/`SIGTERM` handler in `index.ts`.

## New Config Constants

```typescript
export const WARM_POOL_SIZE = parseInt(process.env.WARM_POOL_SIZE ?? '2', 10);
export const WARM_IDLE_MAX_MS = parseInt(process.env.WARM_IDLE_MAX_MS ?? String(10 * 60 * 1000), 10);
```

**Note on concurrent container count:** Warm containers are not tracked by `GroupQueue.activeCount`. With `MAX_CONCURRENT_CONTAINERS=5` and `WARM_POOL_SIZE=2`, up to 7 containers may run simultaneously. On memory-constrained hosts, account for this when setting `MAX_CONCURRENT_CONTAINERS`.

## Files Changed

| File | Change |
|------|--------|
| `src/warm-pool.ts` | New — WarmPool class |
| `src/container-runner.ts` | Add `spawnWarmContainer`, `runWarmContainerAgent` |
| `src/index.ts` | Consult warm pool before cold-start; call `replenish` on exit; pass `preSpawned` to `runAgent` |
| `src/config.ts` | Add `WARM_POOL_SIZE`, `WARM_IDLE_MAX_MS` |
| `src/db.ts` | Add `getMostRecentlyActiveGroups` |
| `src/group-queue.ts` | Add minimal `setActive` method |

## Testing

1. **Log verification** — on startup look for `[warm-pool] seeding`/`ready` logs; on first message look for `[warm-pool] claimed`.
2. **Latency measurement** — add timestamp log around container-ready decision in `index.ts`; warm path should show ~550ms vs ~4000ms cold.
3. **Health check** — set `WARM_IDLE_MAX_MS=30000` (30s), wait 30s, verify replacement log.
4. **Pool miss fallback** — `docker kill` all warm containers, send a message, verify cold-start still works and pool replenishes after.
5. **Race guard** — verify `replenishing` set prevents duplicate warm containers when two messages arrive simultaneously for the same group with an empty pool slot.
