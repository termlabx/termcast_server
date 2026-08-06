import { BrowserWindow } from 'electron';
import type { AgentLogEvent } from './server-agent-log-parser.js';
import { AgentLogRing } from './agent-log-ring.js';
import { formatAgentLogRow } from './agent-log-format.js';

/** Live trace of the agent frames flowing between the phone and this server.
 *  The relay prints one `[agent]`/`[attach]` line per frame; main.ts parses
 *  those and feeds them here. Events are ringed even while the window is shut
 *  so opening it shows the recent traffic rather than an empty pane. */
const ring = new AgentLogRing(2000);
let window: BrowserWindow | null = null;
// `appendRow` only exists once the page has run its script. Painting before
// then would queue a call that resolves after load and double-render the row
// the did-finish-load replay already drew.
let loaded = false;

const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  :root { color-scheme: dark; }
  body { background:#1a1b26; color:#c0caf5; font-family:Menlo,monospace; font-size:12px;
    margin:0; height:100vh; display:flex; flex-direction:column; }
  header { display:flex; gap:8px; align-items:center; padding:8px; border-bottom:1px solid #2a2b3d;
    background:#16161e; flex:none; }
  input { flex:1; background:#1a1b26; border:1px solid #2a2b3d; border-radius:5px; color:#c0caf5;
    font:inherit; padding:4px 8px; }
  input::placeholder { color:#565f89; }
  button { background:#2a2b3d; border:0; border-radius:5px; color:#c0caf5; font:inherit;
    padding:4px 10px; cursor:pointer; }
  button:hover { background:#3b3d57; }
  #count { color:#565f89; white-space:nowrap; }
  #log { flex:1; overflow-y:auto; padding:6px 8px; }
  .row { display:flex; gap:8px; padding:1px 0; align-items:baseline; }
  .row.hidden { display:none; }
  .t { color:#565f89; white-space:nowrap; }
  .d { width:1em; text-align:center; flex:none; font-weight:bold; }
  .in .d { color:#9ece6a; }
  .out .d { color:#7aa2f7; }
  .s { color:#bb9af7; white-space:nowrap; }
  .ty { color:#e0af68; white-space:nowrap; }
  .de { color:#c0caf5; word-break:break-word; white-space:pre-wrap; flex:1; }
  .err .ty, .err .de { color:#f7768e; }
  #empty { color:#565f89; padding:12px 8px; }
</style></head><body>
<header>
  <input id="filter" type="search" placeholder="Filter (session, type, text)…" autocomplete="off">
  <span id="count">0</span>
  <button id="clear">Clear</button>
</header>
<div id="log"><div id="empty">Waiting for agent traffic… Open an agent chat on your phone.</div></div>
<script>
  const log = document.getElementById('log');
  const empty = document.getElementById('empty');
  const filterBox = document.getElementById('filter');
  const count = document.getElementById('count');
  let paused = false;
  let filter = '';
  let total = 0;

  function matches(row) { return !filter || row.dataset.search.includes(filter); }

  function appendRow(data) {
    if (empty) empty.remove();
    const row = document.createElement('div');
    row.className = 'row ' + data.direction + (data.type.endsWith('error') ? ' err' : '');
    row.dataset.search = data.search;
    for (const [cls, text] of [['t', data.time], ['d', data.direction === 'in' ? '\\u2192' : '\\u2190'],
                               ['s', data.scope], ['ty', data.type], ['de', data.detail]]) {
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = text;
      row.appendChild(span);
    }
    if (!matches(row)) row.classList.add('hidden');
    log.appendChild(row);
    total += 1;
    count.textContent = String(total);
    // The ring caps the main-process history; cap the DOM too so a long-running
    // session cannot grow the window's memory without bound.
    while (log.childNodes.length > 4000) log.removeChild(log.firstChild);
    if (!paused) log.scrollTop = log.scrollHeight;
  }

  log.addEventListener('scroll', () => {
    paused = log.scrollTop + log.clientHeight < log.scrollHeight - 40;
  });
  filterBox.addEventListener('input', () => {
    filter = filterBox.value.trim().toLowerCase();
    for (const row of log.children) {
      if (!row.dataset) continue;
      row.classList.toggle('hidden', !matches(row));
    }
  });
  document.getElementById('clear').addEventListener('click', () => {
    log.textContent = '';
    total = 0;
    count.textContent = '0';
  });
</script></body></html>`;

function paint(event: AgentLogEvent): void {
  if (!window || window.isDestroyed() || !loaded) return;
  const row = JSON.stringify(formatAgentLogRow(event));
  // Fire-and-forget: the window can close mid-flight, and a dropped trace row
  // must never take down the tray process.
  window.webContents.executeJavaScript(`appendRow(${row})`).catch(() => {});
}

export function pushAgentLogEvent(event: AgentLogEvent): void {
  ring.push(event);
  paint(event);
}

export function openAgentLogWindow(): void {
  if (window && !window.isDestroyed()) { window.focus(); return; }

  window = new BrowserWindow({
    width: 900,
    height: 720,
    resizable: true,
    center: true,
    title: 'Agent Log',
    backgroundColor: '#1a1b26',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  loaded = false;
  window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  window.webContents.on('did-finish-load', () => {
    loaded = true;
    for (const event of ring.all()) paint(event);
  });
  window.on('closed', () => { window = null; loaded = false; });
}

export function closeAgentLogWindow(): void {
  if (window && !window.isDestroyed()) window.close();
}
