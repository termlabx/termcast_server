import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trayStatus } from './tray-status';

const base = { serverStarting: false, serverRunning: false, relayConnected: null, relayDownMs: 0 };

test('trayStatus: stopped server is offline', () => {
  assert.equal(trayStatus(base), 'offline');
});

test('trayStatus: a stopped server stays offline despite a stale connected relay', () => {
  assert.equal(trayStatus({ ...base, relayConnected: true }), 'offline');
});

test('trayStatus: starting server is connecting', () => {
  assert.equal(trayStatus({ ...base, serverStarting: true }), 'connecting');
});

test('trayStatus: running server with a connected relay is connected', () => {
  assert.equal(trayStatus({ ...base, serverRunning: true, relayConnected: true }), 'connected');
});

test('trayStatus: relay down briefly is connecting, not offline', () => {
  assert.equal(
    trayStatus({ serverStarting: false, serverRunning: true, relayConnected: false, relayDownMs: 29_999 }),
    'connecting',
  );
});

test('trayStatus: relay down past the grace window is offline', () => {
  assert.equal(
    trayStatus({ serverStarting: false, serverRunning: true, relayConnected: false, relayDownMs: 30_000 }),
    'offline',
  );
});

test('trayStatus: unknown relay state is treated as down', () => {
  assert.equal(
    trayStatus({ serverStarting: false, serverRunning: true, relayConnected: null, relayDownMs: 0 }),
    'connecting',
  );
  assert.equal(
    trayStatus({ serverStarting: false, serverRunning: true, relayConnected: null, relayDownMs: 60_000 }),
    'offline',
  );
});
