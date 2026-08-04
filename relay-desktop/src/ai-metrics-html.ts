// Renders the AI Metrics report as a self-contained HTML page. Pure string
// building (no Electron) so it can be unit-tested, and no network assets — the
// tray app has no need to phone home just to draw a table.

import type { SessionInfo } from './ai-metrics';
import type { DayUsage, UsageSummary } from './ai-usage';

/** Escape a JSON payload so it can't break out of its <script> element. */
function jsonForScript(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtTok(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
}

function pct(n: number, of: number): string {
  return of > 0 ? Math.round((n / of) * 100) + '%' : '0%';
}

function dayTotal(d: DayUsage): number {
  return d.input + d.output + d.cacheRead + d.cacheWrite;
}

const COLORS: Record<string, string> = {
  input: '#7aa2f7',
  output: '#9ece6a',
  cacheWrite: '#e0af68',
  cacheRead: '#bb9af7',
};

/** Inline SVG for one stacked-bar-per-day chart. Zero days get a baseline tick. */
function chartSvg(daily: DayUsage[], includeReads: boolean): string {
  const W = 720;
  const H = 190;
  const pad = 6;
  const innerH = H - pad * 2;
  let maxV = 0;
  for (const d of daily) {
    const v = d.input + d.output + d.cacheWrite + (includeReads ? d.cacheRead : 0);
    if (v > maxV) maxV = v;
  }
  if (maxV === 0) maxV = 1;
  const bw = W / daily.length;
  const barW = Math.max(1, bw - 1);
  let html = '';
  for (let i = 0; i < daily.length; i++) {
    const d = daily[i];
    const x = i * bw;
    const yBase = H - pad;
    const total = d.input + d.output + d.cacheWrite + (includeReads ? d.cacheRead : 0);
    let body: string;
    if (total === 0) {
      body = `<line class="zeroday" x1="${x}" y1="${yBase}" x2="${x + bw}" y2="${yBase}"></line>`;
    } else {
      const segs = [
        { k: 'cacheWrite', v: d.cacheWrite },
        { k: 'output', v: d.output },
        { k: 'input', v: d.input },
      ];
      if (includeReads) segs.push({ k: 'cacheRead', v: d.cacheRead });
      let rects = '';
      let y = yBase;
      for (const seg of segs) {
        const h = (seg.v / maxV) * innerH;
        if (h <= 0) continue;
        rects += `<rect x="${x}" y="${y - h}" width="${barW}" height="${h}" fill="${COLORS[seg.k]}"></rect>`;
        y -= h;
      }
      body = rects;
    }
    html += `<g class="day" data-day="${d.day}" data-input="${d.input}" data-output="${d.output}" data-cacheRead="${d.cacheRead}" data-cacheWrite="${d.cacheWrite}" data-requests="${d.requests}">${body}</g>`;
  }
  return html;
}

function wasteTableHtml(usage: UsageSummary): string {
  const rows = [
    { label: 'Expired cache writes', row: usage.waste.expiredCache, note: 'Cache blocks written but never read before their TTL expired.' },
    { label: 'Interrupted turns', row: usage.waste.interrupted, note: 'Output produced in turns the user cut short.' },
    { label: 'Truncated responses', row: usage.waste.truncated, note: 'Output cut off at max_tokens.' },
  ];
  let html = '<tr><th></th><th>tokens</th><th>share</th><th>requests</th></tr>';
  for (const r of rows) {
    html += `<tr><td class="w-label">${esc(r.label)}</td><td>${fmtTok(r.row.tokens)}</td><td>${pct(r.row.tokens, r.row.of)}</td><td>${r.row.requests}</td></tr>`;
    html += `<tr class="w-note"><td colspan="4">${esc(r.note)}</td></tr>`;
  }
  return html;
}

export function aiMetricsHtml(sessions: SessionInfo[], usage: UsageSummary): string {
  const hasData = usage.daily.some(d => d.requests > 0);
  const todayTotal = fmtTok(dayTotal(usage.today));
  const last7Total = fmtTok(dayTotal(usage.last7));
  const wasteTokens = fmtTok(usage.waste.expiredCache.tokens);
  const wastePct = pct(usage.waste.expiredCache.tokens, usage.waste.expiredCache.of);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>AI Metrics</title>
<style>
:root { color-scheme: dark; }
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  background: #1a1b26;
  color: #c0caf5;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-size: 13px;
  padding: 16px;
}
header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
h1 { font-size: 17px; color: #e0af68; font-weight: 600; }
#summary { color: #787c99; font-size: 12px; }
#summary b { color: #a9b1d6; font-weight: 600; }
.tabs { display: flex; gap: 8px; margin-bottom: 12px; }
.toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
#search {
  flex: 1; min-width: 180px;
  background: #24283b; border: 1px solid #33467c; color: #c0caf5;
  border-radius: 6px; padding: 6px 10px; font-size: 12px; outline: none;
}
#search:focus { border-color: #7aa2f7; }
.btn {
  background: #24283b; border: 1px solid #33467c; color: #a9b1d6;
  border-radius: 6px; padding: 5px 12px; font-size: 12px; cursor: pointer;
}
.btn:hover { background: #2f3549; }
.btn.on { background: #7aa2f7; border-color: #7aa2f7; color: #16161e; font-weight: 600; }
#list { display: flex; flex-direction: column; gap: 8px; }
.card {
  background: #1f2335; border: 1px solid #292e42; border-radius: 8px;
  padding: 10px 12px;
}
.card.inactive { opacity: 0.72; }
.card .top { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.dot.on { background: #9ece6a; box-shadow: 0 0 6px #9ece6a88; }
.dot.off { background: #565f89; }
.badge {
  font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase;
  border-radius: 4px; padding: 2px 6px; font-weight: 600; flex: none;
}
.badge.cc { background: #3b4261; color: #bb9af7; }
.badge.oc { background: #2d3340; color: #7dcfff; }
.topic { font-weight: 600; color: #c0caf5; font-size: 13px; min-width: 0; }
.topic .id { color: #565f89; font-weight: 400; font-family: ui-monospace, monospace; font-size: 11px; }
.meta { color: #787c99; font-size: 11px; margin-bottom: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.trace { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
.chip {
  background: #24283b; border: 1px solid #2f3549; border-radius: 5px;
  padding: 3px 7px; font-size: 11px; color: #a9b1d6;
}
.chip b { color: #7aa2f7; font-weight: 600; }
.chip .t { color: #565f89; }
.totals { color: #9d7cd8; font-size: 11px; margin-left: auto; white-space: nowrap; }
.empty { color: #565f89; text-align: center; padding: 40px 0; }
.cost { color: #e0af68; }
.tiles { display: flex; gap: 10px; margin-bottom: 14px; }
.tile {
  flex: 1; background: #1f2335; border: 1px solid #292e42; border-radius: 8px;
  padding: 10px 12px;
}
.tile-label { font-size: 10px; letter-spacing: 0.06em; color: #787c99; font-weight: 600; }
.tile-value { font-size: 20px; color: #7aa2f7; font-weight: 700; margin: 2px 0; }
.tile-sub { font-size: 11px; color: #565f89; }
.chart-box { background: #1f2335; border: 1px solid #292e42; border-radius: 8px; padding: 12px; margin-bottom: 14px; }
.chart-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.chart-title { font-weight: 600; color: #a9b1d6; font-size: 12px; }
.chk { color: #787c99; font-size: 11px; display: flex; align-items: center; gap: 6px; cursor: pointer; }
#chartWrap { position: relative; }
svg { width: 100%; height: auto; display: block; }
svg[hidden] { display: none; }
.zeroday { stroke: #2f3549; stroke-width: 2; }
.tip {
  position: fixed; z-index: 10; background: #24283b; border: 1px solid #33467c;
  border-radius: 6px; padding: 8px 10px; font-size: 11px; color: #a9b1d6;
  pointer-events: none; white-space: nowrap; line-height: 1.5;
}
.waste { background: #1f2335; border: 1px solid #292e42; border-radius: 8px; padding: 12px; }
.waste h2 { font-size: 12px; color: #a9b1d6; margin-bottom: 8px; font-weight: 600; }
#wasteTable { width: 100%; border-collapse: collapse; font-size: 12px; }
#wasteTable th {
  text-align: left; color: #565f89; font-weight: 600; font-size: 10px;
  letter-spacing: 0.06em; text-transform: uppercase; padding: 4px 8px;
}
#wasteTable td { padding: 4px 8px; color: #c0caf5; }
#wasteTable td.w-label { color: #e0af68; font-weight: 600; }
#wasteTable tr.w-note td { color: #565f89; font-size: 11px; padding-bottom: 8px; }
</style>
</head>
<body>
<header>
  <h1>📊 AI Metrics</h1>
  <div id="summary"></div>
</header>
<div class="tabs">
  <button id="tabUsage" class="btn on">Usage</button>
  <button id="tabSessions" class="btn">Sessions</button>
</div>

<div id="usageTab">
  <div id="usageContent"${hasData ? '' : ' hidden'}>
    <div class="tiles">
      <div class="tile">
        <div class="tile-label">TODAY</div>
        <div class="tile-value">${todayTotal}</div>
        <div class="tile-sub">${usage.today.requests} requests</div>
      </div>
      <div class="tile">
        <div class="tile-label">7 DAYS</div>
        <div class="tile-value">${last7Total}</div>
        <div class="tile-sub">${usage.last7.requests} requests</div>
      </div>
      <div class="tile">
        <div class="tile-label">CACHE WASTED (7d)</div>
        <div class="tile-value">${wasteTokens}</div>
        <div class="tile-sub">${wastePct} of cache writes</div>
      </div>
    </div>
    <div class="chart-box">
      <div class="chart-head">
        <span class="chart-title">Daily tokens</span>
        <label class="chk"><input type="checkbox" id="includeReads"> include cache reads</label>
      </div>
      <div id="chartWrap">
        <svg id="chartNoReads" viewBox="0 0 720 190" role="img">${chartSvg(usage.daily, false)}</svg>
        <svg id="chartReads" viewBox="0 0 720 190" role="img" hidden>${chartSvg(usage.daily, true)}</svg>
        <div id="tip" class="tip" hidden></div>
      </div>
    </div>
    <div class="waste">
      <h2>Wasted tokens (last 7 days)</h2>
      <table id="wasteTable">${wasteTableHtml(usage)}</table>
    </div>
  </div>
  <div id="usageEmpty" class="empty"${hasData ? ' hidden' : ''}>No usage recorded yet</div>
</div>

<div id="sessionsTab" hidden>
  <div class="toolbar">
    <input id="search" type="search" placeholder="Search topic, project, model…" autocomplete="off">
    <div id="srcFilter"></div>
    <div id="stateFilter"></div>
  </div>
  <div id="list"></div>
</div>

<script id="data" type="application/json">${jsonForScript({ sessions, usage })}</script>
<script>
(function () {
  var data = JSON.parse(document.getElementById('data').textContent);
  var sessions = data.sessions;
  var listEl = document.getElementById('list');
  var summaryEl = document.getElementById('summary');
  var searchEl = document.getElementById('search');
  var srcEl = document.getElementById('srcFilter');
  var stateEl = document.getElementById('stateFilter');
  var tabUsage = document.getElementById('tabUsage');
  var tabSessions = document.getElementById('tabSessions');
  var usageTab = document.getElementById('usageTab');
  var sessionsTab = document.getElementById('sessionsTab');
  var chartWrap = document.getElementById('chartWrap');
  var chartNoReads = document.getElementById('chartNoReads');
  var chartReads = document.getElementById('chartReads');
  var includeReads = document.getElementById('includeReads');
  var tip = document.getElementById('tip');

  var state = { source: 'all', active: 'all', q: '' };

  function esc(s) {
    var div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }
  function fmtTok(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'k';
    return String(n);
  }
  function rel(t) {
    var d = Date.now() - t;
    if (d < 60000) return 'just now';
    if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
    if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
    return Math.floor(d / 86400000) + 'd ago';
  }
  function dateLabel(t) {
    var d = new Date(t);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function buttons(el, opts, key) {
    el.innerHTML = '';
    opts.forEach(function (o) {
      var b = document.createElement('button');
      b.className = 'btn' + (state[key] === o.v ? ' on' : '');
      b.textContent = o.label;
      b.addEventListener('click', function () {
        state[key] = o.v;
        buttons(el, opts, key);
        render();
      });
      el.appendChild(b);
    });
  }

  function summary() {
    var active = sessions.filter(function (s) { return s.active; }).length;
    var cc = sessions.filter(function (s) { return s.source === 'claude-code'; }).length;
    var oc = sessions.length - cc;
    var tokIn = 0, tokOut = 0, cost = 0;
    sessions.forEach(function (s) {
      tokIn += s.tokens.input; tokOut += s.tokens.output;
      if (s.cost) cost += s.cost;
    });
    summaryEl.innerHTML =
      '<b>' + sessions.length + '</b> sessions · <b>' + active + '</b> active · ' +
      '<b>' + cc + '</b> Claude Code · <b>' + oc + '</b> opencode · ' +
      'total <b>' + fmtTok(tokIn) + '</b> in / <b>' + fmtTok(tokOut) + '</b> out' +
      (cost > 0 ? ' · <b class="cost">$' + cost.toFixed(4) + '</b>' : '');
  }

  function modelChips(s) {
    var html = '';
    s.modelTrace.forEach(function (m) {
      html += '<span class="chip"><b>' + esc(m.model) + '</b> ×' + m.messages +
        ' <span class="t">' + fmtTok(m.inputTokens) + ' in / ' + fmtTok(m.outputTokens) + ' out' +
        (m.cacheReadTokens > 0 ? ' · cache ' + fmtTok(m.cacheReadTokens) : '') + '</span></span>';
    });
    return html;
  }

  function card(s) {
    var srcBadge = s.source === 'claude-code' ? '<span class="badge cc">Claude Code</span>' : '<span class="badge oc">opencode</span>';
    var cost = s.cost ? ' <span class="cost">· $' + s.cost.toFixed(4) + '</span>' : '';
    return '<div class="card' + (s.active ? '' : ' inactive') + '">' +
      '<div class="top"><span class="dot ' + (s.active ? 'on' : 'off') + '"></span>' + srcBadge +
      '<span class="topic">' + esc(s.topic) + ' <span class="id">' + esc(s.id) + '</span></span></div>' +
      '<div class="meta">' + esc(s.project || '(no directory)') +
        ' · ' + rel(s.updatedAt) + ' · ' + dateLabel(s.updatedAt) +
        (s.agent ? ' · agent ' + esc(s.agent) : '') + '</div>' +
      '<div class="trace">' + modelChips(s) +
        '<span class="totals">total ' + fmtTok(s.tokens.input) + ' in / ' + fmtTok(s.tokens.output) + ' out' + cost + '</span>' +
      '</div></div>';
  }

  function matches(s) {
    if (state.source !== 'all' && s.source !== state.source) return false;
    if (state.active === 'active' && !s.active) return false;
    if (state.active === 'inactive' && s.active) return false;
    if (state.q) {
      var q = state.q.toLowerCase();
      var hay = (s.topic + ' ' + s.project + ' ' + s.id + ' ' +
        s.modelTrace.map(function (m) { return m.model; }).join(' ')).toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  }

  function render() {
    var visible = sessions.filter(matches);
    if (visible.length === 0) {
      listEl.innerHTML = '<div class="empty">No sessions match.</div>';
    } else {
      listEl.innerHTML = visible.map(card).join('');
    }
  }

  function setTab(tab) {
    usageTab.hidden = tab !== 'usage';
    sessionsTab.hidden = tab !== 'sessions';
    tabUsage.className = 'btn' + (tab === 'usage' ? ' on' : '');
    tabSessions.className = 'btn' + (tab === 'sessions' ? ' on' : '');
  }
  tabUsage.addEventListener('click', function () { setTab('usage'); });
  tabSessions.addEventListener('click', function () { setTab('sessions'); });

  includeReads.addEventListener('change', function () {
    chartNoReads.hidden = this.checked;
    chartReads.hidden = !this.checked;
  });

  chartWrap.addEventListener('mousemove', function (e) {
    var g = e.target.closest ? e.target.closest('g.day') : null;
    if (!g) { tip.hidden = true; return; }
    var d = {
      input: Number(g.getAttribute('data-input')),
      output: Number(g.getAttribute('data-output')),
      cacheRead: Number(g.getAttribute('data-cacheRead')),
      cacheWrite: Number(g.getAttribute('data-cacheWrite')),
      requests: Number(g.getAttribute('data-requests'))
    };
    tip.innerHTML = '<b>' + esc(g.getAttribute('data-day')) + '</b> · ' + d.requests + ' requests<br>' +
      'input ' + fmtTok(d.input) + '<br>' +
      'output ' + fmtTok(d.output) + '<br>' +
      'cache read ' + fmtTok(d.cacheRead) + '<br>' +
      'cache write ' + fmtTok(d.cacheWrite) + '<br>' +
      'total ' + fmtTok(d.input + d.output + d.cacheRead + d.cacheWrite);
    tip.style.left = (e.clientX + 14) + 'px';
    tip.style.top = (e.clientY + 14) + 'px';
    tip.hidden = false;
  });
  chartWrap.addEventListener('mouseleave', function () { tip.hidden = true; });

  summary();
  render();
  setTab('usage');
})();
</script>
</body>
</html>
`;
}
