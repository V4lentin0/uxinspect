import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { InspectResult, FlowResult, A11yResult, PerfResult } from './types.js';

/**
 * P2 #19 — Diff-against-last-commit CLI.
 *
 * Compares a freshly produced InspectResult against a prior baseline result,
 * summarising:
 *   - new / fixed failing flows
 *   - explore coverage delta
 *   - audit score deltas (perf / a11y / seo / best-practices)
 *   - new / resolved a11y violations
 *   - generic regression hotspots (totals across major checks)
 *
 * The output is plain ASCII by default; if the caller requests colour it uses
 * GCP-style tokens: green for improvements, red for regressions, neutral gray
 * for unchanged.
 */

/** Path where `uxinspect run` auto-saves the last run's InspectResult. */
export const LAST_RUN_FILE = path.join('.uxinspect', 'last.json');

export interface FlowDelta {
  name: string;
  before: 'pass' | 'fail' | 'missing';
  after: 'pass' | 'fail' | 'missing';
  error?: string;
}

export interface CoverageDelta {
  beforePercent: number | null;
  afterPercent: number | null;
  beforeClicked: number | null;
  afterClicked: number | null;
  beforeTotal: number | null;
  afterTotal: number | null;
  /** signed delta (after - before); null when either side is missing */
  percentDelta: number | null;
}

export interface ScoreDelta {
  page: string;
  metric: 'performance' | 'accessibility' | 'bestPractices' | 'seo';
  before: number;
  after: number;
  delta: number;
}

export interface A11yDelta {
  page: string;
  /** Rule-ids that appear only in the AFTER run (newly failing). */
  newViolations: { id: string; impact: string; help: string }[];
  /** Rule-ids that appear only in the BEFORE run (now resolved). */
  fixedViolations: { id: string; impact: string; help: string }[];
}

export interface CheckCountDelta {
  name: string;
  before: number;
  after: number;
  delta: number;
  direction: 'regression' | 'improvement' | 'unchanged';
}

export interface DiffSummary {
  baselineUrl: string;
  currentUrl: string;
  baselineStartedAt: string;
  currentStartedAt: string;
  passedBefore: boolean;
  passedAfter: boolean;
  newFailingFlows: FlowDelta[];
  fixedFlows: FlowDelta[];
  stillFailingFlows: FlowDelta[];
  coverage: CoverageDelta;
  scoreImprovements: ScoreDelta[];
  scoreRegressions: ScoreDelta[];
  a11yDeltas: A11yDelta[];
  checkDeltas: CheckCountDelta[];
  totalRegressions: number;
  totalImprovements: number;
}

/* ------------------------------------------------------------------------- */
/* Core diff                                                                  */
/* ------------------------------------------------------------------------- */

export function diffResults(before: InspectResult, after: InspectResult): DiffSummary {
  const flowDeltas = diffFlows(before.flows, after.flows);
  const coverage = diffCoverage(before, after);
  const scores = diffScores(before.perf, after.perf);
  const a11yDeltas = diffA11y(before.a11y, after.a11y);
  const checkDeltas = diffCheckCounts(before, after);

  const newFailingFlows = flowDeltas.filter(
    (f) => f.after === 'fail' && f.before !== 'fail',
  );
  const fixedFlows = flowDeltas.filter(
    (f) => f.before === 'fail' && f.after === 'pass',
  );
  const stillFailingFlows = flowDeltas.filter(
    (f) => f.before === 'fail' && f.after === 'fail',
  );

  const totalRegressions =
    newFailingFlows.length +
    scores.regressions.length +
    sumA11y(a11yDeltas, 'new') +
    checkDeltas.filter((c) => c.direction === 'regression').length;

  const totalImprovements =
    fixedFlows.length +
    scores.improvements.length +
    sumA11y(a11yDeltas, 'fixed') +
    checkDeltas.filter((c) => c.direction === 'improvement').length;

  return {
    baselineUrl: before.url,
    currentUrl: after.url,
    baselineStartedAt: before.startedAt,
    currentStartedAt: after.startedAt,
    passedBefore: before.passed,
    passedAfter: after.passed,
    newFailingFlows,
    fixedFlows,
    stillFailingFlows,
    coverage,
    scoreImprovements: scores.improvements,
    scoreRegressions: scores.regressions,
    a11yDeltas,
    checkDeltas,
    totalRegressions,
    totalImprovements,
  };
}

function sumA11y(deltas: A11yDelta[], kind: 'new' | 'fixed'): number {
  let n = 0;
  for (const d of deltas) {
    n += kind === 'new' ? d.newViolations.length : d.fixedViolations.length;
  }
  return n;
}

function diffFlows(
  before: FlowResult[] | undefined,
  after: FlowResult[] | undefined,
): FlowDelta[] {
  const beforeMap = new Map<string, FlowResult>();
  const afterMap = new Map<string, FlowResult>();
  for (const f of before ?? []) beforeMap.set(f.name, f);
  for (const f of after ?? []) afterMap.set(f.name, f);
  const names = new Set<string>([...beforeMap.keys(), ...afterMap.keys()]);
  const deltas: FlowDelta[] = [];
  for (const name of names) {
    const b = beforeMap.get(name);
    const a = afterMap.get(name);
    const beforeState: FlowDelta['before'] = !b ? 'missing' : b.passed ? 'pass' : 'fail';
    const afterState: FlowDelta['after'] = !a ? 'missing' : a.passed ? 'pass' : 'fail';
    if (beforeState === 'pass' && afterState === 'pass') continue;
    if (beforeState === 'missing' && afterState === 'pass') continue;
    deltas.push({ name, before: beforeState, after: afterState, error: a?.error ?? b?.error });
  }
  return deltas;
}

function diffCoverage(before: InspectResult, after: InspectResult): CoverageDelta {
  const b = before.explore?.coverage;
  const a = after.explore?.coverage;
  const bPct = b ? b.percent : null;
  const aPct = a ? a.percent : null;
  const percentDelta = bPct !== null && aPct !== null ? round2(aPct - bPct) : null;
  return {
    beforePercent: bPct,
    afterPercent: aPct,
    beforeClicked: b ? b.clicked : null,
    afterClicked: a ? a.clicked : null,
    beforeTotal: b ? b.total : null,
    afterTotal: a ? a.total : null,
    percentDelta,
  };
}

function diffScores(
  before: PerfResult[] | undefined,
  after: PerfResult[] | undefined,
): { improvements: ScoreDelta[]; regressions: ScoreDelta[] } {
  const improvements: ScoreDelta[] = [];
  const regressions: ScoreDelta[] = [];
  if (!before || !after) return { improvements, regressions };
  const beforeMap = new Map<string, PerfResult>();
  for (const p of before) beforeMap.set(p.page, p);
  const metrics: ('performance' | 'accessibility' | 'bestPractices' | 'seo')[] = [
    'performance',
    'accessibility',
    'bestPractices',
    'seo',
  ];
  for (const a of after) {
    const b = beforeMap.get(a.page);
    if (!b) continue;
    for (const m of metrics) {
      const bv = b.scores[m];
      const av = a.scores[m];
      if (typeof bv !== 'number' || typeof av !== 'number') continue;
      const delta = av - bv;
      if (delta === 0) continue;
      const entry: ScoreDelta = { page: a.page, metric: m, before: bv, after: av, delta };
      if (delta > 0) improvements.push(entry);
      else regressions.push(entry);
    }
  }
  return { improvements, regressions };
}

function diffA11y(
  before: A11yResult[] | undefined,
  after: A11yResult[] | undefined,
): A11yDelta[] {
  if (!before && !after) return [];
  const beforeMap = new Map<string, A11yResult>();
  const afterMap = new Map<string, A11yResult>();
  for (const p of before ?? []) beforeMap.set(p.page, p);
  for (const p of after ?? []) afterMap.set(p.page, p);
  const pages = new Set<string>([...beforeMap.keys(), ...afterMap.keys()]);
  const deltas: A11yDelta[] = [];
  for (const page of pages) {
    const b = beforeMap.get(page);
    const a = afterMap.get(page);
    const beforeIds = new Set((b?.violations ?? []).map((v) => v.id));
    const afterIds = new Set((a?.violations ?? []).map((v) => v.id));
    const newViolations = (a?.violations ?? [])
      .filter((v) => !beforeIds.has(v.id))
      .map((v) => ({ id: v.id, impact: v.impact, help: v.help }));
    const fixedViolations = (b?.violations ?? [])
      .filter((v) => !afterIds.has(v.id))
      .map((v) => ({ id: v.id, impact: v.impact, help: v.help }));
    if (newViolations.length === 0 && fixedViolations.length === 0) continue;
    deltas.push({ page, newViolations, fixedViolations });
  }
  return deltas;
}

/**
 * Count-based regression detection across the major numeric audits. We reuse
 * the same "more is worse" convention that `ab-compare` uses but emit a
 * flattened list keyed by check name.
 */
function diffCheckCounts(before: InspectResult, after: InspectResult): CheckCountDelta[] {
  const countByCheck: { name: string; extract: (r: InspectResult) => number | null }[] = [
    { name: 'broken links', extract: (r) => sumBy(r.links, (p) => p.issues.length) },
    { name: 'seo issues', extract: (r) => sumBy(r.seo, (p) => p.issues.length) },
    { name: 'console errors', extract: (r) => sumBy(r.consoleErrors, (p) => p.errorCount) },
    { name: 'security issues', extract: (r) => (r.security ? r.security.issues.length : null) },
    { name: 'budget violations', extract: (r) => (r.budget ? r.budget.length : null) },
    { name: 'retire.js findings', extract: (r) => sumBy(r.retire, (p) => p.findings.length) },
    { name: 'dead clicks', extract: (r) => sumBy(r.deadClicks, (p) => p.findings.length) },
    { name: 'long tasks', extract: (r) => sumBy(r.longTasks, (p) => p.longTasks.length) },
    { name: 'form issues', extract: (r) => sumBy(r.forms, (p) => p.totalIssues) },
    { name: 'visual diff pixels', extract: (r) => sumBy(r.visual, (v) => v.diffPixels) },
    { name: 'mixed content', extract: (r) => sumBy(r.mixedContent, (p) => p.insecureResources.length) },
    { name: 'secret-scan findings', extract: (r) => sumBy(r.secretScan, (p) => p.findings.length) },
  ];
  const out: CheckCountDelta[] = [];
  for (const c of countByCheck) {
    const b = c.extract(before);
    const a = c.extract(after);
    if (b === null && a === null) continue;
    const bv = b ?? 0;
    const av = a ?? 0;
    if (bv === 0 && av === 0) continue;
    const delta = av - bv;
    const direction: CheckCountDelta['direction'] =
      delta > 0 ? 'regression' : delta < 0 ? 'improvement' : 'unchanged';
    out.push({ name: c.name, before: bv, after: av, delta, direction });
  }
  return out;
}

function sumBy<T>(arr: T[] | undefined, pick: (x: T) => number): number | null {
  if (!arr || arr.length === 0) return null;
  let total = 0;
  for (const item of arr) total += pick(item);
  return total;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* ------------------------------------------------------------------------- */
/* Pretty printer                                                             */
/* ------------------------------------------------------------------------- */

export interface FormatOptions {
  color?: boolean;
}

export function formatDiff(summary: DiffSummary, opts: FormatOptions = {}): string {
  const color = opts.color ?? false;
  const c = palette(color);
  const lines: string[] = [];

  lines.push(c.bold('uxinspect diff'));
  lines.push(
    `${c.dim('baseline:')} ${summary.baselineUrl} ${c.dim('(' + summary.baselineStartedAt + ')')}`,
  );
  lines.push(
    `${c.dim('current: ')} ${summary.currentUrl} ${c.dim('(' + summary.currentStartedAt + ')')}`,
  );

  const statusBefore = summary.passedBefore ? c.green('PASS') : c.red('FAIL');
  const statusAfter = summary.passedAfter ? c.green('PASS') : c.red('FAIL');
  lines.push(`${c.dim('status:')}   ${statusBefore} -> ${statusAfter}`);
  lines.push('');

  lines.push(c.bold('Summary'));
  lines.push(`  ${c.green('+')} improvements: ${summary.totalImprovements}`);
  lines.push(`  ${c.red('-')} regressions:  ${summary.totalRegressions}`);
  lines.push('');

  // Flows
  if (
    summary.newFailingFlows.length ||
    summary.fixedFlows.length ||
    summary.stillFailingFlows.length
  ) {
    lines.push(c.bold('Flows'));
    for (const f of summary.newFailingFlows) {
      lines.push(`  ${c.red('NEW FAIL')}  ${f.name}${f.error ? c.dim(' — ' + truncate(f.error, 120)) : ''}`);
    }
    for (const f of summary.fixedFlows) {
      lines.push(`  ${c.green('FIXED   ')}  ${f.name}`);
    }
    for (const f of summary.stillFailingFlows) {
      lines.push(`  ${c.dim('still')}     ${f.name}`);
    }
    lines.push('');
  }

  // Coverage
  if (summary.coverage.percentDelta !== null) {
    const d = summary.coverage.percentDelta;
    const arrow =
      d > 0
        ? c.green(`+${d}%`)
        : d < 0
          ? c.red(`${d}%`)
          : c.dim('0%');
    lines.push(c.bold('Explore coverage'));
    lines.push(
      `  ${summary.coverage.beforePercent}% (${summary.coverage.beforeClicked}/${summary.coverage.beforeTotal}) -> ${summary.coverage.afterPercent}% (${summary.coverage.afterClicked}/${summary.coverage.afterTotal})  ${arrow}`,
    );
    lines.push('');
  } else if (summary.coverage.afterPercent !== null) {
    lines.push(c.bold('Explore coverage'));
    lines.push(
      `  (new) ${summary.coverage.afterPercent}% (${summary.coverage.afterClicked}/${summary.coverage.afterTotal})`,
    );
    lines.push('');
  }

  // Scores
  if (summary.scoreRegressions.length || summary.scoreImprovements.length) {
    lines.push(c.bold('Audit scores'));
    for (const s of summary.scoreRegressions) {
      lines.push(
        `  ${c.red('-')} ${s.metric.padEnd(13)} ${s.before} -> ${s.after} (${c.red(deltaStr(s.delta))}) ${c.dim(s.page)}`,
      );
    }
    for (const s of summary.scoreImprovements) {
      lines.push(
        `  ${c.green('+')} ${s.metric.padEnd(13)} ${s.before} -> ${s.after} (${c.green(deltaStr(s.delta))}) ${c.dim(s.page)}`,
      );
    }
    lines.push('');
  }

  // A11y
  if (summary.a11yDeltas.length) {
    lines.push(c.bold('Accessibility'));
    for (const d of summary.a11yDeltas) {
      lines.push(`  ${c.dim(d.page)}`);
      for (const v of d.newViolations) {
        lines.push(`    ${c.red('NEW')} [${v.impact}] ${v.id} — ${truncate(v.help, 100)}`);
      }
      for (const v of d.fixedViolations) {
        lines.push(`    ${c.green('FIX')} [${v.impact}] ${v.id}`);
      }
    }
    lines.push('');
  }

  // Check-count deltas
  const regCounts = summary.checkDeltas.filter((d) => d.direction === 'regression');
  const impCounts = summary.checkDeltas.filter((d) => d.direction === 'improvement');
  if (regCounts.length || impCounts.length) {
    lines.push(c.bold('Check totals'));
    for (const d of regCounts) {
      lines.push(`  ${c.red('-')} ${d.name.padEnd(22)} ${d.before} -> ${d.after} (${c.red(deltaStr(d.delta))})`);
    }
    for (const d of impCounts) {
      lines.push(`  ${c.green('+')} ${d.name.padEnd(22)} ${d.before} -> ${d.after} (${c.green(deltaStr(d.delta))})`);
    }
    lines.push('');
  }

  if (
    summary.totalRegressions === 0 &&
    summary.totalImprovements === 0 &&
    !summary.newFailingFlows.length &&
    !summary.fixedFlows.length
  ) {
    lines.push(c.dim('No measurable differences between runs.'));
  }

  return lines.join('\n');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '\u2026';
}

function deltaStr(n: number): string {
  return (n > 0 ? '+' : '') + n;
}

function palette(color: boolean): {
  red: (s: string) => string;
  green: (s: string) => string;
  dim: (s: string) => string;
  bold: (s: string) => string;
} {
  if (!color) {
    const id = (s: string): string => s;
    return { red: id, green: id, dim: id, bold: id };
  }
  const wrap = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
  return {
    red: wrap('31'),
    green: wrap('32'),
    dim: wrap('2;37'),
    bold: wrap('1'),
  };
}

/* ------------------------------------------------------------------------- */
/* Filesystem helpers                                                         */
/* ------------------------------------------------------------------------- */

export async function saveLastRun(result: InspectResult, cwd: string = process.cwd()): Promise<string> {
  const full = path.resolve(cwd, LAST_RUN_FILE);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, JSON.stringify(result, null, 2));
  return full;
}

export async function loadResult(p: string): Promise<InspectResult> {
  const raw = await fs.readFile(path.resolve(p), 'utf8');
  return JSON.parse(raw) as InspectResult;
}
