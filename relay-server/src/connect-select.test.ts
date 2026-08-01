import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePeerSelection, type MeshPeer } from './connect-select.js';

const peers: MeshPeer[] = [
  { name: 'laptop', port: 7682 },
  { name: 'workstation', port: 7683 },
];

test('numeric selection picks the 1-based peer', () => {
  assert.deepEqual(resolvePeerSelection(peers, '2'), { peer: peers[1] });
});

test('numeric selection out of range is an error', () => {
  const r = resolvePeerSelection(peers, '9');
  assert.ok('error' in r);
});

test('name selection is case-insensitive', () => {
  assert.deepEqual(resolvePeerSelection(peers, 'LAPTOP'), { peer: peers[0] });
});

test('unknown name is an error', () => {
  const r = resolvePeerSelection(peers, 'nope');
  assert.ok('error' in r);
});

test('empty / whitespace selection is an error', () => {
  assert.ok('error' in resolvePeerSelection(peers, ''));
  assert.ok('error' in resolvePeerSelection(peers, '   '));
});

test('empty peer list is an error', () => {
  assert.ok('error' in resolvePeerSelection([], '1'));
});
