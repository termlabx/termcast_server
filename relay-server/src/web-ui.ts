import { createServer, Server } from 'node:http';
import { createConnection } from 'node:net';
import { PairingInfo, getQRCodeDataURL, getQRCodeText } from './pairing.js';

export class WebUI {
  private server: Server | null = null;
  private pairing: PairingInfo | null = null;
  private regenerateCallback: (() => Promise<PairingInfo>) | null = null;
  private meshPeersProvider: () => unknown = () => [];
  private ttydPort = 7681;
  private statusProvider: (() => unknown) | null = null;
  private boundPort = 0;

  setTtydPort(port: number): void {
    this.ttydPort = port;
  }

  /** Supplies the live snapshot served at GET /api/status. */
  setStatusProvider(fn: () => unknown): void {
    this.statusProvider = fn;
  }

  /** The port the Web UI actually bound to (0 until started). */
  get port(): number {
    return this.boundPort;
  }

  /** Static peer list (kept for back-compat); prefer setMeshPeersProvider. */
  setMeshPeers(peers: { name: string; port: number }[]): void {
    this.meshPeersProvider = () => peers;
  }

  /** Live provider for GET /api/mesh — called on every request. */
  setMeshPeersProvider(fn: () => unknown): void {
    this.meshPeersProvider = fn;
  }

  private meshForwardHandler: ((change: unknown) => unknown) | null = null;

  /** Handles POST /api/mesh/forwards (validated + applied by index.ts). */
  setMeshForwardHandler(fn: (change: unknown) => unknown): void {
    this.meshForwardHandler = fn;
  }

  private leaveHandler: (() => unknown) | null = null;

  /** Handles POST /api/leave (self-eject), wired by index.ts. */
  setLeaveHandler(fn: () => unknown): void {
    this.leaveHandler = fn;
  }

  setPairing(pairing: PairingInfo): void {
    this.pairing = pairing;
  }

  setRegenerateCallback(fn: () => Promise<PairingInfo>): void {
    this.regenerateCallback = fn;
  }

  private grantRegistrar: ((p: PairingInfo) => Promise<void>) | null = null;
  private consumedWaiters: Array<() => void> = [];

  /** Registers the current QR's grant with the relay (wired by index.ts). */
  setGrantRegistrar(fn: (p: PairingInfo) => Promise<void>): void {
    this.grantRegistrar = fn;
  }

  /** Called by index.ts when the relay reports the current QR was claimed. */
  notifyPairingConsumed(): void {
    const waiters = this.consumedWaiters;
    this.consumedWaiters = [];
    for (const w of waiters) w();
  }

  async start(port: number, host: string = '127.0.0.1'): Promise<void> {
    this.server = createServer(async (req, res) => {
      // Long-poll: resolves when the relay reports the current QR was claimed
      // (used by `termcast qr`). Must be checked before the general /api/pairing.
      if (req.url?.startsWith('/api/pairing/consumed')) {
        let timer: ReturnType<typeof setTimeout>;
        let settled = false;
        const done = (consumed: boolean) => {
          if (settled) return;
          settled = true;
          this.consumedWaiters = this.consumedWaiters.filter(w => w !== onConsumed);
          clearTimeout(timer);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ consumed }));
        };
        const onConsumed = () => done(true);
        timer = setTimeout(() => done(false), 6 * 60 * 1000);
        // Drop the waiter if the client (e.g. `termcast qr` on Ctrl-C) hangs up,
        // so neither the waiter nor its 6-min timer leaks.
        req.on('close', () => {
          if (settled) return;
          settled = true;
          this.consumedWaiters = this.consumedWaiters.filter(w => w !== onConsumed);
          clearTimeout(timer);
        });
        this.consumedWaiters.push(onConsumed);
        return;
      }

      if (req.url?.startsWith('/api/pairing')) {
        // Minting a fresh single-use token is an explicit, human-at-the-machine
        // action (the "Show QR" popup / `termcast qr`), signalled by ?new=1. It
        // (re-)anchors mesh consent and registers a new grant. A plain fetch —
        // the dashboard's periodic poll — must only DISPLAY the current QR, or
        // it would silently re-anchor the mesh window and re-register grants on
        // every poll (invalidating a QR shown on another surface).
        const wantNew = new URL(req.url, 'http://localhost').searchParams.has('new');
        if (wantNew && this.regenerateCallback) {
          try {
            this.pairing = await this.regenerateCallback();
          } catch (err) {
            // Keep existing pairing if regeneration fails
          }
        }

        if (!this.pairing) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No pairing available' }));
          return;
        }

        if (wantNew && this.grantRegistrar) {
          try { await this.grantRegistrar(this.pairing); } catch { /* keep serving QR image */ }
        }

        const qrDataURL = await getQRCodeDataURL(this.pairing);
        const qrText = await getQRCodeText(this.pairing);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ qr: qrDataURL, qr_text: qrText, expires_at: this.pairing.expiresAt }));
        return;
      }

      if (req.url === '/api/mesh/forwards' && req.method === 'POST') {
        // CSRF guard: this mutates peer port forwards. The server only binds to
        // loopback, but a page open in the user's browser could still POST here.
        // A browser always attaches an Origin on cross-origin requests, so we
        // reject any Origin that isn't our own loopback origin. Header-less
        // callers (the `termcast` CLI / curl, which send no Origin) are allowed.
        const origin = req.headers.origin;
        if (origin && !this.isAllowedOrigin(origin)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'cross-origin request blocked' }));
          return;
        }
        if (!this.meshForwardHandler) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'forward handler unavailable' }));
          return;
        }
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          try {
            const result = this.meshForwardHandler!(JSON.parse(body)) as { ok: boolean };
            res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }));
          }
        });
        return;
      }

      if (req.url === '/api/leave' && req.method === 'POST') {
        // Same CSRF guard as /api/mesh/forwards: this mutates cluster membership.
        const origin = req.headers.origin;
        if (origin && !this.isAllowedOrigin(origin)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'cross-origin request blocked' }));
          return;
        }
        if (!this.leaveHandler) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'leave handler unavailable' }));
          return;
        }
        const result = this.leaveHandler() as { ok?: boolean };
        res.writeHead(result?.ok ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.url === '/api/mesh') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.meshPeersProvider()));
        return;
      }

      if (req.url === '/forwards') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(FORWARDS_PAGE);
        return;
      }

      if (req.url === '/api/status') {
        if (!this.statusProvider) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'status unavailable' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.statusProvider()));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Termcast Server</title>
<style>body{font-family:system-ui;background:#1a1b26;color:#c0caf5;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}
.card{text-align:center;padding:2rem;border-radius:1rem;background:#24283b;box-shadow:0 4px 24px rgba(0,0,0,.3)}
h1{margin:0 0 1rem}img{border-radius:.5rem}p{color:#787c99;font-size:.9rem}
.peers{margin-top:1rem;border-top:1px solid #414868;padding-top:1rem;text-align:left}
.peers a{display:block;color:#7aa2f7;margin:.25rem 0;text-decoration:none}
.peers a:hover{text-decoration:underline}
.peers-title{color:#c0caf5;font-size:.85rem;font-weight:600;margin-bottom:.4rem}
.fwd{color:#787c99;font-size:.8rem;margin:.1rem 0 .1rem .75rem}</style></head>
<body><div class="card"><h1>Termcast Server</h1><div id="qr"></div><p id="status">Loading...</p><div id="peers"></div></div>
<script>
// Peer names/ports come from the phone's mesh invite (a peer machine's OS
// hostname) and are untrusted, so escape every peer-derived value before it
// lands in innerHTML — same guard the /forwards page uses.
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
async function load(){const r=await fetch('/api/pairing');if(!r.ok){document.getElementById('status').textContent='No active pairing';return}
const d=await r.json();document.getElementById('qr').innerHTML='<img src="'+d.qr+'" width="300">';
const exp=new Date(d.expires_at);document.getElementById('status').textContent='Expires: '+exp.toLocaleTimeString()}
async function loadPeers(){const r=await fetch('/api/mesh');if(!r.ok)return;const peers=await r.json();
const div=document.getElementById('peers');if(!peers.length)return;
let h='<div class="peers"><p class="peers-title">Servers</p>';
h+='<a href="http://localhost:${this.ttydPort}" target="_blank">This machine</a>';
for(const p of peers){h+='<a href="http://localhost:'+esc(p.port)+'" target="_blank">'+esc(p.name)+'</a>';
for(const f of (p.forwards||[]))h+='<div class="fwd">:'+esc(f.localPort)+' → :'+esc(f.remotePort)+' · '+esc(f.state)+'</div>'}
h+='</div>';div.innerHTML=h}
load();loadPeers();setInterval(load,30000);setInterval(loadPeers,10000);
</script></body></html>`);
    });

    // Find an available port
    const startPort = port;
    while (await this.isPortInUse(port)) {
      port++;
      if (port > startPort + 100) {
        console.error(`No available Web UI port (tried ${startPort}-${port - 1})`);
        return;
      }
    }
    if (port !== startPort) {
      console.log(`Web UI port ${startPort} in use, using ${port} instead`);
    }

    this.boundPort = port;
    this.server.listen(port, host, () => {
      console.log(`Web UI: http://${host}:${port}`);
    });
  }

  stop(): void {
    this.server?.close();
  }

  /** True when `origin` is our own loopback origin on the bound port. */
  private isAllowedOrigin(origin: string): boolean {
    return origin === `http://127.0.0.1:${this.boundPort}`
        || origin === `http://localhost:${this.boundPort}`;
  }

  private isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = createConnection({ port, host: '127.0.0.1' });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => { socket.destroy(); resolve(false); });
      socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
    });
  }
}

// Server-rendered management page for mesh port forwards. Opened in a small
// BrowserWindow by the desktop app and reachable from any browser. Talks to
// GET /api/mesh and POST /api/mesh/forwards same-origin.
const FORWARDS_PAGE = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Port Forwards</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box}
body{font-family:system-ui;background:#1a1b26;color:#c0caf5;margin:0;padding:1rem}
h1{font-size:1.1rem;margin:0 0 1rem}
.peer{background:#24283b;border-radius:.75rem;padding:1rem;margin-bottom:1rem}
.peer h2{font-size:.95rem;margin:0 0 .5rem}
.peer h2 span{color:#787c99;font-weight:400;font-size:.8rem}
.fwd{display:flex;align-items:center;gap:.5rem;padding:.25rem 0;font-size:.85rem}
.fwd .state-active{color:#9ece6a}
.fwd .state-error{color:#f7768e}
.fwd .state-pending{color:#787c99}
.fwd button{margin-left:auto}
.add{display:flex;gap:.5rem;margin-top:.5rem}
input{width:7rem;background:#1a1b26;border:1px solid #414868;border-radius:.4rem;color:#c0caf5;padding:.35rem .5rem;font-size:.85rem}
button{background:#414868;border:none;border-radius:.4rem;color:#c0caf5;padding:.35rem .7rem;font-size:.8rem;cursor:pointer}
button:hover{background:#565f89}
.msg{font-size:.8rem;margin-top:.4rem;min-height:1rem}
.msg.err{color:#f7768e}.msg.note{color:#e0af68}
.empty{color:#787c99;font-size:.85rem}
</style></head>
<body><h1>Port Forwards</h1><div id="peers"><p class="empty">Loading…</p></div>
<script>
// Peers are referenced by index everywhere (element ids, click handlers) so
// arbitrary peer names never land inside JS strings — esc() is for HTML only.
let PEERS=[];
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
async function post(body,i){
  const r=await fetch('/api/mesh/forwards',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const res=await r.json();
  const m=document.getElementById('msg-'+i);
  if(m){m.textContent=res.ok?(res.note||''):(res.error||'request failed');m.className='msg '+(res.ok?'note':'err')}
  if(res.ok)load(true);
}
function removeF(i,remotePort){post({peer:PEERS[i].name,action:'remove',remotePort:remotePort},i)}
function add(i){
  const r=parseInt(document.getElementById('r-'+i).value,10);
  const l=parseInt(document.getElementById('l-'+i).value,10);
  const body={peer:PEERS[i].name,action:'add',remotePort:r};
  if(!isNaN(l))body.localPort=l;
  post(body,i);
}
async function load(force){
  if(!force&&document.activeElement&&document.activeElement.tagName==='INPUT')return;
  let peers;
  try{const r=await fetch('/api/mesh');if(!r.ok)return;peers=await r.json()}catch{return}
  PEERS=peers;
  const div=document.getElementById('peers');
  if(!peers.length){div.innerHTML='<p class="empty">No meshed peers. Pair servers from the Termcast app first.</p>';return}
  let h='';
  peers.forEach((p,i)=>{
    h+='<div class="peer"><h2>'+esc(p.name)+' <span>terminal → localhost:'+p.port+'</span></h2>';
    for(const f of (p.forwards||[])){
      h+='<div class="fwd"><span class="state-'+esc(f.state)+'">'
        +(f.state==='active'?'🟢':f.state==='error'?'🔴':'⏳')+'</span>'
        +'localhost:'+f.localPort+' → :'+f.remotePort
        +(f.state==='error'&&f.message?' <span class="state-error">'+esc(f.message)+'</span>':'')
        +'<button onclick="removeF('+i+','+f.remotePort+')">Remove</button></div>';
    }
    h+='<div class="add">'
      +'<input id="r-'+i+'" type="number" min="1" max="65535" placeholder="remote port">'
      +'<input id="l-'+i+'" type="number" min="1" max="65535" placeholder="local (opt)">'
      +'<button onclick="add('+i+')">Add</button></div>'
      +'<div class="msg" id="msg-'+i+'"></div></div>';
  });
  div.innerHTML=h;
}
load(true);setInterval(()=>load(false),5000);
</script></body></html>`;
