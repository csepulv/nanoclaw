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

    this.httpServer = createServer(
      (req: IncomingMessage, res: ServerResponse) => {
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
      },
    );

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
    this.opts.onChatMetadata(
      WEB_JID,
      new Date().toISOString(),
      'Web Chat',
      'web',
      false,
    );
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
