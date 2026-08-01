import { randomBytes } from 'node:crypto';
import { hostname, platform } from 'node:os';
import QRCode from 'qrcode';

function serverOS(): string {
  const p = platform();
  if (p === 'darwin') return 'macOS';
  if (p === 'win32') return 'Windows';
  if (p === 'linux') return 'Linux';
  return p;
}

export interface PairingInfo {
  relayURL: string;
  deviceId: string;
  pairingSecret: string;
  pairingToken: string;
  serverPublicKey: string;
  expiresAt: number;
  serverHostname: string;
  serverOS: string;
  ttydPort: number;
}

export function generatePairingInfo(relayURL: string, serverPublicKey: Buffer, existingDeviceId?: string, ttydPort = 7681): PairingInfo {
  return {
    relayURL,
    deviceId: existingDeviceId || randomBytes(16).toString('hex'),
    pairingSecret: randomBytes(32).toString('base64url'),
    pairingToken: randomBytes(32).toString('base64url'),
    serverPublicKey: serverPublicKey.toString('base64'),
    expiresAt: Date.now() + 5 * 60 * 1000,
    serverHostname: hostname(),
    serverOS: serverOS(),
    ttydPort,
  };
}

export function qrPayload(pairing: PairingInfo): string {
  return JSON.stringify({
    v: 2,
    relay_url: pairing.relayURL,
    device_id: pairing.deviceId,
    pairing_token: pairing.pairingToken,
    server_public_key: pairing.serverPublicKey,
    server_hostname: pairing.serverHostname,
    server_os: pairing.serverOS,
    ttyd_port: pairing.ttydPort,
  });
}

export async function displayQRCode(pairing: PairingInfo): Promise<void> {
  const qrText = await QRCode.toString(qrPayload(pairing), { type: 'utf8', errorCorrectionLevel: 'L', small: true } as any);
  console.log('\n' + qrText);
  console.log(`\nDevice ID: ${pairing.deviceId}`);
  console.log(`Expires: ${new Date(pairing.expiresAt).toLocaleTimeString()}`);
  console.log('Scan this QR code with termcast iphone app to pair.\n');
}

export async function getQRCodeDataURL(pairing: PairingInfo): Promise<string> {
  return QRCode.toDataURL(qrPayload(pairing), { width: 300, margin: 2 });
}

/** UTF-8 ASCII QR for terminal rendering (used by `termcast qr`). */
export async function getQRCodeText(pairing: PairingInfo): Promise<string> {
  return QRCode.toString(qrPayload(pairing), { type: 'utf8', errorCorrectionLevel: 'L', small: true } as any) as unknown as Promise<string>;
}
