// Renders the AI Metrics report as a self-contained HTML page. Pure string
// building (no Electron) so it can be unit-tested, and no network assets — the
// tray app has no need to phone home just to draw a table.

import type { SessionInfo } from './ai-metrics';

/** Escape a JSON payload so it can't break out of its <script> element. */
function jsonForScript(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function aiMetricsHtml(sessions: SessionInfo[]): string {
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
</style>
</head>
<body>
<header>
  <h1>📊 AI Metrics</h1>
  <div id="summary"></div>
</header>
<div class="toolbar">
  <input id="search" type="search" placeholder="Search topic, project, model…" autocomplete="off">
  <div id="srcFilter"></div>
  <div id="stateFilter"></div>
</div>
<div id="list"></div>

<script id="data" type="application/json">${jsonForScript(sessions)}</script>
<script>
(function () {
  var sessions = JSON.parse(document.getElementById('data').textContent);
  var listEl = document.getElementById('list');
  var summaryEl = document.getElementById('summary');
  var searchEl = document.getElementById('search');
  var srcEl = document.getElementById('srcFilter');
  var stateEl = document.getElementById('stateFilter');

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

  searchEl.addEventListener('input', function () { state.q = searchEl.value.trim(); render(); });

  buttons(srcEl, [
    { label: 'All', v: 'all' },
    { label: 'Claude Code', v: 'claude-code' },
    { label: 'opencode', v: 'opencode' },
  ], 'source');
  buttons(stateEl, [
    { label: 'All', v: 'all' },
    { label: 'Active', v: 'active' },
    { label: 'Inactive', v: 'inactive' },
  ], 'active');

  summary();
  render();
})();
</script>
</body>
</html>
`;
}
