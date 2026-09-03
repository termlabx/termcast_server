#!/usr/bin/env node
/*
 * Termcast Server — the termcast daemon
 * Copyright (C) 2026 ulixlab
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at your
 * option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
 * for more details. You should have received a copy of it along with this
 * program. If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Command } from 'commander';
import { TtydManager, detectInstalledMultiplexers, downloadTmux } from './ttyd-manager.js';
import { downloadHerdr } from './herdr-install.js';
import { shouldRecoverFromTtydExit } from './ttyd-restart-policy.js';
import { RelayClient } from './relay-client.js';
import { Bridge } from './bridge.js';
import { generatePairingInfo, displayQRCode } from './pairing.js';
import { resolveRelayUrl, relayHttpUrl } from './relay-url.js';
import { wrapSecret } from './pairing-wrap.js';
import { WebUI } from './web-ui.js';
import { agentLogRing } from './agent-log.js';
import { MeshClient, type MeshPeer } from './mesh-client.js';
import type { StatusSnapshot, ClientStatus } from './status.js';
import { formatStatus } from './status.js';
import { execSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync, chmodSync, realpathSync, renameSync, statSync, truncateSync } from 'node:fs';
import { forwardsFromDisk, forwardsFromInvite, mergeMeshForwards, applyForwardChange, isValidPort, type ForwardChange } from './mesh-forwards.js';
import { loadOrCreateConfigKey, encryptField, decryptField, isEncrypted } from './config-crypto.js';
import { parseRunningState, isPidAlive, type RunningState } from './single-instance.js';
import { needsRotation, backupTail } from './log-rotation.js';
import { type Multiplexer, MULTIPLEXERS, parseMultiplexer, activeMultiplexer, killCommandsForPhone, describeMultiplexerStatus } from './multiplexer.js';
import { listTerminalTargets } from './terminal-targets.js';
import { sweepExpiredClusters, upsertCluster, isMeshActive, isMeshEjected, MESH_EJECTED, type ClusterMap } from './membership.js';
import { AgentRegistry } from './agent/registry.js';
import { AttachmentManager } from './agent/attachments.js';
import { ClaudeAdapter } from './agent/claude-adapter.js';
import { OpencodeAdapter } from './agent/opencode-adapter.js';
import { OpencodeEventStream } from './agent/opencode-event-stream.js';
import { OpencodeClient, defaultOpencodeDbPath } from './agent/opencode-client.js';
import { OpencodeServer } from './agent/opencode-server.js';
import { AGENT_SESSIONS, AGENT_EVENT } from './agent/frames.js';
import { stageHookScripts, installHooks, removeHooks, hooksInstalled, hookSettingsPath, hookInstallDir } from './agent/hook-install.js';
import { ensureHooks, writeOptOut, clearOptOut } from './agent/hook-autosetup.js';
import { PermissionBroker } from './agent/permission-broker.js';
import { defaultDeskRegistry } from './agent/desk-target.js';
import { SessionLiveness } from './agent/session-liveness.js';
import type { AgentAdapter, AgentEvent } from './agent/adapter.js';
import type { AgentKind } from './agent/types.js';

const program = new Command();

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
) as { version: string };

program
  .name('termcast')
  .description('Termcast relay server — access your terminal from anywhere')
  .version(version);

// --- Persistent server config (survives restarts) ---

interface ServerConfig {
  deviceId: string;
  privateKey: string; // base64 raw 32-byte key
  publicKey: string;  // base64 raw 32-byte key
  pairingSecret: string;
  clusters: ClusterMap; // per-phone tmux-session anchors; not secret
  // Server↔server mesh lifetime anchor (epoch ms). Decoupled from `clusters`
  // so the mesh survives the phone being offline and old phones that don't send
  // `phone_id`. See membership.ts: >0 active-until+7d, 0 never, <0 ejected.
  meshPairedAt: number;
  // Which multiplexer this machine runs: 'tmux' | 'herdr' | 'none'. Machine-wide
  // and not secret. Legacy configs lack it and default to tmux.
}

const configDir = join(homedir(), '.ttyd-server');
const configFile = join(configDir, 'config.json');
const meshPeersFile = join(configDir, 'mesh-peers.json');

function loadMeshPeers(): MeshPeer[] {
  try {
    if (existsSync(meshPeersFile)) {
      const raw = JSON.parse(readFileSync(meshPeersFile, 'utf-8')) as (MeshPeer & { forwards?: unknown })[];
      const key = loadOrCreateConfigKey(configDir);
      let migrated = false;
      const peers = raw.map(p => {
        if (!isEncrypted(p.pairingSecret)) migrated = true;
        return { ...p, pairingSecret: decryptField(p.pairingSecret, key), forwards: forwardsFromDisk(p.forwards) };
      });
      // Re-save to upgrade any legacy plaintext peer secrets to ciphertext.
      if (migrated) saveMeshPeers(peers);
      return peers;
    }
  } catch {}
  return [];
}

function saveMeshPeers(peers: MeshPeer[]): void {
  // Each peer's pairingSecret authorizes us onto that peer's relay room, so
  // encrypt it at rest (peers are held decrypted in memory). The file also gets
  // owner-only perms as defence in depth.
  const key = loadOrCreateConfigKey(configDir);
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  try { chmodSync(configDir, 0o700); } catch {}
  const onDisk = peers.map(p => ({ ...p, pairingSecret: encryptField(p.pairingSecret, key) }));
  writeFileSync(meshPeersFile, JSON.stringify(onDisk, null, 2), { mode: 0o600 });
  try { chmodSync(meshPeersFile, 0o600); } catch {}
}

function loadServerConfig(): ServerConfig | null {
  try {
    if (!existsSync(configFile)) return null;
    const raw = JSON.parse(readFileSync(configFile, 'utf-8')) as ServerConfig;
    const key = loadOrCreateConfigKey(configDir);
    const cfg: ServerConfig = {
      deviceId: raw.deviceId,
      privateKey: decryptField(raw.privateKey, key), // throws if copied without the key file
      publicKey: raw.publicKey,
      pairingSecret: decryptField(raw.pairingSecret, key),
      // Legacy configs lack this; default to an empty per-phone cluster map.
      clusters: raw.clusters && typeof raw.clusters === 'object' ? raw.clusters as ClusterMap : {},
      // Legacy configs lack this; 0 = never associated (mesh off until a QR show
      // or a mesh invite re-anchors it).
      meshPairedAt: typeof raw.meshPairedAt === 'number' ? raw.meshPairedAt : 0,
      // Legacy configs lack this; anything unrecognised means tmux, so an
      // upgrade behaves exactly as before.
    };
    // Upgrade a legacy plaintext config to ciphertext on first run after update,
    // and persist the freshly defaulted clusters / meshPairedAt fields. A
    // legacy `multiplexer` field is simply dropped on the next save: the active
    // multiplexer is detected now, so a stored one has nothing to say.
    if (!isEncrypted(raw.privateKey) || !isEncrypted(raw.pairingSecret)
        || typeof raw.clusters !== 'object' || typeof raw.meshPairedAt !== 'number') {
      saveServerConfig(cfg);
    }
    return cfg;
  } catch {
    // Unreadable / undecryptable config (e.g. moved to another machine without
    // the key) is treated as no config: the caller generates a fresh identity.
    return null;
  }
}

function saveServerConfig(config: ServerConfig): void {
  // config.json holds the server's private key and pairing secret — the only
  // credentials that authorize a client to reach this terminal. The private key
  // and pairing secret are encrypted with the local key file (so a leaked
  // config.json is inert), and the dir/file are kept owner-only as defence in
  // depth. mode on mkdir/write only applies on creation, so chmod explicitly to
  // also tighten files written by older versions (default umask).
  const key = loadOrCreateConfigKey(configDir);
  const onDisk: ServerConfig = {
    deviceId: config.deviceId,
    privateKey: encryptField(config.privateKey, key),
    publicKey: config.publicKey, // public — safe in clear (also lives in the QR)
    pairingSecret: encryptField(config.pairingSecret, key),
    clusters: config.clusters ?? {}, // not secret
    meshPairedAt: config.meshPairedAt ?? 0, // not secret
  };
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  try { chmodSync(configDir, 0o700); } catch {}
  writeFileSync(configFile, JSON.stringify(onDisk, null, 2), { mode: 0o600 });
  try { chmodSync(configFile, 0o600); } catch {}
}

const multiplexerFile = join(configDir, 'multiplexer');

/**
 * Mirror the active multiplexer into a one-word file the ttyd wrapper script
 * reads at connection time. The script runs under dash and cannot parse
 * config.json, hence the sidecar. Writing via a temp file + rename keeps the
 * read atomic, so a connection landing mid-write never sees a truncated value.
 */
function writeMultiplexerSidecar(mux: Multiplexer): void {
  try {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const tmp = `${multiplexerFile}.tmp`;
    writeFileSync(tmp, `${mux}\n`, { mode: 0o600 });
    renameSync(tmp, multiplexerFile);
  } catch {}
}

/** Offline leave: drop all phone clusters and clear saved peers (next start). */
function ejectInConfig(): boolean {
  const cfg = loadServerConfig();
  if (!cfg) return false;
  // Durable isolation: MESH_EJECTED survives restarts and is honoured over any
  // stale mesh invite, so the machine stays out until the QR is shown again.
  saveServerConfig({ ...cfg, clusters: {}, meshPairedAt: MESH_EJECTED });
  saveMeshPeers([]);
  return true;
}

program
  .command('start')
  .description('Start the Termcast server and connect to relay')
  .option('-r, --relay <url>', 'Relay URL (or set TERMCAST_RELAY_URL)')
  .option('-p, --port <port>', 'Local termcastd port', '7681')
  .option('-w, --web-port <port>', 'Web UI port', '8080')
  .option('-s, --shell <shell>', 'Shell to use')
  .action(async (opts) => {
    // Refuse a second instance against this ~/.ttyd-server identity before any
    // side effect runs (spawning ttyd, connecting to the relay). See
    // single-instance.ts for why: two live daemons fight over the relay room
    // and evict every connected phone on every reconnect.
    const stateDir = join(homedir(), '.ttyd-server');
    mkdirSync(stateDir, { recursive: true });
    const stateFile = join(stateDir, 'state.json');
    const running = readRunningState();
    if (running) {
      console.error(`\x1b[31mTermcast is already running\x1b[0m (pid ${running.pid}).`);
      let procName: string | null = null;
      try {
        procName = execSync(`ps -p ${running.pid} -o comm=`, { encoding: 'utf-8' }).trim() || null;
      } catch {}
      if (procName) console.error(`  → ${procName}`);
      console.error('Stop it first (termcast stop, or quit Termcast from the menu bar if that\'s the app), then retry.');
      process.exit(1);
    }
    // Claim the identity immediately, before the slower steps below (ttyd,
    // relay, QR) — a second `start` racing us right now must see a live pid
    // rather than land in the same gap this check just closed.
    writeFileSync(stateFile, JSON.stringify({ pid: process.pid }));

    // Resolve the relay before anything else: there is no default, and failing
    // here must not leave a spawned termcastd behind.
    const resolvedRelay = resolveRelayUrl(opts.relay);
    if (!resolvedRelay.ok) {
      console.error(`\x1b[31m${resolvedRelay.error}\x1b[0m`);
      process.exit(1);
    }
    const relayURL = resolvedRelay.url;

    // Derived from what is installed, never stored. The bridge reads this per
    // connection, so installing a multiplexer takes effect on the next phone
    // without respawning ttyd. The sidecar is written purely as a cache for the
    // wrapper script — it is an output of detection, not an input to it.
    let currentMultiplexer = activeMultiplexer();
    writeMultiplexerSidecar(currentMultiplexer);

    const ttyd = new TtydManager({
      port: parseInt(opts.port),
      shell: opts.shell,
      multiplexer: currentMultiplexer,
    });
    const webUI = new WebUI();
    webUI.setTtydPort(parseInt(opts.port));

    const serverStartedAt = Date.now();
    // Set once we begin our own shutdown, so the termcastd 'exit' handler can
    // tell an intentional stop from termcastd dying underneath a live relay.
    let shuttingDown = false;
    // Live client roster, keyed by relay connection id.
    const clients = new Map<number, ClientStatus>();
    // HTTP fetches we make to the Cloudflare relay Worker (register, etc.).
    let cloudflareHttpRequests = 0;

    ttyd.on('log', (msg: string) => process.stdout.write(msg));
    ttyd.on('started', (port: number) => console.log(`termcastd running on port ${port}`));
    ttyd.on('exit', (code: number | null, signal: string | null) => {
      // Recover from termcastd dying for ANY reason (including a graceful
      // SIGTERM → code 0), unless we stopped it ourselves during shutdown.
      // Otherwise the relay keeps the phone paired ("connected") while the
      // terminal backend is gone, looping forever on "Cannot connect to local
      // termcastd". Exiting lets the supervisor respawn us with a fresh ttyd.
      if (!shouldRecoverFromTtydExit({ shuttingDown, code, signal })) return;
      console.error(`\x1b[31mtermcastd exited (${signal ? `signal ${signal}` : `exit code ${code}`}) while serving — restarting to recover.\x1b[0m`);
      process.exit(1);
    });

    await ttyd.start();
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Load or generate keypair and pairing info
    const { generateKeyPair } = await import('./crypto.js');
    const relayHTTP = relayHttpUrl(relayURL);

    const savedConfig = loadServerConfig();
    let keyPair: { publicKey: Buffer; privateKey: Buffer };
    let currentPairing: ReturnType<typeof generatePairingInfo>;

    if (savedConfig) {
      // Reuse persisted identity so the iPhone can reconnect without re-scanning
      keyPair = {
        privateKey: Buffer.from(savedConfig.privateKey, 'base64'),
        publicKey: Buffer.from(savedConfig.publicKey, 'base64'),
      };
      currentPairing = generatePairingInfo(relayURL, Buffer.from(savedConfig.publicKey, 'base64'), savedConfig.deviceId, parseInt(opts.port));
      currentPairing = { ...currentPairing, pairingSecret: savedConfig.pairingSecret };
    } else {
      keyPair = generateKeyPair();
      currentPairing = generatePairingInfo(relayURL, keyPair.publicKey, undefined, parseInt(opts.port));
      saveServerConfig({
        deviceId: currentPairing.deviceId,
        privateKey: keyPair.privateKey.toString('base64'),
        publicKey: keyPair.publicKey.toString('base64'),
        pairingSecret: currentPairing.pairingSecret,
        clusters: {},
        meshPairedAt: 0,
      });
    }

    // Process-local mirror of config.json's per-phone clusters map. The mesh
    // predicate, cluster_paired upsert, and the sweep timer share this source.
    let clusters: ClusterMap = savedConfig?.clusters ?? {};
    const persistClusters = () => {
      const cfg = loadServerConfig();
      if (cfg) saveServerConfig({ ...cfg, clusters });
    };

    // Server↔server mesh lifetime anchor (see membership.ts). Decoupled from
    // `clusters`: the mesh stays up for 7 days after the last association (QR
    // show or mesh invite) even while the phone is offline, and independent of
    // whether the phone sends `phone_id`.
    let meshPairedAt: number = savedConfig?.meshPairedAt ?? 0;
    const persistMeshPairedAt = () => {
      const cfg = loadServerConfig();
      if (cfg) saveServerConfig({ ...cfg, meshPairedAt });
    };

    // Tear down every multiplexer's session for a set of phones (best-effort).
    // A phone can hold one session per multiplexer — switching the setting
    // deliberately leaves the other dormant rather than killing it — so expiry
    // and leave must clear both namespaces.
    function killPhoneSessions(phoneIds: string[]): void {
      for (const id of phoneIds) {
        for (const cmd of killCommandsForPhone(id)) {
          try { execSync(cmd); } catch {}
        }
      }
    }

    // Helper to register pairing with relay backend
    async function registerPairing(pairing: typeof currentPairing): Promise<boolean> {
      try {
        cloudflareHttpRequests++;
        const resp = await fetch(`${relayHTTP}/api/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            device_id: pairing.deviceId,
            pairing_secret: pairing.pairingSecret,
          }),
        });
        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          if (resp.status === 429 || body.includes('1027')) {
            console.error(`\x1b[31mRelay quota exceeded (HTTP 429): Cloudflare Workers daily request limit reached.\x1b[0m`);
            console.error(`  Resets at midnight UTC. Upgrade at cloudflare.com/workers to remove the cap.`);
          } else {
            console.error(`\x1b[31mRelay registration failed (HTTP ${resp.status}).\x1b[0m`);
            if (body) console.error(`  Details: ${body.slice(0, 200)}`);
          }
        }
        return resp.ok;
      } catch (err) {
        const msg = (err as Error).message;
        console.error(`\x1b[31mCannot reach relay server: ${msg}\x1b[0m`);
        if (msg.includes('ENOTFOUND') || msg.includes('getaddrinfo')) {
          console.error(`  → Check your internet connection or relay URL: ${relayHTTP}`);
        } else if (msg.includes('ECONNREFUSED')) {
          console.error(`  → Relay server at ${relayHTTP} is not responding.`);
        } else if (msg.includes('certificate') || msg.includes('SSL')) {
          console.error(`  → TLS/certificate error. Check the relay URL protocol (https vs http).`);
        }
        return false;
      }
    }

    // Register the current QR's single-use grant with the relay: device_id +
    // one-time token hash + the pairing secret wrapped to that token. The relay
    // never stores the plaintext secret — only this token holder can unwrap it.
    async function registerGrant(pairing: typeof currentPairing): Promise<void> {
      cloudflareHttpRequests++;
      const resp = await fetch(`${relayHTTP}/api/pairing/grant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: pairing.deviceId,
          pairing_secret: pairing.pairingSecret,
          pairing_token: pairing.pairingToken,
          wrapped_secret: wrapSecret(pairing.pairingSecret, pairing.pairingToken),
          grant_expires_at: pairing.expiresAt,
        }),
      });
      if (!resp.ok) console.error(`\x1b[31mFailed to register pairing grant (HTTP ${resp.status}).\x1b[0m`);
    }

    // Initial registration
    if (!await registerPairing(currentPairing)) {
      console.error(`\nRelay URL: ${relayHTTP}`);
      console.error(`  → Verify the relay is running and reachable.`);
      console.error(`  → Override with: termcast start --relay <url>`);
      process.exit(1);
    }

    // Connect to relay
    const relay = new RelayClient(relayHTTP, currentPairing.deviceId);
    const bridge = new Bridge(ttyd.wsURL, relay, keyPair);

    relay.on('connected', () => console.log('\x1b[32m✓ Connected to relay\x1b[0m'));
    relay.on('disconnected', () => console.log('\x1b[33m⚠ Disconnected from relay — will auto-reconnect\x1b[0m'));
    relay.on('pairing_consumed', () => {
      console.log('[pairing] consumed');   // desktop parses this to close the QR window
      webUI.notifyPairingConsumed();        // resolves the `termcast qr` long-poll
    });
    relay.on('client_offline', (connId: number) => {
      console.log(`Client disconnected [id=${connId}]`);
      clients.delete(connId);
    });
    relay.on('client_connect', (connId: number, payload: Buffer) => {
      console.log(`Client connected [id=${connId}]`);
      const info = parseClientInfo(payload);
      clients.set(connId, { id: connId, ...info, paired: false, connectedAt: Date.now() });
      const parts: string[] = [];
      if (info.ip) parts.push(info.ip);
      if (info.location) parts.push(info.location);
      if (info.device) parts.push(info.device);
      if (parts.length > 0) console.log(`Client info [id=${connId}]: ${parts.join(' | ')}`);
    });
    bridge.on('handshake_complete', (connId: number, peerDeviceId: string | null) => {
      console.log(`\x1b[32m✓ Client paired [id=${connId}] — E2E encryption active\x1b[0m`);
      const existing = clients.get(connId);
      if (existing) {
        existing.paired = true;
        // A meshing-in server authenticates as its deviceId; remember it so
        // meshSnapshot() can attach this peer's IP/location to its outbound row.
        if (peerDeviceId) existing.peerDeviceId = peerDeviceId;
      }
    });

    relay.connect();
    bridge.start();

    // Start any mesh peers saved from a previous session
    const meshClients = new Map<string, MeshClient>();

    function startMeshPeer(peer: MeshPeer): void {
      const existing = meshClients.get(peer.deviceId);
      if (existing) existing.stop();
      const mc = new MeshClient(peer, currentPairing.deviceId, (peerDeviceId) => {
        // This peer evicted us: it no longer lists us. Drop it permanently so a
        // restart won't re-add it, and clean it out of the live client map.
        savedPeers = savedPeers.filter(p => p.deviceId !== peerDeviceId);
        saveMeshPeers(savedPeers);
        meshClients.delete(peerDeviceId);
      }, configDir); // configDir holds the mesh keypair we sign connects with
      meshClients.set(peer.deviceId, mc);
      mc.start();
    }

    // The saved peer set, kept in memory so invite merges and CLI edits share it.
    let savedPeers: MeshPeer[] = [];

    // Live snapshot for GET /api/mesh and the status endpoint. `name`/`port`
    // are load-bearing (desktop Peers submenu, `termcast connect`); `forwards`
    // is additive.
    const meshSnapshot = () => {
      // Index inbound mesh connections by the deviceId they authenticated as, so
      // each outbound peer row can carry the IP/location observed on its return
      // leg (the relay geo-tags inbound connections; outbound dials don't see it).
      const inboundByDevice = new Map<string, ClientStatus>();
      for (const c of clients.values()) if (c.peerDeviceId) inboundByDevice.set(c.peerDeviceId, c);
      return savedPeers.map(p => {
        const inbound = inboundByDevice.get(p.deviceId);
        return {
          name: p.name,
          port: p.localPort,
          connected: meshClients.get(p.deviceId)?.isConnected() ?? false,
          ip: inbound?.ip,
          location: inbound?.location,
          forwards: meshClients.get(p.deviceId)?.forwardStates() ?? [],
        };
      });
    };
    webUI.setMeshPeersProvider(meshSnapshot);

    savedPeers = loadMeshPeers();
    // Upgrade migration: a pre-meshPairedAt config that already has saved peers
    // was a working mesh — treat those peers as freshly associated so the mesh
    // doesn't go dark for 7 days on first boot after update.
    if (meshPairedAt === 0 && savedPeers.length > 0) {
      meshPairedAt = Date.now();
      persistMeshPairedAt();
    }
    if (isMeshActive(meshPairedAt)) {
      for (const peer of savedPeers) startMeshPeer(peer);
    } else {
      stopAllMesh(); // mesh association expired/ejected on boot: isolate
    }

    bridge.on('cluster_paired', ({ phoneId, pairedAt }: { phoneId: string; pairedAt: number }) => {
      const before = clusters[phoneId]?.pairedAt;
      clusters = upsertCluster(clusters, phoneId, pairedAt);
      if (clusters[phoneId]?.pairedAt !== before) persistClusters();
    });

    // Inbound mesh gating, split so the bridge can tell a permanent eviction
    // apart from a transient "not yet known" (see bridge.handleHandshake):
    //  - active check: are we still in the mesh (anchor not expired/ejected)?
    //  - membership check: is this specific peer in our current set?
    // Inactive ⇒ permanent evict; active-but-unknown ⇒ retry (invite may be in
    // flight). This prevents the mutual-eviction deadlock during simultaneous
    // bidirectional mesh setup.
    // Read live rather than captured, so a switch (from the web UI, the CLI, or
    // a phone) reaches the very next connection.
    bridge.setMultiplexerProvider(() => currentMultiplexer);
    bridge.setMeshActiveCheck(() => isMeshActive(meshPairedAt));
    bridge.setMeshMembershipCheck((peerDeviceId) =>
      savedPeers.some(p => p.deviceId === peerDeviceId));

    bridge.on('mesh_invite', (incoming: (MeshPeer & { forwards?: unknown })[]) => {
      // A stale invite must not resurrect an ejected machine: ignore invites
      // while ejected (cleared only by showing the QR again — the consent gate).
      if (isMeshEjected(meshPairedAt)) return;

      // The invite is authoritative for the PEER SET: it carries the phone's
      // full, current list. Forwards are merged per-peer: invite-sourced
      // forwards are replaced wholesale, locally-added (CLI) forwards survive.
      const prior = new Map(savedPeers.map(p => [p.deviceId, p]));
      const desired = new Map<string, MeshPeer>();
      for (const peer of incoming) {
        const merged = mergeMeshForwards(
          prior.get(peer.deviceId)?.forwards ?? [],
          forwardsFromInvite(peer.forwards),
        );
        desired.set(peer.deviceId, { ...peer, forwards: merged }); // dedupe, last wins
      }

      // Reap mesh clients for peers no longer in the invite.
      for (const [deviceId, mc] of meshClients) {
        if (!desired.has(deviceId)) {
          mc.stop();
          meshClients.delete(deviceId);
        }
      }

      // Start / refresh the current set (startMeshPeer replaces any existing client).
      for (const peer of desired.values()) startMeshPeer(peer);

      savedPeers = [...desired.values()];
      saveMeshPeers(savedPeers);

      // Receiving a non-empty invite IS the association event (the phone scanned
      // this machine into a cluster). Re-anchor the 7-day mesh window so it
      // persists while the phone is offline. Empty invites (disconnect/sweep)
      // don't extend the lease.
      if (savedPeers.length > 0) {
        meshPairedAt = Date.now();
        persistMeshPairedAt();
      }
    });

    // Stop every outbound MeshClient and forget the peer set (durable on disk).
    function stopAllMesh(): void {
      for (const mc of meshClients.values()) mc.stop();
      meshClients.clear();
      savedPeers = [];
      saveMeshPeers(savedPeers);
    }

    // Leave: drop every phone cluster, kill their tmux sessions, isolate mesh,
    // and best-effort notify connected phones.
    function leaveCluster(): { ok: true } {
      killPhoneSessions(Object.keys(clusters));
      clusters = {};
      persistClusters();
      // Durable ejection: survives restarts and is honoured over stale invites,
      // so the machine stays out until the QR is shown again.
      meshPairedAt = MESH_EJECTED;
      persistMeshPairedAt();
      stopAllMesh();
      bridge.notifyPhonesSelfEject(currentPairing.deviceId);
      console.log('Left the cluster. Scan the QR again to rejoin.');
      return { ok: true };
    }

    webUI.setLeaveHandler(() => leaveCluster());

    /**
     * Re-derive the multiplexer from what is installed, and publish it.
     *
     * Every surface that used to *set* the multiplexer calls this instead.
     * Setting is gone, but installing a binary genuinely changes the answer, so
     * re-detecting on those signals is what lets a freshly installed herdr take
     * effect without a restart. Live connections are undisturbed; the next one
     * gets the new value.
     */
    function refreshMultiplexer(): Multiplexer {
      const installed = detectInstalledMultiplexers();
      const detected = activeMultiplexer(installed);
      if (detected !== currentMultiplexer) {
        currentMultiplexer = detected;
        writeMultiplexerSidecar(detected);
        console.log(`Multiplexer detected: ${detected}.`);
      }
      bridge.broadcastMultiplexerState(detected, installed);
      return detected;
    }

    webUI.setMultiplexerHandlers({
      get: () => ({ active: currentMultiplexer, installed: detectInstalledMultiplexers() }),
      install: async (name) => {
        if (name === 'herdr') {
          await downloadHerdr(join(homedir(), '.termcast', 'bin', 'herdr'));
        } else {
          await downloadTmux();
        }
        // The install may well have changed which multiplexer is active.
        refreshMultiplexer();
      },
    });

    // A phone on an older build still sends SET_MULTIPLEXER. There is nothing
    // to set any more, so answer with the truth: its picker snaps back to what
    // this machine actually runs instead of showing a change that never took.
    bridge.on('multiplexer_set', () => refreshMultiplexer());
    bridge.setMultiplexerStateProvider(() => ({
      active: currentMultiplexer,
      installed: detectInstalledMultiplexers(),
    }));
    // The raw-terminal picker resolves fresh on every request, so a session the
    // user just created is visible without waiting for anything.
    bridge.setTerminalTargetsProvider(() => listTerminalTargets());

    // Claude Code's hooks are what record which pane holds a session. Without
    // them a session started in tmux is unreachable from the phone, and the
    // guard that should refuse the send stays silent — so it is answered
    // headlessly while the user's own terminal shows nothing. Ensuring them
    // here is what makes a fresh install work with no manual step; a
    // deliberate `agent teardown` is remembered and honoured.
    switch (ensureHooks()) {
      case 'installed':
        console.log('\x1b[32m✓ Phone approvals enabled (Claude Code hooks installed)\x1b[0m');
        break;
      case 'failed':
        console.warn(`\x1b[33m⚠ Could not install Claude Code hooks — agent sessions may not be reachable. Run: termcast agent setup\x1b[0m`);
        break;
      default:
        // already / opted-out / no-claude: the routine steady state.
        break;
    }

    // --- Agent sessions -----------------------------------------------------
    // opencode is optional: if no server can be found or spawned, only Claude
    // Code sessions are listed. A missing agent is never an error.
    //
    // It is discovered lazily on every session listing, so a server started
    // before opencode was available picks it up without a restart, and a
    // crashed `opencode serve` is recovered on the next listing.
    const opencodeServer = new OpencodeServer();
    let opencodeAdapter: OpencodeAdapter | null = null;
    let opencodeUrl: string | null = null;

    // One desk registry and one liveness oracle for the whole process: a
    // session listing asks them about every session at once, and the liveness
    // oracle caches its process scan across those calls.
    const deskRegistry = defaultDeskRegistry();
    const liveness = new SessionLiveness();

    const claudeAdapter = new ClaudeAdapter(undefined, { desk: deskRegistry, liveness });
    const adapterProvider = (): AgentAdapter[] => [
      claudeAdapter,
      ...(opencodeAdapter ? [opencodeAdapter] : []),
    ];
    const agentRegistry = new AgentRegistry(adapterProvider, { desk: deskRegistry, liveness });
    const attachments = new AttachmentManager(agentRegistry);

    // Events with no transcript to tail — an SDK session's messages, and the
    // turn_end a desk send owes the phone — go to every connection currently
    // attached to that session. Declared before ensureOpencode because the
    // opencode adapter is (re)built there and needs it at construction.
    const agentEventSink = (event: AgentEvent): void => {
      for (const connId of attachments.connectionsFor(event.sessionId)) {
        bridge.sendAgentFrame(connId, AGENT_EVENT, event);
      }
    };
    claudeAdapter.setEventSink(agentEventSink);

    const ensureOpencode = async (): Promise<void> => {
      const url = await opencodeServer.ensureRunning();
      if (url === opencodeUrl) return;
      opencodeUrl = url;
      opencodeAdapter = url
        ? new OpencodeAdapter(
            new OpencodeClient(url, defaultOpencodeDbPath()),
            new OpencodeEventStream({ baseUrl: url }),
            // No liveness oracle: opencode's send no longer branches on it (an
            // unreachable session is posted to, not refused), and the registry
            // keeps its own for the listing.
            { desk: deskRegistry },
          )
        : null;
      // Desk sends have no transcript flag to end their turn, so the adapter
      // emits turn_end itself — it needs the same fan-out the SDK path uses.
      opencodeAdapter?.setEventSink(agentEventSink);
      if (url) {
        console.log(`\x1b[32m✓ opencode sessions enabled via ${url}\x1b[0m`);
      } else {
        console.warn('\x1b[33m⚠ opencode not available — only Claude Code sessions will be listed.\x1b[0m');
      }
    };
    await ensureOpencode();

    const approvalsEnabled = (): boolean => {
      try {
        return hooksInstalled(JSON.parse(readFileSync(hookSettingsPath(), 'utf8')));
      } catch {
        return false;
      }
    };

    bridge.on('agent_list', async ({ connId }: { connId: number }) => {
      await ensureOpencode();
      const sessions = await agentRegistry.list();
      bridge.sendAgentFrame(connId, AGENT_SESSIONS, { sessions, approvalsEnabled: approvalsEnabled() });
    });

    bridge.on('agent_attach', async (req: { connId: number; agent: AgentKind; sessionId: string; sinceSeq: number }) => {
      // Backfill first so the phone has context before live events arrive.
      const page = await agentRegistry.history(req.agent, req.sessionId, null, 50);
      bridge.sendAgentFrame(req.connId, AGENT_EVENT, {
        kind: 'history', sessionId: req.sessionId, beforeSeq: null,
        hasMore: page.hasMore, messages: page.messages,
      });

      await attachments.attach(req.connId, req.agent, req.sessionId, req.sinceSeq, (event) => {
        bridge.sendAgentFrame(req.connId, AGENT_EVENT, event);
      });
    });

    bridge.on('agent_history', async (req: { connId: number; agent: AgentKind; sessionId: string; beforeSeq: number | null; limit: number }) => {
      const page = await agentRegistry.history(req.agent, req.sessionId, req.beforeSeq, Math.min(req.limit, 50));
      bridge.sendAgentFrame(req.connId, AGENT_EVENT, {
        kind: 'history', sessionId: req.sessionId, beforeSeq: req.beforeSeq,
        hasMore: page.hasMore, messages: page.messages,
      });
    });

    bridge.on('agent_detach_all', () => attachments.detachAll());

    bridge.on('agent_send', async (req: { connId: number; agent: AgentKind; sessionId: string; text: string }) => {
      const adapter = agentRegistry.adapterFor(req.agent);
      if (!adapter) return;
      try {
        await adapter.send(req.sessionId, req.text);
      } catch (err) {
        bridge.sendAgentFrame(req.connId, AGENT_EVENT, {
          kind: 'status', sessionId: req.sessionId, seq: -1,
          status: 'error', detail: (err as Error).message,
        });
      }
    });

    bridge.on('agent_interrupt', async (req: { connId: number; agent: AgentKind; sessionId: string }) => {
      await agentRegistry.adapterFor(req.agent)?.interrupt(req.sessionId).catch(() => {});
    });

    const permissionBroker = new PermissionBroker();

    // Fan every pending permission out to the phones watching that session.
    permissionBroker.onRequest((request) => {
      for (const connId of attachments.connectionsFor(request.sessionId)) {
        bridge.sendAgentFrame(connId, AGENT_EVENT, {
          kind: 'permission', sessionId: request.sessionId, seq: -1, request,
        });
      }
    });

    bridge.on('agent_permission', async (req: { requestId: string; behavior: 'allow' | 'deny' }) => {
      permissionBroker.resolve(req.requestId, req.behavior);
      // SDK-driven sessions hold their own resolvers.
      for (const adapter of adapterProvider()) {
        await adapter.respondPermission(req.requestId, req.behavior).catch(() => {});
      }
    });

    bridge.on('agent_question', async (req: { connId: number; requestId: string; answers?: string[]; rejected?: boolean }) => {
      for (const adapter of adapterProvider()) {
        await adapter.respondQuestion(req.requestId, req.answers, req.rejected).catch(() => {});
      }
    });

    // A pending approval must not outlive the phone that could answer it.
    bridge.on('agent_detach', ({ connId }: { connId: number }) => {
      attachments.detach(connId);
      if (attachments.attachedSessions().length === 0) permissionBroker.releaseAll();
    });

    webUI.setPermissionHandler({
      broker: permissionBroker,
      isAttached: (id) => attachments.isAttached(id),
    });

    // The trace behind /agent-log. The desktop tray builds the same view from
    // this process's stdout; a CLI install reads it here instead.
    webUI.setAgentLogRing(agentLogRing);

    // CLI-driven forward add/remove (POST /api/mesh/forwards).
    webUI.setMeshForwardHandler((raw: unknown) => {
      const change = raw as ForwardChange;
      if (!change || typeof change.peer !== 'string' || (change.action !== 'add' && change.action !== 'remove')) {
        return { ok: false, error: 'invalid request' };
      }
      const result = applyForwardChange(savedPeers, change);
      if (!result.ok) return result;
      savedPeers = result.peers;
      saveMeshPeers(savedPeers);
      startMeshPeer(result.peer); // reconnects with the new forward set
      return { ok: true, note: result.note };
    });

    // Register the startup QR's single-use grant before showing it, so a fast
    // scan can't beat the grant into existence.
    await registerGrant(currentPairing);
    await displayQRCode(currentPairing);

    // Save state so `ttyd-server qr` can regenerate QR codes (stateDir/stateFile
    // were already created above, by the single-instance guard).
    const saveState = () => {
      writeFileSync(stateFile, JSON.stringify({
        relayURL,
        deviceId: currentPairing.deviceId,
        serverPublicKey: keyPair.publicKey.toString('base64'),
        pid: process.pid,
        webPort: webUI.port,
      }));
    };
    saveState();

    // The agent permission hook needs the loopback web port to ask whether a
    // phone wants to approve a tool call.
    writeFileSync(join(stateDir, 'web-port'), `${webUI.port}\n`);

    // Expose a live snapshot for `termcast status` (served at GET /api/status).
    webUI.setStatusProvider((): StatusSnapshot => {
      const cf = relay.cloudflareStats;
      return {
        version,
        serverPid: process.pid,
        uptimeSeconds: (Date.now() - serverStartedAt) / 1000,
        relay: { url: relayURL, connected: relay.connected },
        ttyd: {
          pid: ttyd.pid,
          port: ttyd.currentPort,
          running: ttyd.isRunning,
          uptimeSeconds: ttyd.uptimeSeconds,
        },
        clients: [...clients.values()],
        cloudflare: {
          httpRequests: cloudflareHttpRequests,
          wsConnects: cf.wsConnects,
          wsMessagesSent: cf.wsMessagesSent,
          total: cloudflareHttpRequests + cf.wsConnects + cf.wsMessagesSent,
        },
        mesh: meshSnapshot(),
      };
    });

    // Refresh callback for the QR popup / web UI.
    //
    // This must NOT rotate the pairing secret. Other servers that have meshed to
    // us hold this secret; rotating it silently invalidates every mesh link — the
    // peers start failing the relay handshake with HTTP 403 and drop off the
    // dropdown. The secret is already long-lived: generated once, persisted in
    // config.json, reused across restarts, and registered with the relay at
    // startup. So we reuse it and only refresh the display expiry so the UI
    // countdown stays accurate.
    webUI.setRegenerateCallback(async () => {
      // Showing the QR is the human-at-the-machine consent event: it (re-)anchors
      // the 7-day mesh window and clears any prior ejection, so this is how a
      // machine re-joins after `leave` or after the window lapsed. It still does
      // NOT rotate the pairing secret (that would break peers meshed to us).
      const wasInactive = !isMeshActive(meshPairedAt);
      meshPairedAt = Date.now();
      persistMeshPairedAt();
      // If peers are still known and the mesh had gone idle, bring them back up.
      if (wasInactive) for (const peer of savedPeers) startMeshPeer(peer);
      // Mint a fresh one-time token so each shown QR is single-use. The
      // long-lived pairing secret is deliberately NOT rotated.
      currentPairing = { ...currentPairing, pairingToken: randomBytes(32).toString('base64url'), expiresAt: Date.now() + 5 * 60 * 1000 };
      return currentPairing;
    });

    webUI.setPairing(currentPairing);

    // Register a fresh grant on every future QR mint (the web-UI calls this
    // after regenerating the token). The startup grant was registered above.
    webUI.setGrantRegistrar(async (p) => { await registerGrant(p as typeof currentPairing); });

    // Sweep timer: (1) kill per-phone tmux sessions past their 7-day cap, and
    // (2) isolate the server↔server mesh once its association window lapses.
    // These are now independent: the mesh no longer requires a phone cluster.
    const clusterSweepTimer = setInterval(() => {
      const { kept, expiredPhoneIds: expired } = sweepExpiredClusters(clusters);
      if (expired.length > 0) {
        killPhoneSessions(expired);
        clusters = kept;
        persistClusters();
        console.log(`Expired ${expired.length} cluster(s) past the 7-day cap.`);
      }
      if (!isMeshActive(meshPairedAt) && meshClients.size > 0) {
        console.log('Mesh association expired — isolating mesh.');
        stopAllMesh();
      }
    }, 60_000);
    clusterSweepTimer.unref();

    // Rotate our own log file so it can't grow without bound. Whatever
    // supervises us (launchd, systemd, or the fallback loop) opens
    // termcast.log in append mode and hands us that fd as stdout/stderr —
    // truncating the file by path (not through that fd) keeps it valid for
    // the next write, so this doesn't need coordination with the supervisor.
    // Caps total on-disk footprint at ~5MB: 2.5MB active + 2.5MB backup.
    const LOG_FILE = join(homedir(), '.termcast', 'termcast.log');
    const MAX_LOG_BYTES = 2_621_440;
    const rotateLogInterval = setInterval(() => {
      try {
        const size = statSync(LOG_FILE).size;
        if (!needsRotation(size, MAX_LOG_BYTES)) return;
        const content = readFileSync(LOG_FILE);
        writeFileSync(`${LOG_FILE}.1`, backupTail(content, MAX_LOG_BYTES));
        truncateSync(LOG_FILE, 0);
      } catch {
        // No log file yet (e.g. running interactively with stdout on a tty) —
        // nothing to rotate.
      }
    }, parseInt(process.env.TERMCAST_ROTATE_INTERVAL_MS ?? '30000', 10));
    rotateLogInterval.unref();

    await webUI.start(parseInt(opts.webPort));
    // Re-persist now that we know the actual bound web port (it may have shifted
    // if the requested port was busy) so `termcast status` can reach /api/status.
    saveState();

    const shutdown = () => {
      shuttingDown = true;
      console.log('\nShutting down...');
      bridge.stop();
      attachments.detachAll();
      opencodeServer.stop();
      relay.disconnect();
      webUI.stop();
      clearInterval(clusterSweepTimer);
      clearInterval(rotateLogInterval);
      for (const mc of meshClients.values()) mc.stop();
      meshClients.clear();
      try { unlinkSync(stateFile); } catch {}

      const exit = () => process.exit(0);
      if (!ttyd.isRunning) { exit(); return; }
      // Wait for ttyd to confirm exit before we exit, so the SIGKILL fallback
      // in ttyd.stop() has time to fire if ttyd ignores SIGTERM.
      // For orphan pids (no ChildProcess handle), the timeout is the only signal.
      ttyd.once('exit', exit);
      ttyd.stop();
      setTimeout(exit, 6000).unref();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program
  .command('qr')
  .description('Generate a new pairing QR code (while server is running)')
  .action(async () => {
    const stateFile = join(homedir(), '.ttyd-server', 'state.json');
    if (!existsSync(stateFile)) {
      console.error('\x1b[31mNo running server found.\x1b[0m');
      console.error('Start the server first: termcast start');
      process.exit(1);
    }

    let state: { relayURL: string; deviceId: string; serverPublicKey: string; pid: number; webPort: number };
    try {
      state = JSON.parse(readFileSync(stateFile, 'utf-8'));
    } catch {
      console.error('\x1b[31mFailed to read server state.\x1b[0m');
      process.exit(1);
    }

    if (!Number.isInteger(state.pid)) {
      console.error('\x1b[31mServer state is missing a valid PID.\x1b[0m');
      process.exit(1);
    }

    // Check if the recorded server process is still alive. Signal 0 delivers
    // nothing — it only runs the kernel's existence/permission checks, so it's
    // the standard way to probe a PID:
    //   no throw      -> process exists and we can signal it (alive)
    //   EPERM         -> process exists but owned by another user (alive)
    //   ESRCH / other -> no such process (dead)
    let alive = true;
    try {
      process.kill(state.pid, 0);
    } catch (err) {
      alive = (err as NodeJS.ErrnoException).code === 'EPERM';
    }
    if (!alive) {
      console.error('\x1b[31mServer (pid ' + state.pid + ') is not running.\x1b[0m');
      console.error('Start the server first: termcast start');
      // Remove the stale state file so the next check reports accurately.
      try { unlinkSync(stateFile); } catch {}
      process.exit(1);
    }

    if (!Number.isInteger(state.webPort) || state.webPort <= 0) {
      console.error('\x1b[31mServer web-UI port unknown — restart the server.\x1b[0m');
      process.exit(1);
    }
    const base = `http://127.0.0.1:${state.webPort}`;

    // Mint a fresh single-use QR via the running server, which owns the grant
    // lifecycle (registers the one-time token with the relay and will be told
    // when it is claimed). This is the single source of truth for pairing.
    let meta: { qr_text: string; expires_at: number };
    try {
      // ?new=1: this is an explicit user action, so mint a fresh single-use QR.
      const r = await fetch(`${base}/api/pairing?new=1`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      meta = await r.json() as { qr_text: string; expires_at: number };
    } catch (err) {
      console.error(`\x1b[31mFailed to get a QR from the running server: ${(err as Error).message}\x1b[0m`);
      process.exit(1);
    }

    console.log('\n' + meta.qr_text);
    console.log('\nScan this QR code with the termcast iPhone app to pair.');
    console.log('Waiting for a device to pair… (Ctrl-C to stop)\n');

    // Long-poll the running server; it resolves this when the relay reports the
    // grant was claimed (single-use consumed) or after the QR expiry window.
    // Note: only one grant is live at a time, so a "consumed" signal here means
    // the current QR was claimed. If another surface showed a newer QR in the
    // meantime, this poll resolves on that consumption — acceptable given the
    // only-latest-QR-is-live model.
    try {
      const consumed = await fetch(`${base}/api/pairing/consumed`).then(r => r.json() as Promise<{ consumed: boolean }>);
      if (consumed.consumed) console.log('\x1b[32m✓ Paired — QR now invalid\x1b[0m');
      else console.log('\x1b[33mQR expired without pairing. Run `termcast qr` again.\x1b[0m');
    } catch (err) {
      console.error(`\x1b[31mLost contact with the running server: ${(err as Error).message}\x1b[0m`);
      process.exit(1);
    }
    process.exit(0);
  });

program
  .command('status')
  .description('Show server status: termcastd process, clients, and relay usage')
  .option('--json', 'Output the raw status snapshot as JSON')
  .action(async (opts) => {
    const stateFile = join(homedir(), '.ttyd-server', 'state.json');
    const supervisorPidFile = join(homedir(), '.termcast', 'termcast.pid');

    const isAlive = (pid: number): boolean => {
      try { process.kill(pid, 0); return true; }
      catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
    };

    if (!existsSync(stateFile)) {
      // The supervisor may be up but mid-restart (no live server yet).
      let supervised = false;
      try {
        const pid = parseInt(readFileSync(supervisorPidFile, 'utf-8').trim(), 10);
        supervised = Number.isInteger(pid) && isAlive(pid);
      } catch {}
      if (opts.json) {
        console.log(JSON.stringify(supervised ? { running: false, starting: true } : { running: false }));
      } else if (supervised) {
        console.log('\x1b[33m● Termcast supervisor running — server starting up...\x1b[0m');
      } else {
        console.log('○ Termcast is not running.');
        console.log('  Start it with: termcast start');
      }
      process.exit(0);
    }

    let state: { pid?: number; webPort?: number };
    try {
      state = JSON.parse(readFileSync(stateFile, 'utf-8'));
    } catch {
      console.error('\x1b[31mFailed to read server state.\x1b[0m');
      process.exit(1);
    }

    if (!state.pid || !isAlive(state.pid)) {
      try { unlinkSync(stateFile); } catch {}
      if (opts.json) {
        console.log(JSON.stringify({ running: false }));
      } else {
        console.log('○ Termcast is not running.');
        console.log('  Start it with: termcast start');
      }
      process.exit(0);
    }

    if (!state.webPort) {
      if (opts.json) {
        console.log(JSON.stringify({ running: true, webUi: false, serverPid: state.pid }));
      } else {
        console.log(`\x1b[32m● Termcast running\x1b[0m (pid ${state.pid})`);
        console.log('  Detailed status needs the Web UI; restart the server to enable it.');
      }
      process.exit(0);
    }

    // Query the running server's live snapshot.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const resp = await fetch(`http://127.0.0.1:${state.webPort}/api/status`, {
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const snapshot = (await resp.json()) as StatusSnapshot;
      if (opts.json) {
        console.log(JSON.stringify(snapshot, null, 2));
      } else {
        console.log(formatStatus(snapshot, { color: process.stdout.isTTY }));
      }
    } catch (err) {
      if (opts.json) {
        console.log(JSON.stringify({ running: true, serverPid: state.pid, detailError: (err as Error).message }));
      } else {
        console.log(`\x1b[32m● Termcast running\x1b[0m (pid ${state.pid})`);
        console.log(`  \x1b[33mCould not fetch live details:\x1b[0m ${(err as Error).message}`);
      }
      process.exit(0);
    } finally {
      clearTimeout(timer);
    }
  });

program
  .command('connect')
  .description('Open one of the servers this machine is meshed to')
  .argument('[server]', 'Server name or number to open directly (skips the prompt)')
  .action(async (serverArg?: string) => {
    const { resolvePeerSelection } = await import('./connect-select.js');
    const { openUrl } = await import('./open-url.js');
    const { createInterface } = await import('node:readline');

    // Use the live-pid check (not just the file's presence) so a crashed server
    // that left a stale state.json reports "not running" instead of a confusing
    // connection error below.
    const state = readRunningState();
    if (!state) {
      console.log('Termcast is not running. Start it with: termcast start');
      process.exit(0);
    }
    if (!state.webPort) {
      console.log('Termcast is running but the Web UI is unavailable — restart the server.');
      process.exit(0);
    }

    // Fetch the mesh peer list (same source as the desktop "Peers" submenu).
    let peers: { name: string; port: number }[];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const resp = await fetch(`http://127.0.0.1:${state.webPort}/api/mesh`, { signal: controller.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      peers = (await resp.json()) as { name: string; port: number }[];
    } catch (err) {
      console.error(`\x1b[31mCould not reach the running server:\x1b[0m ${(err as Error).message}`);
      process.exit(1);
    } finally {
      clearTimeout(timer);
    }

    if (peers.length === 0) {
      console.log('No other servers available. Pair servers from the Termcast app first.');
      process.exit(0);
    }

    const open = (peer: { name: string; port: number }) => {
      const url = `http://localhost:${peer.port}`;
      console.log(`Opening ${peer.name} (${url})…`);
      openUrl(url);
    };

    // Direct form: `termcast connect <name|number>`.
    if (serverArg !== undefined) {
      const sel = resolvePeerSelection(peers, serverArg);
      if ('error' in sel) { console.error(`\x1b[31m${sel.error}\x1b[0m`); process.exit(1); }
      open(sel.peer);
      process.exit(0);
    }

    // Interactive form.
    console.log('Available servers:');
    peers.forEach((p, i) => console.log(`  ${i + 1}) ${p.name}  →  http://localhost:${p.port}`));
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`Select a server [1-${peers.length}]: `, (answer) => {
      rl.close();
      const sel = resolvePeerSelection(peers, answer);
      if ('error' in sel) { console.error(`\x1b[31m${sel.error}\x1b[0m`); process.exit(1); }
      open(sel.peer);
      process.exit(0);
    });
  });

/** Read state.json and confirm the recorded server process is alive. */
function readRunningState(): RunningState | null {
  const stateFile = join(homedir(), '.ttyd-server', 'state.json');
  if (!existsSync(stateFile)) return null;
  let raw: string;
  try {
    raw = readFileSync(stateFile, 'utf-8');
  } catch {
    return null;
  }
  const state = parseRunningState(raw);
  if (!state) return null;
  return isPidAlive(state.pid, process.kill.bind(process)) ? state : null;
}

const mesh = program
  .command('mesh')
  .description('Manage port forwards to meshed peer servers');

mesh
  .command('forward')
  .description("Expose a meshed peer's port on this machine (like ssh -L)")
  .argument('<peer>', 'Peer name (case-insensitive) or deviceId prefix')
  .argument('[spec]', "Peer's port to expose: <peerPort>[:<localPort>] (localPort defaults to peerPort)")
  .option('--remove <peerPort>', "Remove the forward for this peer port")
  .addHelpText('after', `
How it works:
  A forward makes a port running on the PEER machine reachable on THIS
  machine, tunneled over the encrypted relay:

      termcast mesh forward <peer> <peerPort>[:<localPort>]
      →  localhost:<localPort>  ->  <peer>:<peerPort>
             (on your box)            (on the peer)

  <peerPort>   the port of the service running on the peer (what to reach)
  <localPort>  the port to open on your machine (defaults to <peerPort>)

Examples:
  # Reach the peer's Postgres locally on the same port, then: psql -h localhost -p 5432
  termcast mesh forward macbook 5432

  # Local 5432 is taken — expose the peer's 5432 on localhost:15432 instead
  termcast mesh forward macbook 5432:15432

  # Forward the peer's dev server; open http://localhost:3000
  termcast mesh forward macbook 3000

  # Identify the peer by deviceId prefix instead of name
  termcast mesh forward 4f3a 3000

  # Remove a forward (use the peer's port you added)
  termcast mesh forward macbook --remove 5432

  # List peers and their forwards
  termcast mesh forwards
`)
  .action(async (peerArg: string, spec: string | undefined, opts: { remove?: string }) => {
    let change: ForwardChange;
    if (opts.remove !== undefined) {
      const remotePort = parseInt(opts.remove, 10);
      if (!isValidPort(remotePort)) {
        console.error(`\x1b[31mInvalid port: ${opts.remove}\x1b[0m`);
        process.exit(1);
      }
      change = { peer: peerArg, action: 'remove', remotePort };
    } else {
      const m = spec?.match(/^(\d+)(?::(\d+))?$/);
      if (!m) {
        console.error('\x1b[31mUsage: termcast mesh forward <peer> <peerPort>[:<localPort>]\x1b[0m');
        console.error('\x1b[2m  e.g. termcast mesh forward macbook 5432        (localhost:5432 -> macbook:5432)\x1b[0m');
        console.error('\x1b[2m       termcast mesh forward macbook 5432:15432  (localhost:15432 -> macbook:5432)\x1b[0m');
        process.exit(1);
      }
      const remotePort = parseInt(m[1], 10);
      const localPort = m[2] ? parseInt(m[2], 10) : remotePort;
      if (!isValidPort(remotePort) || !isValidPort(localPort)) {
        console.error(`\x1b[31mPorts must be 1-65535 (got ${spec})\x1b[0m`);
        process.exit(1);
      }
      change = { peer: peerArg, action: 'add', remotePort, localPort };
    }

    const describe = change.action === 'add'
      ? `localhost:${change.localPort} → ${peerArg}:${change.remotePort}`
      : `forward for ${peerArg}:${change.remotePort}`;

    const state = readRunningState();
    if (state?.webPort) {
      // Live update through the running server.
      try {
        const resp = await fetch(`http://127.0.0.1:${state.webPort}/api/mesh/forwards`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(change),
        });
        const result = (await resp.json()) as { ok: boolean; error?: string; note?: string };
        if (!result.ok) {
          console.error(`\x1b[31m${result.error ?? 'request failed'}\x1b[0m`);
          process.exit(1);
        }
        if (result.note) console.log(`\x1b[33m${result.note}\x1b[0m`);
        console.log(change.action === 'add' ? `✓ Forwarding ${describe}` : `✓ Removed ${describe}`);
      } catch (err) {
        console.error(`\x1b[31mCould not reach the running server: ${(err as Error).message}\x1b[0m`);
        process.exit(1);
      }
    } else {
      // Server not running: edit mesh-peers.json directly; applies on next start.
      const result = applyForwardChange(loadMeshPeers(), change);
      if (!result.ok) {
        console.error(`\x1b[31m${result.error}\x1b[0m`);
        process.exit(1);
      }
      saveMeshPeers(result.peers);
      if (result.note) console.log(`\x1b[33m${result.note}\x1b[0m`);
      console.log(change.action === 'add' ? `✓ Saved ${describe}` : `✓ Removed ${describe}`);
      console.log('  Server is not running — applies on next start.');
    }
  });

mesh
  .command('forwards')
  .description('List mesh peers and their port forwards')
  .action(async () => {
    interface Row { name: string; port: number; forwards?: { remotePort: number; localPort: number; state?: string; message?: string }[] }
    let rows: Row[];
    let live = false;

    const state = readRunningState();
    if (state?.webPort) {
      try {
        const resp = await fetch(`http://127.0.0.1:${state.webPort}/api/mesh`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        rows = (await resp.json()) as Row[];
        live = true;
      } catch (err) {
        console.error(`\x1b[31mCould not reach the running server: ${(err as Error).message}\x1b[0m`);
        process.exit(1);
      }
    } else {
      rows = loadMeshPeers().map(p => ({ name: p.name, port: p.localPort, forwards: p.forwards }));
      if (rows.length > 0) console.log('\x1b[33mServer is not running — showing saved configuration.\x1b[0m');
    }

    if (rows!.length === 0) {
      console.log('No meshed peers. Pair servers from the Termcast app first.');
      return;
    }
    for (const p of rows!) {
      console.log(`${p.name}  \x1b[2m→ localhost:${p.port}\x1b[0m`);
      for (const f of p.forwards ?? []) {
        const status = live ? `  ${f.state === 'active' ? '\x1b[32mactive\x1b[0m' : f.state === 'error' ? `\x1b[31merror${f.message ? ': ' + f.message : ''}\x1b[0m` : '\x1b[2mpending\x1b[0m'}` : '';
        console.log(`  localhost:${f.localPort} → :${f.remotePort}${status}`);
      }
    }
  });

const mux = program
  .command('multiplexer')
  .description('Show the detected terminal multiplexer (tmux, herdr, or none)');

// Read-only: the active multiplexer is whatever is installed, so there is
// nothing to set. `install` below is the way to change the answer.
mux.action(() => {
  const installed = detectInstalledMultiplexers();
  console.log(describeMultiplexerStatus(activeMultiplexer(installed), installed));
});

mux
  .command('install <name>')
  .description('Install a multiplexer binary: tmux or herdr')
  .action(async (name: string) => {
    if (name !== 'tmux' && name !== 'herdr') {
      console.error(`\x1b[31mNothing to install for: ${name}\x1b[0m`);
      console.error('  → Use one of: tmux, herdr');
      process.exit(1);
    }
    try {
      console.log(`Installing ${name} for ${process.platform}-${process.arch}...`);
      const path = name === 'herdr'
        ? (await downloadHerdr(join(homedir(), '.termcast', 'bin', 'herdr')), join(homedir(), '.termcast', 'bin', 'herdr'))
        : await downloadTmux();
      console.log(`✓ ${name} installed at ${path}`);
    } catch (err) {
      console.error(`\x1b[31m${name} install failed: ${(err as Error).message}\x1b[0m`);
      process.exit(1);
    }
  });

const agent = program.command('agent').description('Agent session chat controls');

agent
  .command('setup')
  .description('Install Claude Code hooks so phones can approve tool calls')
  .action(() => {
    stageHookScripts();
    installHooks(hookSettingsPath(), { hookDir: hookInstallDir() });
    // Clears any previous opt-out, so the next start stops skipping them.
    clearOptOut();
    console.log('Installed. Claude Code sessions can now be approved from a paired phone.');
    console.log('Sessions with no phone attached are unaffected. Undo with: termcast agent teardown');
  });

agent
  .command('teardown')
  .description('Remove the Claude Code hooks installed by setup')
  .action(() => {
    removeHooks(hookSettingsPath());
    // Remembered, or the next daemon start would put them straight back.
    writeOptOut();
    console.log('Removed. Tool approvals return to the terminal prompt.');
    console.log('Termcast will not re-install them. Undo with: termcast agent setup');
  });

agent
  .command('status')
  .description('Show whether phone approvals are enabled')
  .action(() => {
    let installed = false;
    try {
      installed = hooksInstalled(JSON.parse(readFileSync(hookSettingsPath(), 'utf8')));
    } catch {
      installed = false;
    }
    console.log(installed ? 'Phone approvals: enabled' : 'Phone approvals: not installed (run: termcast agent setup)');
  });

program
  .command('leave')
  .alias('eject')
  .description('Leave the cluster (self-eject). Show the QR on this machine to rejoin.')
  .action(async () => {
    const state = readRunningState();
    if (state?.webPort) {
      try {
        const resp = await fetch(`http://127.0.0.1:${state.webPort}/api/leave`, { method: 'POST' });
        const result = (await resp.json()) as { ok: boolean; error?: string };
        if (!result.ok) {
          console.error(`\x1b[31m${result.error ?? 'leave failed'}\x1b[0m`);
          process.exit(1);
        }
        console.log('✓ Left the cluster. Show the QR on this machine to rejoin.');
      } catch (err) {
        console.error(`\x1b[31mCould not reach the running server: ${(err as Error).message}\x1b[0m`);
        process.exit(1);
      }
    } else {
      if (!ejectInConfig()) {
        console.error('\x1b[31mNo server config found — nothing to leave.\x1b[0m');
        process.exit(1);
      }
      console.log('✓ Marked as left the cluster. Applies on next start; show the QR to rejoin.');
    }
  });

/**
 * Download `url` to `destPath`, overwriting atomically (temp file + rename) so a
 * partial download never leaves a corrupt binary. Mirrors scripts/download.mjs's
 * downloadToFile; reimplemented here in TS because that .mjs is not shipped in
 * the shell-install tarball, and `upgrade` must work on shell installs too.
 */
async function downloadToFile(url: string, destPath: string, mode = 0o755): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error('empty body');
  mkdirSync(dirname(destPath), { recursive: true });
  const tmp = join(dirname(destPath), `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  try {
    writeFileSync(tmp, bytes, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, destPath);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

/** Force-redownload the native binaries into <root>/bin/, overwriting stale ones. */
async function redownloadBinaries(): Promise<void> {
  const { binaryKeys, resolveBaseUrl, releaseUrl } = await import('./upgrade.js');
  const keys = binaryKeys();
  if (!keys.supported) {
    console.log(`\x1b[33m→ No prebuilt binaries for ${keys.platform}-${keys.arch}; skipping binary download.\x1b[0m`);
    return;
  }
  const base = resolveBaseUrl();
  // <root>/bin is the same dir the runtime resolves binaries from, for both the
  // npm (<pkg>/bin) and shell (~/.termcast/bin) layouts.
  const binDir = fileURLToPath(new URL('../bin/', import.meta.url));

  console.log(`→ Downloading ${keys.termcastd}…`);
  try {
    await downloadToFile(releaseUrl(base, keys.termcastd, { via: 'upgrade' }), join(binDir, keys.termcastd));
  } catch (err) {
    console.error(`\x1b[31mFailed to download ${keys.termcastd}: ${(err as Error).message}\x1b[0m`);
    console.error('  The server cannot run without it. Retry, or re-run the installer.');
    process.exit(1);
  }

  console.log(`→ Downloading ${keys.tmux}…`);
  try {
    await downloadToFile(releaseUrl(base, keys.tmux, { via: 'upgrade' }), join(binDir, keys.tmux));
  } catch (err) {
    console.log(`\x1b[33m  ${keys.tmux} unavailable (${(err as Error).message}); continuing without tmux.\x1b[0m`);
  }
}

/** Re-fetch and extract the latest server code (dist/ + package.json) for a shell install. */
async function upgradeShellServer(base: string): Promise<void> {
  const installDir = join(homedir(), '.termcast');
  console.log('→ Downloading latest server code…');
  const resp = await fetch(`${base}/releases/latest.tar.gz`, { redirect: 'follow' });
  if (!resp.ok) throw new Error(`server download failed: HTTP ${resp.status}`);
  const bytes = Buffer.from(await resp.arrayBuffer());
  if (bytes.length === 0) throw new Error('server download failed: empty body');

  const tmp = join(installDir, `.upgrade-${Date.now()}.tar.gz`);
  writeFileSync(tmp, bytes, { mode: 0o600 });
  try {
    execSync(`tar xzf '${tmp}' -C '${installDir}'`, { stdio: 'ignore' });
  } finally {
    try { unlinkSync(tmp); } catch {}
  }

  // The tarball ships dist/ + package.json only (no node_modules), so refresh
  // production deps in case any changed. Best-effort: a failure here is not fatal
  // (deps rarely change), but we tell the user how to recover.
  const nodeDir = dirname(process.execPath);
  const siblingNpm = join(nodeDir, 'npm');
  const npmBin = existsSync(siblingNpm) ? siblingNpm : 'npm';
  try {
    // The bundled npm is `#!/usr/bin/env node`, so node must be on PATH for it
    // to launch — prepend the running node's dir (the installer's bundled node
    // isn't otherwise on PATH).
    execSync(`'${npmBin}' install --omit=dev --silent`, {
      cwd: installDir,
      stdio: 'ignore',
      env: { ...process.env, PATH: `${nodeDir}:${process.env.PATH ?? ''}` },
    });
  } catch {
    console.log('\x1b[33m  Could not refresh dependencies automatically; if the server fails to start, re-run the installer.\x1b[0m');
  }
}

/** Prompt for a yes/no answer (default no). Resolves true only on y/yes. */
async function promptYesNo(question: string): Promise<boolean> {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

program
  .command('upgrade')
  .description('Download the latest Termcast binaries + server code, then restart')
  .option('--binaries-only', 'Only re-download native binaries; skip the server code update')
  .option('-y, --yes', 'Restart automatically without prompting (supervised installs)')
  .action(async (opts: { binariesOnly?: boolean; yes?: boolean }) => {
    const { detectInstall, decideRestart, resolveBaseUrl } = await import('./upgrade.js');

    // Resolve the real path of the running script (the global npm bin is a
    // symlink) so the install-kind check sees the actual install location.
    let scriptPath: string;
    try { scriptPath = realpathSync(fileURLToPath(import.meta.url)); }
    catch { scriptPath = fileURLToPath(import.meta.url); }
    const kind = detectInstall(scriptPath, homedir());

    const base = resolveBaseUrl();

    console.log(`\x1b[1mUpgrading Termcast\x1b[0m (current v${version}, ${kind} install)`);

    // 1. Pull the latest server code.
    if (!opts.binariesOnly) {
      if (kind === 'npm') {
        console.log('→ Updating @termcast/cli via npm…');
        const res = spawnSync('npm', ['install', '-g', '@termcast/cli@latest'], { stdio: 'inherit' });
        if (res.status !== 0) {
          console.error('\x1b[31mnpm update failed.\x1b[0m Run manually: npm install -g @termcast/cli@latest');
          process.exit(1);
        }
      } else {
        try {
          await upgradeShellServer(base);
        } catch (err) {
          console.error(`\x1b[31m${(err as Error).message}\x1b[0m`);
          console.error('  Re-run the installer: curl -fsSL ' + base + '/install.sh | bash');
          process.exit(1);
        }
      }
    }

    // 2. Force-refresh the native binaries (npm's idempotent postinstall would
    //    otherwise keep stale ones).
    await redownloadBinaries();

    // Report the new version where it's cheap to read (shell extract rewrote it).
    let newVersion = 'latest';
    if (kind === 'shell') {
      try {
        newVersion = (JSON.parse(readFileSync(join(homedir(), '.termcast', 'package.json'), 'utf-8')) as { version: string }).version;
      } catch {}
    }
    console.log(`\x1b[32m✓ Upgrade complete\x1b[0m (v${version} → ${kind === 'shell' ? 'v' + newVersion : newVersion})`);

    // 3. Restart handling.
    const supervisorPid = (() => {
      try {
        const pid = parseInt(readFileSync(join(homedir(), '.termcast', 'termcast.pid'), 'utf-8').trim(), 10);
        if (Number.isInteger(pid)) { try { process.kill(pid, 0); return pid; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EPERM') return pid; } }
      } catch {}
      return null;
    })();
    const wrapperPath = join(homedir(), '.termcast', 'bin', 'termcast');
    const running = readRunningState();

    const plan = decideRestart({
      supervisorAlive: supervisorPid !== null,
      wrapperExists: existsSync(wrapperPath),
      foregroundAlive: running !== null,
    });

    if (plan === 'auto') {
      const doRestart = opts.yes || await promptYesNo('\nRestart the server now to apply the upgrade? [y/N] ');
      if (doRestart) {
        console.log('→ Restarting…');
        const res = spawnSync(wrapperPath, ['restart'], { stdio: 'inherit' });
        if (res.status !== 0) {
          console.error('\x1b[31mRestart failed.\x1b[0m Restart manually: termcast restart');
          process.exit(1);
        }
      } else {
        console.log('  Apply later with: \x1b[36mtermcast restart\x1b[0m');
      }
    } else if (plan === 'manual-foreground') {
      console.log('\n\x1b[33mA server is running.\x1b[0m Stop it (Ctrl+C) and run \x1b[36mtermcast start\x1b[0m to apply the upgrade.');
    } else {
      console.log('  Start the server with: \x1b[36mtermcast start\x1b[0m');
    }
  });

/** Pull ip / location / device out of a relay client_connect payload. */
function parseClientInfo(payload: Buffer): { ip?: string; location?: string; device?: string } {
  try {
    const info = JSON.parse(payload.toString());
    const out: { ip?: string; location?: string; device?: string } = {};
    if (info.ip) out.ip = String(info.ip);
    if (info.city && info.country) out.location = `${info.city}, ${info.country}`;
    else if (info.country) out.location = String(info.country);
    const device = parseUserAgent(info.ua || '');
    if (device) out.device = device;
    return out;
  } catch {
    return {};
  }
}

function parseUserAgent(ua: string): string {
  if (/termcast-mesh/.test(ua)) return 'Server';
  // The iOS app's URLSession default UA is "ttyd_mobile/<build> CFNetwork/… Darwin/…"
  if (/ttyd_mobile/.test(ua)) return 'iPhone';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return '';
}

program.parse(process.argv, { from: 'node' });
