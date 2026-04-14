import type { InspectConfig, InspectResult } from './types.js';

export interface CronField { values: number[]; }

export interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

export interface ScheduleOptions {
  cron: string;
  cfg: InspectConfig;
  maxRuns?: number;
  onResult?: (result: InspectResult, firedAt: Date) => void | Promise<void>;
  onError?: (err: unknown, firedAt: Date) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface ScheduleStats {
  runs: number;
  errors: number;
  lastResult?: InspectResult;
  startedAt: Date;
  stoppedAt?: Date;
}

const FIELD_RANGES: Array<{ name: keyof ParsedCron; min: number; max: number; wildcard?: boolean }> = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 6 },
];

const SAFETY_CAP = 10_000;
const LOOKAHEAD_MINUTES = 366 * 24 * 60;

function parseInteger(token: string, fieldName: string): number {
  if (!/^-?\d+$/.test(token)) {
    throw new Error(`invalid cron: non-integer "${token}" in ${fieldName}`);
  }
  const n = Number(token);
  if (!Number.isInteger(n)) {
    throw new Error(`invalid cron: non-integer "${token}" in ${fieldName}`);
  }
  return n;
}

function expandSegment(
  segment: string,
  min: number,
  max: number,
  fieldName: string,
): number[] {
  if (segment.length === 0) {
    throw new Error(`invalid cron: empty segment in ${fieldName}`);
  }

  let rangePart = segment;
  let step = 1;

  const slashIdx = segment.indexOf('/');
  if (slashIdx !== -1) {
    rangePart = segment.slice(0, slashIdx);
    const stepStr = segment.slice(slashIdx + 1);
    if (stepStr.length === 0) {
      throw new Error(`invalid cron: missing step after "/" in ${fieldName}`);
    }
    step = parseInteger(stepStr, fieldName);
    if (step <= 0) {
      throw new Error(`invalid cron: step must be > 0 in ${fieldName}`);
    }
  }

  let rangeStart: number;
  let rangeEnd: number;

  if (rangePart === '*') {
    rangeStart = min;
    rangeEnd = max;
  } else {
    const dashIdx = rangePart.indexOf('-');
    if (dashIdx > 0) {
      const a = parseInteger(rangePart.slice(0, dashIdx), fieldName);
      const b = parseInteger(rangePart.slice(dashIdx + 1), fieldName);
      if (a > b) {
        throw new Error(`invalid cron: range start > end "${rangePart}" in ${fieldName}`);
      }
      rangeStart = a;
      rangeEnd = b;
    } else {
      const n = parseInteger(rangePart, fieldName);
      rangeStart = n;
      if (slashIdx !== -1) {
        // "n/step" means "from n to max stepping by step"
        rangeEnd = max;
      } else {
        rangeEnd = n;
      }
    }
  }

  if (rangeStart < min || rangeEnd > max) {
    throw new Error(
      `invalid cron: value out of range [${min}-${max}] in ${fieldName} ("${segment}")`,
    );
  }

  const values: number[] = [];
  for (let v = rangeStart; v <= rangeEnd; v += step) {
    values.push(v);
  }
  return values;
}

function parseField(
  raw: string,
  min: number,
  max: number,
  fieldName: string,
): CronField {
  if (raw.length === 0) {
    throw new Error(`invalid cron: empty ${fieldName} field`);
  }
  const segments = raw.split(',');
  const set = new Set<number>();
  for (const seg of segments) {
    for (const v of expandSegment(seg, min, max, fieldName)) {
      set.add(v);
    }
  }
  if (set.size === 0) {
    throw new Error(`invalid cron: no values expanded for ${fieldName}`);
  }
  const values = Array.from(set).sort((a, b) => a - b);
  return { values };
}

export function parseCron(expr: string): ParsedCron {
  if (typeof expr !== 'string') {
    throw new Error('invalid cron: expression must be a string');
  }
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`invalid cron: expected 5 fields, got ${parts.length}`);
  }
  const [minStr, hourStr, domStr, monStr, dowStr] = parts;
  return {
    minute: parseField(minStr, FIELD_RANGES[0].min, FIELD_RANGES[0].max, 'minute'),
    hour: parseField(hourStr, FIELD_RANGES[1].min, FIELD_RANGES[1].max, 'hour'),
    dayOfMonth: parseField(domStr, FIELD_RANGES[2].min, FIELD_RANGES[2].max, 'dayOfMonth'),
    month: parseField(monStr, FIELD_RANGES[3].min, FIELD_RANGES[3].max, 'month'),
    dayOfWeek: parseField(dowStr, FIELD_RANGES[4].min, FIELD_RANGES[4].max, 'dayOfWeek'),
  };
}

function isRestricted(
  field: CronField,
  min: number,
  max: number,
): boolean {
  const expected = max - min + 1;
  return field.values.length !== expected;
}

function matchesCron(parsed: ParsedCron, d: Date): boolean {
  const minute = d.getMinutes();
  const hour = d.getHours();
  const dom = d.getDate();
  const month = d.getMonth() + 1;
  const dow = d.getDay();

  if (!parsed.minute.values.includes(minute)) return false;
  if (!parsed.hour.values.includes(hour)) return false;
  if (!parsed.month.values.includes(month)) return false;

  const domRestricted = isRestricted(parsed.dayOfMonth, 1, 31);
  const dowRestricted = isRestricted(parsed.dayOfWeek, 0, 6);
  const domMatch = parsed.dayOfMonth.values.includes(dom);
  const dowMatch = parsed.dayOfWeek.values.includes(dow);

  if (domRestricted && dowRestricted) {
    if (!domMatch && !dowMatch) return false;
  } else if (domRestricted) {
    if (!domMatch) return false;
  } else if (dowRestricted) {
    if (!dowMatch) return false;
  }

  return true;
}

export function nextFireTime(parsed: ParsedCron, from: Date): Date {
  const start = new Date(from.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  const cursor = new Date(start.getTime());
  for (let i = 0; i < LOOKAHEAD_MINUTES; i++) {
    if (matchesCron(parsed, cursor)) {
      return new Date(cursor.getTime());
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  throw new Error('no matching cron time within 1 year');
}

function sleepUntil(target: Date, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const delay = Math.max(0, target.getTime() - Date.now());
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function safeCallback<T>(
  fn: ((arg: T, firedAt: Date) => void | Promise<void>) | undefined,
  arg: T,
  firedAt: Date,
): Promise<void> {
  if (!fn) return;
  try {
    await fn(arg, firedAt);
  } catch {
    // swallow handler errors so the loop never breaks
  }
}

export async function runSchedule(opts: ScheduleOptions): Promise<ScheduleStats> {
  const parsed = parseCron(opts.cron);
  const requestedMax = opts.maxRuns === undefined ? Infinity : opts.maxRuns;
  const cap = Number.isFinite(requestedMax)
    ? Math.min(requestedMax, SAFETY_CAP)
    : SAFETY_CAP;

  const stats: ScheduleStats = {
    runs: 0,
    errors: 0,
    startedAt: new Date(),
  };

  const mod = (await import('./index.js')) as { inspect: (c: InspectConfig) => Promise<InspectResult> };
  const inspect = mod.inspect;

  while (stats.runs < cap) {
    if (opts.signal?.aborted) break;

    let target: Date;
    try {
      target = nextFireTime(parsed, new Date());
    } catch (err) {
      stats.errors += 1;
      await safeCallback(opts.onError, err, new Date());
      break;
    }

    await sleepUntil(target, opts.signal);
    if (opts.signal?.aborted) break;

    const firedAt = new Date();
    try {
      const result = await inspect(opts.cfg);
      stats.runs += 1;
      stats.lastResult = result;
      await safeCallback(opts.onResult, result, firedAt);
    } catch (err) {
      stats.runs += 1;
      stats.errors += 1;
      await safeCallback(opts.onError, err, firedAt);
    }
  }

  stats.stoppedAt = new Date();
  return stats;
}
