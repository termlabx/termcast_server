import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { RelayClient } from './relay-client.js';
import * as crypto from './crypto.js';
import { PortForwardHandler } from './port-forward.js';
import { type Multiplexer, MULTIPLEXERS } from './multiplexer.js';
import type { TerminalTarget } from './terminal-targets.js';
import {
  AGENT_LIST, AGENT_ATTACH, AGENT_DETACH, AGENT_HISTORY,
  AGENT_SEND, AGENT_INTERRUPT, AGENT_PERMISSION, AGENT_QUESTION,
  AGENT_EVENT, AGENT_SESSIONS,
  decodeAgentFrame, encodeAgentFrame, isAgentOpcode,
} from './agent/frames.js';

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
const SET_MULTIPLEXER = 0x53;   // phone → server: change the machine setting
const MULTIPLEXER_STATE = 0x54; // server → phone: active + what is installed
const TERMINAL_LIST = 0x55;         // phone → server: ask for the terminal picker
const TERMINAL_LIST_RESULT = 0x56;  // server → phone: the terminal targets
const TERMINAL_ATTACH = 0x57;       // phone → server: attach terminal to a target

const AGENT_KINDS = ['claude', 'opencode'] as const;

/**
 * Local ttyd WS URL for a session. Phones carry three url-args: their per-phone
 * session id, the active multiplexer, and an attach flag. In the default case
 * ($1 = phone id, $2 = multiplexer) the wrapper prefixes the id into this app's
 * private `tc_`/`tch_` namespace. In attach mode an exact session name is
 * passed in so the phone can join a session the machine already has.
 */
export function localWsUrlFor(
  base: string,
  phoneId: string | null,
  mux: Multiplexer | null,
  attach: { name: string; mux: 'tmux' | 'herdr' } | null = null,
): string {
  if (!phoneId) return base;
  if (attach) {
    const args = [
      `arg=${encodeURIComponent(attach.name)}`,
      `arg=${encodeURIComponent(attach.mux)}`,
      'arg=1',
    ];
    return `${base}?${args.join('&')}`;
  }
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
  attachTarget: TerminalTarget | null; // multiplexer session this terminal attaches to, or null
}

/** One parseable [agent] log line; the desktop tray parses these (see
 *  relay-desktop/src/server-agent-log-parser.ts). Values with whitespace or
 *  quotes are JSON-quoted so a parser can split on `key=value` tokens. */
function agentLog(dir: '->' | '<-', fields: Record<string, unknown>): void {
  const parts = Object.entries(fields).map(([k, v]) => {
    if (v === null) return `${k}=null`;
    // Arrays interpolate to `a,b` — a value with a space in it would then split
    // across two key=value tokens, so serialize them as JSON.
    if (Array.isArray(v)) return `${k}=${JSON.stringify(v)}`;
    if (typeof v === 'string' && /[\s"]/.test(v)) return `${k}=${JSON.stringify(v)}`;
    return `${k}=${v}`;
  });
  console.log(`[agent] ${dir} ${parts.join(' ')}`);
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
  // Supplies the machine's current terminal picker when a phone asks (0x55).
  private terminalTargetsProvider: (() => Promise<TerminalTarget[]> | TerminalTarget[]) | null = null;

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

  /** Registers the source of the machine's terminal picker (tmux/herdr/bash). */
  setTerminalTargetsProvider(fn: () => Promise<TerminalTarget[]> | TerminalTarget[]): void {
    this.terminalTargetsProvider = fn;
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

  private multiplexerStateProvider:
    (() => { active: Multiplexer; installed: { tmux: boolean; herdr: boolean } }) | null = null;

  /** Supplies the MULTIPLEXER_STATE sent to each phone right after handshake. */
  setMultiplexerStateProvider(
    fn: () => { active: Multiplexer; installed: { tmux: boolean; herdr: boolean } },
  ): void {
    this.multiplexerStateProvider = fn;
  }

  /**
   * Push the machine's multiplexer state to every connected phone, so a change
   * made from any surface re-renders their key bars without a reconnect.
   */
  broadcastMultiplexerState(active: Multiplexer, installed: { tmux: boolean; herdr: boolean }): void {
    const inner = Buffer.concat([
      Buffer.from([MULTIPLEXER_STATE]),
      Buffer.from(JSON.stringify({ active, installed })),
    ]);
    for (const session of this.sessions.values()) {
      if (!session.isPhone || !session.key) continue;
      try {
        this.relay.send(MSG_DATA, session.connId, crypto.encrypt(inner, session.key));
      } catch (err) {
        console.error('[bridge] multiplexer state send failed:', (err as Error).message);
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
    // Release every agent subscription in one go: leaking a tail poller per
    // reconnect is the same class of leak that drained battery through ttyd.
    this.emit('agent_detach_all');
  }

  private createSession(connId: number, _metaPayload: Buffer): void {
    this.teardownSession(connId); // clear any stale session reusing this id
    this.sessions.set(connId, { connId, key: null, localWs: null, portForward: null, pendingLocalFrames: [], isPhone: false, phoneId: null, peerDeviceId: null, outFrames: [], flushScheduled: false, attachTarget: null });
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
      } else if (firstByte === SET_MULTIPLEXER) {
        try {
          const { multiplexer } = JSON.parse(decrypted.subarray(1).toString()) as { multiplexer?: unknown };
          // Strict membership, not parseMultiplexer's lenient default: a typo
          // must be ignored, never silently applied as tmux.
          if (MULTIPLEXERS.includes(multiplexer as Multiplexer)) {
            this.emit('multiplexer_set', multiplexer as Multiplexer);
          }
        } catch {
          // A malformed frame is dropped; the setting is left alone.
        }
      } else if (firstByte === TERMINAL_LIST) {
        this.handleTerminalList(session);
      } else if (firstByte === TERMINAL_ATTACH) {
        this.handleTerminalAttach(session, decrypted.subarray(1));
      } else if (firstByte !== undefined && isAgentOpcode(firstByte)) {
        this.handleAgentFrame(session.connId, decrypted);
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

  /**
   * Reply to a phone's terminal-picker request. The list is resolved fresh so a
   * session created moments ago is visible; a failure contributes the plain
   * shell, which is always safe.
   */
  private async handleTerminalList(session: ClientSession): Promise<void> {
    const targets = this.terminalTargetsProvider ? await this.terminalTargetsProvider() : [];
    this.sendTerminalTargets(session.connId, targets);
  }

  /**
   * Re-attach this phone's terminal to an existing multiplexer session (or the
   * plain shell). The target comes from the picker the phone was just shown, so
   * the only validation needed is that the shape is sane.
   */
  private handleTerminalAttach(session: ClientSession, body: Buffer): void {
    let target: unknown;
    try {
      target = JSON.parse(body.toString());
    } catch {
      return; // malformed frame — nothing to attach to
    }
    const { kind, name } = (target ?? {}) as { kind?: unknown; name?: unknown };
    if (kind === 'bash') {
      session.attachTarget = { kind: 'bash', id: 'bash', name: 'Plain shell' };
    } else if ((kind === 'tmux' || kind === 'herdr') && typeof name === 'string' && name.trim()) {
      session.attachTarget = { kind, id: `${kind}:${name}`, name: name.trim() };
    } else {
      return; // unrecognised target shape
    }
    agentLog('->', { conn: session.connId, type: 'attach-terminal', kind, name: session.attachTarget.name });
    console.log(`[attach] conn=${session.connId} target=${session.attachTarget.id} mux=${session.attachTarget.kind}`);
    this.connectLocal(session);
  }

  /** Encrypt and push the terminal picker to one phone. */
  sendTerminalTargets(connId: number, targets: TerminalTarget[]): void {
    const session = this.sessions.get(connId);
    const key = session?.key;
    if (!key) return;
    const inner = Buffer.concat([
      Buffer.from([TERMINAL_LIST_RESULT]),
      Buffer.from(JSON.stringify({ targets })),
    ]);
    try {
      this.relay.send(MSG_DATA, connId, crypto.encrypt(inner, key));
    } catch (err) {
      console.error('[bridge] terminal list send failed:', (err as Error).message);
    }
  }

  /**
   * Agent control frames. Every malformed or unrecognised payload is dropped
   * silently: the phone re-requests, and a bad frame must never take down the
   * data path shared with the terminal.
   */
  private handleAgentFrame(connId: number, decrypted: Buffer): void {
    const frame = decodeAgentFrame(decrypted);
    if (!frame) return;
    const payload = (frame.payload ?? {}) as Record<string, unknown>;

    switch (frame.opcode) {
      case AGENT_LIST:
        agentLog('->', { conn: connId, type: 'list' });
        this.emit('agent_list', { connId });
        return;

      case AGENT_ATTACH: {
        const target = this.readTarget(payload);
        if (!target) return;
        const sinceSeq = typeof payload.sinceSeq === 'number' ? payload.sinceSeq : -1;
        agentLog('->', { conn: connId, agent: target.agent, session: target.sessionId, type: 'attach', sinceSeq });
        this.emit('agent_attach', { connId, ...target, sinceSeq });
        return;
      }

      case AGENT_DETACH:
        agentLog('->', { conn: connId, type: 'detach' });
        this.emit('agent_detach', { connId });
        return;

      case AGENT_HISTORY: {
        const target = this.readTarget(payload);
        if (!target) return;
        const beforeSeq = typeof payload.beforeSeq === 'number' ? payload.beforeSeq : null;
        const limit = typeof payload.limit === 'number' ? payload.limit : 50;
        agentLog('->', { conn: connId, agent: target.agent, session: target.sessionId, type: 'history', beforeSeq, limit });
        this.emit('agent_history', { connId, ...target, beforeSeq, limit });
        return;
      }

      case AGENT_SEND: {
        const target = this.readTarget(payload);
        if (!target || typeof payload.text !== 'string') return;
        agentLog('->', { conn: connId, agent: target.agent, session: target.sessionId, type: 'send', text: payload.text });
        this.emit('agent_send', { connId, ...target, text: payload.text });
        return;
      }

      case AGENT_INTERRUPT: {
        const target = this.readTarget(payload);
        if (!target) return;
        agentLog('->', { conn: connId, agent: target.agent, session: target.sessionId, type: 'interrupt' });
        this.emit('agent_interrupt', { connId, ...target });
        return;
      }

      case AGENT_PERMISSION: {
        const { requestId, behavior } = payload;
        if (typeof requestId !== 'string') return;
        if (behavior !== 'allow' && behavior !== 'deny') return;
        agentLog('->', { conn: connId, type: 'permission', requestId, behavior });
        this.emit('agent_permission', { connId, requestId, behavior });
        return;
      }

      case AGENT_QUESTION: {
        const { requestId, answers, rejected } = payload;
        if (typeof requestId !== 'string') return;
        if (rejected === true) {
          agentLog('->', { conn: connId, type: 'question', requestId, rejected: true });
          this.emit('agent_question', { connId, requestId, rejected: true });
        } else if (Array.isArray(answers)) {
          const clean = answers.filter((a) => typeof a === 'string');
          agentLog('->', { conn: connId, type: 'question', requestId, answers: clean });
          this.emit('agent_question', { connId, requestId, answers: clean });
        }
        return;
      }

      default:
        return;
    }
  }

  /** Validates the (agent, sessionId) pair every session-scoped frame carries. */
  private readTarget(payload: Record<string, unknown>): { agent: string; sessionId: string } | null {
    const { agent, sessionId } = payload;
    if (typeof sessionId !== 'string' || !sessionId) return null;
    if (!AGENT_KINDS.includes(agent as (typeof AGENT_KINDS)[number])) return null;
    return { agent: agent as string, sessionId };
  }

  /** Encrypt and push an agent frame to one phone. */
  sendAgentFrame(connId: number, opcode: number, payload: unknown): void {
    const session = this.sessions.get(connId);
    const key = session?.key;
    if (!key) return;
    try {
      this.relay.send(MSG_DATA, connId, crypto.encrypt(encodeAgentFrame(opcode, payload), key));
    } catch (err) {
      console.error('[bridge] agent frame send failed:', (err as Error).message);
    }
    if (opcode === AGENT_EVENT || opcode === AGENT_SESSIONS) {
      const ev = payload as Record<string, unknown>;
      const kind = ev.kind ?? (opcode === AGENT_SESSIONS ? 'sessions' : 'event');
      const fields: Record<string, unknown> = { conn: connId };
      if (typeof ev.sessionId === 'string') fields.session = ev.sessionId;
      fields.type = kind;
      if (ev.kind === 'status') {
        fields.value = ev.status;
        if (typeof ev.detail === 'string') fields.detail = ev.detail;
      } else if (ev.kind === 'message') {
        fields.seq = ev.seq;
      } else if (ev.kind === 'delta') {
        fields.messageId = ev.messageId;
        if (typeof ev.text === 'string') fields.text = ev.text;
      } else if (ev.kind === 'history') {
        fields.count = Array.isArray(ev.messages) ? ev.messages.length : 0;
      } else if (ev.kind === 'permission' && ev.request) {
        fields.requestId = (ev.request as Record<string, unknown>).requestId;
      } else if (ev.kind === 'question' && ev.request) {
        const r = ev.request as Record<string, unknown>;
        fields.requestId = r.requestId;
        if (typeof r.prompt === 'string') fields.prompt = r.prompt;
      } else if (opcode === AGENT_SESSIONS) {
        fields.count = Array.isArray(ev.sessions) ? ev.sessions.length : 0;
      }
      agentLog('<-', fields);
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
      // Tell a freshly connected phone which multiplexer this machine runs, so
      // its key bar renders correctly from the first frame rather than after a
      // change. Phones only — mesh peers have no key bar.
      if (session.isPhone && session.key && this.multiplexerStateProvider) {
        const { active, installed } = this.multiplexerStateProvider();
        const inner = Buffer.concat([
          Buffer.from([MULTIPLEXER_STATE]),
          Buffer.from(JSON.stringify({ active, installed })),
        ]);
        try {
          this.relay.send(MSG_DATA, session.connId, crypto.encrypt(inner, session.key));
        } catch (err) {
          console.error('[bridge] multiplexer state send failed:', (err as Error).message);
        }
      }
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
    // A phone that picked a session attaches to it by exact name; one that
    // picked the plain shell uses `none` with no session override; the default
    // stays the phone's own isolated session under the machine multiplexer.
    let attach: { name: string; mux: 'tmux' | 'herdr' } | null = null;
    let effectiveMux: Multiplexer | null = mux;
    if (session.attachTarget) {
      if (session.attachTarget.kind === 'bash') {
        effectiveMux = 'none';
      } else {
        attach = { name: session.attachTarget.name, mux: session.attachTarget.kind };
        effectiveMux = session.attachTarget.kind;
      }
    }
    const ws = new WebSocket(localWsUrlFor(this.localWsURL, session.phoneId, effectiveMux, attach), ['tty']);
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
    this.emit('agent_detach', { connId });
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
