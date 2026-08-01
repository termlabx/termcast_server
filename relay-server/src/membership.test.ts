import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEVEN_DAYS_MS } from './membership.js';
import {
  sessionNameFor, isActiveCluster, hasActiveCluster, upsertCluster, sweepExpiredClusters,
  isMeshActive, isMeshEjected, MESH_EJECTED,
} from './membership.js';

test('sessionNameFor: prefixes tc_ and sanitizes to [A-Za-z0-9_]', () => {
  assert.equal(sessionNameFor('1A2B-3C4D'), 'tc_1A2B_3C4D');
  assert.equal(sessionNameFor('abc def.x'), 'tc_abc_def_x');
});

test('isActiveCluster: active within 7 days, inactive at/after the cap', () => {
  const now = 1_000_000_000_000;
  assert.equal(isActiveCluster({ pairedAt: now }, now), true);
  assert.equal(isActiveCluster({ pairedAt: now }, now + SEVEN_DAYS_MS - 1), true);
  assert.equal(isActiveCluster({ pairedAt: now }, now + SEVEN_DAYS_MS), false);
});

test('hasActiveCluster: true iff any cluster is active', () => {
  const now = 1_000_000_000_000;
  const map = {
    a: { pairedAt: now - SEVEN_DAYS_MS, sessionName: 'tc_a' }, // expired
    b: { pairedAt: now, sessionName: 'tc_b' },                 // active
  };
  assert.equal(hasActiveCluster(map, now), true);
  assert.equal(hasActiveCluster({ a: map.a }, now), false);
  assert.equal(hasActiveCluster({}, now), false);
});

test('upsertCluster: adds new, keeps the newer pairedAt on update', () => {
  const now = 1_000_000_000_000;
  const m1 = upsertCluster({}, 'P1', now, now);
  assert.deepEqual(m1, { P1: { pairedAt: now, sessionName: 'tc_P1' } });
  // Reconnect reports an OLDER pairedAt → no extension.
  const m2 = upsertCluster(m1, 'P1', now - 5000, now);
  assert.equal(m2.P1.pairedAt, now);
  // Re-scan reports a NEWER pairedAt → extends.
  const m3 = upsertCluster(m2, 'P1', now + 5000, now);
  assert.equal(m3.P1.pairedAt, now + 5000);
});

test('sweepExpiredClusters: partitions and returns expired session names', () => {
  const now = 1_000_000_000_000;
  const map = {
    a: { pairedAt: now - SEVEN_DAYS_MS - 1, sessionName: 'tc_a' },
    b: { pairedAt: now, sessionName: 'tc_b' },
  };
  const { kept, expired } = sweepExpiredClusters(map, now);
  assert.deepEqual(Object.keys(kept), ['b']);
  assert.deepEqual(expired, ['tc_a']);
});

// --- Mesh association anchor (phone-agnostic; decoupled from phone clusters) ---

test('isMeshActive: positive anchor active within 7 days, inactive at/after the cap', () => {
  const now = 1_000_000_000_000;
  assert.equal(isMeshActive(now, now), true);
  assert.equal(isMeshActive(now, now + SEVEN_DAYS_MS - 1), true);
  assert.equal(isMeshActive(now, now + SEVEN_DAYS_MS), false);
});

test('isMeshActive: never-associated (0) and ejected (<0) anchors are inactive', () => {
  const now = 1_000_000_000_000;
  assert.equal(isMeshActive(0, now), false);
  assert.equal(isMeshActive(MESH_EJECTED, now), false);
  assert.equal(isMeshActive(-now, now), false); // any negative is inactive
});

test('isMeshEjected: only a negative anchor is ejected', () => {
  assert.equal(isMeshEjected(MESH_EJECTED), true);
  assert.equal(isMeshEjected(-1), true);
  assert.equal(isMeshEjected(0), false);
  assert.equal(isMeshEjected(1_000_000_000_000), false);
});

test('MESH_EJECTED is a negative sentinel', () => {
  assert.ok(MESH_EJECTED < 0);
});
