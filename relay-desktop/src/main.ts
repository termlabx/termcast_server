/*
 * Termcast Server — the macOS menu-bar app
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
import { app, Tray, Menu, nativeImage, nativeTheme, net, BrowserWindow, powerSaveBlocker, dialog, Notification, shell } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, createWriteStream, renameSync, statSync, WriteStream } from 'node:fs';
import { homedir } from 'node:os';
import { spawn, ChildProcess } from 'node:child_process';
import { parseClientLogEvents, parseMultiplexerLogEvent } from './server-log-parser';
import { forwardLabel, versionLabel, statusDot, clientLabel, clientDetailLines, clientDevice, isServerClient, peerDetailLines, trayTooltip, type ForwardState } from './tray-format';
import { trayStatus, type TrayStatus } from './tray-status';
import { trayIconFile } from './tray-icons';

interface Settings {
  openAtLogin: boolean;
  preventSleep: boolean;
  serverWasRunning: boolean;
  /**
   * Relay to connect to, e.g. "wss://relay.example.com". There is no default —
   * the daemon refuses to start without one. Launched from Finder we inherit no
   * shell env, so this setting (not TERMCAST_RELAY_URL) is the primary channel.
   */
  relayUrl: string;
}

const settingsPath = join(app.getPath('userData'), 'settings.json');

// ---- Logging ----------------------------------------------------------------

let logStream: WriteStream | null = null;

function setupLogging(): void {
  const logsDir = app.getPath('logs');
  mkdirSync(logsDir, { recursive: true });
  const logPath = join(logsDir, 'main.log');

  // Rotate if > 5 MB
  try {
    if (statSync(logPath).size > 5 * 1024 * 1024) {
      renameSync(logPath, join(logsDir, 'main.1.log'));
    }
  } catch { /* file doesn't exist yet */ }

  logStream = createWriteStream(logPath, { flags: 'a' });

  const writeLine = (level: string, args: unknown[]) => {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    logStream!.write(`[${new Date().toISOString()}] [${level}] ${msg}\n`);
  };

  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);
  console.log = (...args: unknown[]) => { origLog(...args); writeLine('INFO', args); };
  console.error = (...args: unknown[]) => { origError(...args); writeLine('ERROR', args); };

  console.log(`Log file: ${logPath}`);
}

function log(msg: string, data?: Record<string, unknown>): void {
  const suffix = data ? ' ' + JSON.stringify(data) : '';
  console.log(`[DBG] ${msg}${suffix}`);
}

function loadSettings(): Settings {
  try {
    return { openAtLogin: false, preventSleep: false, serverWasRunning: true, ...JSON.parse(readFileSync(settingsPath, 'utf-8')) };
  } catch {
    return { openAtLogin: false, preventSleep: false, serverWasRunning: true, relayUrl: '' };
  }
}

function saveSettings(settings: Settings): void {
  mkdirSync(join(settingsPath, '..'), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

function notify(title: string, body: string): void {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
}

function showError(title: string, message: string, restartAfter = false): void {
  // showErrorBox is modal and blocks until the user clicks OK.
  dialog.showErrorBox(title, message);
  if (restartAfter && !serverProcess) {
    log('Restarting server after error dialog dismissed', { title });
    startServer();
  }
}

let tray: Tray | null = null;
let serverProcess: ChildProcess | null = null;
let serverStarting = false;
let serverRunning = false;
const connectedClients = new Map<number, { info: string | null }>();
let webUIUrl: string | null = null;
let qrWindow: BrowserWindow | null = null;
let qrButtonDisabled = false;
let qrCountdown = 0;
let qrCountdownTimer: ReturnType<typeof setInterval> | null = null;
let meshPeers: { name: string; port: number; connected?: boolean; ip?: string; location?: string; forwards?: ForwardState[] }[] = [];
let serverVersion: string | null = null;
let meshPollTimer: ReturnType<typeof setInterval> | null = null;
let forwardsWindow: BrowserWindow | null = null;
let multiplexerWindow: BrowserWindow | null = null;
let sleepBlockerId: number | null = null;
// Relay reachability behind the tray badge: null until /api/status (or a relay
// log line) says otherwise. relayDownSince anchors the grace window that keeps a
// routine reconnect from flashing the badge red.
let relayConnected: boolean | null = null;
let relayDownSince: number | null = null;

function setRelayConnected(connected: boolean | null): void {
  relayConnected = connected;
  if (connected) {
    relayDownSince = null;
  } else if (relayDownSince === null) {
    relayDownSince = Date.now();
  }
}

/** Clear relay state across a server restart, so a fresh start doesn't inherit a
 *  stale relayDownSince and jump straight to a red badge. */
function resetRelayState(): void {
  relayConnected = null;
  relayDownSince = null;
}

function currentTrayStatus(): TrayStatus {
  return trayStatus({
    serverStarting,
    serverRunning,
    relayConnected,
    relayDownMs: relayDownSince === null ? 0 : Date.now() - relayDownSince,
  });
}

function setOpenAtLogin(enabled: boolean): void {
  app.setLoginItemSettings({ openAtLogin: enabled });
  const s = loadSettings();
  s.openAtLogin = enabled;
  saveSettings(s);
  updateTray();
}

function setPreventSleep(enabled: boolean): void {
  log('setPreventSleep', { enabled });
  if (enabled && sleepBlockerId === null) {
    sleepBlockerId = powerSaveBlocker.start('prevent-display-sleep');
    log('Power save blocker started', { id: sleepBlockerId });
  } else if (!enabled && sleepBlockerId !== null) {
    powerSaveBlocker.stop(sleepBlockerId);
    log('Power save blocker stopped', { id: sleepBlockerId });
    sleepBlockerId = null;
  }
  const s = loadSettings();
  s.preventSleep = enabled;
  saveSettings(s);
  updateTray();
}

function closeQRWindow(): void {
  if (qrWindow) {
    qrWindow.close();
  }
  if (qrCountdownTimer) {
    clearInterval(qrCountdownTimer);
    qrCountdownTimer = null;
  }
  qrButtonDisabled = false;
  qrCountdown = 0;
}

function showQRPopup(): void {
  if (qrButtonDisabled || !webUIUrl) return;

  qrButtonDisabled = true;
  qrCountdown = 60;
  updateTray();

  // Clicking "Show QR" is the human-at-the-machine consent event: mint a fresh
  // single-use token (?new=1) so this QR is single-use and mesh consent re-anchors.
  const qrUrl = `${webUIUrl}/api/pairing?new=1`;
  log('QR fetch', { url: qrUrl });
  net.fetch(qrUrl)
    .then(r => {
      log('QR fetch response', { status: r.status, ok: r.ok });
      return r.json() as Promise<{ qr?: string }>;
    })
    .then(data => {
      if (!data.qr) {
        log('QR fetch returned no qr field');
        qrButtonDisabled = false;
        qrCountdown = 0;
        updateTray();
        return;
      }
      log('QR data received', { qrLength: data.qr.length });

      qrWindow = new BrowserWindow({
        width: 300,
        height: 360,
        resizable: false,
        center: true,
        alwaysOnTop: true,
        title: 'Scan QR Code',
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
        },
      });

      const html = `<!DOCTYPE html>
<html><head><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  background: #1a1b26;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  height: 100vh;
  font-family: -apple-system, system-ui, sans-serif;
}
img { border-radius: 8px; }
p { color: #787c99; font-size: 12px; margin-top: 10px; }
#countdown { color: #565f89; font-size: 24px; margin-top: 8px; font-variant-numeric: tabular-nums; }
</style></head><body>
<img src="${data.qr}" width="250">
<p>Scan to pair</p>
<div id="countdown">60s</div>
<script>
  let t = 60;
  const el = document.getElementById('countdown');
  setInterval(() => { if (--t > 0) el.textContent = t + 's'; }, 1000);
</script>
</body></html>`;

      qrWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

      // Countdown timer — update menu every second
      qrCountdownTimer = setInterval(() => {
        qrCountdown--;
        updateTray();
        if (qrCountdown <= 0) {
          qrWindow?.close();
        }
      }, 1000);

      qrWindow.on('closed', () => {
        if (qrCountdownTimer) {
          clearInterval(qrCountdownTimer);
          qrCountdownTimer = null;
        }
        qrWindow = null;
        qrButtonDisabled = false;
        qrCountdown = 0;
        updateTray();
      });
    })
    .catch((err: unknown) => {
      log('QR fetch failed', { error: err instanceof Error ? err.message : String(err) });
      qrButtonDisabled = false;
      qrCountdown = 0;
      updateTray();
    });
}

/** Poll the running server for peers + live forward states, and for relay
 *  reachability behind the tray badge. Both ride the same timer — one interval,
 *  not two, to keep idle wakeups down. */
function startMeshPoll(): void {
  stopMeshPoll();
  const poll = () => {
    if (!webUIUrl) return;
    net.fetch(`${webUIUrl}/api/mesh`)
      .then(r => r.json() as Promise<typeof meshPeers>)
      .then(peers => { meshPeers = peers; updateTray(); })
      .catch(() => { /* transient — keep last data */ });
    fetchServerStatus();
  };
  poll();
  meshPollTimer = setInterval(poll, 10_000);
}

function stopMeshPoll(): void {
  if (meshPollTimer) { clearInterval(meshPollTimer); meshPollTimer = null; }
}

/** One fetch feeds both the version label and the tray badge. A failed fetch
 *  means the local Web UI is unreachable, which is itself a "relay unknown"
 *  signal — it goes through the same grace window as an explicit disconnect. */
function fetchServerStatus(): void {
  if (!webUIUrl) return;
  net.fetch(`${webUIUrl}/api/status`)
    .then(r => r.json() as Promise<{ version?: string; relay?: { connected?: boolean } }>)
    .then(s => {
      serverVersion = s.version ?? null;
      setRelayConnected(s.relay?.connected ?? null);
      updateTray();
    })
    .catch(() => { setRelayConnected(null); updateTray(); });
}

function leaveCluster(): void {
  if (!webUIUrl) return;
  net.fetch(`${webUIUrl}/api/leave`, { method: 'POST' })
    .then(r => r.json() as Promise<{ ok?: boolean }>)
    .then(res => { log('leave cluster', { ok: res.ok }); meshPeers = []; updateTray(); })
    .catch((err: unknown) => log('leave cluster failed', { error: err instanceof Error ? err.message : String(err) }));
}

function showForwardsWindow(): void {
  if (!webUIUrl) return;
  if (forwardsWindow) { forwardsWindow.focus(); return; }
  forwardsWindow = new BrowserWindow({
    width: 420,
    height: 560,
    resizable: true,
    center: true,
    alwaysOnTop: true,
    title: 'Port Forwards',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  forwardsWindow.loadURL(`${webUIUrl}/forwards`);
  forwardsWindow.on('closed', () => { forwardsWindow = null; });
}

function showMultiplexerWindow(): void {
  if (!webUIUrl) return;
  if (multiplexerWindow) { multiplexerWindow.focus(); return; }
  multiplexerWindow = new BrowserWindow({
    width: 420,
    height: 460,
    resizable: true,
    center: true,
    alwaysOnTop: true,
    title: 'Terminal Multiplexer',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  multiplexerWindow.loadURL(`${webUIUrl}/multiplexer`);
  multiplexerWindow.on('closed', () => { multiplexerWindow = null; });
}

/** Path to the plain template glyph — Windows/Linux, and the darwin fallback. */
function templateIconPath(): string {
  return join(__dirname, '..', 'assets', 'trayTemplate.png');
}

/**
 * Swap in the badged icon for the current status. macOS flattens template
 * images to one tint, so a coloured badge means leaving template mode and
 * colouring the glyph ourselves from the app appearance. That tracks the menu
 * bar in every ordinary setup, but not when macOS darkens the menu bar on its
 * own (Light Mode over a dark desktop picture) — the accepted cost of colour.
 *
 * A missing or undecodable asset falls back to today's template icon rather
 * than leaving an invisible tray item.
 */
function applyTrayIcon(status: TrayStatus): void {
  if (!tray) return;

  if (process.platform !== 'darwin') {
    const plain = nativeImage.createFromPath(templateIconPath());
    plain.setTemplateImage(true);
    tray.setImage(plain);
    return;
  }

  const file = trayIconFile(status, nativeTheme.shouldUseDarkColors);
  const badged = nativeImage.createFromPath(join(__dirname, '..', 'assets', file));
  if (badged.isEmpty()) {
    log('Tray icon asset missing — falling back to template', { file });
    const plain = nativeImage.createFromPath(templateIconPath());
    plain.setTemplateImage(true);
    tray.setImage(plain);
    return;
  }
  badged.setTemplateImage(false);
  tray.setImage(badged);
}

function updateTray(): void {
  if (!tray) return;

  // Real connected devices = connected mesh peers (servers) + inbound clients
  // that aren't the return leg of a mesh link (iPhones, etc.). A meshed peer is
  // counted once via its named row, never again as its inbound "Server" client.
  const connectedPeerCount = meshPeers.filter(p => p.connected).length;
  const phoneClients = [...connectedClients.values()].filter(e => !isServerClient(e.info));
  const deviceCount = connectedPeerCount + phoneClients.length;
  const status = currentTrayStatus();
  applyTrayIcon(status);
  if (process.platform === 'darwin') {
    tray.setTitle(deviceCount > 0 ? ` 🔵${deviceCount}` : '');
  }
  tray.setToolTip(trayTooltip(status, deviceCount));

  const menuItems: Electron.MenuItemConstructorOptions[] = [];

  // --- Status section ---
  if (serverStarting) {
    menuItems.push({ label: '🟡  Server is starting...', enabled: false });
  } else if (serverRunning) {
    menuItems.push({ label: '🟢  Server is running', enabled: false });
    // The server can be up while the relay isn't — phones can't reach it then,
    // so say so rather than leaving "running" to imply reachable.
    if (status !== 'connected') {
      menuItems.push({
        label: status === 'offline' ? '🔴  Relay unreachable' : '🔄  Connecting to relay...',
        enabled: false,
      });
    }
  } else {
    menuItems.push({ label: '🔴  Server is stopped', enabled: false });
  }

  menuItems.push({ type: 'separator' });

  // --- QR Code (available whenever the server is running, even with clients
  // connected, so additional phones can pair on demand) ---
  if (serverStarting || serverRunning) {
    const qrReady = serverRunning && webUIUrl && !qrButtonDisabled;
    let qrLabel = '📱  Show QR Code';
    if (qrButtonDisabled && qrCountdown > 0) qrLabel = `📱  Show QR Code (${qrCountdown}s)`;
    menuItems.push({
      label: qrLabel,
      enabled: !!qrReady,
      click: () => showQRPopup(),
    });
    menuItems.push({ type: 'separator' });
  }

  // --- Server controls ---
  if (serverStarting || serverRunning) {
    menuItems.push({
      label: '⏹  Stop Server',
      click: () => stopServer(),
    });
  } else {
    menuItems.push({
      label: '▶️  Start Server',
      click: () => startServer(),
    });
  }

  menuItems.push({ type: 'separator' });

  // --- Settings ---
  const settings = loadSettings();
  const openAtLogin = settings.openAtLogin;
  const preventSleep = settings.preventSleep;
  menuItems.push({
    label: 'Launch at Login',
    type: 'checkbox',
    checked: openAtLogin,
    click: () => setOpenAtLogin(!openAtLogin),
  });
  menuItems.push({
    label: 'Prevent Sleep',
    type: 'checkbox',
    checked: preventSleep,
    click: () => setPreventSleep(!preventSleep),
  });

  // --- Connections list: local machine, mesh servers, connected iPhones ---
  if (serverRunning) {
    menuItems.push({ type: 'separator' });
    menuItems.push({
      label: 'This machine (terminal)',
      click: () => shell.openExternal('http://localhost:7681'),
    });

    // Mesh servers (other Macs/Linux). Green when the mesh socket is up, else
    // yellow. Details show IP/Location (from the peer's inbound leg) + Device;
    // status is conveyed by the dot, not a text line.
    for (const peer of meshPeers) {
      const connected = peer.connected ?? false;
      const detailLines: Electron.MenuItemConstructorOptions[] =
        peerDetailLines(peer).map(l => ({ label: l, enabled: false }));
      for (const f of peer.forwards ?? []) detailLines.push({ label: forwardLabel(f), enabled: false });
      menuItems.push({
        label: `${statusDot(connected)} ${peer.name}`,
        submenu: [
          { label: 'Open in Browser', click: () => shell.openExternal(`http://localhost:${peer.port}`) },
          { label: 'Details', submenu: detailLines },
        ],
      });
    }

    // Connected iPhones (clients). Only present while connected, so always green.
    // Inbound "Server" connections are the return leg of a mesh link and are
    // already shown as a named peer above, so skip them here.
    for (const [, entry] of connectedClients) {
      if (clientDevice(entry.info) === 'Server') continue;
      menuItems.push({
        label: `${statusDot(true)} ${clientLabel(entry.info)}`,
        submenu: [
          { label: 'Details', submenu: clientDetailLines(entry.info).map(l => ({ label: l, enabled: false })) },
        ],
      });
    }
  }

  // The multiplexer is a machine setting, so it is offered whenever the server
  // is up — unlike port forwards, which only make sense with peers.
  if (serverRunning) {
    menuItems.push({ type: 'separator' });
    menuItems.push({ label: 'Terminal Multiplexer…', click: () => showMultiplexerWindow() });
  }

  // --- Port forwards section (manages forwards across all peers) ---
  if (serverRunning && meshPeers.length > 0) {
    menuItems.push({ type: 'separator' });
    menuItems.push({ label: 'Manage Port Forwards…', click: () => showForwardsWindow() });
    menuItems.push({ label: 'Leave cluster', click: () => leaveCluster() });
  }

  menuItems.push({ type: 'separator' });
  menuItems.push({
    label: '⚙︎  Relay settings…',
    // Materialise the file first: on a fresh install nothing has written it yet
    // and openPath on a missing path silently does nothing.
    click: () => { saveSettings(loadSettings()); shell.openPath(settingsPath); },
  });
  menuItems.push({
    label: '💬  Support on Discord',
    click: () => shell.openExternal('https://discord.gg/MZkhBDJKf'),
  });
  menuItems.push({ label: versionLabel(app.getVersion(), serverVersion), enabled: false });
  menuItems.push({
    label: '⏻  Quit Termcast Desktop',
    click: () => { stopServer(false).then(() => app.exit(0)); },
  });

  tray.setContextMenu(Menu.buildFromTemplate(menuItems));
}

function createTray(): void {
  const icon = nativeImage.createFromPath(templateIconPath());
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  // The badged icons are drawn per appearance, so re-pick one when the system
  // flips between light and dark.
  nativeTheme.on('updated', () => updateTray());
  updateTray();
}

function startServer(saveState = true): void {
  if (serverProcess) return;

  if (saveState) {
    const s = loadSettings();
    s.serverWasRunning = true;
    saveSettings(s);
  }

  const serverBase = app.isPackaged
    ? join(process.resourcesPath, 'relay-server')
    : join(__dirname, '..', '..', 'relay-server');
  const serverPath = join(serverBase, 'dist', 'index.js');

  // Use Electron's bundled Node.js so we don't depend on system node
  // (nvm/volta/fnm paths aren't in PATH when launched from Finder)
  // Termcast ships no default relay. Prefer the saved setting over any inherited
  // env, since launching from Finder gives us no shell environment at all.
  const relayUrl = (loadSettings().relayUrl || process.env.TERMCAST_RELAY_URL || '').trim();
  if (!relayUrl) {
    log('No relay configured — not spawning server');
    serverStarting = false;
    serverRunning = false;
    updateTray();
    showError(
      'No relay configured',
      'Termcast does not ship a default relay.\n\n'
      + `Add your relay to:\n${settingsPath}\n\n`
      + 'e.g.  "relayUrl": "wss://relay.example.com"\n\n'
      + 'Then start the server again.',
    );
    return;
  }

  const env: Record<string, string | undefined> = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    TERMCAST_RELAY_URL: relayUrl,
  };
  if (app.isPackaged) {
    const extraPaths = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/opt/local/bin'];
    env.PATH = [...extraPaths, env.PATH].join(':');
  }

  log('Spawning relay server', { execPath: process.execPath, serverPath, cwd: serverBase, PATH: env.PATH });

  serverProcess = spawn(process.execPath, [serverPath, 'start'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: serverBase,
    env,
  });

  log('Server process spawned', { pid: serverProcess.pid });

  serverStarting = true;
  serverRunning = false;
  connectedClients.clear();
  webUIUrl = null;
  resetRelayState();
  updateTray();

  let stderrBuffer = '';

  serverProcess.stderr?.on('data', (data: Buffer) => {
    const text = data.toString();
    console.error(text.trimEnd());
    // Strip Chromium/Electron internal log lines (e.g. "[0531/214601.501128:ERROR:codesign_util.cc(109)]")
    // and tmux noise — neither belongs in the user-facing crash dialog.
    const meaningful = text.split('\n')
      .filter(l => !/^\[\d{4}\/\d{6,}[.:]\d+:\w+:[^\]]+\]/.test(l) && !l.includes('tmux'))
      .join('\n');
    stderrBuffer += meaningful;
  });

  serverProcess.stdout?.on('data', (data: Buffer) => {
    const line = data.toString();
    console.log(line.trimEnd());

    const urlMatch = line.match(/Web UI: (http:\/\/[^\s]+)/);
    if (urlMatch) {
      webUIUrl = urlMatch[1].replace(/\/$/, '');
      serverStarting = false;
      serverRunning = true;
      log('Server ready', { webUIUrl });
      startMeshPoll(); // polls /api/mesh and /api/status immediately, then every 10 s
      updateTray();
    }

    for (const ev of parseClientLogEvents(line)) {
      if (ev.kind === 'connected') {
        if (!connectedClients.has(ev.id)) connectedClients.set(ev.id, { info: null });
        log('Client connected', { id: ev.id, active: connectedClients.size });
        updateTray();
      } else if (ev.kind === 'info') {
        const entry = connectedClients.get(ev.id) ?? { info: null };
        entry.info = ev.info;
        connectedClients.set(ev.id, entry);
        log('Client info updated', { id: ev.id, info: ev.info });
        updateTray();
      } else if (ev.kind === 'disconnected') {
        connectedClients.delete(ev.id);
        log('Client disconnected', { id: ev.id, active: connectedClients.size });
        updateTray();
      } else if (ev.kind === 'pairing-consumed') {
        // A device claimed the current QR — the code is now single-use spent,
        // so close the popup. Keyed to grant consumption (not a client connect),
        // so a QR opened to add another device isn't closed by a reconnect.
        log('Pairing consumed — closing QR window');
        closeQRWindow();
      }
    }

    if (line.includes('Disconnected from relay')) {
      // Relay WebSocket dropped — auto-reconnect is in progress, no user notification needed
      log('Relay WebSocket disconnected — waiting for reconnect');
      connectedClients.clear();
      // Drive the badge off the log line so it reacts immediately; the 10 s
      // /api/status poll then reconciles.
      setRelayConnected(false);
      updateTray();
    }

    if (line.includes('Reconnecting to relay')) {
      log('Relay reconnect attempt in progress');
    }

    if (line.includes('Connected to relay') || line.includes('Reconnected to relay')) {
      log('Relay WebSocket connected/reconnected');
      setRelayConnected(true);
      updateTray();
    }


    // herdr is fetched lazily the first time it is selected (~17MB), so surface
    // progress — otherwise the first switch looks like a hang.
    const muxEvent = parseMultiplexerLogEvent(line);
    if (muxEvent === 'herdr-downloading') {
      log('herdr not found — download triggered');
      notify('Termcast', 'Downloading herdr...');
    } else if (muxEvent === 'herdr-ready') {
      log('herdr ready');
      notify('Termcast', 'herdr downloaded and ready');
    } else if (muxEvent === 'herdr-unavailable') {
      log('herdr unavailable');
      notify('Termcast', 'herdr could not be installed — keeping the current multiplexer.');
    }

    if (line.includes('tmux not found — downloading')) {
      log('tmux not found — download triggered');
      notify('Termcast', 'Downloading tmux...');
    }

    if (line.includes('tmux ready')) {
      log('tmux ready');
      notify('Termcast', 'tmux downloaded and ready');
    }

    const meshLines = line.matchAll(/Mesh peer: ([^|]+)\|(\d+)/g);
    for (const m of meshLines) {
      const name = m[1].trim();
      const port = parseInt(m[2], 10);
      if (!meshPeers.some(p => p.name === name)) {
        log('Mesh peer discovered', { name, port });
        meshPeers.push({ name, port, connected: false });
        updateTray();
      }
    }

    if (line.includes('tmux not available') || line.includes('tmux unavailable')) {
      log('tmux not available');
      notify('Termcast', 'tmux not installed — terminal will use basic shell.\nFor the best experience: brew install tmux');
    }
  });

  serverProcess.on('error', (err) => {
    log('Server process error', { message: err.message, code: (err as NodeJS.ErrnoException).code });
    serverProcess = null;
    serverStarting = false;
    serverRunning = false;
    connectedClients.clear();
    webUIUrl = null;
    resetRelayState();
    updateTray();
    showError('Server Failed to Start', `Could not launch server process: ${err.message}`);
  });

  serverProcess.on('exit', (code, signal) => {
    const wasStarting = serverStarting;
    log('Server process exited', { code, signal, wasStarting, stderrBytes: stderrBuffer.length });
    if (stderrBuffer.trim()) {
      console.error('[server stderr]\n' + stderrBuffer.trim());
    }
    serverProcess = null;
    serverStarting = false;
    serverRunning = false;
    connectedClients.clear();
    webUIUrl = null;
    meshPeers = [];
    stopMeshPoll();
    serverVersion = null;
    resetRelayState();
    forwardsWindow?.close();
  multiplexerWindow?.close();
    updateTray();

    if (code !== 0 && code !== null) {
      // Extract a user-friendly message from stderr
      let message = `Server exited with code ${code}.`;
      if (stderrBuffer.includes('Port') && stderrBuffer.includes('in use')) {
        message = 'Port 7681 is already in use. Kill the other process or change the port.';
      } else if (stderrBuffer.includes('quota exceeded') || stderrBuffer.includes('HTTP 429') || stderrBuffer.includes('1027')) {
        message = 'Cloudflare Workers daily request limit exceeded.\n\nThe relay resets at midnight UTC.\nTo remove the cap: upgrade at cloudflare.com/workers.';
      } else if (stderrBuffer.includes('Cannot reach relay') || stderrBuffer.includes('ENOTFOUND') || stderrBuffer.includes('ECONNREFUSED')) {
        message = 'Cannot reach the relay server. Check your internet connection and that the relay is running.';
      } else if (stderrBuffer.includes('registration failed')) {
        const httpMatch = stderrBuffer.match(/registration failed \(HTTP (\d+)\)/);
        message = httpMatch
          ? `Relay rejected the connection (HTTP ${httpMatch[1]}). Check the relay URL and server logs.`
          : 'Failed to register with relay server.';
      } else if (stderrBuffer.includes('libwebsockets') || stderrBuffer.includes('dlopen') || stderrBuffer.includes('evlib')) {
        message = 'Missing system library (libwebsockets).\n\nRun: brew install libwebsockets\nOr reinstall Termcast.';
      } else if (stderrBuffer.trim()) {
        // Use the first non-empty meaningful line
        const firstLine = stderrBuffer.trim()
          .split('\n')
          .map(l => l.replace(/\x1b\[[0-9;]*m/g, '').trim())
          .find(l => l.length > 0);
        message = firstLine ?? `Server exited with code ${code}.`;
      }
      showError('Server Failed to Start', message, true);
    } else if (signal) {
      showError('Server Crashed', `Server was terminated by signal ${signal}.\n\nPlease restart Termcast.`);
    } else if (wasStarting) {
      showError('Server Failed to Start', 'Server process exited unexpectedly.', true);
    }
  });
}

function killOrphanTtyd(): void {
  const pidFile = join(homedir(), '.termcast', 'ttyd.pid');
  try {
    const { pid } = JSON.parse(readFileSync(pidFile, 'utf-8')) as { pid: number };
    try { process.kill(pid, 'SIGTERM'); } catch {}
    setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch {} }, 3000).unref();
    try { unlinkSync(pidFile); } catch {}
  } catch {}
}

function stopServer(saveState = true): Promise<void> {
  log('Stopping server', { saveState, hadProcess: !!serverProcess });
  if (saveState) {
    const s = loadSettings();
    s.serverWasRunning = false;
    saveSettings(s);
  }

  const proc = serverProcess;
  serverProcess = null;
  serverStarting = false;
  serverRunning = false;
  connectedClients.clear();
  webUIUrl = null;
  meshPeers = [];
  stopMeshPoll();
  serverVersion = null;
  resetRelayState();
  forwardsWindow?.close();
  multiplexerWindow?.close();
  closeQRWindow();
  updateTray();

  if (!proc || proc.killed) {
    killOrphanTtyd();
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      killOrphanTtyd();
      resolve();
    }, 8000);

    proc.once('exit', () => {
      clearTimeout(timeout);
      killOrphanTtyd();
      resolve();
    });

    proc.kill('SIGTERM');
  });
}

app.whenReady().then(() => {
  setupLogging();
  log('App starting', {
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
  });

  if (process.platform === 'darwin') {
    app.dock?.hide();
  }

  // Restore persisted settings
  const settings = loadSettings();
  log('Settings loaded', settings as unknown as Record<string, unknown>);

  if (settings.openAtLogin) {
    app.setLoginItemSettings({ openAtLogin: true });
  }
  if (settings.preventSleep) {
    sleepBlockerId = powerSaveBlocker.start('prevent-display-sleep');
    log('Power save blocker started at launch');
  }

  createTray();
  if (settings.serverWasRunning) {
    startServer(false);
  }
});

app.on('window-all-closed', () => {
  // Tray-only app — no windows to manage
});

let isQuitting = false;
app.on('before-quit', (event) => {
  if (isQuitting) return;
  isQuitting = true;
  log('App quitting');
  event.preventDefault();
  qrWindow?.close();
  stopServer(false).then(() => {
    log('Quit — all done');
    app.exit(0);
  });
});
