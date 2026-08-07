// Pure aggregation over UsageRecord[]: daily rollups, today/last7 totals, and
// the three waste rows. No I/O and no clock reads except an injected `now`,
// so everything here is testable against hand-built arrays.

import type { UsageRecord } from './ai-metrics';

export interface DayUsage {
  day: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  requests: number;
}

export interface WasteRow {
  tokens: number;
  /** Denominator this row is a share of. */
  of: number;
  /** Requests contributing to this row. */
  requests: number;
}

export interface UsageSummary {
  /** Ascending, gap-filled: every day in range present, zeros included. */
  daily: DayUsage[];
  today: DayUsage;
  last7: DayUsage;
  /** Computed over the last 7 days only — same window as `last7`. */
  waste: {
    expiredCache: WasteRow;
    interrupted: WasteRow;
    truncated: WasteRow;
  };
  /** Range actually covered, for the chart axis. */
  from: string;
  to: string;
}

export interface SummarizeOptions {
  now?: number;
  /** Days of history in the chart. Default 30. */
  days?: number;
  /** Injected for deterministic day-key tests. */
  timeZone?: string;
}

/** Local-time YYYY-MM-DD day key for an ms epoch, in the given timezone. */
export function dayKey(ms: number, timeZone?: string): string {
  if (!Number.isFinite(ms)) return '';
  const base: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit' };
  const fmt = timeZone
    ? new Intl.DateTimeFormat('en-CA', { ...base, timeZone })
    : new Intl.DateTimeFormat('en-CA', base);
  const parts = fmt.formatToParts(new Date(ms));
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find(p => p.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function recordDay(record: UsageRecord, timeZone?: string): string {
  return record.day || dayKey(record.at, timeZone);
}

function emptyDay(day: string): DayUsage {
  return { day, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
}

function dailyUsage(records: UsageRecord[], from: string, to: string, timeZone?: string): DayUsage[] {
  const buckets = new Map<string, DayUsage>();
  for (let day = from; day <= to; day = addDays(day, 1)) {
    buckets.set(day, emptyDay(day));
  }
  for (const r of records) {
    const b = buckets.get(recordDay(r, timeZone));
    if (!b) continue;
    b.input += r.input;
    b.output += r.output;
    b.cacheRead += r.cacheRead;
    b.cacheWrite += r.cacheWrite;
    b.requests += 1;
  }
  return [...buckets.values()];
}

function totalsFor(daily: DayUsage[], fromDay: string, toDay: string): DayUsage {
  const acc = emptyDay(fromDay === toDay ? fromDay : '');
  for (const d of daily) {
    if (d.day >= fromDay && d.day <= toDay) {
      acc.input += d.input;
      acc.output += d.output;
      acc.cacheRead += d.cacheRead;
      acc.cacheWrite += d.cacheWrite;
      acc.requests += d.requests;
    }
  }
  return acc;
}

function expiredCacheWaste(records: UsageRecord[]): WasteRow {
  const bySession = new Map<string, UsageRecord[]>();
  for (const r of records) {
    let arr = bySession.get(r.sessionId);
    if (!arr) {
      arr = [];
      bySession.set(r.sessionId, arr);
    }
    arr.push(r);
  }
  let tokens = 0;
  let of = 0;
  let requests = 0;
  for (const arr of bySession.values()) {
    arr.sort((a, b) => a.at - b.at);
    for (let i = 0; i < arr.length; i++) {
      const r = arr[i];
      if (r.cacheWrite <= 0 || r.cacheTtlMs === 0) continue;
      of += r.cacheWrite;
      const next = arr[i + 1];
      if (!next || next.at - r.at > r.cacheTtlMs) {
        tokens += r.cacheWrite;
        requests += 1;
      }
    }
  }
  return { tokens, of, requests };
}

function interruptedWaste(records: UsageRecord[]): WasteRow {
  let tokens = 0;
  let of = 0;
  let requests = 0;
  for (const r of records) {
    if (r.source !== 'claude-code') continue;
    of += r.output;
    if (r.interrupted) {
      tokens += r.output;
      requests += 1;
    }
  }
  return { tokens, of, requests };
}

function truncatedWaste(records: UsageRecord[]): WasteRow {
  let tokens = 0;
  let of = 0;
  let requests = 0;
  for (const r of records) {
    of += r.output;
    if (r.stopReason === 'max_tokens') {
      tokens += r.output;
      requests += 1;
    }
  }
  return { tokens, of, requests };
}

export function summarize(records: UsageRecord[], opts: SummarizeOptions = {}): UsageSummary {
  const now = opts.now ?? Date.now();
  const days = opts.days ?? 30;
  const timeZone = opts.timeZone;
  const todayKey = dayKey(now, timeZone);
  const fromKey = addDays(todayKey, -(days - 1));
  const daily = dailyUsage(records, fromKey, todayKey, timeZone);
  const today = totalsFor(daily, todayKey, todayKey);
  const last7From = addDays(todayKey, -6);
  const last7 = totalsFor(daily, last7From, todayKey);
  const windowed = records.filter(r => {
    const day = recordDay(r, timeZone);
    return day >= last7From && day <= todayKey;
  });
  return {
    daily,
    today,
    last7,
    waste: {
      expiredCache: expiredCacheWaste(windowed),
      interrupted: interruptedWaste(windowed),
      truncated: truncatedWaste(windowed),
    },
    from: fromKey,
    to: todayKey,
  };
}
