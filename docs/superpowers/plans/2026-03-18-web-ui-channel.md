# Web UI Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a browser-based chat interface to NanoClaw as a self-registering channel with WebSocket communication.

**Architecture:** New `web` channel follows the existing channel pattern (factory + self-registration). An HTTP server serves a single-page chat UI and upgrades to WebSocket for real-time messaging. The channel auto-registers its own group (`web:chat` / `web-chat` folder) and routes messages through the standard NanoClaw pipeline.

**Tech Stack:** Node.js `http` + `ws` (WebSocket library), vanilla HTML/CSS/JS for the chat page.

**Spec:** `docs/superpowers/specs/2026-03-18-web-ui-channel-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/config.ts` | Add `WEB_UI_PORT` constant |
| `src/channels/registry.ts` | Add optional `registerGroup` to `ChannelOpts` |
| `src/index.ts` | Pass `registerGroup` in `channelOpts` |
| `src/channels/web.ts` | **New** — Channel implementation: HTTP server, WebSocket handling, message buffering, group auto-registration |
| `src/channels/web-ui.html` | **New** — Self-contained chat page (HTML/CSS/JS) |
| `src/channels/index.ts` | Add `import './web.js'` |

---

### Task 1: Add `WEB_UI_PORT` config

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add the constant**

In `src/config.ts`, after the `IDLE_TIMEOUT` line, add:

```ts
export const WEB_UI_PORT = parseInt(process.env.WEB_UI_PORT || '3005', 10);
```

- [ ] **Step 2: Build to verify no errors**

Run: `npm run build`
Expected: Clean compile

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat(web-ui): add WEB_UI_PORT config constant"
```

---

### Task 2: Extend ChannelOpts with optional registerGroup

**Files:**
- Modify: `src/channels/registry.ts`
- Modify: `src/index.ts`

The web channel needs to auto-register its group. Other channels don't do this (their groups are registered via IPC by the agent). We extend `ChannelOpts` with an optional callback so the web channel can register during `connect()`.

- [ ] **Step 1: Add registerGroup to ChannelOpts**

In `src/channels/registry.ts`, the `RegisteredGroup` import is already present. Add to the `ChannelOpts` interface:

```ts
export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup?: (jid: string, group: RegisteredGroup) => void;
}
```

- [ ] **Step 2: Pass registerGroup in channelOpts in index.ts**

In `src/index.ts`, in the `channelOpts` object (around line 544), add `registerGroup`:

```ts
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // ... existing code unchanged ...
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
    registerGroup,
  };
```

- [ ] **Step 3: Build to verify no errors**

Run: `npm run build`
Expected: Clean compile. Existing channels ignore the new optional field.

- [ ] **Step 4: Commit**

```bash
git add src/channels/registry.ts src/index.ts
git commit -m "feat(web-ui): add optional registerGroup to ChannelOpts"
```

---

### Task 3: Install `ws` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install ws**

Run: `npm install ws`

The `ws` library is the standard WebSocket implementation for Node.js. It handles the HTTP upgrade handshake and provides a clean API for bidirectional communication.

- [ ] **Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(web-ui): add ws dependency for WebSocket support"
```

---

### Task 4: Create the web channel

**Files:**
- Create: `src/channels/web.ts`

This is the core implementation. The channel:
1. Starts an HTTP server that serves the chat page and handles WebSocket upgrades
2. Auto-registers the `web:chat` group during `connect()`
3. Buffers outbound messages when no client is connected, replays on reconnect
4. Implements the full `Channel` interface

- [ ] **Step 1: Create src/channels/web.ts**

```ts
import crypto from 'crypto';
import fs from 'fs';
import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';

import { WEB_UI_PORT } from '../config.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, RegisteredGroup } from '../types.js';

const WEB_JID = 'web:chat';
const WEB_GROUP_FOLDER = 'web-chat';
const MAX_BUFFER_SIZE = 100;

interface OutboundMessage {
  type: 'message' | 'typing';
  text?: string;
  isTyping?: boolean;
}

export class WebChannel implements Channel {
  name = 'web';

  private opts: ChannelOpts;
  private httpServer: Server | null = null;
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private buffer: OutboundMessage[] = [];

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.ensureGroupRegistered();

    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const htmlPath = path.join(__dirname, 'web-ui.html');

    this.httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/' || req.url === '/index.html') {
        fs.readFile(htmlPath, (err, data) => {
          if (err) {
            res.writeHead(500);
            res.end('Failed to load chat page');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(data);
        });
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    this.wss = new WebSocketServer({ server: this.httpServer, path: '/ws' });

    this.wss.on('connection', (ws: WebSocket) => {
      logger.info('Web UI client connected');

      // Replace any existing client (single-session)
      if (this.client && this.client.readyState === WebSocket.OPEN) {
        this.client.close(1000, 'Replaced by new connection');
      }
      this.client = ws;

      // Replay buffered messages
      for (const msg of this.buffer) {
        ws.send(JSON.stringify(msg));
      }
      this.buffer = [];

      ws.on('message', (data: Buffer) => {
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.type === 'message' && parsed.text) {
            this.handleInboundMessage(parsed.text);
          }
        } catch (err) {
          logger.warn({ err }, 'Web UI: failed to parse client message');
        }
      });

      ws.on('close', () => {
        if (this.client === ws) {
          this.client = null;
          logger.info('Web UI client disconnected');
        }
      });

      ws.on('error', (err) => {
        logger.warn({ err }, 'Web UI WebSocket error');
      });
    });

    return new Promise((resolve, reject) => {
      this.httpServer!.listen(WEB_UI_PORT, '127.0.0.1', () => {
        logger.info({ port: WEB_UI_PORT }, 'Web UI started');
        console.log(`\n  Web UI: http://localhost:${WEB_UI_PORT}\n`);
        resolve();
      });
      this.httpServer!.on('error', reject);
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const msg: OutboundMessage = { type: 'message', text };
    if (this.client && this.client.readyState === WebSocket.OPEN) {
      this.client.send(JSON.stringify(msg));
    } else {
      if (this.buffer.length >= MAX_BUFFER_SIZE) {
        this.buffer.shift();
      }
      this.buffer.push(msg);
    }
  }

  isConnected(): boolean {
    return this.httpServer?.listening === true;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('web:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.close(1000, 'Server shutting down');
      this.client = null;
    }
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }
    logger.info('Web UI stopped');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const msg: OutboundMessage = { type: 'typing', isTyping };
    if (this.client && this.client.readyState === WebSocket.OPEN) {
      this.client.send(JSON.stringify(msg));
    }
    // Don't buffer typing indicators — they're ephemeral
  }

  private ensureGroupRegistered(): void {
    const groups = this.opts.registeredGroups();
    if (groups[WEB_JID]) return;

    const group: RegisteredGroup = {
      name: 'Web Chat',
      folder: WEB_GROUP_FOLDER,
      trigger: '',
      added_at: new Date().toISOString(),
      requiresTrigger: false,
      isMain: false,
    };

    if (!this.opts.registerGroup) {
      throw new Error('Web channel requires registerGroup in ChannelOpts');
    }
    this.opts.registerGroup(WEB_JID, group);
    this.opts.onChatMetadata(WEB_JID, new Date().toISOString(), 'Web Chat', 'web', false);
    logger.info('Web UI: auto-registered web:chat group');
  }

  private handleInboundMessage(text: string): void {
    const timestamp = new Date().toISOString();
    this.opts.onChatMetadata(WEB_JID, timestamp, 'Web Chat', 'web', false);
    this.opts.onMessage(WEB_JID, {
      id: crypto.randomUUID(),
      chat_jid: WEB_JID,
      sender: 'web-user',
      sender_name: 'User',
      content: text,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    });
  }
}

registerChannel('web', (opts: ChannelOpts) => {
  return new WebChannel(opts);
});
```

- [ ] **Step 2: Build to verify**

Run: `npm run build`
Expected: Clean compile (the channel isn't imported yet, but the file should compile)

- [ ] **Step 3: Commit**

```bash
git add src/channels/web.ts
git commit -m "feat(web-ui): add web channel implementation"
```

---

### Task 5: Create the chat page

**Files:**
- Create: `src/channels/web-ui.html`

Self-contained HTML/CSS/JS chat interface. Dark theme, auto-reconnect, typing indicator, auto-scroll. Zero external dependencies. Uses safe DOM methods only (no innerHTML with untrusted content).

- [ ] **Step 1: Create src/channels/web-ui.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>NanoClaw</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #1a1a2e;
    color: #e0e0e0;
    height: 100vh;
    display: flex;
    flex-direction: column;
  }

  #header {
    padding: 12px 16px;
    background: #16213e;
    border-bottom: 1px solid #2a2a4a;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  #header h1 { font-size: 16px; font-weight: 600; }

  #status { font-size: 12px; color: #888; }
  #status.connected { color: #4ade80; }
  #status.disconnected { color: #f87171; }

  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .msg {
    max-width: 80%;
    padding: 10px 14px;
    border-radius: 12px;
    white-space: pre-wrap;
    word-wrap: break-word;
    font-size: 14px;
    line-height: 1.5;
  }

  .msg.user {
    align-self: flex-end;
    background: #3b82f6;
    color: #fff;
    border-bottom-right-radius: 4px;
  }

  .msg.assistant {
    align-self: flex-start;
    background: #2a2a4a;
    color: #e0e0e0;
    border-bottom-left-radius: 4px;
  }

  #typing {
    padding: 0 16px 8px;
    font-size: 13px;
    color: #888;
    min-height: 24px;
  }

  .typing-dots::after {
    content: '';
    animation: dots 1.5s steps(4, end) infinite;
  }

  @keyframes dots {
    0% { content: ''; }
    25% { content: '.'; }
    50% { content: '..'; }
    75% { content: '...'; }
  }

  #input-bar {
    padding: 12px 16px;
    background: #16213e;
    border-top: 1px solid #2a2a4a;
    display: flex;
    gap: 8px;
  }

  #input {
    flex: 1;
    padding: 10px 14px;
    background: #1a1a2e;
    border: 1px solid #2a2a4a;
    border-radius: 8px;
    color: #e0e0e0;
    font-size: 14px;
    font-family: inherit;
    resize: none;
    outline: none;
    min-height: 40px;
    max-height: 120px;
  }

  #input:focus { border-color: #3b82f6; }

  #send {
    padding: 10px 20px;
    background: #3b82f6;
    color: #fff;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    cursor: pointer;
    align-self: flex-end;
  }

  #send:hover { background: #2563eb; }
  #send:disabled { background: #555; cursor: not-allowed; }
</style>
</head>
<body>

<div id="header">
  <h1>NanoClaw</h1>
  <span id="status" class="disconnected">disconnected</span>
</div>

<div id="messages"></div>
<div id="typing"></div>

<div id="input-bar">
  <textarea id="input" rows="1" placeholder="Type a message..." autofocus></textarea>
  <button id="send">Send</button>
</div>

<script>
(function() {
  var messagesEl = document.getElementById('messages');
  var typingEl = document.getElementById('typing');
  var inputEl = document.getElementById('input');
  var sendBtn = document.getElementById('send');
  var statusEl = document.getElementById('status');

  var ws = null;
  var reconnectDelay = 1000;
  var MAX_RECONNECT_DELAY = 30000;

  function connect() {
    var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(protocol + '//' + location.host + '/ws');

    ws.onopen = function() {
      statusEl.textContent = 'connected';
      statusEl.className = 'connected';
      reconnectDelay = 1000;
      sendBtn.disabled = false;
    };

    ws.onclose = function() {
      statusEl.textContent = 'disconnected';
      statusEl.className = 'disconnected';
      sendBtn.disabled = true;
      ws = null;
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    };

    ws.onerror = function() {};

    ws.onmessage = function(event) {
      var msg = JSON.parse(event.data);
      if (msg.type === 'message') {
        appendMessage('assistant', msg.text);
        setTypingIndicator(false);
      } else if (msg.type === 'typing') {
        setTypingIndicator(msg.isTyping);
      }
    };
  }

  function appendMessage(role, text) {
    var div = document.createElement('div');
    div.className = 'msg ' + role;
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function setTypingIndicator(isTyping) {
    while (typingEl.firstChild) {
      typingEl.removeChild(typingEl.firstChild);
    }
    if (isTyping) {
      var span = document.createElement('span');
      span.className = 'typing-dots';
      span.textContent = 'Thinking';
      typingEl.appendChild(span);
    }
  }

  function sendMessage() {
    var text = inputEl.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

    appendMessage('user', text);
    ws.send(JSON.stringify({ type: 'message', text: text }));
    inputEl.value = '';
    inputEl.style.height = 'auto';
  }

  sendBtn.addEventListener('click', sendMessage);

  inputEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  inputEl.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  });

  connect();
})();
</script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add src/channels/web-ui.html
git commit -m "feat(web-ui): add self-contained chat page"
```

---

### Task 6: Wire the channel into NanoClaw

**Files:**
- Modify: `src/channels/index.ts`
- Modify: `package.json`

The HTML file needs to be copied into `dist/channels/` during build so the compiled `web.js` can find it via `path.join(__dirname, 'web-ui.html')`. In dev mode (`tsx`), `__dirname` resolves to `src/channels/` so it works without the copy step.

- [ ] **Step 1: Add the import**

In `src/channels/index.ts`, add after the telegram import:

```ts
// web
import './web.js';
```

- [ ] **Step 2: Add HTML copy to the build script**

In `package.json`, update the build script:

```json
"build": "tsc && cp src/channels/web-ui.html dist/channels/web-ui.html",
```

- [ ] **Step 3: Build and verify**

Run: `npm run build`
Expected: Clean compile, and `dist/channels/web-ui.html` exists

- [ ] **Step 4: Commit**

```bash
git add src/channels/index.ts package.json
git commit -m "feat(web-ui): register web channel and copy HTML to build output"
```

---

### Task 7: End-to-end manual test

- [ ] **Step 1: Start NanoClaw**

Run: `npm run dev`

Expected in console output:
```
Web UI: http://localhost:3005
```

- [ ] **Step 2: Open browser**

Navigate to `http://localhost:3005`. Expected:
- Dark-themed chat interface loads
- Status shows "connected" in green
- Input field is focused

- [ ] **Step 3: Send a message**

Type "Hello" and press Enter. Expected:
- User message appears on the right (blue bubble)
- Typing indicator appears ("Thinking...")
- Agent response appears on the left (dark bubble) after processing
- Typing indicator disappears

- [ ] **Step 4: Test reconnect**

Refresh the browser page. Expected:
- Status briefly shows "disconnected" then "connected"
- Chat history is cleared (expected — no persistence)
- Can send new messages

- [ ] **Step 5: Verify group was created**

Check that `groups/web-chat/` directory exists with a `logs/` subdirectory.

- [ ] **Step 6: Commit any fixes if needed**

If any issues were found and fixed during testing, commit them.
