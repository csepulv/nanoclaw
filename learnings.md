# Learnings — Apple Container Migration & Performance

Captured during the migration from Raspberry Pi (Docker) to macOS (Apple Container), March 2026.

## Apple Container vs Docker Differences

### Directory-only mounts
Apple Container (VirtioFS) only supports directory mounts, not file mounts. Docker allows mounting `/dev/null` over a single file to shadow it — Apple Container errors with `path '/dev/null' is not a directory`.

**Workaround:** The Dockerfile entrypoint starts as root and uses `mount --bind /dev/null /workspace/project/.env` inside the container, then drops privileges via `setpriv`. The host-side code must NOT add the `/dev/null` file mount to the container args.

### Networking model
Docker Desktop on macOS routes `host.docker.internal` to the host's loopback (`127.0.0.1`). Apple Container does not — containers get their own IP on a `192.168.64.0/24` virtual network via `bridge100`.

- `host.docker.internal` does not resolve inside Apple Container VMs
- The credential proxy must bind to `0.0.0.0` (bridge100 may not exist at startup)
- Detect the gateway IP dynamically via `container network ls --format json` → `status.ipv4Gateway` on the `default` network
- Fallback to `192.168.64.1` if detection fails (the typical bridge IP)
- Support `CONTAINER_HOST_GATEWAY` env var override for edge cases
- See PR #887 on upstream for the approach used

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

## OAuth vs API Key Authentication

### The OAuth latency bug
Claude Code CLI with OAuth (Max subscription) has a known bug causing 60-90 second delays on every API call. Documented in:
- [anthropics/claude-code#20527](https://github.com/anthropics/claude-code/issues/20527) — 60s latency on all `--print` requests
- [anthropics/claude-code#17330](https://github.com/anthropics/claude-code/issues/17330) — extreme latency for Max subscription
- [anthropics/claude-code#18028](https://github.com/anthropics/claude-code/issues/18028) — API streaming stalls

**Symptoms:** The agent sits idle for 60s producing zero output, then suddenly responds. With multiple tool-call turns per query, this compounds to 10+ minutes per response.

**Fix:** Switch from `CLAUDE_CODE_OAUTH_TOKEN` to `ANTHROPIC_API_KEY` in `.env`. The credential proxy auto-detects the auth mode. With API key, the same queries that took 12 minutes dropped to 24 seconds.

**Downside:** Max subscription ($200/month) does not include API key generation. API usage is billed separately at per-token rates via console.anthropic.com. This means paying for both subscription and API.

### Alternatives to separate API billing
- **[CLIProxyAPI](https://rogs.me/2026/02/use-your-claude-max-subscription-as-an-api-with-cliproxyapi/)** — A Go binary that routes OpenAI-format API requests through your Max subscription OAuth token, avoiding the CLI's broken token exchange. Could theoretically replace the credential proxy for OAuth mode.
- **[Vercel AI Gateway](https://vercel.com/changelog/claude-code-max-via-ai-gateway-available-now-for-claude-code)** — Supports Claude Code Max subscription routing with no additional cost.
- **Refresh OAuth token** — Running `claude setup-token` to get a fresh token may help in some cases.
- **Pin Claude Code version** — The bug was introduced around v2.1.19; some versions may not have it.

## Response Time Breakdown

After fixing the OAuth issue, response times for basic queries are 15-35 seconds. The breakdown:

| Component | Time | Notes |
|-----------|------|-------|
| Slack/Telegram poll interval | ~2s | Message loop POLL_INTERVAL |
| Container VM start | ~1-2s | Apple Container cold start |
| Entrypoint + diff check | ~1s | Skips tsc recompile when source unchanged |
| SDK/CLI initialization | ~3-5s | Loading config, MCP servers |
| API calls (tool turns) | 15-25s | Typically 3-4 tool-use turns at 4-9s each |
| IPC + message send | <0.5s | Negligible |

**Container/proxy infrastructure overhead is under 0.5s.** Nearly all time is model inference across multiple API round-trips.

### Reducing response time
- **Fewer tool calls** — The agent does 3-4 tool calls per basic question (reads files, searches code). A `maxTurns` limit or simpler CLAUDE.md instructions could reduce this.
- **Faster model** — Haiku would be 3-5x faster but less capable. Could be configured per-group via a `CLAUDE_MODEL` env var.
- **Smaller context** — The 307MB project root is mounted read-only. `.gitignore` excludes `node_modules` from search, but the agent still has a large codebase to consider.

## Container Startup Optimization

### TypeScript recompilation (Issue #941)
The Dockerfile entrypoint originally ran `npx tsc` on every container start, adding 2-5 minutes on Apple Container VMs. Fixed by:
- Pre-building to `/app/dist` during image build
- Saving source snapshot to `/app/src.built`
- Entrypoint does `diff -rq /app/src /app/src.built` — only recompiles if mounted source differs
- Common case (no customization) skips tsc entirely

### Boot-time crash loop (Issue #1067)
`ensureContainerRuntimeRunning()` made a single attempt to start Apple Container, failing immediately on boot when services weren't ready. Fixed by:
- Retry loop: 10 attempts with 5s intervals
- `ThrottleInterval: 30` in launchd plist to prevent rapid restart OOM

## Typing Indicators

Telegram supports typing indicators (`sendChatAction('typing')`) but they expire after ~5 seconds. A naive `setInterval` repeating every 4s causes the indicator to persist permanently because Telegram has no "stop typing" API — the action just expires naturally.

**Better approach:** The agent-runner emits a null-result output marker on each SDK tool-use turn. The host receives these via the streaming output callback and refreshes `setTyping` only when the agent is actively working. The indicator naturally expires ~5s after the last tool call, which is when the final response is being generated.

## Debugging

Set `LOG_LEVEL=debug` in the launchd plist's `EnvironmentVariables` (not `.env` — the logger reads `process.env` at import time, not the `.env` file). This enables:
- Container stderr (SDK debug output, agent-runner logs) written to container log files
- Real-time `[agent-runner]` messages in the main nanoclaw log showing each SDK message type and timing
- Credential proxy request logging
