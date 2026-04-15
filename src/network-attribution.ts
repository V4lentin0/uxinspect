import { performance } from 'node:perf_hooks';
import type { Page, Response, Request } from 'playwright';

export interface NetworkFailure {
  url: string;
  status: number;
  statusText: string;
  method: string;
  durationMs: number;
  ts: number;
}

export interface NetworkSummary {
  '2xx': number;
  '3xx': number;
  '4xx': number;
  '5xx': number;
  failed: number;
}

interface TimelineEntry {
  ts: number;
  url: string;
  status: number;
  statusText: string;
  method: string;
  durationMs: number;
  kind: 'response' | 'failed';
}

export interface StepNetCapture {
  end(): { failures: NetworkFailure[]; step: string; count: NetworkSummary };
}

export interface NetworkHandle {
  markStepStart(stepLabel: string): StepNetCapture;
  result(): { failures: NetworkFailure[]; count: NetworkSummary };
  detach(): void;
}

function emptySummary(): NetworkSummary {
  return { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, failed: 0 };
}

function classify(entry: TimelineEntry, summary: NetworkSummary): void {
  if (entry.kind === 'failed') {
    summary.failed += 1;
    return;
  }
  const s = entry.status;
  if (s >= 200 && s < 300) summary['2xx'] += 1;
  else if (s >= 300 && s < 400) summary['3xx'] += 1;
  else if (s >= 400 && s < 500) summary['4xx'] += 1;
  else if (s >= 500) summary['5xx'] += 1;
}

function isFailure(entry: TimelineEntry): boolean {
  if (entry.kind === 'failed') return true;
  return entry.status >= 400;
}

function toFailure(entry: TimelineEntry): NetworkFailure {
  return {
    url: entry.url,
    status: entry.status,
    statusText: entry.statusText,
    method: entry.method,
    durationMs: entry.durationMs,
    ts: entry.ts,
  };
}

export function attachNetworkCapture(page: Page): NetworkHandle {
  const attachedAt = performance.now();
  const timeline: TimelineEntry[] = [];
  const requestStart = new WeakMap<Request, number>();

  const onRequest = (req: Request): void => {
    requestStart.set(req, performance.now());
  };

  const onResponse = (res: Response): void => {
    const req = res.request();
    const start = requestStart.get(req) ?? performance.now();
    const now = performance.now();
    let statusText = '';
    try {
      statusText = res.statusText();
    } catch {
      statusText = '';
    }
    timeline.push({
      ts: now - attachedAt,
      url: res.url(),
      status: res.status(),
      statusText,
      method: req.method(),
      durationMs: now - start,
      kind: 'response',
    });
  };

  const onRequestFailed = (req: Request): void => {
    const start = requestStart.get(req) ?? performance.now();
    const now = performance.now();
    const failure = req.failure();
    timeline.push({
      ts: now - attachedAt,
      url: req.url(),
      status: 0,
      statusText: failure?.errorText ?? 'request failed',
      method: req.method(),
      durationMs: now - start,
      kind: 'failed',
    });
  };

  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);

  const slice = (fromTs: number, toTs: number): TimelineEntry[] =>
    timeline.filter((e) => e.ts >= fromTs && e.ts <= toTs);

  const buildResult = (entries: TimelineEntry[]): {
    failures: NetworkFailure[];
    count: NetworkSummary;
  } => {
    const summary = emptySummary();
    const failures: NetworkFailure[] = [];
    for (const entry of entries) {
      classify(entry, summary);
      if (isFailure(entry)) failures.push(toFailure(entry));
    }
    return { failures, count: summary };
  };

  return {
    markStepStart(stepLabel: string): StepNetCapture {
      const startTs = performance.now() - attachedAt;
      return {
        end(): { failures: NetworkFailure[]; step: string; count: NetworkSummary } {
          const endTs = performance.now() - attachedAt;
          const entries = slice(startTs, endTs);
          const { failures, count } = buildResult(entries);
          return { failures, step: stepLabel, count };
        },
      };
    },
    result(): { failures: NetworkFailure[]; count: NetworkSummary } {
      return buildResult(timeline);
    },
    detach(): void {
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfailed', onRequestFailed);
    },
  };
}

export function stepLabelFor(step: unknown): string {
  if (!step || typeof step !== 'object') return 'step';
  const s = step as Record<string, unknown>;
  const keys = Object.keys(s);
  const kind = keys[0] ?? 'step';
  const val = s[kind];
  if (typeof val === 'string') return `${kind}:${val}`;
  if (typeof val === 'number' || typeof val === 'boolean') return `${kind}:${String(val)}`;
  if (val && typeof val === 'object') {
    const v = val as Record<string, unknown>;
    if (typeof v.selector === 'string') return `${kind}:${v.selector}`;
    if (typeof v.url === 'string') return `${kind}:${v.url}`;
    if (typeof v.from === 'string') return `${kind}:${v.from}`;
    if (typeof v.trigger === 'string') return `${kind}:${v.trigger}`;
  }
  return kind;
}
