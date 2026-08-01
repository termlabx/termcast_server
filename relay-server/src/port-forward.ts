import * as net from 'node:net';

// Sub-command bytes (inside decrypted DATA payload)
const PF_OPEN = 0x40;
const PF_DATA = 0x41;
const PF_CLOSE = 0x42;
const PF_OPEN_ACK = 0x43;

export { PF_OPEN, PF_DATA, PF_CLOSE, PF_OPEN_ACK };

export class PortForwardHandler {
  // flow-id → { socket, remotePort }
  private flows = new Map<number, { socket: net.Socket; remotePort: number }>();
  // registered remote ports from PF_OPEN
  private registeredPorts = new Set<number>();
  // callback to send encrypted data back through relay
  private sendToRelay: (data: Buffer) => void;

  constructor(sendToRelay: (data: Buffer) => void) {
    this.sendToRelay = sendToRelay;
  }

  handleMessage(subCmd: number, flowId: number, payload: Buffer): void {
    switch (subCmd) {
      case PF_OPEN:
        this.handleOpen(flowId, payload);
        break;
      case PF_DATA:
        this.handleData(flowId, payload);
        break;
      case PF_CLOSE:
        this.handleClose(flowId);
        break;
    }
  }

  private handleOpen(_flowId: number, payload: Buffer): void {
    try {
      const { remotePort, localPort } = JSON.parse(payload.toString());
      console.log(`[port-forward] PF_OPEN: Mac:${remotePort} → iPhone:${localPort}`);
      this.registeredPorts.add(remotePort);

      // Test that the remote port is reachable.
      // Use a replied flag to prevent duplicate ACKs from connect/error/timeout races.
      let replied = false;
      const sendAck = (status: string, message?: string) => {
        if (replied) return;
        replied = true;
        testSocket.destroy();
        const ackPayload: any = { remotePort, status };
        if (message) ackPayload.message = message;
        const ack = this.frameMessage(PF_OPEN_ACK, 0, Buffer.from(JSON.stringify(ackPayload)));
        this.sendToRelay(ack);
        console.log(`[port-forward] PF_OPEN_ACK sent (${status}) for port ${remotePort}${message ? ': ' + message : ''}`);
      };

      const testSocket = net.createConnection({ host: '127.0.0.1', port: remotePort }, () => {
        sendAck('ok');
      });
      testSocket.on('error', (err: any) => sendAck('error', err.message));
      testSocket.setTimeout(3000, () => sendAck('error', 'Connection timeout'));
    } catch (err) {
      console.error('[port-forward] PF_OPEN parse error:', (err as Error).message);
    }
  }

  private handleData(flowId: number, payload: Buffer): void {
    const existing = this.flows.get(flowId);
    if (existing) {
      // Forward data to existing socket
      if (!existing.socket.destroyed) {
        existing.socket.write(payload);
      }
      return;
    }

    // New flow — need to determine which remote port this flow targets.
    // The remotePort is encoded in the first PF_DATA for a new flow as a 2-byte prefix.
    // NOTE: This could also be a 'zombie' flow (Mac closed, iPhone sent more data).
    // In that case, the prefix will likely be missing, leading to an 'unregistered port' error.
    if (payload.length < 2) {
      console.warn(`[port-forward] PF_DATA for unknown flow ${flowId} too short (possibly zombie)`);
      this.sendToRelay(this.frameMessage(PF_CLOSE, flowId, Buffer.alloc(0)));
      return;
    }
    const remotePort = payload.readUInt16BE(0);
    const initialData = payload.subarray(2);

    if (!this.registeredPorts.has(remotePort)) {
      console.warn(`[port-forward] PF_DATA for unknown flow ${flowId} targets unregistered port ${remotePort} (possibly zombie). Closing.`);
      this.sendToRelay(this.frameMessage(PF_CLOSE, flowId, Buffer.alloc(0)));
      return;
    }

    console.log(`[port-forward] New flow ${flowId} → 127.0.0.1:${remotePort}`);
    const socket = net.createConnection({ host: '127.0.0.1', port: remotePort });

    this.flows.set(flowId, { socket, remotePort });

    socket.on('connect', () => {
      if (initialData.length > 0) {
        socket.write(initialData);
      }
    });

    socket.on('data', (data: Buffer) => {
      const msg = this.frameMessage(PF_DATA, flowId, data);
      this.sendToRelay(msg);
    });

    socket.on('close', () => {
      // Guard: only send PF_CLOSE if we still own this flow (prevents duplicate after error)
      if (this.flows.has(flowId)) {
        this.flows.delete(flowId);
        this.sendToRelay(this.frameMessage(PF_CLOSE, flowId, Buffer.alloc(0)));
      }
    });

    socket.on('error', (err: any) => {
      console.error(`[port-forward] Flow ${flowId} socket error: ${err.message}`);
      // Let 'close' handle cleanup — it always fires after 'error'
    });
  }

  private handleClose(flowId: number): void {
    const flow = this.flows.get(flowId);
    if (flow) {
      console.log(`[port-forward] PF_CLOSE flow ${flowId}`);
      flow.socket.destroy();
      this.flows.delete(flowId);
    }
  }

  /** Frame a port-forward sub-message: [subCmd][flowId (4B BE)][payload] */
  private frameMessage(subCmd: number, flowId: number, payload: Buffer): Buffer {
    const header = Buffer.alloc(5);
    header[0] = subCmd;
    header.writeUInt32BE(flowId, 1);
    return Buffer.concat([header, payload]);
  }

  /** Tear down all flows (called on client disconnect). */
  destroyAll(): void {
    for (const [flowId, flow] of this.flows) {
      console.log(`[port-forward] Destroying flow ${flowId}`);
      flow.socket.destroy();
    }
    this.flows.clear();
    this.registeredPorts.clear();
  }
}
