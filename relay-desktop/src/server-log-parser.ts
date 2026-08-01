// Parses the relay-server's stdout into structured per-client events for the
// tray. The server emits one log line per event; a single stdout chunk may
// contain several lines, so we split and scan each.
//
// Relevant server lines (see relay-server/src/index.ts):
//   "Client connected [id=N]"
//   "Client info [id=N]: <ip | city, country | device>"
//   "Client disconnected [id=N]"
// Note: the server also logs "✓ Client paired [id=N] …" on handshake — that is
// deliberately NOT a connect event (connect is already counted), so we ignore it.

export type ClientLogEvent =
  | { kind: 'connected'; id: number }
  | { kind: 'info'; id: number; info: string }
  | { kind: 'disconnected'; id: number }
  | { kind: 'pairing-consumed' };

export function parseClientLogEvents(chunk: string): ClientLogEvent[] {
  const events: ClientLogEvent[] = [];
  for (const line of chunk.split('\n')) {
    if (line.includes('[pairing] consumed')) { events.push({ kind: 'pairing-consumed' }); continue; }

    const connected = line.match(/Client connected \[id=(\d+)\]/);
    if (connected) { events.push({ kind: 'connected', id: parseInt(connected[1], 10) }); continue; }

    const info = line.match(/Client info \[id=(\d+)\]: (.+)/);
    if (info) { events.push({ kind: 'info', id: parseInt(info[1], 10), info: info[2].trim() }); continue; }

    const disconnected = line.match(/Client disconnected \[id=(\d+)\]/);
    if (disconnected) { events.push({ kind: 'disconnected', id: parseInt(disconnected[1], 10) }); continue; }
  }
  return events;
}
