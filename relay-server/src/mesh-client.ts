import WebSocket from 'ws';
import * as net from 'node:net';
import * as crypto from './crypto.js';
import type { MeshForward, MeshForwardState } from './mesh-forwards.js';
import { loadOrCreateMeshKeypair, signMeshChallenge, type MeshKeypair } from './mesh-identity.js';

const MSG_HANDSHAKE = 0x01;
const MSG_HANDSHAKE_ACK = 0x02;
const MSG_DATA = 0x03;
const MSG_PING = 0x05;
const MSG_PONG = 0x06;
const PF_OPEN = 0x40;
const PF_DATA = 0x41;
const PF_CLOSE = 0x42;
const PF_OPEN_ACK = 0x43;
const MESH_EVICT = 0x50;
const MESH_RETRY = 0x52; // peer is in the cluster but hasn't registered us yet

export interface MeshPeer {
  name: string;
  deviceId: string;
  relayURL: string;
  pairingSecret: string;
  remotePort: number; // ttyd HTTP port on the peer server
  localPort: number;  // local TCP port this machine listens on for proxying
  serverPublicKey: string; // base64 raw 32-byte Curve25519 public key
  forwards?: MeshForward[]; // additional port forwards beyond ttyd
}

interface ForwardRuntime {
  remotePort: number;
  localPort: number;
  isTtyd: boolean;
  server: net.Server | null;
  state: 'pending' | 'active' | 'error';
  message?: string;
}

export class MeshClient {
  private ws: WebSocket | null = null;
  private symmetricKey: Buffer | null = null;
  private forwardRuntimes = new Map<number, ForwardRuntime>(); // keyed by remotePort
  private flows = new Map<number, { socket: net.Socket; remotePort: number }>();
  private flowFirstDataSent = new Set<number>();
  private nextFlowId = 1;
  private running = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private meshRetryCount = 0; // consecutive MESH_RETRYs (peer not ready yet)
  private consecutive4xx = 0;
  private keyRegistered = false;

  constructor(
    private readonly peer: MeshPeer,
    private readonly ownDeviceId?: string,
    private readonly onEvicted?: (peerDeviceId: string) => void,
    // Where the mesh keypair lives. Omitted in unit tests, which drives the
    // client down the unattested path the relay still admits in monitor mode.
    private readonly configDir?: string,
  ) {}

  start(): void {
    this.running = true;
    this.doConnect();
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardownTCP();
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.symmetricKey = null;
  }

  private doConnect(): void {
    if (!this.running) return;
    // Opening the socket now needs a challenge from the relay, so it is async.
    // Failures land in scheduleReconnect, same as any other connect failure.
    void this.openSocket().catch((err: unknown) => {
      if (!this.running) return;
      console.log(`[mesh:${this.peer.name}] connect failed: ${String(err)}`);
      this.scheduleReconnect();
    });
  }

  private async openSocket(): Promise<void> {
    if (!this.running) return;

    const clientId = `mesh-${this.peer.deviceId}`;
    const wsBase = this.peer.relayURL
      .replace(/^https:\/\//, 'wss://')
      .replace(/^http:\/\//, 'ws://');
    const url = `${wsBase}/api/connect/client`
      + `?device_id=${encodeURIComponent(this.peer.deviceId)}`
      + `&pairing_secret=${encodeURIComponent(this.peer.pairingSecret)}`
      + `&client_id=${clientId}`;

    // Identify as a mesh peer so the remote server lists us as "Server"
    // (the relay forwards this UA in the client_connect payload). The UA is only
    // a label — a clone can set it too, which is exactly why the credential
    // below exists: a signature over a single-use challenge from a key the relay
    // has on file.
    const headers: Record<string, string> = { 'User-Agent': 'termcast-mesh' };
    const credential = await this.meshCredential(clientId);
    Object.assign(headers, credential);

    // stop() may have run while we were fetching the challenge.
    if (!this.running) return;

    const ws = new WebSocket(url, { headers });
    this.ws = ws;
    ws.binaryType = 'arraybuffer';

    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.reconnectDelay = 1000;
      this.consecutive4xx = 0;
      this.performHandshake();
    });

    ws.on('message', (raw: ArrayBuffer) => {
      if (this.ws !== ws) return;
      const buf = Buffer.from(raw);
      if (buf.length === 0) return;
      const type = buf[0];
      const payload = buf.subarray(1);

      if (type === MSG_HANDSHAKE_ACK) {
        this.onHandshakeAck();
      } else if (type === MSG_DATA) {
        const key = this.symmetricKey;
        if (!key) return;
        try {
          const inner = crypto.decrypt(payload, key);
          this.handleInner(inner);
        } catch {}
      } else if (type === MSG_PING) {
        ws.send(Buffer.from([MSG_PONG]));
      }
    });

    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.symmetricKey = null;
      this.teardownTCP();
      this.scheduleReconnect();
    });

    ws.on('error', (err: Error) => {
      if (this.ws !== ws) return;
      const statusMatch = err.message.match(/Unexpected server response: (\d+)/);
      if (statusMatch) {
        const status = parseInt(statusMatch[1]);
        if (status >= 400 && status < 500) {
          // A 4xx means the peer is offline (404) or our pairing secret is stale
          // (403). This is usually persistent, so we back off hard — but we never
          // give up permanently: the peer may come online or re-pair, and a fresh
          // mesh invite will replace this client with up-to-date credentials.
          this.consecutive4xx++;
          if (this.consecutive4xx === 2) {
            console.log(`[mesh:${this.peer.name}] peer rejecting (HTTP ${status}), backing off — will keep retrying`);
          }
        }
      }
    });
  }

  /**
   * Fetches a single-use challenge and signs it with this machine's mesh key.
   *
   * Best-effort: with no configDir (unit tests) or an unreachable relay, it
   * returns no headers and the connect proceeds unattested — which the relay
   * admits while ATTEST_MODE=monitor and refuses once it is `enforce`.
   */
  private async meshCredential(clientId: string): Promise<Record<string, string>> {
    if (!this.configDir) return {};
    try {
      const httpBase = this.peer.relayURL
        .replace(/^wss:\/\//, 'https://')
        .replace(/^ws:\/\//, 'http://');

      const kp = loadOrCreateMeshKeypair(this.configDir);
      await this.registerKey(httpBase, kp);

      const resp = await fetch(
        `${httpBase}/api/attest/challenge?device_id=${encodeURIComponent(this.peer.deviceId)}`,
      );
      if (!resp.ok) return {};
      const { challenge } = await resp.json() as { challenge?: string };
      if (!challenge) return {};

      const clientData = `${challenge}|${this.peer.deviceId}|${clientId}`;
      return {
        'X-Mesh-Key-Id': kp.keyId,
        'X-Mesh-Signature': signMeshChallenge(kp.privateKeyPem, clientData),
        'X-Attest-Challenge': challenge,
      };
    } catch (err) {
      console.log(`[mesh:${this.peer.name}] mesh credential unavailable: ${String(err)}`);
      return {};
    }
  }

  /**
   * Publishes our public key to the peer's relay room, authenticated by the
   * pairing secret we already hold. The relay cannot verify our signature until
   * it knows the key. Once per process is enough.
   */
  private async registerKey(httpBase: string, kp: MeshKeypair): Promise<void> {
    if (this.keyRegistered) return;
    const resp = await fetch(`${httpBase}/api/mesh/register-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_id: this.peer.deviceId,
        pairing_secret: this.peer.pairingSecret,
        key_id: kp.keyId,
        public_key_spki: kp.publicKeySpki,
        peer_device_id: this.ownDeviceId ?? '',
      }),
    });
    if (resp.ok) this.keyRegistered = true;
  }

  private performHandshake(): void {
    const kp = crypto.generateKeyPair();
    const serverPub = Buffer.from(this.peer.serverPublicKey, 'base64');
    const sharedSecret = crypto.computeSharedSecret(kp.privateKey, serverPub);
    this.symmetricKey = crypto.deriveKey(sharedSecret);

    const json = JSON.stringify({
      client_public_key: kp.publicKey.toString('base64'),
      ...(this.ownDeviceId ? { peer_device_id: this.ownDeviceId } : {}),
    });
    const msg = Buffer.alloc(1 + json.length);
    msg[0] = MSG_HANDSHAKE;
    Buffer.from(json).copy(msg, 1);
    this.ws?.send(msg);
  }

  private onHandshakeAck(): void {
    this.meshRetryCount = 0; // peer accepted us; reset the not-ready backoff
    this.forwardRuntimes.clear();
    const all: { remotePort: number; localPort: number; isTtyd: boolean }[] = [
      { remotePort: this.peer.remotePort, localPort: this.peer.localPort, isTtyd: true },
    ];
    for (const f of this.peer.forwards ?? []) {
      if (all.some(e => e.remotePort === f.remotePort)) continue;
      all.push({ remotePort: f.remotePort, localPort: f.localPort, isTtyd: false });
    }
    for (const fwd of all) {
      this.forwardRuntimes.set(fwd.remotePort, { ...fwd, server: null, state: 'pending' });
      const payload = JSON.stringify({ remotePort: fwd.remotePort, localPort: fwd.localPort });
      this.sendEncrypted(Buffer.concat([
        Buffer.from([PF_OPEN]),
        Buffer.alloc(4), // flowId 0 reserved for control
        Buffer.from(payload),
      ]));
    }
  }

  private handleInner(data: Buffer): void {
    if (data.length < 5) return;
    const subCmd = data[0];
    const flowId = data.readUInt32BE(1);
    const payload = data.subarray(5);

    if (subCmd === MESH_EVICT) {
      this.handleEvicted();
      return;
    }

    if (subCmd === MESH_RETRY) {
      this.handleRetry();
      return;
    }

    if (subCmd === PF_OPEN_ACK) {
      try {
        const ack = JSON.parse(payload.toString());
        // Peers have always included remotePort in the ACK (port-forward.ts),
        // but fall back to the ttyd forward if a very old peer omits it.
        const rt = ack.remotePort !== undefined
          ? this.forwardRuntimes.get(ack.remotePort)
          : this.forwardRuntimes.get(this.peer.remotePort);
        if (!rt) return;
        if (ack.status === 'ok') {
          this.startListener(rt);
        } else {
          rt.state = 'error';
          rt.message = ack.message || 'peer rejected forward';
          console.error(`[mesh:${this.peer.name}] PF_OPEN_ACK error for :${rt.remotePort}: ${rt.message}`);
        }
      } catch {}
    } else if (subCmd === PF_DATA) {
      const flow = this.flows.get(flowId);
      if (flow && !flow.socket.destroyed) flow.socket.write(payload);
    } else if (subCmd === PF_CLOSE) {
      const flow = this.flows.get(flowId);
      if (flow) {
        this.flows.delete(flowId);
        this.flowFirstDataSent.delete(flowId);
        flow.socket.destroy();
      }
    }
  }

  private handleEvicted(): void {
    console.log(`[mesh:${this.peer.name}] evicted by peer — removing peer and stopping`);
    const cb = this.onEvicted;
    this.stop();          // running = false, closes ws, no reconnect
    cb?.(this.peer.deviceId);
  }

  /**
   * Peer is in the cluster but hasn't registered us yet — typically its mesh
   * invite is still in flight during simultaneous bidirectional setup. Keep the
   * peer (do NOT call onEvicted) and reconnect with a growing backoff so the
   * race converges once the peer's invite lands. Setting reconnectDelay here
   * (after the open handler reset it to 1s) is what makes the backoff grow.
   */
  private handleRetry(): void {
    this.meshRetryCount++;
    this.reconnectDelay = Math.min(1000 * 2 ** this.meshRetryCount, 60_000);
    console.log(`[mesh:${this.peer.name}] peer not ready yet — retrying in ${this.reconnectDelay}ms`);
    try { this.ws?.close(); } catch {} // 'close' handler schedules the reconnect
  }

  private startListener(rt: ForwardRuntime): void {
    if (rt.server) return;
    const srv = net.createServer((sock) => this.onTCPConnection(sock, rt.remotePort));
    rt.server = srv;
    srv.on('error', (err: any) => {
      rt.state = 'error';
      rt.message = err.message;
      console.error(`[mesh:${this.peer.name}] TCP server error on port ${rt.localPort}: ${err.message}`);
      if (rt.server === srv) rt.server = null;
    });
    srv.listen(rt.localPort, '127.0.0.1', () => {
      rt.state = 'active';
      if (rt.isTtyd) {
        // Parsed by the desktop app — do not change the format of these lines.
        console.log(`[mesh] ${this.peer.name} → localhost:${rt.localPort}`);
        console.log(`Mesh peer: ${this.peer.name}|${rt.localPort}`);
      } else {
        console.log(`[mesh:${this.peer.name}] forward localhost:${rt.localPort} → :${rt.remotePort}`);
      }
    });
  }

  private onTCPConnection(sock: net.Socket, remotePort: number): void {
    // Find next unused flowId
    while (this.flows.has(this.nextFlowId)) {
      this.nextFlowId = this.nextFlowId >= 0xFFFFFFFF ? 1 : this.nextFlowId + 1;
    }
    const flowId = this.nextFlowId++;
    this.flows.set(flowId, { socket: sock, remotePort });

    sock.on('data', (chunk: Buffer) => {
      let body: Buffer;
      if (!this.flowFirstDataSent.has(flowId)) {
        this.flowFirstDataSent.add(flowId);
        // First packet carries 2-byte big-endian remotePort prefix (PortForwardHandler reads it)
        const prefix = Buffer.alloc(2);
        prefix.writeUInt16BE(remotePort, 0);
        body = Buffer.concat([prefix, chunk]);
      } else {
        body = chunk;
      }
      this.sendEncrypted(this.frameMessage(PF_DATA, flowId, body));
    });

    sock.on('close', () => {
      if (this.flows.has(flowId)) {
        this.flows.delete(flowId);
        this.flowFirstDataSent.delete(flowId);
        this.sendEncrypted(this.frameMessage(PF_CLOSE, flowId, Buffer.alloc(0)));
      }
    });

    sock.on('error', () => {}); // 'close' fires after 'error'
  }

  private frameMessage(subCmd: number, flowId: number, payload: Buffer): Buffer {
    const header = Buffer.alloc(5);
    header[0] = subCmd;
    header.writeUInt32BE(flowId, 1);
    return Buffer.concat([header, payload]);
  }

  private sendEncrypted(inner: Buffer): void {
    const key = this.symmetricKey;
    const ws = this.ws;
    if (!key || !ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      const encrypted = crypto.encrypt(inner, key);
      const msg = Buffer.alloc(1 + encrypted.length);
      msg[0] = MSG_DATA;
      encrypted.copy(msg, 1);
      ws.send(msg);
    } catch {}
  }

  private teardownTCP(): void {
    for (const [, rt] of this.forwardRuntimes) {
      if (rt.server) { rt.server.close(); rt.server = null; }
      rt.state = 'pending';
      rt.message = undefined;
    }
    for (const [, flow] of this.flows) flow.socket.destroy();
    this.flows.clear();
    this.flowFirstDataSent.clear();
    this.nextFlowId = 1;
  }

  /** Runtime state of the extra forwards (excludes the ttyd forward). */
  forwardStates(): MeshForwardState[] {
    return [...this.forwardRuntimes.values()]
      .filter(rt => !rt.isTtyd)
      .map(rt => ({
        remotePort: rt.remotePort,
        localPort: rt.localPort,
        state: rt.state,
        ...(rt.message ? { message: rt.message } : {}),
      }));
  }

  /** True only when the mesh WebSocket to this peer is currently OPEN. */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    // Persistent 4xx rejections back off to a 5-minute ceiling so we don't hammer
    // an offline / mis-paired peer; transient failures use the normal 30s ceiling.
    const cap = this.consecutive4xx >= 2 ? 300_000 : 30_000;
    const delay = Math.min(this.reconnectDelay, cap);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, cap);
    console.log(`[mesh:${this.peer.name}] reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.running) this.doConnect();
    }, delay);
  }
}
