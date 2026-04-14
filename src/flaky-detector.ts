import type { InspectConfig, InspectResult, FlowResult } from './types.js';

export interface FlakyOptions {
  runs: number;
  concurrency?: number;
  threshold?: number;
}

export interface FlowFlakiness {
  name: string;
  passes: number;
  fails: number;
  ratio: number;
  flaky: boolean;
  errors: string[];
}

export interface VisualFlakiness {
  page: string;
  viewport: string;
  diffs: number[];
  variance: number;
}

export interface FlakyReport {
  totalRuns: number;
  fullyPassing: number;
  fullyFailing: number;
  flows: FlowFlakiness[];
  visualFlakiness: VisualFlakiness[];
  flakyFlows: number;
  passed: boolean;
}

type InspectFn = (config: InspectConfig) => Promise<InspectResult>;

const MAX_ERRORS_PER_FLOW = 5;
const VISUAL_VARIANCE_EPSILON = 0.001;

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

async function loadInspect(): Promise<InspectFn> {
  const mod = (await import('./index.js')) as { inspect: InspectFn };
  return mod.inspect;
}

async function runSequential(
  inspectFn: InspectFn,
  cfg: InspectConfig,
  runs: number,
): Promise<InspectResult[]> {
  const results: InspectResult[] = [];
  for (let i = 0; i < runs; i++) {
    results.push(await inspectFn(cfg));
  }
  return results;
}

async function runConcurrent(
  inspectFn: InspectFn,
  cfg: InspectConfig,
  runs: number,
  concurrency: number,
): Promise<InspectResult[]> {
  const results: InspectResult[] = new Array<InspectResult>(runs);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= runs) return;
      results[index] = await inspectFn(cfg);
    }
  }

  const workers: Promise<void>[] = [];
  const poolSize = Math.min(concurrency, runs);
  for (let i = 0; i < poolSize; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

interface FlowAccumulator {
  name: string;
  passes: number;
  fails: number;
  errors: string[];
  errorSet: Set<string>;
}

function aggregateFlows(
  results: InspectResult[],
  threshold: number,
  totalRuns: number,
): FlowFlakiness[] {
  const acc = new Map<string, FlowAccumulator>();

  for (const result of results) {
    const flows: FlowResult[] = result.flows ?? [];
    for (const flow of flows) {
      let entry = acc.get(flow.name);
      if (!entry) {
        entry = {
          name: flow.name,
          passes: 0,
          fails: 0,
          errors: [],
          errorSet: new Set<string>(),
        };
        acc.set(flow.name, entry);
      }
      if (flow.passed) {
        entry.passes++;
      } else {
        entry.fails++;
      }
      const errMsg = extractFlowError(flow);
      if (errMsg && !entry.errorSet.has(errMsg)) {
        entry.errorSet.add(errMsg);
        if (entry.errors.length < MAX_ERRORS_PER_FLOW) {
          entry.errors.push(errMsg);
        }
      }
    }
  }

  const out: FlowFlakiness[] = [];
  for (const entry of acc.values()) {
    const denominator = entry.passes + entry.fails;
    const ratio = denominator === 0 ? 0 : entry.fails / denominator;
    const flaky = ratio > 0 && ratio < 1 && ratio >= threshold;
    out.push({
      name: entry.name,
      passes: entry.passes,
      fails: entry.fails,
      ratio,
      flaky,
      errors: entry.errors,
    });
  }

  // stabilise order: flaky first, then by name
  out.sort((a, b) => {
    if (a.flaky !== b.flaky) return a.flaky ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  void totalRuns;
  return out;
}

function extractFlowError(flow: FlowResult): string | null {
  if (flow.error && flow.error.trim().length > 0) return flow.error.trim();
  for (const step of flow.steps ?? []) {
    if (!step.passed && step.error && step.error.trim().length > 0) {
      return step.error.trim();
    }
  }
  return null;
}

function aggregateVisual(results: InspectResult[]): VisualFlakiness[] {
  const buckets = new Map<string, { page: string; viewport: string; diffs: number[] }>();

  for (const result of results) {
    const visuals = result.visual ?? [];
    for (const v of visuals) {
      const key = `${v.page}::${v.viewport}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { page: v.page, viewport: v.viewport, diffs: [] };
        buckets.set(key, bucket);
      }
      if (typeof v.diffRatio === 'number' && Number.isFinite(v.diffRatio)) {
        bucket.diffs.push(v.diffRatio);
      }
    }
  }

  const out: VisualFlakiness[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.diffs.length < 2) continue;
    let min = bucket.diffs[0];
    let max = bucket.diffs[0];
    for (const d of bucket.diffs) {
      if (d < min) min = d;
      if (d > max) max = d;
    }
    const variance = max - min;
    if (variance > VISUAL_VARIANCE_EPSILON) {
      out.push({
        page: bucket.page,
        viewport: bucket.viewport,
        diffs: bucket.diffs.slice(),
        variance,
      });
    }
  }

  out.sort((a, b) => {
    if (b.variance !== a.variance) return b.variance - a.variance;
    return `${a.page}::${a.viewport}`.localeCompare(`${b.page}::${b.viewport}`);
  });
  return out;
}

export async function detectFlakiness(
  cfg: InspectConfig,
  opts: FlakyOptions,
): Promise<FlakyReport> {
  const runs = clamp(opts.runs, 2, 20);
  const concurrency = clamp(opts.concurrency ?? 1, 1, 10);
  const threshold =
    typeof opts.threshold === 'number' && Number.isFinite(opts.threshold)
      ? Math.min(1, Math.max(0, opts.threshold))
      : 0;

  const inspectFn = await loadInspect();
  const results =
    concurrency <= 1
      ? await runSequential(inspectFn, cfg, runs)
      : await runConcurrent(inspectFn, cfg, runs, concurrency);

  let fullyPassing = 0;
  let fullyFailing = 0;
  for (const r of results) {
    if (r.passed === true) fullyPassing++;
    else if (r.passed === false) fullyFailing++;
  }

  const flows = aggregateFlows(results, threshold, runs);
  const visualFlakiness = aggregateVisual(results);

  let flakyFlows = 0;
  for (const f of flows) {
    if (f.flaky) flakyFlows++;
  }

  return {
    totalRuns: runs,
    fullyPassing,
    fullyFailing,
    flows,
    visualFlakiness,
    flakyFlows,
    passed: flakyFlows === 0 && fullyFailing === 0,
  };
}

function trimOneLine(input: string, max: number): string {
  const collapsed = input.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  if (max <= 1) return collapsed.slice(0, max);
  return `${collapsed.slice(0, max - 1)}…`;
}

function padRight(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + ' '.repeat(width - s.length);
}

function padLeft(s: string, width: number): string {
  if (s.length >= width) return s;
  return ' '.repeat(width - s.length) + s;
}

function formatPercent(ratio: number): string {
  const pct = ratio * 100;
  if (!Number.isFinite(pct)) return '  0.0%';
  return `${pct.toFixed(1)}%`;
}

function formatNumber(n: number, digits: number): string {
  if (!Number.isFinite(n)) return '0';
  return n.toFixed(digits);
}

export function formatFlakyReport(report: FlakyReport): string {
  const lines: string[] = [];
  lines.push(`Flaky detector: ${report.totalRuns} runs`);
  lines.push(
    `  ${report.fullyPassing} fully passing, ` +
      `${report.fullyFailing} fully failing, ` +
      `${report.flakyFlows} flaky flows`,
  );
  lines.push(`  status: ${report.passed ? 'PASS' : 'FAIL'}`);

  if (report.flows.length > 0) {
    lines.push('');
    lines.push('Flows:');
    const nameWidth = Math.min(
      32,
      Math.max(4, ...report.flows.map((f) => f.name.length)),
    );
    const header =
      `  ${padRight('name', nameWidth)}  ` +
      `${padLeft('pass', 5)} ${padLeft('fail', 5)} ` +
      `${padLeft('ratio', 7)}  flag  error`;
    lines.push(header);
    for (const f of report.flows) {
      const name = trimOneLine(f.name, nameWidth);
      const flag = f.flaky ? 'FLAKY' : f.fails === 0 ? 'ok   ' : 'fail ';
      const err = f.errors.length > 0 ? trimOneLine(f.errors[0], 80) : '';
      lines.push(
        `  ${padRight(name, nameWidth)}  ` +
          `${padLeft(String(f.passes), 5)} ${padLeft(String(f.fails), 5)} ` +
          `${padLeft(formatPercent(f.ratio), 7)}  ${flag} ${err}`.trimEnd(),
      );
    }
  }

  if (report.visualFlakiness.length > 0) {
    lines.push('');
    lines.push('Visual flakiness:');
    for (const v of report.visualFlakiness) {
      let min = v.diffs[0] ?? 0;
      let max = v.diffs[0] ?? 0;
      for (const d of v.diffs) {
        if (d < min) min = d;
        if (d > max) max = d;
      }
      const key = trimOneLine(`${v.page}/${v.viewport}`, 50);
      lines.push(
        `  ${key}: variance=${formatNumber(v.variance, 3)} ` +
          `(min=${formatNumber(min, 3)} max=${formatNumber(max, 3)})`,
      );
    }
  }

  return lines.join('\n');
}
