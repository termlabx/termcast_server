import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { RelayClient } from './relay-client.js';
import * as crypto from './crypto.js';
import { PortForwardHandler } from './port-forward.js';
import type { Multiplexer } from './multiplexer.js';

const MSG_HANDSHAKE = 0x01;
const MSG_HANDSHAKE_ACK = 0x02;
const MSG_DATA = 0x03;
/** ttyd server→client command byte for terminal OUTPUT (rest: 0x31 title,
 *  0x32 prefs, 0x40-0x43 port-forward, 0x51 self-eject). Only OUTPUT runs may
 *  be merged; every other frame must keep its own boundary. */
const TTYD_OUTPUT = 0x30;

/**
 * Merge runs of consecutive ttyd OUTPUT frames into a single OUTPUT frame so a
 * chatty terminal costs one encrypt + one relay send (and one downstream
 * wakeup) instead of one per tiny chunk. The terminal is a byte stream, so the
 * client sees an identical result. Non-output frames flush the current run and
 * pass through untouched to preserve ordering. `maxBytes` caps a merged frame
 * so we never exceed the relay's WebSocket message limit on a big dump.
 */
export function coalesceOutputFrames(frames: Buffer[], maxBytes = 128 * 1024): Buffer[] {
  const out: Buffer[] = [];
  let run: Buffer[] = [];
  let runLen = 0;
  const flush = () => {
    if (run.length > 0) {
      out.push(Buffer.concat([Buffer.from([TTYD_OUTPUT]), ...run]));
      run = [];
      runLen = 0;
    }
  };
  for (const f of frames) {
    if (f.length > 0 && f[0] === TTYD_OUTPUT) {
      const body = f.subarray(1);
      if (runLen > 0 && runLen + body.length > maxBytes) flush();
      run.push(body);
      runLen += body.length;
    } else {
      flush();
      out.push(f);
    }
  }
  flush();
  return out;
}
const INNER_MESH_INVITE = 0x09;
const MESH_EVICT = 0x50;
const MESH_RETRY = 0x52;
const SELF_EJECT_NOTICE = 0x51;

/**
 * Local ttyd WS URL for a session. Phones carry two url-args: their per-phone
 * session id ($1) and the active multiplexer ($2). Non-phone connections carry
 * neither, so the wrapper script falls back to the sidecar file.
 */
export function localWsUrlFor(base: string, phoneId: string | null, mux: Multiplexer | null): string {
  if (!phoneId) return base;
  const args = [`arg=${encodeURIComponent(phoneId)}`];
  if (mux) args.push(`arg=${encodeURIComponent(mux)}`);
  return `${base}?${args.join('&')}`;
}

interface ClientSession {
  connId: number;
  key: Buffer | null;
  localWs: WebSocket | null;
  portForward: PortForwardHandler | null;
  pendingLocalFrames: Buffer[];
  isPhone: boolean; // true once handshook without peer_device_id
  phoneId: string | null; // stable per-install phone UUID, or null for non-phones
  peerDeviceId: string | null; // deviceId a meshing-in server identified as, or null
  outFrames: Buffer[]; // ttyd→relay frames buffered for the next coalesced flush
  flushScheduled: boolean; // a setImmediate flush is already armed for outFrames
}

export class Bridge extends EventEmitter {
  private relay: RelayClient;
  private localWsURL: string;
  private serverKeyPair: { publicKey: Buffer; privateKey: Buffer };
  private running = false;
  private sessions = new Map<number, ClientSession>();
  private meshMembershipCheck: ((peerDeviceId: string) => boolean) | null = null;
  private meshActiveCheck: (() => boolean) | null = null;
  // Read per connection, so a multiplexer switch applies to the next phone that
  // connects without respawning ttyd or dropping anyone already attached.
  private multiplexerProvider: (() => Multiplexer) | null = null;

  private clientConnectHandler: ((connId: number, payload: Buffer) => void) | null = null;
  private messageHandler: ((type: number, connId: number, payload: Buffer) => void) | null = null;
  private clientOfflineHandler: ((connId: number) => void) | null = null;
  private relayDisconnectHandler: (() => void) | null = null;

  constructor(localWsURL: string, relay: RelayClient, keyPair: { publicKey: Buffer; privateKey: Buffer }) {
    super();
    this.localWsURL = localWsURL;
    this.relay = relay;
    this.serverKeyPair = keyPair;
  }

  get publicKey(): Buffer {
    return this.serverKeyPair.publicKey;
  }

  /** Registers the source of the machine's active multiplexer. */
  setMultiplexerProvider(fn: () => Multiplexer): void {
    this.multiplexerProvider = fn;
  }

  /** Registers the predicate that tells whether a peer is currently in our set. */
  setMeshMembershipCheck(fn: (peerDeviceId: string) => boolean): void {
    this.meshMembershipCheck = fn;
  }

  /**
   * Registers the predicate that tells whether THIS server is participating in
   * the mesh (i.e. not left/expired). It distinguishes a permanent eviction
   * ("we left the cluster") from a transient "we don't know you yet" retry.
   * Defaults to always-active when unset.
   */
  setMeshActiveCheck(fn: () => boolean): void {
    this.meshActiveCheck = fn;
  }

  /** Best-effort: tell every connected phone that this machine left the cluster. */
  notifyPhonesSelfEject(deviceId: string): void {
    const inner = Buffer.concat([
      Buffer.from([SELF_EJECT_NOTICE]),
      Buffer.from(JSON.stringify({ deviceId })),
    ]);
    for (const session of this.sessions.values()) {
      if (!session.isPhone || !session.key) continue;
      try {
        this.relay.send(MSG_DATA, session.connId, crypto.encrypt(inner, session.key));
      } catch (err) {
        console.error('[bridge] self-eject notice send failed:', (err as Error).message);
      }
    }
  }

  start(): void {
    this.running = true;

    this.clientConnectHandler = (connId, payload) => this.createSession(connId, payload);
    this.messageHandler = (type, connId, payload) => {
      const session = this.sessions.get(connId);
      if (!session) { console.log(`[bridge] message for unknown connId ${connId} — dropping`); return; }
      if (type === MSG_HANDSHAKE) this.handleHandshake(session, payload);
      else if (type === MSG_DATA) this.handleData(session, payload);
    };
    this.clientOfflineHandler = (connId) => this.teardownSession(connId);
    // The relay backend force-closes every phone socket whenever this server
    // reconnects (relay-room handleServerConnect), so a dropped uplink means all
    // client sessions are already dead. Reap them now instead of waiting for
    // per-connId CLIENT_OFFLINE frames, which race with (and are lost across)
    // the reconnect — leaving orphaned ttyd sockets that each keep a tmux
    // attach-client alive and waking the CPU.
    this.relayDisconnectHandler = () => this.teardownAllSessions();

    this.relay.on('client_connect', this.clientConnectHandler);
    this.relay.on('message', this.messageHandler);
    this.relay.on('client_offline', this.clientOfflineHandler);
    this.relay.on('disconnected', this.relayDisconnectHandler);
  }

  private teardownAllSessions(): void {
    for (const connId of [...this.sessions.keys()]) this.teardownSession(connId);
  }

  private createSession(connId: number, _metaPayload: Buffer): void {
    this.teardownSession(connId); // clear any stale session reusing this id
    this.sessions.set(connId, { connId, key: null, localWs: null, portForward: null, pendingLocalFrames: [], isPhone: false, phoneId: null, peerDeviceId: null, outFrames: [], flushScheduled: false });
    this.emit('client_connected', connId);
  }

  private handleData(session: ClientSession, payload: Buffer): void {
    const key = session.key;
    if (!key) { console.log(`[bridge] DATA for connId ${session.connId} before key — dropping`); return; }
    try {
      const decrypted = crypto.decrypt(payload, key);
      const firstByte = decrypted[0];
      if (firstByte === INNER_MESH_INVITE) {
        try {
          this.emit('mesh_invite', JSON.parse(decrypted.subarray(1).toString()));
        } catch (err) {
          console.error('[bridge] MESH_INVITE parse error:', (err as Error).message);
        }
      } else if (firstByte !== undefined && firstByte >= 0x40 && firstByte <= 0x43) {
        if (session.portForward && decrypted.length >= 5) {
          session.portForward.handleMessage(firstByte, decrypted.readUInt32BE(1), decrypted.subarray(5));
        }
      } else {
        this.forwardToTtyd(session, decrypted);
      }
    } catch (err) {
      console.error(`[bridge] Decryption failed for connId ${session.connId}:`, (err as Error).message);
    }
  }

  private forwardToTtyd(session: ClientSession, frame: Buffer): void {
    if (session.localWs?.readyState === WebSocket.OPEN) {
      session.localWs.send(frame);
    } else if (session.localWs?.readyState === WebSocket.CONNECTING) {
      session.pendingLocalFrames.push(frame);
    } else {
      console.error(`[bridge] connId ${session.connId}: localWs not OPEN — dropping terminal frame`);
    }
  }

  private handleHandshake(session: ClientSession, payload: Buffer): void {
    try {
      const { client_public_key, peer_device_id, phone_id, paired_at } = JSON.parse(payload.toString());
      const clientPubKey = Buffer.from(client_public_key, 'base64');
      const sharedSecret = crypto.computeSharedSecret(this.serverKeyPair.privateKey, clientPubKey);
      session.key = crypto.deriveKey(sharedSecret);
      console.log(`[bridge] connId ${session.connId}: symmetric key derived OK`);

      // Membership gate: a meshing-in server identifies itself via peer_device_id.
      // Phone clients omit peer_device_id and are never subject to this check.
      // Two distinct rejections (never send an ACK for either):
      //   - We have LEFT/EXPIRED the cluster  → permanent MESH_EVICT.
      //   - We are active but don't know this peer YET (its mesh invite may still
      //     be in flight during simultaneous bidirectional setup) → MESH_RETRY,
      //     so the peer reconnects instead of permanently dropping us. This is
      //     what breaks the mutual-eviction deadlock when two servers mesh into
      //     each other at the same time.
      if (typeof peer_device_id === 'string') {
        const active = this.meshActiveCheck ? this.meshActiveCheck() : true;
        if (!active) {
          console.log(`[bridge] connId ${session.connId}: mesh inactive — evicting peer ${peer_device_id}`);
          this.sendMeshEvict(session);
          this.teardownSession(session.connId);
          return;
        }
        if (this.meshMembershipCheck && !this.meshMembershipCheck(peer_device_id)) {
          console.log(`[bridge] connId ${session.connId}: peer ${peer_device_id} not known yet — asking retry`);
          this.sendMeshRetry(session);
          this.teardownSession(session.connId);
          return;
        }
      }

      // Phone clients omit peer_device_id; remember so we can notify them on self-eject.
      session.isPhone = typeof peer_device_id !== 'string';
      session.peerDeviceId = typeof peer_device_id === 'string' ? peer_device_id : null;

      // Phone clients carry a stable phone_id; record it and announce the
      // pairing so index.ts can upsert this phone's cluster (and name its tmux
      // session). paired_at is the phone's local lease anchor (resets on re-scan).
      if (typeof phone_id === 'string' && phone_id.length > 0) {
        session.phoneId = phone_id;
        const pairedAt = typeof paired_at === 'number' ? paired_at : Date.now();
        this.emit('cluster_paired', { phoneId: phone_id, pairedAt });
      }

      session.portForward?.destroyAll();
      session.portForward = new PortForwardHandler((data: Buffer) => {
        const k = session.key;
        if (k) {
          try { this.relay.send(MSG_DATA, session.connId, crypto.encrypt(data, k)); }
          catch (err) { console.error('[bridge] Port-forward encryption failed:', (err as Error).message); }
        }
      });

      this.relay.send(MSG_HANDSHAKE_ACK, session.connId, Buffer.from(JSON.stringify({ status: 'ok' })));
      this.connectLocal(session);
      this.emit('handshake_complete', session.connId, session.peerDeviceId);
    } catch (err) {
      console.error('[bridge] Handshake failed:', (err as Error).message);
    }
  }

  private sendMeshEvict(session: ClientSession): void {
    this.sendMeshControl(session, MESH_EVICT, 'evict');
  }

  private sendMeshRetry(session: ClientSession): void {
    this.sendMeshControl(session, MESH_RETRY, 'retry');
  }

  private sendMeshControl(session: ClientSession, subCmd: number, label: string): void {
    const key = session.key;
    if (!key) return;
    const inner = Buffer.alloc(5); // [subCmd, flowId=0]; no payload
    inner[0] = subCmd;
    try {
      this.relay.send(MSG_DATA, session.connId, crypto.encrypt(inner, key));
    } catch (err) {
      console.error(`[bridge] mesh ${label} send failed:`, (err as Error).message);
    }
  }

  private connectLocal(session: ClientSession): void {
    if (!this.running) return;
    if (session.localWs) { try { session.localWs.close(); } catch {} session.localWs = null; }

    const mux = this.multiplexerProvider ? this.multiplexerProvider() : null;
    const ws = new WebSocket(localWsUrlFor(this.localWsURL, session.phoneId, mux), ['tty']);
    session.localWs = ws;

    ws.on('open', () => {
      if (session.localWs !== ws) return;
      ws.send(JSON.stringify({ AuthToken: '', columns: 80, rows: 24 }));
      for (const frame of session.pendingLocalFrames) ws.send(frame);
      session.pendingLocalFrames = [];
    });

    ws.on('message', (data: Buffer) => {
      if (session.localWs !== ws) return;
      if (!session.key) return;
      // Buffer this chunk and flush after the current I/O poll phase, so a burst
      // of tiny ttyd frames read in one tick collapses into a single encrypted
      // relay send. setImmediate keeps latency at zero (same event-loop turn).
      session.outFrames.push(data);
      if (!session.flushScheduled) {
        session.flushScheduled = true;
        setImmediate(() => this.flushOutput(session));
      }
    });

    ws.on('close', () => {
      if (session.localWs !== ws) return;
      session.localWs = null;
      // Only reconnect ttyd while the session is still alive (client present).
      if (this.sessions.has(session.connId)) {
        setTimeout(() => {
          if (this.running && this.sessions.has(session.connId) && !session.localWs) this.connectLocal(session);
        }, 2000);
      }
    });

    ws.on('error', (err: any) => {
      if (session.localWs !== ws) return;
      if (err.code === 'ECONNREFUSED') {
        console.error(`\x1b[31mCannot connect to local termcastd at ${this.localWsURL}\x1b[0m`);
      } else {
        console.error(`[bridge] connId ${session.connId} termcastd error: ${err.message}`);
      }
    });
  }

  /** Encrypt and send the buffered ttyd output, merging consecutive OUTPUT
   *  frames so a chatty terminal is one send instead of many. */
  private flushOutput(session: ClientSession): void {
    session.flushScheduled = false;
    const frames = session.outFrames;
    if (frames.length === 0) return;
    session.outFrames = [];
    const key = session.key;
    if (!key) return; // session torn down between schedule and flush
    for (const frame of coalesceOutputFrames(frames)) {
      try { this.relay.send(MSG_DATA, session.connId, crypto.encrypt(frame, key)); }
      catch (err) { console.error('[bridge] Encryption failed:', (err as Error).message); }
    }
  }

  private teardownSession(connId: number): void {
    const session = this.sessions.get(connId);
    if (!session) return;
    this.sessions.delete(connId);
    if (session.localWs) { try { session.localWs.close(); } catch {} }
    session.portForward?.destroyAll();
    session.key = null;
    session.pendingLocalFrames = [];
    session.outFrames = [];
    this.emit('client_disconnected', connId);
  }

  stop(): void {
    this.running = false;
    if (this.clientConnectHandler) { this.relay.off('client_connect', this.clientConnectHandler); this.clientConnectHandler = null; }
    if (this.messageHandler) { this.relay.off('message', this.messageHandler); this.messageHandler = null; }
    if (this.clientOfflineHandler) { this.relay.off('client_offline', this.clientOfflineHandler); this.clientOfflineHandler = null; }
    if (this.relayDisconnectHandler) { this.relay.off('disconnected', this.relayDisconnectHandler); this.relayDisconnectHandler = null; }
    this.teardownAllSessions();
  }
}
