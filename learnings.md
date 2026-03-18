# Learnings — Apple Container Migration

Captured during the migration from Raspberry Pi (Docker) to macOS (Apple Container), March 2026.

## Apple Container vs Docker Differences

### Directory-only mounts
Apple Container (VirtioFS) only supports directory mounts, not file mounts. Docker allows mounting `/dev/null` over a single file to shadow it — Apple Container errors with `path '/dev/null' is not a directory`.

**Workaround:** The Dockerfile entrypoint starts as root and uses `mount --bind /dev/null /workspace/project/.env` inside the container, then drops privileges via `setpriv`. The host-side code must NOT add the `/dev/null` file mount to the container args.

### Networking model
Docker Desktop on macOS routes `host.docker.internal` to the host's loopback (`127.0.0.1`). Apple Container does not — containers get their own IP on a `192.168.64.0/24` virtual network via `bridge100`.

- The host is reachable at the `bridge100` interface IP (typically `192.168.64.1`)
- `host.docker.internal` does not resolve inside Apple Container VMs
- The credential proxy must bind to the bridge IP (not `127.0.0.1`) so containers can connect
- Detect the bridge IP at runtime: `os.networkInterfaces()['bridge100']`

### Container exec syntax
Apple Container's `container exec` does not use `--` before the command (unlike Docker). Using `--` causes `failed to find target executable --`.

```bash
# Docker
docker exec container-name -- ps aux

# Apple Container
container exec container-name ps aux
```

## Upstream Skill Branch Gaps

The `skill/apple-container` branch at `upstream` (qwibitai/nanoclaw) was incomplete as of this migration:

1. **`container-runtime.ts`** still uses `host.docker.internal` and binds proxy to `127.0.0.1` — no bridge100 detection
2. **`container-runner.ts`** still has the `/dev/null` file mount for `.env` shadowing (should be removed since the entrypoint handles it)
3. **`container-runner.ts`** references `input.isMain` instead of `isMain` in `_spawnContainer` (merge artifact from the warm pool refactor)

These were fixed locally during this session.

## Warm Container Pool

The warm pool was built to eliminate ~4s cold starts on Raspberry Pi (Docker). On Apple Container (macOS), cold starts are ~200ms, making the pool unnecessary.

- The warm pool caused a crash loop on Apple Container — containers died immediately before being claimed, triggering infinite respawn
- Root cause was not diagnosed (likely related to Apple Container's different lifecycle behavior)
- Reverted entirely; tagged `warm-container` before removal for reference
- Can be disabled without code changes via `WARM_POOL_SIZE=0` in `.env` if the code is ever restored

## Merge Conflicts

When merging skill branches that were authored against a different codebase state:

- `package-lock.json`: safe to accept theirs, then `npm install` to reconcile
- `.env.example`: merge both sides (keep all channel tokens)
- Code files with warm pool refactoring: the `_spawnContainer`/`_driveContainer` extraction created merge artifacts (e.g., `input.isMain` instead of `isMain`)
- Pre-commit hooks (prettier) can interfere with `git revert --continue` by modifying files between revert steps — use manual edits instead of `git revert` for complex multi-commit reverts
