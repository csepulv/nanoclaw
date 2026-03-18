# Web UI Channel

A self-contained chat interface for NanoClaw, served as a new channel alongside Slack/Telegram.

## Problem

NanoClaw's only interaction paths are messaging platforms (WhatsApp, Telegram, Slack). There's no way to chat with the agent directly from a browser — a common preference for development, testing, and everyday use.

## Design

### Architecture

The web UI is a new channel (`src/channels/web.ts`) that follows the existing self-registration pattern. It has two parts:

1. **HTTP server** — serves the chat HTML page and handles WebSocket upgrade requests
2. **WebSocket connection** — bidirectional real-time messaging with the browser

```
Browser <--WebSocket--> web channel <--Channel interface--> NanoClaw orchestrator <--container--> Agent
```

The web channel auto-registers a synthetic JID (`web:chat`) as its own independent group with folder `web-chat` during `connect()`. This gives it its own container session, memory, and filesystem — just like any other group. Messages from the browser flow through the same `onMessage` -> `storeMessage` -> `processGroupMessages` -> `runContainerAgent` pipeline as any other channel.

The channel is always-on — it starts automatically with NanoClaw on a default port. No credentials to configure.

### Group Registration

During `connect()`, the web channel:

1. Calls `onChatMetadata('web:chat', timestamp, 'Web Chat', 'web', false)` to register the chat in the DB
2. Checks if `web:chat` already exists in `registeredGroups()` — if not, registers it via the same mechanism other channels use (IPC/DB)
3. The registered group has: `{ name: 'Web Chat', folder: 'web-chat', trigger: '', requiresTrigger: false, isMain: false }`

The group has `requiresTrigger: false` so every message triggers the agent (no `@name` prefix needed). This matches how a direct chat should behave.

### WebSocket Protocol

Simple JSON messages in both directions.

**Browser -> Server:**
```json
{"type": "message", "text": "Hello, what can you do?"}
```

**Server -> Browser:**
```json
{"type": "message", "text": "I can help with..."}
{"type": "typing", "isTyping": true}
{"type": "typing", "isTyping": false}
```

No auth, no session negotiation. Single connection = single conversation. If the WebSocket disconnects, the browser reconnects automatically. The agent's container session persists via NanoClaw's existing session tracking regardless of WebSocket state.

### Inbound Message Format

When the browser sends a message, the web channel constructs a `NewMessage`:

```
{
  id: crypto.randomUUID(),
  chat_jid: 'web:chat',
  sender: 'web-user',
  sender_name: 'User',
  content: <text from browser>,
  timestamp: new Date().toISOString(),
  is_from_me: false,
  is_bot_message: false
}
```

### Outbound Message Buffering

When the agent sends a response but no WebSocket client is connected (browser closed, network drop), messages are buffered in memory (capped at 100 messages). On reconnect, buffered messages are replayed to the client before new messages flow. This prevents silent message loss.

### Chat Page

A single self-contained HTML file (`src/channels/web-ui.html`) served at `http://localhost:3005`.

- Standard chat layout: message list on top, input bar at bottom
- Dark theme
- Typing indicator (animated dots) when the agent is working
- Auto-reconnect on WebSocket disconnect (exponential backoff)
- Auto-scroll to bottom on new messages
- Preformatted text rendering (agent output is markdown-ish but rendered as plain text with `white-space: pre-wrap`)
- No conversation history on refresh (agent session/memory persists server-side)
- Zero external dependencies — fully self-contained HTML/CSS/JS

### Streaming Granularity

Per-turn from the Claude Agent SDK's `query()` async iterator. Messages appear in the browser each time the agent completes a thought or tool call. This is not token-level streaming — responses arrive in bursts. This matches the constraint of the SDK's current API surface.

### Configuration

One new environment variable (optional):

| Variable | Default | Purpose |
|----------|---------|---------|
| `WEB_UI_PORT` | `3005` | Port for the HTTP/WebSocket server |

### Channel Interface Implementation

```
Channel {
  name: 'web'
  connect()       -- registers group, starts HTTP server, begins accepting WebSocket connections
  sendMessage()   -- pushes {"type":"message"} to connected WebSocket client (or buffers if disconnected)
  isConnected()   -- true when HTTP server is listening
  ownsJid()       -- returns true for JIDs starting with "web:"
  disconnect()    -- closes WebSocket connections and HTTP server
  setTyping()     -- pushes {"type":"typing"} to connected WebSocket client
}
```

### Sender Allowlist Interaction

Web messages have `is_from_me: false` and `is_bot_message: false`, so they pass through the sender-allowlist check in `onMessage`. Since `web:chat` is its own group, the allowlist only applies if explicitly configured for the `web:chat` JID. By default, no allowlist = all messages accepted.

## Files

| File | Change |
|------|--------|
| `src/channels/web.ts` | **New** — channel implementation: HTTP server, WebSocket handling, Channel interface |
| `src/channels/web-ui.html` | **New** — self-contained chat page (HTML/CSS/JS) |
| `src/channels/index.ts` | Add `import './web.js'` |
| `src/config.ts` | Add `WEB_UI_PORT` constant |

## Constraints

- No authentication — localhost only
- Single WebSocket client at a time (single session)
- No conversation history persistence in the browser
- Streaming is per-turn, not token-level
- No file upload, image support, or rich media — text only

## Future Possibilities (Not In Scope)

- Mapping to existing group instead of own group (configurable `WEB_UI_GROUP`)
- Token-level streaming (requires SDK changes or direct API use)
- localStorage conversation history
- Markdown rendering via inline library
- Multiple simultaneous sessions
- File/image support
