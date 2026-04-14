import { promises as fs } from 'node:fs';
import type { InspectResult, PerfResult, A11yResult, VisualResult } from './types.js';

export interface DiffThresholds {
  lcpMsIncrease?: number;
  clsIncrease?: number;
  tbtMsIncrease?: number;
  perfScoreDrop?: number;
  a11yScoreDrop?: number;
  a11yCriticalIncrease?: number;
  a11ySeriousIncrease?: number;
  visualDiffRatioIncrease?: number;
  newConsoleErrors?: number;
  newBrokenLinks?: number;
}

export interface MetricDelta {
  metric: string;
  page?: string;
  baseline: number;
  current: number;
  delta: number;
  threshold: number;
  regressed: boolean;
}

export interface BudgetDiffResult {
  passed: boolean;
  deltas: MetricDelta[];
  regressions: MetricDelta[];
  summary: {
    totalChecked: number;
    regressedCount: number;
    worst?: MetricDelta;
  };
}

interface ResolvedThresholds {
  lcpMsIncrease: number;
  clsIncrease: number;
  tbtMsIncrease: number;
  perfScoreDrop: number;
  a11yScoreDrop: number;
  a11yCriticalIncrease: number;
  a11ySeriousIncrease: number;
  visualDiffRatioIncrease: number;
  newConsoleErrors: number;
  newBrokenLinks: number;
}

const DEFAULTS: ResolvedThresholds = {
  lcpMsIncrease: 200,
  clsIncrease: 0.02,
  tbtMsIncrease: 100,
  perfScoreDrop: 3,
  a11yScoreDrop: 3,
  a11yCriticalIncrease: 0,
  a11ySeriousIncrease: 2,
  visualDiffRatioIncrease: 0.005,
  newConsoleErrors: 0,
  newBrokenLinks: 0,
};

function resolveThresholds(t?: DiffThresholds): ResolvedThresholds {
  return {
    lcpMsIncrease: t?.lcpMsIncrease ?? DEFAULTS.lcpMsIncrease,
    clsIncrease: t?.clsIncrease ?? DEFAULTS.clsIncrease,
    tbtMsIncrease: t?.tbtMsIncrease ?? DEFAULTS.tbtMsIncrease,
    perfScoreDrop: t?.perfScoreDrop ?? DEFAULTS.perfScoreDrop,
    a11yScoreDrop: t?.a11yScoreDrop ?? DEFAULTS.a11yScoreDrop,
    a11yCriticalIncrease: t?.a11yCriticalIncrease ?? DEFAULTS.a11yCriticalIncrease,
    a11ySeriousIncrease: t?.a11ySeriousIncrease ?? DEFAULTS.a11ySeriousIncrease,
    visualDiffRatioIncrease: t?.visualDiffRatioIncrease ?? DEFAULTS.visualDiffRatioIncrease,
    newConsoleErrors: t?.newConsoleErrors ?? DEFAULTS.newConsoleErrors,
    newBrokenLinks: t?.newBrokenLinks ?? DEFAULTS.newBrokenLinks,
  };
}

function round(value: number, digits = 3): number {
  const m = Math.pow(10, digits);
  return Math.round(value * m) / m;
}

function makeDelta(
  metric: string,
  baseline: number,
  current: number,
  threshold: number,
  page?: string,
  higherIsWorse = true,
): MetricDelta {
  const rawDelta = current - baseline;
  const delta = round(rawDelta, 4);
  const regressed = higherIsWorse ? rawDelta > threshold : -rawDelta > threshold;
  const row: MetricDelta = {
    metric,
    baseline: round(baseline, 4),
    current: round(current, 4),
    delta,
    threshold,
    regressed,
  };
  if (page !== undefined) row.page = page;
  return row;
}

function perfByPage(list: PerfResult[] | undefined): Map<string, PerfResult> {
  const map = new Map<string, PerfResult>();
  for (const entry of list ?? []) map.set(entry.page, entry);
  return map;
}

function visualByKey(list: VisualResult[] | undefined): Map<string, VisualResult> {
  const map = new Map<string, VisualResult>();
  for (const entry of list ?? []) map.set(`${entry.page}::${entry.viewport}`, entry);
  return map;
}

function avgScore(list: PerfResult[] | undefined, key: 'performance' | 'accessibility'): number {
  const items = list ?? [];
  if (items.length === 0) return 0;
  let sum = 0;
  for (const item of items) sum += item.scores[key];
  return sum / items.length;
}

function countA11yImpact(
  list: A11yResult[] | undefined,
  impact: 'critical' | 'serious',
): number {
  let n = 0;
  for (const page of list ?? []) {
    for (const v of page.violations) {
      if (v.impact === impact) n += 1;
    }
  }
  return n;
}

function collectConsoleMessages(result: InspectResult): Set<string> {
  const set = new Set<string>();
  for (const capture of result.consoleErrors ?? []) {
    for (const issue of capture.issues) set.add(issue.message);
  }
  return set;
}

function countNewConsoleErrors(baseline: InspectResult, current: InspectResult): number {
  const prior = collectConsoleMessages(baseline);
  let n = 0;
  for (const capture of current.consoleErrors ?? []) {
    for (const issue of capture.issues) {
      if (issue.type === 'warning') continue;
      if (!prior.has(issue.message)) n += 1;
    }
  }
  return n;
}

function collectBrokenLinkUrls(result: InspectResult): Set<string> {
  const set = new Set<string>();
  for (const entry of result.links ?? []) {
    for (const b of entry.broken) {
      if (b.status === 0 || b.status >= 400) set.add(b.url);
    }
  }
  return set;
}

function countNewBrokenLinks(baseline: InspectResult, current: InspectResult): number {
  const prior = collectBrokenLinkUrls(baseline);
  const now = collectBrokenLinkUrls(current);
  let n = 0;
  for (const url of now) if (!prior.has(url)) n += 1;
  return n;
}

function diffPerfPages(
  baseline: InspectResult,
  current: InspectResult,
  th: ResolvedThresholds,
): MetricDelta[] {
  const rows: MetricDelta[] = [];
  const baseMap = perfByPage(baseline.perf);
  const curMap = perfByPage(current.perf);
  for (const [page, cur] of curMap) {
    const prev = baseMap.get(page);
    if (!prev) continue;
    rows.push(makeDelta('lcp_ms', prev.metrics.lcp, cur.metrics.lcp, th.lcpMsIncrease, page));
    rows.push(makeDelta('cls', prev.metrics.cls, cur.metrics.cls, th.clsIncrease, page));
    rows.push(makeDelta('tbt_ms', prev.metrics.tbt, cur.metrics.tbt, th.tbtMsIncrease, page));
  }
  return rows;
}

function diffVisualPages(
  baseline: InspectResult,
  current: InspectResult,
  th: ResolvedThresholds,
): MetricDelta[] {
  const rows: MetricDelta[] = [];
  const baseMap = visualByKey(baseline.visual);
  const curMap = visualByKey(current.visual);
  for (const [key, cur] of curMap) {
    const prev = baseMap.get(key);
    if (!prev) continue;
    rows.push(
      makeDelta(
        'visual_diff_ratio',
        prev.diffRatio,
        cur.diffRatio,
        th.visualDiffRatioIncrease,
        `${cur.page} [${cur.viewport}]`,
      ),
    );
  }
  return rows;
}

function diffAggregateScores(
  baseline: InspectResult,
  current: InspectResult,
  th: ResolvedThresholds,
): MetricDelta[] {
  const rows: MetricDelta[] = [];
  const basePerf = avgScore(baseline.perf, 'performance');
  const curPerf = avgScore(current.perf, 'performance');
  rows.push(makeDelta('perf_score_avg', basePerf, curPerf, th.perfScoreDrop, undefined, false));

  const baseA11y = avgScore(baseline.perf, 'accessibility');
  const curA11y = avgScore(current.perf, 'accessibility');
  rows.push(makeDelta('a11y_score_avg', baseA11y, curA11y, th.a11yScoreDrop, undefined, false));

  const baseCrit = countA11yImpact(baseline.a11y, 'critical');
  const curCrit = countA11yImpact(current.a11y, 'critical');
  rows.push(makeDelta('a11y_critical', baseCrit, curCrit, th.a11yCriticalIncrease));

  const baseSer = countA11yImpact(baseline.a11y, 'serious');
  const curSer = countA11yImpact(current.a11y, 'serious');
  rows.push(makeDelta('a11y_serious', baseSer, curSer, th.a11ySeriousIncrease));
  return rows;
}

function diffCrossReport(
  baseline: InspectResult,
  current: InspectResult,
  th: ResolvedThresholds,
): MetricDelta[] {
  const rows: MetricDelta[] = [];
  const newErrors = countNewConsoleErrors(baseline, current);
  rows.push(makeDelta('new_console_errors', 0, newErrors, th.newConsoleErrors));

  const newBroken = countNewBrokenLinks(baseline, current);
  rows.push(makeDelta('new_broken_links', 0, newBroken, th.newBrokenLinks));
  return rows;
}

export function diffReports(
  baseline: InspectResult,
  current: InspectResult,
  thresholds?: DiffThresholds,
): BudgetDiffResult {
  const th = resolveThresholds(thresholds);
  const deltas: MetricDelta[] = [
    ...diffPerfPages(baseline, current, th),
    ...diffVisualPages(baseline, current, th),
    ...diffAggregateScores(baseline, current, th),
    ...diffCrossReport(baseline, current, th),
  ];
  const regressions = deltas.filter((d) => d.regressed);
  let worst: MetricDelta | undefined;
  let worstScore = -Infinity;
  for (const r of regressions) {
    const score = Math.abs(r.delta) - r.threshold;
    if (score > worstScore) {
      worstScore = score;
      worst = r;
    }
  }
  const summary: BudgetDiffResult['summary'] = {
    totalChecked: deltas.length,
    regressedCount: regressions.length,
  };
  if (worst) summary.worst = worst;
  return {
    passed: regressions.length === 0,
    deltas,
    regressions,
    summary,
  };
}

const COL_WIDTHS: readonly number[] = [20, 22, 10, 10, 10, 10, 10];
const COL_HEADERS: readonly string[] = [
  'Metric',
  'Page',
  'Baseline',
  'Current',
  'Delta',
  'Threshold',
  'Status',
];

function pad(value: string | number, width: number): string {
  const raw = typeof value === 'number' ? String(value) : value;
  const s = raw.length > width ? (width > 1 ? raw.slice(0, width - 1) + '…' : raw.slice(0, width)) : raw;
  return s + ' '.repeat(Math.max(0, width - s.length));
}

function renderRow(cells: readonly (string | number)[]): string {
  return '| ' + cells.map((c, i) => pad(c, COL_WIDTHS[i] ?? 10)).join(' | ') + ' |';
}

export function formatDiff(result: BudgetDiffResult): string {
  const status = result.passed ? 'PASS' : 'FAIL';
  const header = `Budget Diff: ${status} — ${result.summary.regressedCount}/${result.summary.totalChecked} regressions`;
  const sep = '| ' + COL_WIDTHS.map((w) => '-'.repeat(w)).join(' | ') + ' |';
  const rows = result.deltas.map((d) =>
    renderRow([
      d.metric,
      d.page ?? '-',
      d.baseline,
      d.current,
      d.delta,
      d.threshold,
      d.regressed ? 'REGRESSED' : 'OK',
    ]),
  );
  const lines = [header, '', renderRow(COL_HEADERS), sep, ...rows];
  if (result.summary.worst) {
    const w = result.summary.worst;
    const pagePart = w.page ? ` (${w.page})` : '';
    lines.push('', `Worst: ${w.metric}${pagePart} delta=${w.delta} threshold=${w.threshold}`);
  }
  return lines.join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateReport(raw: unknown, source: string): InspectResult {
  if (!isRecord(raw)) {
    throw new Error(`Invalid report ${source}: expected object`);
  }
  if (typeof raw.url !== 'string') {
    throw new Error(`Invalid report ${source}: missing 'url'`);
  }
  if (!Array.isArray(raw.flows)) {
    throw new Error(`Invalid report ${source}: missing 'flows' array`);
  }
  if (typeof raw.passed !== 'boolean') {
    throw new Error(`Invalid report ${source}: missing 'passed' boolean`);
  }
  return raw as unknown as InspectResult;
}

export async function loadReport(path: string): Promise<InspectResult> {
  const text = await fs.readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse JSON at ${path}: ${msg}`);
  }
  return validateReport(parsed, path);
}

export async function diffReportFiles(
  baselinePath: string,
  currentPath: string,
  thresholds?: DiffThresholds,
): Promise<BudgetDiffResult> {
  const [baseline, current] = await Promise.all([loadReport(baselinePath), loadReport(currentPath)]);
  return diffReports(baseline, current, thresholds);
}
