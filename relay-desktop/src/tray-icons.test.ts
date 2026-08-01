import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { trayIconFile, TRAY_ICON_FILES } from './tray-icons';

test('trayIconFile: connected picks the green badge for the current appearance', () => {
  assert.equal(trayIconFile('connected', false), 'tray-connected-light.png');
  assert.equal(trayIconFile('connected', true), 'tray-connected-dark.png');
});

test('trayIconFile: connecting picks the refresh badge', () => {
  assert.equal(trayIconFile('connecting', false), 'tray-connecting-light.png');
  assert.equal(trayIconFile('connecting', true), 'tray-connecting-dark.png');
});

test('trayIconFile: offline picks the red badge', () => {
  assert.equal(trayIconFile('offline', false), 'tray-offline-light.png');
  assert.equal(trayIconFile('offline', true), 'tray-offline-dark.png');
});

test('every mapped icon exists in assets, at 1x and 2x', () => {
  const assets = join(__dirname, '..', 'assets');
  assert.equal(TRAY_ICON_FILES.length, 6);
  for (const file of TRAY_ICON_FILES) {
    assert.ok(existsSync(join(assets, file)), `missing asset: ${file}`);
    const retina = file.replace(/\.png$/, '@2x.png');
    assert.ok(existsSync(join(assets, retina)), `missing asset: ${retina}`);
  }
});
