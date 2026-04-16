// GitHub-flavored markdown renderer for the PR bot comment.
//
// Comment shape (kept small so the sidebar preview stays readable):
//
//   <!-- uxinspect:pr-bot -->
//   ### uxinspect
//   <status line>
//
//   | Metric | Main | PR | Delta |
//   | --- | --- | --- | --- |
//   | Flows passed | ... |
//
//   <details>New failures</details>
//   <details>Fixed</details>
//   <details>Coverage breakdown</details>
//
//   <footer with commit sha + timestamp>
//
// Constraints: no emoji, no third-party brand names beyond GitHub terms.

export interface ResultSnapshot {
  flows: FlowResult[];
  coveragePct?: number;
  perfScore?: number;      // 0-100 Lighthouse-style
  a11yScore?: number;      // 0-100
  generatedAt?: string;
  commit?: string;
}

export interface FlowResult {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  failureReason?: string;
  durationMs?: number;
}

export interface DiffOutcome {
  newFailures: FlowResult[];   // present in PR, not in main
  fixed: FlowResult[];         // failing on main, passing on PR
  stillFailing: FlowResult[];  // failing on both
  coverageDelta?: number;      // PR - main, percentage points
  perfDelta?: number;
  a11yDelta?: number;
  prCoverage?: number;
  mainCoverage?: number;
  prPerf?: number;
  mainPerf?: number;
  prA11y?: number;
  mainA11y?: number;
}

export interface RenderInput {
  marker: string;
  prSha: string;
  baselineSha?: string;
  diff: DiffOutcome;
  prResult: ResultSnapshot;
  generatedAt: string;
  reportUrl?: string;
}

export function renderComment(input: RenderInput): string {
  const { marker, prSha, baselineSha, diff, prResult, generatedAt, reportUrl } = input;
  const status = pickStatus(diff);
  const lines: string[] = [];

  lines.push(marker);
  lines.push('### uxinspect — PR verification');
  lines.push('');
  lines.push(status);
  lines.push('');
  lines.push(renderMetricsTable(diff));
  lines.push('');

  if (diff.newFailures.length > 0) {
    lines.push(details(`New failures (${diff.newFailures.length})`, renderFlowList(diff.newFailures, true)));
  }
  if (diff.fixed.length > 0) {
    lines.push(details(`Fixed on this PR (${diff.fixed.length})`, renderFlowList(diff.fixed, false)));
  }
  if (diff.stillFailing.length > 0) {
    lines.push(
      details(
        `Still failing on main (${diff.stillFailing.length})`,
        renderFlowList(diff.stillFailing, true),
      ),
    );
  }
  const coverageBlock = renderCoverageBlock(prResult);
  if (coverageBlock) lines.push(details('Coverage breakdown', coverageBlock));

  lines.push('');
  lines.push(renderFooter(prSha, baselineSha, generatedAt, reportUrl));
  return lines.join('\n');
}

function pickStatus(diff: DiffOutcome): string {
  if (diff.newFailures.length > 0) {
    return `**Status:** regression — ${diff.newFailures.length} new failure${
      diff.newFailures.length === 1 ? '' : 's'
    } vs main.`;
  }
  if (diff.fixed.length > 0) {
    return `**Status:** clean — ${diff.fixed.length} flow${
      diff.fixed.length === 1 ? '' : 's'
    } newly passing, no regressions.`;
  }
  return '**Status:** clean — no flow-level regressions detected.';
}

function renderMetricsTable(diff: DiffOutcome): string {
  const rows: string[] = [];
  rows.push('| Metric | main | PR | delta |');
  rows.push('| --- | ---: | ---: | ---: |');
  rows.push(metricRow('Coverage %', diff.mainCoverage, diff.prCoverage, diff.coverageDelta, '%', 1));
  rows.push(metricRow('Performance', diff.mainPerf, diff.prPerf, diff.perfDelta, '', 0));
  rows.push(metricRow('Accessibility', diff.mainA11y, diff.prA11y, diff.a11yDelta, '', 0));
  return rows.join('\n');
}

function metricRow(
  label: string,
  main: number | undefined,
  pr: number | undefined,
  delta: number | undefined,
  suffix: string,
  digits: number,
): string {
  return `| ${label} | ${fmt(main, suffix, digits)} | ${fmt(pr, suffix, digits)} | ${fmtDelta(
    delta,
    suffix,
    digits,
  )} |`;
}

function fmt(v: number | undefined, suffix: string, digits: number): string {
  if (v === undefined || Number.isNaN(v)) return '—';
  return `${v.toFixed(digits)}${suffix}`;
}

function fmtDelta(v: number | undefined, suffix: string, digits: number): string {
  if (v === undefined || Number.isNaN(v)) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(digits)}${suffix}`;
}

function renderFlowList(flows: FlowResult[], showReason: boolean): string {
  const rows: string[] = [];
  rows.push('');
  rows.push('| Flow | Duration | Reason |');
  rows.push('| --- | ---: | --- |');
  for (const f of flows) {
    const dur = f.durationMs !== undefined ? `${(f.durationMs / 1000).toFixed(1)}s` : '—';
    const reason = showReason ? escapePipes(f.failureReason ?? '') : '—';
    rows.push(`| \`${escapePipes(f.name)}\` | ${dur} | ${reason || '—'} |`);
  }
  rows.push('');
  return rows.join('\n');
}

function renderCoverageBlock(result: ResultSnapshot): string | null {
  if (result.coveragePct === undefined) return null;
  const passed = result.flows.filter((f) => f.status === 'pass').length;
  const failed = result.flows.filter((f) => f.status === 'fail').length;
  const skipped = result.flows.filter((f) => f.status === 'skip').length;
  const lines: string[] = [];
  lines.push('');
  lines.push(`- Flows: **${result.flows.length}** total · ${passed} passed · ${failed} failed · ${skipped} skipped`);
  lines.push(`- Interactive-element coverage: **${result.coveragePct.toFixed(1)}%**`);
  if (result.perfScore !== undefined) lines.push(`- Performance score: **${result.perfScore}**`);
  if (result.a11yScore !== undefined) lines.push(`- Accessibility score: **${result.a11yScore}**`);
  lines.push('');
  return lines.join('\n');
}

function details(summary: string, body: string): string {
  return `<details>\n<summary>${escapeHtml(summary)}</summary>\n${body}\n</details>\n`;
}

function renderFooter(
  prSha: string,
  baselineSha: string | undefined,
  generatedAt: string,
  reportUrl: string | undefined,
): string {
  const shortPr = prSha.slice(0, 7);
  const shortBase = baselineSha ? baselineSha.slice(0, 7) : 'main';
  const reportLink = reportUrl ? ` · [full report](${reportUrl})` : '';
  return `<sub>Compared \`${shortPr}\` against \`${shortBase}\` at ${generatedAt}${reportLink}</sub>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapePipes(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// Build a DiffOutcome from two ResultSnapshots. Exposed so the webhook handler
// can fall back to client-side diffing if the api.uxinspect.com diff endpoint
// is unavailable.
export function diffSnapshots(main: ResultSnapshot | null, pr: ResultSnapshot): DiffOutcome {
  const mainByName = new Map<string, FlowResult>();
  if (main) for (const f of main.flows) mainByName.set(f.name, f);
  const prByName = new Map<string, FlowResult>();
  for (const f of pr.flows) prByName.set(f.name, f);

  const newFailures: FlowResult[] = [];
  const fixed: FlowResult[] = [];
  const stillFailing: FlowResult[] = [];

  for (const f of pr.flows) {
    const base = mainByName.get(f.name);
    const baseFailed = base?.status === 'fail';
    const prFailed = f.status === 'fail';
    if (prFailed && !baseFailed) newFailures.push(f);
    else if (!prFailed && baseFailed) fixed.push(f);
    else if (prFailed && baseFailed) stillFailing.push(f);
  }

  return {
    newFailures,
    fixed,
    stillFailing,
    prCoverage: pr.coveragePct,
    mainCoverage: main?.coveragePct,
    coverageDelta: deltaOrUndefined(pr.coveragePct, main?.coveragePct),
    prPerf: pr.perfScore,
    mainPerf: main?.perfScore,
    perfDelta: deltaOrUndefined(pr.perfScore, main?.perfScore),
    prA11y: pr.a11yScore,
    mainA11y: main?.a11yScore,
    a11yDelta: deltaOrUndefined(pr.a11yScore, main?.a11yScore),
  };
}

function deltaOrUndefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined || b === undefined) return undefined;
  return a - b;
}
