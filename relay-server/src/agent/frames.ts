/**
 * Inner-frame opcodes for the agent chat feature.
 *
 * Already claimed elsewhere and NOT available: 0x09 (mesh invite),
 * 0x40-0x43 (port-forward), 0x53 (set-multiplexer). ttyd's own frames start
 * with ASCII digits (0x30+) and must keep falling through untouched.
 */
export const AGENT_LIST = 0x60;
export const AGENT_SESSIONS = 0x61;
export const AGENT_ATTACH = 0x62;
export const AGENT_EVENT = 0x63;
export const AGENT_SEND = 0x64;
export const AGENT_PERMISSION = 0x65;
export const AGENT_DETACH = 0x66;
export const AGENT_INTERRUPT = 0x67;
export const AGENT_HISTORY = 0x68;

const FIRST = AGENT_LIST;
const LAST = AGENT_HISTORY;

export function isAgentOpcode(byte: number): boolean {
  return byte >= FIRST && byte <= LAST;
}

export function encodeAgentFrame(opcode: number, payload: unknown): Buffer {
  return Buffer.concat([Buffer.from([opcode]), Buffer.from(JSON.stringify(payload), 'utf8')]);
}

/**
 * Returns null for anything that is not a well-formed agent frame. Callers
 * treat null as "not mine" and fall through, so a malformed payload can never
 * throw into the bridge's data path.
 */
export function decodeAgentFrame(buf: Buffer): { opcode: number; payload: unknown } | null {
  if (buf.length < 1) return null;
  const opcode = buf[0];
  if (!isAgentOpcode(opcode)) return null;
  try {
    return { opcode, payload: JSON.parse(buf.subarray(1).toString('utf8')) };
  } catch {
    return null;
  }
}
