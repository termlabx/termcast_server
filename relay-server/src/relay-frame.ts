// Server↔relay link framing (Node/Buffer side): [type:1][connId:1][payload].
// connId 0 = server-global (heartbeat); 1..16 = a specific client.

export function encodeServerFrame(type: number, connId: number, payload: Buffer): Buffer {
  const out = Buffer.alloc(2 + payload.length);
  out[0] = type;
  out[1] = connId;
  payload.copy(out, 2);
  return out;
}

export function decodeServerFrame(data: Buffer): { type: number; connId: number; payload: Buffer } {
  return { type: data[0], connId: data[1], payload: data.subarray(2) };
}
