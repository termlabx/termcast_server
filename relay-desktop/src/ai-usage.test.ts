import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from './ai-usage';
import type { UsageRecord } from './ai-metrics';

function rec(partial: Partial<UsageRecord> & { at: number; day?: string }): UsageRecord {
  return {
    source: partial.source ?? 'claude-code',
    sessionId: 's',
    model: 'm',
    at: partial.at,
    day: partial.day ?? '',
    input: partial.input ?? 0,
    output: partial.output ?? 0,
    cacheRead: partial.cacheRead ?? 0,
    cacheWrite: partial.cacheWrite ?? 0,
    cacheTtlMs: partial.cacheTtlMs ?? 0,
    stopReason: partial.stopReason,
    interrupted: partial.interrupted,
  };
}

test('daily is gap-filled, ascending, and includes idle days as zeros', () => {
  const now = Date.parse('2026-08-05T12:00:00Z');
  const s = summarize([
    rec({ at: Date.parse('2026-08-02T10:00:00Z'), day: '2026-08-02', input: 10, output: 5 }),
    rec({ at: Date.parse('2026-08-04T10:00:00Z'), day: '2026-08-04', input: 20 }),
  ], { now, days: 30, timeZone: 'UTC' });
  assert.equal(s.daily.length, 30);
  assert.equal(s.daily[0].day, '2026-07-07');
  assert.equal(s.daily[29].day, '2026-08-05');
  for (let i = 1; i < s.daily.length; i++) {
    const [y, m, d] = s.daily[i].day.split('-').map(Number);
    assert.equal(s.daily[i - 1].day, new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10));
  }
  const idle = s.daily.find(d => d.day === '2026-08-03');
  assert.ok(idle);
  assert.equal(idle.input, 0);
  assert.equal(idle.output, 0);
  assert.equal(idle.requests, 0);
  assert.equal(s.daily.find(d => d.day === '2026-08-02')?.input, 10);
  assert.equal(s.daily.find(d => d.day === '2026-08-04')?.input, 20);
});

test('a record just after midnight UTC lands on the prior day in America/Los_Angeles', () => {
  const now = Date.parse('2026-08-03T20:00:00Z');
  const s = summarize([
    rec({ at: Date.parse('2026-08-03T06:30:00Z'), input: 10 }),
  ], { now, days: 30, timeZone: 'America/Los_Angeles' });
  assert.equal(s.today.day, '2026-08-03');
  assert.equal(s.daily.find(d => d.day === '2026-08-02')?.input, 10);
  assert.equal(s.daily.find(d => d.day === '2026-08-03')?.input, 0);
});

test('today and last7 equal the corresponding sums of daily', () => {
  const now = Date.parse('2026-08-05T12:00:00Z');
  const s = summarize([
    rec({ at: Date.parse('2026-08-05T09:00:00Z'), day: '2026-08-05', input: 10, output: 1 }),
    rec({ at: Date.parse('2026-08-04T09:00:00Z'), day: '2026-08-04', input: 20, output: 2 }),
    rec({ at: Date.parse('2026-07-30T09:00:00Z'), day: '2026-07-30', input: 5, output: 3 }),
    rec({ at: Date.parse('2026-08-10T09:00:00Z'), day: '2026-08-10', input: 100, output: 4 }),
  ], { now, days: 30, timeZone: 'UTC' });
  assert.equal(s.today.day, '2026-08-05');
  assert.equal(s.today.input, 10);
  assert.equal(s.today.output, 1);
  assert.equal(s.today.requests, 1);
  assert.equal(s.last7.input, 35);
  assert.equal(s.last7.output, 6);
  assert.equal(s.last7.requests, 3);
  let sum = 0;
  for (const d of s.daily) {
    if (d.day >= '2026-07-30' && d.day <= '2026-08-05') sum += d.input;
  }
  assert.equal(sum, s.last7.input);
  assert.equal(s.daily.find(d => d.day === '2026-08-05')?.input, s.today.input);
});

test('expired cache waste: reads inside TTL are not wasted; reads after TTL and final writes are', () => {
  const now = Date.parse('2026-08-05T12:00:00Z');
  const s = summarize([
    rec({ sessionId: 's', at: Date.parse('2026-08-01T00:00:00Z'), day: '2026-08-01', cacheWrite: 100, cacheTtlMs: 3_600_000 }),
    rec({ sessionId: 's', at: Date.parse('2026-08-01T00:10:00Z'), day: '2026-08-01' }),
    rec({ sessionId: 's', at: Date.parse('2026-08-02T00:00:00Z'), day: '2026-08-02', cacheWrite: 100, cacheTtlMs: 3_600_000 }),
    rec({ sessionId: 's', at: Date.parse('2026-08-02T02:00:00Z'), day: '2026-08-02' }),
    rec({ sessionId: 's', at: Date.parse('2026-08-03T00:00:00Z'), day: '2026-08-03', cacheWrite: 50, cacheTtlMs: 3_600_000 }),
  ], { now, days: 30, timeZone: 'UTC' });
  assert.equal(s.waste.expiredCache.tokens, 150);
  assert.equal(s.waste.expiredCache.of, 250);
  assert.equal(s.waste.expiredCache.requests, 2);
});

test('records with unknown cache TTL are excluded from the expired-cache row', () => {
  const now = Date.parse('2026-08-05T12:00:00Z');
  const s = summarize([
    rec({ sessionId: 's', at: Date.parse('2026-08-01T00:00:00Z'), day: '2026-08-01', cacheWrite: 100, cacheTtlMs: 0 }),
  ], { now, days: 30, timeZone: 'UTC' });
  assert.equal(s.waste.expiredCache.tokens, 0);
  assert.equal(s.waste.expiredCache.of, 0);
  assert.equal(s.waste.expiredCache.requests, 0);
});

test('interrupted and truncated rows sum only their matching records', () => {
  const now = Date.parse('2026-08-05T12:00:00Z');
  const s = summarize([
    rec({ at: Date.parse('2026-08-01T00:00:00Z'), day: '2026-08-01', output: 30, interrupted: true }),
    rec({ at: Date.parse('2026-08-02T00:00:00Z'), day: '2026-08-02', output: 40, stopReason: 'max_tokens' }),
    rec({ at: Date.parse('2026-08-03T00:00:00Z'), day: '2026-08-03', output: 10 }),
    rec({ source: 'opencode', at: Date.parse('2026-08-04T00:00:00Z'), day: '2026-08-04', output: 60, stopReason: 'max_tokens' }),
  ], { now, days: 30, timeZone: 'UTC' });
  assert.equal(s.waste.interrupted.tokens, 30);
  assert.equal(s.waste.interrupted.requests, 1);
  assert.equal(s.waste.interrupted.of, 80);
  assert.equal(s.waste.truncated.tokens, 100);
  assert.equal(s.waste.truncated.requests, 2);
  assert.equal(s.waste.truncated.of, 140);
});

test('waste rows are scoped to the last 7 days, not all history', () => {
  const now = Date.parse('2026-08-05T12:00:00Z');
  const s = summarize([
    rec({ at: Date.parse('2026-07-01T00:00:00Z'), day: '2026-07-01', output: 200, interrupted: true, cacheWrite: 100, cacheTtlMs: 3_600_000 }),
  ], { now, days: 30, timeZone: 'UTC' });
  assert.equal(s.waste.interrupted.tokens, 0);
  assert.equal(s.waste.interrupted.of, 0);
  assert.equal(s.waste.truncated.of, 0);
  assert.equal(s.waste.expiredCache.tokens, 0);
  assert.equal(s.waste.expiredCache.of, 0);
});
