# Warm Container Pool — Implementation Summary

## Why

On Raspberry Pi 5 (aarch64, Docker 29.3.0), cold container starts take ~4 seconds per message. Warm/IPC starts take ~550ms. The goal was to eliminate cold starts by pre-spawning containers and claiming them when a message arrives.

## What Was Built

A per-group warm container pool with a global cap, LRU eviction, health checks, and race protection. All new work is in 10 commits on `main` (SHAs listed below).

## Commits

```
1aab1ce feat: add WARM_POOL_SIZE and WARM_IDLE_MAX_MS config constants
956295f feat: add getMostRecentlyActiveGroups to db
bac0381 feat: extract _spawnContainer/_driveContainer, add spawnWarmContainer/runWarmContainerAgent
0666dcb feat: add WarmPool class
ff6ca4a fix: add logger.warn on DB error, collect-then-act in health check
f801b13 feat: wire WarmPool into orchestrator — claim before cold-start, replenish on exit, seed on startup
b3f6cde fix: consistent LRU eviction via DB activity, wire updateRegisteredGroups on group add, add eviction test
460db0a fix: add non-null assertions for stdin/stdout/stderr, cast fakeProc in warm tests
```

Also two doc commits (`302cc78`, `5820d0b`) for the design spec and implementation plan in `docs/superpowers/`.

## Files Changed

| File | What changed |
|------|--------------|
| `src/config.ts` | Added `WARM_POOL_SIZE` (default 2) and `WARM_IDLE_MAX_MS` (default 10 min) |
| `src/db.ts` | Added `getMostRecentlyActiveGroups(limit)` — groups ordered by most recent activity, groups only |
| `src/db.test.ts` | Tests for `getMostRecentlyActiveGroups` |
| `src/container-runner.ts` | Extracted `_spawnContainer`/`_driveContainer` from `runContainerAgent`; added `WarmContainerHandle`, `spawnWarmContainer`, `runWarmContainerAgent` |
| `src/container-runner.test.ts` | Tests for `spawnWarmContainer` and `runWarmContainerAgent` |
| `src/warm-pool.ts` | New: `WarmPool` class |
| `src/warm-pool.test.ts` | New: 10 tests for `WarmPool` |
| `src/index.ts` | Wired `warmPool` into orchestrator |

## How It Works

**Docker mounts are fixed at container creation.** A warm container for group A can only ever serve group A — it has group A's volume mounts. So the pool is per-group, not generic.

**Startup seeding:** On startup, query DB for `WARM_POOL_SIZE` most recently active groups. Pre-spawn a container for each.

**On message:** `processGroupMessages` calls `warmPool.claim(chatJid)`. If a warm container exists for that group, it's removed from the pool and passed to `runAgent` as `preSpawned`. `runAgent` writes the prompt to the already-running container's stdin and drives it normally. If no warm container exists, falls back to cold start.

**Replenishment:** After every container exits (warm or cold), `warmPool.replenish(chatJid)` fires in the `finally` block of `runAgent`. It spawns a replacement if there's pool capacity.

**LRU eviction:** When the pool is full and a recently-active group needs a slot, the least recently active current pool entry is evicted (killed). Both sides of the comparison use DB activity order from `getMostRecentlyActiveGroups`.

**Race guard:** `replenishing: Set<string>` prevents two concurrent `replenish` calls for the same JID from both spawning a container.

**Premature exit:** If a warm container dies before being claimed (e.g., OOM), its `exit` handler removes it from the pool and calls `replenish`.

**Health check:** `setInterval` every 60 seconds kills and replaces containers idle longer than `WARM_IDLE_MAX_MS`.

## To Revert

To remove this work entirely:

```bash
git revert 460db0a b3f6cde f801b13 ff6ca4a 0666dcb bac0381 956295f 1aab1ce
```

Or to reset to the commit before this work started:

```bash
# Find the base commit (first commit before 1aab1ce)
git log --oneline 1aab1ce^..1aab1ce~1
# Then: git reset --hard <that SHA>
```

Files to delete if reverting manually:
- `src/warm-pool.ts`
- `src/warm-pool.test.ts`

The `container-runner.ts` refactor (extracting `_spawnContainer`/`_driveContainer`) is clean and could be kept even without the pool — it doesn't change external behavior.

## On Apple Silicon + Apple Container

If switching to Apple Container via the `/convert-to-apple-container` skill, the warm pool should still work since `spawnWarmContainer` uses `CONTAINER_RUNTIME_BIN` from `container-runtime.ts`. However, Apple Container cold starts are much faster (~200ms vs ~4s for Docker on Pi), so the pool may not be worth the complexity on Apple Silicon. The main value was on the Pi's slower Docker.

## Env Vars

```bash
WARM_POOL_SIZE=2          # Number of pre-warmed containers (0 to disable)
WARM_IDLE_MAX_MS=600000   # Max idle time before health-check replacement (ms)
```

Set `WARM_POOL_SIZE=0` to disable without reverting code.
