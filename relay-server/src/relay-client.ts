import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { encodeServerFrame, decodeServerFrame } from './relay-frame.js';

const MSG_HANDSHAKE = 0x01;
const MSG_HANDSHAKE_ACK = 0x02;
const MSG_DATA = 0x03;
const MSG_PING = 0x05;
const MSG_PONG = 0x06;
const MSG_CLIENT_OFFLINE = 0x08;
const MSG_CLIENT_CONNECT = 0x0a;
const MSG_PAIRING_CONSUMED = 0x0b;

export class RelayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private relayURL: string;
  private deviceId: string;
  private shouldReconnect = false;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPongTime: number = Date.now();

  // Cloudflare relay usage counters (cumulative for the process lifetime).
  // wsConnects   — every WebSocket (re)connection attempt to the relay Worker
  // wsMessagesSent — every frame we push up that socket (pings + terminal data)
  private _wsConnects = 0;
  private _wsMessagesSent = 0;

  constructor(relayURL: string, deviceId: string) {
    super();
    this.relayURL = relayURL;
    this.deviceId = deviceId;
  }

  /** True while the relay WebSocket is open. */
  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Cumulative relay-side Cloudflare usage since the process started. */
  get cloudflareStats(): { wsConnects: number; wsMessagesSent: number } {
    return { wsConnects: this._wsConnects, wsMessagesSent: this._wsMessagesSent };
  }

  connect(): void {
    this.shouldReconnect = true;
    this.doConnect();
  }

  private doConnect(): void {
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }

    this._wsConnects++;
    const url = `${this.relayURL}/api/connect/server?device_id=${encodeURIComponent(this.deviceId)}&protocol=2`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';

    ws.on('open', () => {
      if (this.ws !== ws) return; // stale socket
      this.reconnectDelay = 1000;
      this.lastPongTime = Date.now();
      this.emit('connected');
      this.startHeartbeat();
    });

    ws.on('message', (data: ArrayBuffer) => {
      if (this.ws !== ws) return; // stale socket
      const bytes = Buffer.from(new Uint8Array(data));
      if (bytes.length === 0) return;
      const { type, connId, payload } = decodeServerFrame(bytes);

      switch (type) {
        case MSG_DATA:
        case MSG_HANDSHAKE:
          this.emit('message', type, connId, payload);
          break;
        case MSG_CLIENT_CONNECT:
          this.emit('client_connect', connId, payload);
          break;
        case MSG_CLIENT_OFFLINE:
          this.emit('client_offline', connId);
          break;
        case MSG_PAIRING_CONSUMED:
          this.emit('pairing_consumed');
          break;
        case MSG_PONG:
          this.lastPongTime = Date.now();
          break;
      }
    });

    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return; // stale socket — ignore
      this.ws = null;
      this.stopHeartbeat();
      console.log(`[relay] Connection closed (code: ${code}, reason: ${reason.toString() || 'none'})`);
      this.emit('disconnected');
      this.scheduleReconnect();
    });

    ws.on('error', (err: any) => {
      if (this.ws !== ws) return;
      const code = err.code || '';
      if (code === 'ECONNREFUSED') {
        console.error(`\x1b[31mRelay connection refused at ${this.relayURL}\x1b[0m`);
      } else if (code === 'ENOTFOUND') {
        console.error(`\x1b[31mCannot resolve relay host — check DNS/internet\x1b[0m`);
      } else if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
        console.error(`\x1b[31mRelay connection timed out — network may be blocking WebSocket\x1b[0m`);
      } else if (err.message?.includes('Unexpected server response: 429')) {
        console.error(`\x1b[31mRelay rate limited (429) — too many connections, retry later\x1b[0m`);
      } else {
        console.error(`[relay] WebSocket error: ${err.message}`);
      }
      this.emit('error', err);
    });
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    const delay = this.reconnectDelay;
    // Exponential backoff, capped at 2h so a rate-limited/offline relay
    // is retried rarely instead of hammered.
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 7_200_000);
    console.log(`Reconnecting to relay in ${delay >= 1000 ? `${delay / 1000}s` : `${delay}ms`}...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) {
        this.doConnect();
      }
    }, delay);
  }

  send(type: number, connId: number, payload: Buffer): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this._wsMessagesSent++;
    this.ws.send(encodeServerFrame(type, connId, payload));
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        if (Date.now() - this.lastPongTime > 90_000) {
          console.error(`[relay] No pong received for 90s, assuming connection dead. Reconnecting...`);
          this.ws.terminate();
          return;
        }
        this._wsMessagesSent++;
        this.ws.send(encodeServerFrame(MSG_PING, 0, Buffer.alloc(0)));
      }
    }, 60_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
