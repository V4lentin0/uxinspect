import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { InspectResult, PerfResult, A11yResult, VisualResult } from './types.js';

export interface HistoryRun { path: string; result: InspectResult; }
export interface HistoryConfig { title?: string; maxRuns?: number; }

interface MetricSeries {
  label: string;
  values: number[];
  format: (v: number) => string;
  neutral?: boolean;
  higherBetter?: boolean;
  passingThreshold?: number;
}

interface TableRow {
  index: number;
  date: string;
  status: 'PASS' | 'FAIL';
  durationMs: number;
  lcpAvg: number | null;
  perfAvg: number | null;
  a11yCritical: number;
  consoleErrors: number;
}

const SPARK_W = 600;
const SPARK_H = 80;
const SPARK_PX = 10;
const SPARK_PY = 10;
const GREEN = '#10B981';
const BLUE = '#3B82F6';
const RED = '#EF4444';
const TEXT = '#1D1D1F';
const BORDER = '#E5E7EB';
const MUTED = '#6B7280';

export async function loadHistory(dir: string): Promise<HistoryRun[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const jsonFiles = entries.filter((f) => f.toLowerCase().endsWith('.json'));
  const runs: HistoryRun[] = [];
  for (const file of jsonFiles) {
    const full = path.join(dir, file);
    try {
      const raw = await fs.readFile(full, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (isInspectResult(parsed)) runs.push({ path: full, result: parsed });
    } catch {
      continue;
    }
  }
  runs.sort((a, b) => {
    const ta = a.result.startedAt ?? '';
    const tb = b.result.startedAt ?? '';
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });
  return runs;
}

export function renderHistoryHtml(runs: HistoryRun[], config?: HistoryConfig): string {
  const title = config?.title ?? 'uxinspect history';
  const maxRuns = config?.maxRuns ?? 30;
  const limited = runs.slice(-maxRuns);
  const total = limited.length;
  const passCount = limited.filter((r) => r.result.passed).length;
  const passRate = total === 0 ? 0 : (passCount / total) * 100;
  const avgDuration = total === 0 ? 0 : limited.reduce((s, r) => s + (r.result.durationMs ?? 0), 0) / total;

  const series = buildSeries(limited);
  const rows = buildTableRows(limited);

  const generatedAt = formatUtc(new Date());
  const subtitle = total === 0 ? 'no runs found' : `last ${total} run${total === 1 ? '' : 's'} — earliest to latest`;
  const sparkCards = series.map(renderSparkCard).join('\n');
  const tableHtml = renderTable(rows);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #FAFAFA; color: ${TEXT}; font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; font-size: 14px; line-height: 1.5; -webkit-font-smoothing: antialiased; }
.wrap { max-width: 1040px; margin: 0 auto; padding: 32px 20px 80px; }
header.page { margin-bottom: 24px; }
header.page h1 { margin: 0 0 4px; font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
header.page .subtitle { margin: 0; color: ${MUTED}; font-size: 13px; }
.stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 20px; }
.stat { background: #FFFFFF; border: 1px solid ${BORDER}; border-radius: 8px; padding: 14px 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
.stat .label { font-size: 12px; color: ${MUTED}; text-transform: uppercase; letter-spacing: 0.04em; }
.stat .value { margin-top: 4px; font-size: 20px; font-weight: 600; color: ${TEXT}; }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-bottom: 20px; }
@media (max-width: 760px) { .grid, .stats { grid-template-columns: 1fr; } }
.card { background: #FFFFFF; border: 1px solid ${BORDER}; border-radius: 8px; padding: 14px 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
.card .title { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 6px; }
.card .title .name { font-size: 13px; font-weight: 600; color: ${TEXT}; }
.card .title .latest { font-size: 12px; color: ${MUTED}; font-variant-numeric: tabular-nums; }
.card .meta { display: flex; justify-content: space-between; font-size: 11px; color: ${MUTED}; margin-top: 4px; font-variant-numeric: tabular-nums; }
.card svg { display: block; width: 100%; height: auto; }
.card .empty { height: ${SPARK_H}px; display: flex; align-items: center; justify-content: center; color: ${MUTED}; font-size: 12px; background: #FAFAFA; border-radius: 6px; }
table.runs { width: 100%; border-collapse: collapse; background: #FFFFFF; border: 1px solid ${BORDER}; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.06); font-variant-numeric: tabular-nums; }
table.runs caption { text-align: left; padding: 12px 16px 4px; font-weight: 600; color: ${TEXT}; caption-side: top; }
table.runs th, table.runs td { padding: 10px 14px; text-align: left; font-size: 13px; border-bottom: 1px solid ${BORDER}; }
table.runs thead th { background: #FFFFFF; color: ${MUTED}; font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
table.runs tbody tr:nth-child(even) td { background: #FAFAFA; }
table.runs tbody tr:nth-child(odd) td { background: #FFFFFF; }
table.runs tbody tr:last-child td { border-bottom: none; }
.status.pass { color: ${GREEN}; font-weight: 600; }
.status.fail { color: ${RED}; font-weight: 600; }
footer.page { margin-top: 28px; color: ${MUTED}; font-size: 12px; text-align: center; }
</style>
</head>
<body>
<div class="wrap">
  <header class="page">
    <h1>${escapeHtml(title)}</h1>
    <p class="subtitle">${escapeHtml(subtitle)}</p>
  </header>
  <section class="stats" aria-label="summary">
    <div class="stat"><div class="label">Total runs</div><div class="value">${escapeHtml(String(total))}</div></div>
    <div class="stat"><div class="label">Pass rate</div><div class="value">${escapeHtml(formatPercent(passRate))}</div></div>
    <div class="stat"><div class="label">Avg duration</div><div class="value">${escapeHtml(formatDuration(avgDuration))}</div></div>
  </section>
  <section class="grid" aria-label="metrics">
${sparkCards}
  </section>
  <section aria-label="runs">
${tableHtml}
  </section>
  <footer class="page">Generated ${escapeHtml(generatedAt)} UTC</footer>
</div>
</body>
</html>
`;
}

export async function writeHistoryHtml(dir: string, outPath: string, config?: HistoryConfig): Promise<void> {
  const runs = await loadHistory(dir);
  const html = renderHistoryHtml(runs, config);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, html, 'utf8');
}

function isInspectResult(value: unknown): value is InspectResult {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.startedAt === 'string' && typeof v.finishedAt === 'string' && typeof v.durationMs === 'number' && typeof v.passed === 'boolean';
}

function buildSeries(runs: HistoryRun[]): MetricSeries[] {
  const perfScore: number[] = [];
  const a11yScore: number[] = [];
  const lcp: number[] = [];
  const cls: number[] = [];
  const tbt: number[] = [];
  const a11yCritical: number[] = [];
  const a11ySerious: number[] = [];
  const visualDiffMax: number[] = [];
  const consoleErrors: number[] = [];
  const duration: number[] = [];

  for (const run of runs) {
    const perf = run.result.perf ?? [];
    perfScore.push(meanBy(perf, (p) => p.scores.performance));
    a11yScore.push(meanBy(perf, (p) => p.scores.accessibility));
    lcp.push(meanBy(perf, (p) => p.metrics.lcp));
    cls.push(meanBy(perf, (p) => p.metrics.cls));
    tbt.push(meanBy(perf, (p) => p.metrics.tbt));
    const a11y = run.result.a11y ?? [];
    a11yCritical.push(countViolations(a11y, 'critical'));
    a11ySerious.push(countViolations(a11y, 'serious'));
    visualDiffMax.push(maxDiffRatio(run.result.visual ?? []));
    consoleErrors.push((run.result.consoleErrors ?? []).length);
    duration.push(run.result.durationMs ?? 0);
  }

  return [
    { label: 'Performance score', values: perfScore, format: (v) => v.toFixed(0), higherBetter: true, passingThreshold: 80 },
    { label: 'Accessibility score', values: a11yScore, format: (v) => v.toFixed(0), higherBetter: true, passingThreshold: 80 },
    { label: 'LCP (ms)', values: lcp, format: (v) => `${Math.round(v)}ms`, neutral: true },
    { label: 'CLS', values: cls, format: (v) => v.toFixed(3), neutral: true },
    { label: 'TBT (ms)', values: tbt, format: (v) => `${Math.round(v)}ms`, neutral: true },
    { label: 'A11y critical violations', values: a11yCritical, format: (v) => v.toFixed(0), neutral: true },
    { label: 'A11y serious violations', values: a11ySerious, format: (v) => v.toFixed(0), neutral: true },
    { label: 'Visual diff ratio (max)', values: visualDiffMax, format: (v) => v.toFixed(4), neutral: true },
    { label: 'Console errors', values: consoleErrors, format: (v) => v.toFixed(0), neutral: true },
    { label: 'Duration', values: duration, format: (v) => formatDuration(v), neutral: true },
  ];
}

function meanBy(perf: PerfResult[], pick: (p: PerfResult) => number): number {
  if (perf.length === 0) return 0;
  let sum = 0;
  let n = 0;
  for (const p of perf) {
    const v = pick(p);
    if (Number.isFinite(v)) { sum += v; n++; }
  }
  return n === 0 ? 0 : sum / n;
}

function countViolations(a11y: A11yResult[], impact: 'critical' | 'serious'): number {
  let count = 0;
  for (const page of a11y) {
    for (const v of page.violations ?? []) {
      if (v.impact === impact) count++;
    }
  }
  return count;
}

function maxDiffRatio(visual: VisualResult[]): number {
  let max = 0;
  for (const v of visual) {
    if (typeof v.diffRatio === 'number' && v.diffRatio > max) max = v.diffRatio;
  }
  return max;
}

function buildTableRows(runs: HistoryRun[]): TableRow[] {
  return runs.map((run, i) => {
    const perf = run.result.perf ?? [];
    const lcpAvg = perf.length ? meanBy(perf, (p) => p.metrics.lcp) : null;
    const perfAvg = perf.length ? meanBy(perf, (p) => p.scores.performance) : null;
    return {
      index: i + 1,
      date: formatDate(run.result.startedAt),
      status: run.result.passed ? 'PASS' : 'FAIL',
      durationMs: run.result.durationMs ?? 0,
      lcpAvg,
      perfAvg,
      a11yCritical: countViolations(run.result.a11y ?? [], 'critical'),
      consoleErrors: (run.result.consoleErrors ?? []).length,
    };
  });
}

function renderSparkCard(s: MetricSeries): string {
  const latest = s.values.length ? s.values[s.values.length - 1] : null;
  const latestLabel = latest === null ? '—' : s.format(latest);
  const min = s.values.length ? Math.min(...s.values) : 0;
  const max = s.values.length ? Math.max(...s.values) : 0;

  let stroke = BLUE;
  if (!s.neutral && s.higherBetter && s.passingThreshold !== undefined && s.values.length > 0) {
    const avg = s.values.reduce((a, v) => a + v, 0) / s.values.length;
    stroke = avg >= s.passingThreshold ? GREEN : BLUE;
  } else if (!s.neutral) {
    stroke = GREEN;
  }

  const body = s.values.length === 0 ? `<div class="empty">no data</div>` : renderSparkline(s.values, stroke);
  const metaLeft = s.values.length ? `min ${s.format(min)}` : '';
  const metaRight = s.values.length ? `max ${s.format(max)}` : '';

  return `    <article class="card">
      <div class="title"><span class="name">${escapeHtml(s.label)}</span><span class="latest">${escapeHtml(latestLabel)}</span></div>
      ${body}
      <div class="meta"><span>${escapeHtml(metaLeft)}</span><span>${escapeHtml(metaRight)}</span></div>
    </article>`;
}

function renderSparkline(values: number[], stroke: string): string {
  const n = values.length;
  const innerW = SPARK_W - SPARK_PX * 2;
  const innerH = SPARK_H - SPARK_PY * 2;

  let min = Math.min(...values);
  let max = Math.max(...values);
  if (!Number.isFinite(min) || !Number.isFinite(max)) { min = 0; max = 0; }
  if (min === max) {
    const pad = Math.abs(min) * 0.05 || 1;
    min -= pad; max += pad;
  } else {
    const range = max - min;
    min -= range * 0.05;
    max += range * 0.05;
  }

  const xFor = (i: number): number => n <= 1 ? SPARK_PX + innerW / 2 : SPARK_PX + (i / (n - 1)) * innerW;
  const yFor = (v: number): number => max === min ? SPARK_PY + innerH / 2 : SPARK_PY + (1 - (v - min) / (max - min)) * innerH;

  const points: string[] = [];
  const circles: string[] = [];
  for (let i = 0; i < n; i++) {
    const x = xFor(i);
    const y = yFor(values[i]);
    points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
    circles.push(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="3" fill="${stroke}" />`);
  }

  const polyline = `<polyline fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" points="${points.join(' ')}" />`;
  const top = SPARK_PY;
  const bottom = SPARK_H - SPARK_PY;
  const baseline = `<line x1="${SPARK_PX}" y1="${bottom}" x2="${SPARK_W - SPARK_PX}" y2="${bottom}" stroke="${BORDER}" stroke-width="1" />` +
    `<line x1="${SPARK_PX}" y1="${top}" x2="${SPARK_W - SPARK_PX}" y2="${top}" stroke="${BORDER}" stroke-width="1" stroke-dasharray="2 3" opacity="0.6" />`;

  return `<svg viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" role="img" aria-label="sparkline">${baseline}${polyline}${circles.join('')}</svg>`;
}

function renderTable(rows: TableRow[]): string {
  if (rows.length === 0) {
    return `<div class="card"><div class="title"><span class="name">Runs</span></div><div class="empty">no runs</div></div>`;
  }
  const head = `<thead><tr><th>Run</th><th>Date</th><th>Status</th><th>Duration</th><th>LCP (avg)</th><th>Perf (avg)</th><th>A11y critical</th><th>Console errors</th></tr></thead>`;
  const body = rows.map((r) => {
    const lcp = r.lcpAvg === null ? '—' : `${Math.round(r.lcpAvg)}ms`;
    const perf = r.perfAvg === null ? '—' : r.perfAvg.toFixed(0);
    const statusClass = r.status === 'PASS' ? 'pass' : 'fail';
    return `<tr><td>${escapeHtml(String(r.index))}</td><td>${escapeHtml(r.date)}</td><td><span class="status ${statusClass}">${escapeHtml(r.status)}</span></td><td>${escapeHtml(formatDuration(r.durationMs))}</td><td>${escapeHtml(lcp)}</td><td>${escapeHtml(perf)}</td><td>${escapeHtml(String(r.a11yCritical))}</td><td>${escapeHtml(String(r.consoleErrors))}</td></tr>`;
  }).join('');
  return `<table class="runs"><caption>Runs</caption>${head}<tbody>${body}</tbody></table>`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}m ${rem.toFixed(0)}s`;
}

function formatPercent(n: number): string {
  return Number.isFinite(n) ? `${n.toFixed(1)}%` : '—';
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

function formatUtc(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

function pad2(n: number): string { return n < 10 ? `0${n}` : String(n); }

function escapeHtml(s: string): string {
  return s.replace(/[&<>"'`]/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      case '`': return '&#96;';
      default: return c;
    }
  });
}
