import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forwardLabel, versionLabel, statusDot, clientLabel, clientDetailLines, clientDevice, isServerClient, peerDetailLines, trayTooltip } from './tray-format';

test('trayTooltip: connected with no devices', () => {
  assert.equal(trayTooltip('connected', 0), 'Termcast — ready for connections');
});

test('trayTooltip: connected reports the device count', () => {
  assert.equal(trayTooltip('connected', 1), 'Termcast — 1 device connected');
  assert.equal(trayTooltip('connected', 3), 'Termcast — 3 devices connected');
});

test('trayTooltip: connecting and offline ignore the device count', () => {
  assert.equal(trayTooltip('connecting', 2), 'Termcast — connecting...');
  assert.equal(trayTooltip('offline', 2), 'Termcast — not connected');
});

test('forwardLabel: active forward', () => {
  assert.equal(
    forwardLabel({ remotePort: 3000, localPort: 3000, state: 'active' }),
    'localhost:3000 → :3000 · 🟢 active',
  );
});

test('forwardLabel: error forward includes message', () => {
  assert.equal(
    forwardLabel({ remotePort: 8080, localPort: 18080, state: 'error', message: 'address in use' }),
    'localhost:18080 → :8080 · 🔴 error — address in use',
  );
});

test('forwardLabel: error without message has no dash suffix', () => {
  assert.equal(
    forwardLabel({ remotePort: 8080, localPort: 8080, state: 'error' }),
    'localhost:8080 → :8080 · 🔴 error',
  );
});

test('forwardLabel: pending forward', () => {
  assert.equal(
    forwardLabel({ remotePort: 5432, localPort: 5432, state: 'pending' }),
    'localhost:5432 → :5432 · ⏳ pending',
  );
});

test('versionLabel: with server version', () => {
  assert.equal(versionLabel('0.35.0', '0.35.0'), 'Termcast 0.35.0 · server 0.35.0');
});

test('versionLabel: server version unknown', () => {
  assert.equal(versionLabel('0.35.0', null), 'Termcast 0.35.0');
});

test('statusDot: connected is green, disconnected is yellow', () => {
  assert.equal(statusDot(true), '🟢');
  assert.equal(statusDot(false), '🟡');
});

test('clientLabel: uses the device kind', () => {
  assert.equal(clientLabel('1.2.3.4 | Berlin, DE | iPhone'), 'iPhone');
  assert.equal(clientLabel('1.2.3.4 | iPad'), 'iPad');           // no location
  assert.equal(clientLabel('10.0.0.5 | Server'), 'Server');
});

test('clientLabel: falls back to iPhone when device is unknown/absent', () => {
  assert.equal(clientLabel(null), 'iPhone');
  assert.equal(clientLabel('1.2.3.4'), 'iPhone');
  assert.equal(clientLabel('1.2.3.4 | Berlin, DE'), 'iPhone');   // unknown UA, no device token
  assert.equal(clientLabel(''), 'iPhone');
});

test('clientDetailLines: full info', () => {
  assert.deepEqual(
    clientDetailLines('1.2.3.4 | Berlin, DE | iPhone'),
    ['IP: 1.2.3.4', 'Location: Berlin, DE', 'Device: iPhone'],
  );
});

test('clientDetailLines: missing location is not mislabeled as device', () => {
  assert.deepEqual(clientDetailLines('1.2.3.4 | iPad'), ['IP: 1.2.3.4', 'Device: iPad']);
});

test('clientDetailLines: missing device', () => {
  assert.deepEqual(clientDetailLines('1.2.3.4 | Berlin, DE'), ['IP: 1.2.3.4', 'Location: Berlin, DE']);
});

test('clientDetailLines: only ip', () => {
  assert.deepEqual(clientDetailLines('1.2.3.4'), ['IP: 1.2.3.4']);
});

test('clientDetailLines: long IPv6 is shortened', () => {
  assert.deepEqual(
    clientDetailLines('2600:1700:1151:d9c0:a24a:9bfa:d246:ed8a | San Jose, US | iPhone'),
    ['IP: 2600:1700:…:ed8a', 'Location: San Jose, US', 'Device: iPhone'],
  );
});

test('clientDetailLines: null info shows placeholder', () => {
  assert.deepEqual(clientDetailLines(null), ['(no info yet)']);
  assert.deepEqual(clientDetailLines(''), ['(no info yet)']);
});

test('clientDevice: returns device token or null', () => {
  assert.equal(clientDevice('10.0.0.5 | Server'), 'Server');
  assert.equal(clientDevice('1.2.3.4 | Berlin, DE | iPhone'), 'iPhone');
  assert.equal(clientDevice('1.2.3.4'), null);
  assert.equal(clientDevice(null), null);
});

test('isServerClient: true only when the device segment is exactly Server', () => {
  assert.equal(isServerClient('2600:1700:1151:d9c0::1 | San Jose, US | Server'), true);
  assert.equal(isServerClient('1.2.3.4 | Berlin, DE | iPhone 15 Pro'), false);
  assert.equal(isServerClient('1.2.3.4 | Berlin, DE | Serverless'), false);
  assert.equal(isServerClient('1.2.3.4'), false);
  assert.equal(isServerClient(null), false);
  assert.equal(isServerClient(''), false);
});

test('isServerClient: detects Server even when location is absent', () => {
  // Regression: the old positional parse read segment [2], so a mesh peer with
  // no geo ("ip | Server") was miscounted as a phone. Content-aware parse fixes it.
  assert.equal(isServerClient('10.0.0.5 | Server'), true);
});

test('peerDetailLines: full ip + location', () => {
  assert.deepEqual(
    peerDetailLines({ ip: '2600:1700:1151:d9c0::1', location: 'San Jose, US' }),
    ['IP: 2600:1700:…:1', 'Location: San Jose, US', 'Device: Server'],
  );
});

test('peerDetailLines: no inbound leg yet still shows Device', () => {
  assert.deepEqual(peerDetailLines({}), ['Device: Server']);
});

test('peerDetailLines: long IPv6 is shortened like phone rows', () => {
  assert.deepEqual(
    peerDetailLines({ ip: '2600:1700:1151:d9c0:a24a:9bfa:d246:ed8a', location: 'San Jose, US' }),
    ['IP: 2600:1700:…:ed8a', 'Location: San Jose, US', 'Device: Server'],
  );
});

test('peerDetailLines: ip only', () => {
  assert.deepEqual(peerDetailLines({ ip: '1.2.3.4' }), ['IP: 1.2.3.4', 'Device: Server']);
});
