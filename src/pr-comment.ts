import type { InspectResult, A11yViolation } from './types.js';

export type CommentFlavor = 'github' | 'gitlab' | 'bitbucket';

export interface PrCommentOptions {
  reportUrl?: string;
  compareTo?: InspectResult;
  maxFailures?: number;
  includeSummary?: boolean;
}

interface Metrics {
  flowsTotal: number;
  flowsPassed: number;
  flowsFailed: number;
  a11yCritical: number;
  a11ySerious: number;
  visualDiffs: number;
  lcpAvg: number | null;
  clsAvg: number | null;
  brokenLinks: number;
  consoleErrors: number;
}

interface FailureEntry {
  category: 'flow' | 'a11y' | 'visual' | 'link';
  line: string;
}

const DEFAULT_MAX_FAILURES = 10;
const TOOL_NAME = 'uxinspect';
const COLOR_PASS = '#10B981';
const COLOR_FAIL = '#EF4444';
const COLLAPSE_THRESHOLD = 5;

function countA11yByImpact(
  a11y: InspectResult['a11y'],
  impact: A11yViolation['impact'],
): number {
  if (!a11y) return 0;
  let total = 0;
  for (const page of a11y) {
    for (const v of page.violations) {
      if (v.impact === impact) total += 1;
    }
  }
  return total;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function perfAverage(
  result: InspectResult,
  pick: (m: { lcp: number; cls: number }) => number,
): number | null {
  const perf = result.perf;
  if (!perf || perf.length === 0) return null;
  const vals: number[] = [];
  for (const p of perf) {
    const v = pick(p.metrics);
    if (typeof v === 'number' && Number.isFinite(v)) vals.push(v);
  }
  return average(vals);
}

function brokenLinkCount(result: InspectResult): number {
  if (!Array.isArray(result.links)) return 0;
  let count = 0;
  for (const item of result.links) {
    count += Array.isArray(item.broken) ? item.broken.length : 0;
  }
  return count;
}

function consoleErrorCount(result: InspectResult): number {
  if (!Array.isArray(result.consoleErrors)) return 0;
  let count = 0;
  for (const entry of result.consoleErrors) {
    count += typeof entry.errorCount === 'number' ? entry.errorCount : 0;
  }
  return count;
}

function computeMetrics(result: InspectResult): Metrics {
  const flowsTotal = result.flows.length;
  const flowsPassed = result.flows.filter((f) => f.passed).length;
  return {
    flowsTotal,
    flowsPassed,
    flowsFailed: flowsTotal - flowsPassed,
    a11yCritical: countA11yByImpact(result.a11y, 'critical'),
    a11ySerious: countA11yByImpact(result.a11y, 'serious'),
    visualDiffs: (result.visual ?? []).filter((v) => !v.passed).length,
    lcpAvg: perfAverage(result, (m) => m.lcp),
    clsAvg: perfAverage(result, (m) => m.cls),
    brokenLinks: brokenLinkCount(result),
    consoleErrors: consoleErrorCount(result),
  };
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 3)) + '...';
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function collectFailures(result: InspectResult, max: number): FailureEntry[] {
  const out: FailureEntry[] = [];
  if (max <= 0) return out;
  const push = (entry: FailureEntry): boolean => {
    out.push(entry);
    return out.length >= max;
  };

  for (const f of result.flows) {
    if (f.passed) continue;
    const reason = f.error ? ` - ${oneLine(f.error)}` : '';
    if (push({ category: 'flow', line: `Flow failed: ${f.name}${reason}` })) return out;
  }
  for (const page of result.a11y ?? []) {
    if (page.passed) continue;
    for (const v of page.violations) {
      if (v.impact !== 'critical') continue;
      if (push({
        category: 'a11y',
        line: `a11y critical: ${v.id} - ${oneLine(v.help)} (${page.page})`,
      })) return out;
    }
  }
  for (const v of result.visual ?? []) {
    if (v.passed) continue;
    const pct = (v.diffRatio * 100).toFixed(2);
    if (push({
      category: 'visual',
      line: `Visual diff: ${v.page} @ ${v.viewport} - diffRatio ${pct}% (${v.diffPixels}px)`,
    })) return out;
  }
  for (const entry of result.links ?? []) {
    for (const link of entry.broken ?? []) {
      if (push({
        category: 'link',
        line: `Broken link: ${link.url} -> ${link.status} (${entry.page})`,
      })) return out;
    }
  }
  return out;
}

function formatLcp(ms: number | null): string {
  return ms === null ? 'n/a' : `${Math.round(ms)}ms`;
}

function formatCls(v: number | null): string {
  return v === null ? 'n/a' : v.toFixed(3);
}

function signedInt(n: number): string {
  if (n === 0) return '0';
  return n > 0 ? `+${n}` : `${n}`;
}

function signedMs(n: number): string {
  const r = Math.round(n);
  if (r === 0) return '0ms';
  return r > 0 ? `+${r}ms` : `${r}ms`;
}

function signedCls(n: number): string {
  if (Math.abs(n) < 0.001) return '0';
  return n > 0 ? `+${n.toFixed(3)}` : n.toFixed(3);
}

function diffDeltas(current: InspectResult, previous: InspectResult): string[] {
  const a = computeMetrics(current);
  const b = computeMetrics(previous);
  const lines: string[] = [];
  if (a.lcpAvg !== null && b.lcpAvg !== null) {
    const d = a.lcpAvg - b.lcpAvg;
    if (Math.round(d) !== 0) lines.push(`LCP ${signedMs(d)}`);
  }
  if (a.clsAvg !== null && b.clsAvg !== null) {
    const d = a.clsAvg - b.clsAvg;
    if (Math.abs(d) >= 0.001) lines.push(`CLS ${signedCls(d)}`);
  }
  if (a.a11yCritical !== b.a11yCritical) {
    lines.push(`a11y criticals ${signedInt(a.a11yCritical - b.a11yCritical)}`);
  }
  if (a.a11ySerious !== b.a11ySerious) {
    lines.push(`a11y serious ${signedInt(a.a11ySerious - b.a11ySerious)}`);
  }
  if (a.visualDiffs !== b.visualDiffs) {
    lines.push(`visual diffs ${signedInt(a.visualDiffs - b.visualDiffs)}`);
  }
  if (a.flowsFailed !== b.flowsFailed) {
    lines.push(`flow failures ${signedInt(a.flowsFailed - b.flowsFailed)}`);
  }
  if (a.brokenLinks !== b.brokenLinks) {
    lines.push(`broken links ${signedInt(a.brokenLinks - b.brokenLinks)}`);
  }
  if (a.consoleErrors !== b.consoleErrors) {
    lines.push(`console errors ${signedInt(a.consoleErrors - b.consoleErrors)}`);
  }
  return lines;
}

function statusWord(passed: boolean): 'PASS' | 'FAIL' {
  return passed ? 'PASS' : 'FAIL';
}

function summaryRows(m: Metrics): Array<[string, string]> {
  return [
    ['Flows', `${m.flowsPassed}/${m.flowsTotal} passed`],
    ['a11y criticals', `${m.a11yCritical}`],
    ['a11y serious', `${m.a11ySerious}`],
    ['Visual diffs', `${m.visualDiffs}`],
    ['LCP avg', formatLcp(m.lcpAvg)],
    ['CLS avg', formatCls(m.clsAvg)],
    ['Broken links', `${m.brokenLinks}`],
    ['Console errors', `${m.consoleErrors}`],
  ];
}

interface RenderSpec {
  header: (pass: boolean, word: 'PASS' | 'FAIL') => string[];
  summary: (m: Metrics) => string[];
  failures: (items: FailureEntry[]) => string[];
}

function buildBody(
  result: InspectResult,
  opts: PrCommentOptions,
  spec: RenderSpec,
): string {
  const max = opts.maxFailures ?? DEFAULT_MAX_FAILURES;
  const includeSummary = opts.includeSummary !== false;
  const metrics = computeMetrics(result);
  const pass = result.passed;
  const word = statusWord(pass);
  const lines: string[] = [];

  lines.push(...spec.header(pass, word));
  lines.push('');

  if (includeSummary) {
    lines.push(...spec.summary(metrics));
    lines.push('');
  }

  if (opts.compareTo) {
    const deltas = diffDeltas(result, opts.compareTo);
    if (deltas.length > 0) {
      lines.push('### Regression deltas');
      lines.push('');
      for (const d of deltas) lines.push(`- ${d}`);
      lines.push('');
    }
  }

  const failures = collectFailures(result, max);
  if (failures.length > 0) {
    lines.push(...spec.failures(failures));
    lines.push('');
  }

  if (opts.reportUrl) {
    lines.push(`View full report: ${opts.reportUrl}`);
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function tableSummary(m: Metrics): string[] {
  const out = ['| Metric | Value |', '| --- | --- |'];
  for (const [k, v] of summaryRows(m)) out.push(`| ${k} | ${v} |`);
  return out;
}

function bulletSummary(m: Metrics): string[] {
  const out = ['**Summary**', ''];
  for (const [k, v] of summaryRows(m)) out.push(`- **${k}:** ${v}`);
  return out;
}

function plainFailureList(items: FailureEntry[]): string[] {
  const out = [`### Top failures (${items.length})`, ''];
  for (const f of items) out.push(`- ${truncate(f.line, 400)}`);
  return out;
}

function bulletFailureList(items: FailureEntry[]): string[] {
  const out = [`**Top failures (${items.length})**`, ''];
  for (const f of items) out.push(`- ${truncate(f.line, 400)}`);
  return out;
}

export function renderGithubComment(
  result: InspectResult,
  opts: PrCommentOptions = {},
): string {
  return buildBody(result, opts, {
    header: (pass, word) => {
      const color = pass ? COLOR_PASS : COLOR_FAIL;
      return [
        `## ${TOOL_NAME} &mdash; <span style="color:${color}">${word}</span>`,
      ];
    },
    summary: tableSummary,
    failures: (items) => {
      if (items.length <= COLLAPSE_THRESHOLD) return plainFailureList(items);
      const out = [`### Top failures (${items.length})`, ''];
      out.push('<details><summary>Show failures</summary>');
      out.push('');
      for (const f of items) out.push(`- ${truncate(f.line, 400)}`);
      out.push('');
      out.push('</details>');
      return out;
    },
  });
}

export function renderGitlabComment(
  result: InspectResult,
  opts: PrCommentOptions = {},
): string {
  return buildBody(result, opts, {
    header: (_pass, word) => [
      `## ${TOOL_NAME} -- ${word}`,
      '',
      `> Status: ${word}`,
    ],
    summary: tableSummary,
    failures: plainFailureList,
  });
}

export function renderBitbucketComment(
  result: InspectResult,
  opts: PrCommentOptions = {},
): string {
  return buildBody(result, opts, {
    header: (_pass, word) => [
      `## ${TOOL_NAME} -- ${word}`,
      '',
      `**Status:** ${word}`,
    ],
    summary: bulletSummary,
    failures: bulletFailureList,
  });
}

export function toPrComment(
  result: InspectResult,
  flavor: CommentFlavor,
  opts?: PrCommentOptions,
): string {
  switch (flavor) {
    case 'github':
      return renderGithubComment(result, opts);
    case 'gitlab':
      return renderGitlabComment(result, opts);
    case 'bitbucket':
      return renderBitbucketComment(result, opts);
    default: {
      const exhaustive: never = flavor;
      throw new Error(`Unknown flavor: ${String(exhaustive)}`);
    }
  }
}
