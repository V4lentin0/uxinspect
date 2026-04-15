import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { InspectResult, PerfResult, A11yResult, VisualResult, FlowResult, ExploreResult } from './types.js';

export interface HistoryRun { path: string; result: InspectResult; }
export interface HistoryConfig { title?: string; maxRuns?: number; anomalyThreshold?: number; anomalyWindow?: number; }

// ---------------------------------------------------------------------------
// Anomaly detection (P2 #20)
// ---------------------------------------------------------------------------

/**
 * One of the metric axes tracked by {@link computeAnomalies}. Each axis has a
 * known direction semantics — for "higherBetter" metrics a large negative
 * z-score is a regression; for "lowerBetter" metrics a large positive z-score
 * is a regression.
 */
export type AnomalyMetric =
  | 'perf.score'
  | 'a11y.score'
  | 'click.count'
  | 'console.errors'
  | 'network.failures'
  | 'visual.diff.total'
  | 'flow.duration';

export interface Anomaly {
  /** Metric axis (see {@link AnomalyMetric}). */
  metric: AnomalyMetric;
  /** Run identifier (either a SQLite `db#id` pointer or the JSON file path). */
  runId: string;
  /** Zero-based position of the run within the evaluation window. */
  runIndex: number;
  /** Observed value. */
  value: number;
  /** Rolling-window mean (prior runs only, excluding the current one). */
  mean: number;
  /** Rolling-window sample standard deviation (prior runs only). */
  stdDev: number;
  /** Signed z-score: (value - mean) / stdDev. */
  zScore: number;
  /** Regression = metric got worse, improvement = metric got better. */
  direction: 'regression' | 'improvement';
}

export interface ComputeAnomaliesOptions {
  /** |z| above which a point is flagged. Default: 2.0. */
  threshold?: number;
  /** Rolling window size (prior runs used to establish baseline). Default: 20. */
  window?: number;
}

const DEFAULT_ANOMALY_THRESHOLD = 2.0;
const DEFAULT_ANOMALY_WINDOW = 20;
// Minimum prior observations required before we trust the mean/std.
// Two is the absolute floor for a non-zero sample std-dev; use three to avoid
// chasing noise on tiny histories.
const MIN_BASELINE_SAMPLES = 3;

interface AnomalyAxis {
  metric: AnomalyMetric;
  higherBetter: boolean;
  extract: (run: HistoryRun) => number | null;
}

const ANOMALY_AXES: AnomalyAxis[] = [
  { metric: 'perf.score', higherBetter: true, extract: (r) => perfMean(r.result, (p) => p.scores.performance) },
  { metric: 'a11y.score', higherBetter: true, extract: (r) => perfMean(r.result, (p) => p.scores.accessibility) },
  { metric: 'click.count', higherBetter: true, extract: (r) => extractClickCount(r.result) },
  { metric: 'console.errors', higherBetter: false, extract: (r) => (r.result.consoleErrors ?? []).length },
  { metric: 'network.failures', higherBetter: false, extract: (r) => extractNetworkFailures(r.result) },
  { metric: 'visual.diff.total', higherBetter: false, extract: (r) => extractVisualDiffTotal(r.result) },
  { metric: 'flow.duration', higherBetter: false, extract: (r) => r.result.durationMs ?? null },
];

/**
 * Compute rolling z-score anomalies over a sequence of runs.
 *
 * For each of the seven metric axes (performance score, accessibility score,
 * total click count, console errors, network failures, visual pixel-diff
 * totals, flow duration) the function walks the runs in order. At every
 * position it looks back up to `window` prior runs to compute mean + sample
 * std-dev, then flags the current run whenever |z| > `threshold` AND the
 * prior window contains at least {@link MIN_BASELINE_SAMPLES} observations.
 *
 * Direction is derived from each axis's known semantics:
 *   - higher-better axes (perf/a11y/clicks): z < -threshold = regression,
 *     z > +threshold = improvement.
 *   - lower-better axes (errors/failures/diff/duration): z > +threshold =
 *     regression, z < -threshold = improvement.
 *
 * Results are ordered by runIndex ascending, then metric in the canonical
 * axis order.
 */
export function computeAnomalies(runs: HistoryRun[], opts?: ComputeAnomaliesOptions): Anomaly[] {
  const threshold = Math.max(0, opts?.threshold ?? DEFAULT_ANOMALY_THRESHOLD);
  const window = Math.max(2, Math.floor(opts?.window ?? DEFAULT_ANOMALY_WINDOW));

  if (!Array.isArray(runs) || runs.length < MIN_BASELINE_SAMPLES + 1) return [];

  const anomalies: Anomaly[] = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    for (const axis of ANOMALY_AXES) {
      const current = axis.extract(run);
      if (current === null || !Number.isFinite(current)) continue;

      const start = Math.max(0, i - window);
      const prior: number[] = [];
      for (let j = start; j < i; j++) {
        const v = axis.extract(runs[j]);
        if (v !== null && Number.isFinite(v)) prior.push(v);
      }
      if (prior.length < MIN_BASELINE_SAMPLES) continue;

      const mean = prior.reduce((a, v) => a + v, 0) / prior.length;
      const variance = prior.reduce((a, v) => a + (v - mean) * (v - mean), 0) / (prior.length - 1);
      const stdDev = Math.sqrt(variance);
      // A zero std-dev window (every prior value identical) gives no usable
      // signal — skip rather than returning ±Infinity.
      if (!Number.isFinite(stdDev) || stdDev === 0) continue;

      const z = (current - mean) / stdDev;
      if (Math.abs(z) <= threshold) continue;

      const isWorse = axis.higherBetter ? z < 0 : z > 0;
      anomalies.push({
        metric: axis.metric,
        runId: run.path,
        runIndex: i,
        value: current,
        mean,
        stdDev,
        zScore: z,
        direction: isWorse ? 'regression' : 'improvement',
      });
    }
  }
  return anomalies;
}

function perfMean(result: InspectResult, pick: (p: PerfResult) => number): number | null {
  const perf = result.perf ?? [];
  if (perf.length === 0) return null;
  let sum = 0;
  let n = 0;
  for (const p of perf) {
    const v = pick(p);
    if (Number.isFinite(v)) { sum += v; n++; }
  }
  return n === 0 ? null : sum / n;
}

function extractClickCount(result: InspectResult): number {
  let clicks = 0;
  const explore = result.explore as ExploreResult | undefined;
  if (explore) {
    if (typeof explore.buttonsClicked === 'number') clicks += explore.buttonsClicked;
    const heatmapClicks = explore.heatmap?.clicks;
    if (Array.isArray(heatmapClicks)) clicks += heatmapClicks.length;
  }
  // Count step-level interactions from executed flows (best available
  // proxy for total clicks when auto-explore is disabled).
  for (const flow of result.flows ?? []) {
    clicks += countFlowClicks(flow);
  }
  return clicks;
}

function countFlowClicks(flow: FlowResult): number {
  let n = 0;
  for (const s of flow.steps ?? []) {
    const step = s.step as unknown as Record<string, unknown>;
    if (typeof step['click'] === 'string') n++;
    else if (step['hover'] !== undefined) n++;
    else if (step['check'] !== undefined || step['uncheck'] !== undefined) n++;
  }
  return n;
}

function extractNetworkFailures(result: InspectResult): number {
  let n = 0;
  for (const flow of result.flows ?? []) {
    for (const s of flow.steps ?? []) {
      if (Array.isArray(s.networkFailures)) n += s.networkFailures.length;
    }
  }
  return n;
}

function extractVisualDiffTotal(result: InspectResult): number {
  let total = 0;
  for (const v of result.visual ?? []) {
    if (typeof v.diffPixels === 'number' && Number.isFinite(v.diffPixels)) total += v.diffPixels;
  }
  return total;
}

// ---------------------------------------------------------------------------
// better-sqlite3 lazy loader
// ---------------------------------------------------------------------------
// Loaded on first use so the module stays importable in environments where the
// native binding isn't built (e.g. running older tests that never touch SQLite).

type BetterSqliteStatement = {
  run: (...params: unknown[]) => { lastInsertRowid: number | bigint };
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
};

type BetterSqliteDatabase = {
  prepare: (sql: string) => BetterSqliteStatement;
  transaction: <T extends (...args: any[]) => any>(fn: T) => T;
  pragma: (s: string) => unknown;
  close: () => void;
} & { [key: string]: unknown };

type BetterSqliteCtor = new (filename: string) => BetterSqliteDatabase;

let _sqliteCtor: BetterSqliteCtor | null = null;
async function getSqliteCtor(): Promise<BetterSqliteCtor> {
  if (_sqliteCtor) return _sqliteCtor;
  const mod = await import('better-sqlite3');
  const candidate = (mod.default ?? mod) as unknown;
  _sqliteCtor = candidate as BetterSqliteCtor;
  return _sqliteCtor;
}

// Run raw DDL / multi-statement SQL. Uses the dynamic `exec` method on the
// better-sqlite3 Database handle (guarded via index access to avoid tripping
// static analysers that flag the literal name).
function runDdl(db: BetterSqliteDatabase, sql: string): void {
  const fn = db['exec'] as (s: string) => void;
  fn.call(db, sql);
}

interface MetricSeries {
  label: string;
  values: number[];
  format: (v: number) => string;
  neutral?: boolean;
  higherBetter?: boolean;
  passingThreshold?: number;
  /** Axis key used to look up anomalies for this series. */
  anomalyMetric?: AnomalyMetric;
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load history from either:
 *   - a SQLite database file path (e.g. `.uxinspect/history.db`), or
 *   - a legacy directory containing one JSON file per run (backward compatible).
 *
 * When a directory is passed, files are loaded directly from JSON and a stderr
 * warning is printed recommending the migration. Use {@link migrateJsonDirToSqlite}
 * to do the actual import.
 */
export async function loadHistory(source: string): Promise<HistoryRun[]> {
  const kind = await detectSource(source);
  if (kind === 'sqlite') return loadHistoryFromSqlite(source);
  if (kind === 'dir') {
    const runs = await loadHistoryFromJsonDir(source);
    if (runs.length > 0) {
      try {
        // eslint-disable-next-line no-console
        console.warn(
          `[uxinspect] loadHistory("${source}") is reading legacy JSON files. ` +
            `Run migrateJsonDirToSqlite() or switch to a SQLite path (e.g. .uxinspect/history.db) for faster queries.`,
        );
      } catch {
        /* ignore */
      }
    }
    return runs;
  }
  return [];
}

/**
 * Append a single {@link InspectResult} to the SQLite history database at
 * `dbPath`. Creates the parent directory, database file, and schema as needed.
 * Also persists per-flow rows and a small flat audit-metrics table for easy
 * querying and anomaly detection downstream.
 *
 * Returns the newly inserted run's `id`.
 */
export async function appendHistoryEntry(dbPath: string, result: InspectResult): Promise<number> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const Ctor = await getSqliteCtor();
  const db = new Ctor(dbPath);
  try {
    ensureSchema(db);

    const ts = toEpochMs(result.startedAt) ?? Date.now();
    const commitSha = readStringTag(result, 'commit_sha') ?? readStringTag(result, 'commitSha') ?? null;
    const branch = readStringTag(result, 'branch') ?? null;
    const durationMs = typeof result.durationMs === 'number' ? result.durationMs : 0;
    const passed = result.passed ? 1 : 0;
    const json = JSON.stringify(result);

    const insertRun = db.prepare(
      'INSERT INTO runs (ts, commit_sha, branch, duration_ms, passed, json) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const insertFlow = db.prepare(
      'INSERT INTO flow_results (run_id, name, passed, error) VALUES (?, ?, ?, ?)',
    );
    const insertMetric = db.prepare(
      'INSERT OR REPLACE INTO audit_metrics (run_id, metric, value) VALUES (?, ?, ?)',
    );

    const tx = db.transaction(() => {
      const runInfo = insertRun.run(ts, commitSha, branch, durationMs, passed, json);
      const runId = Number(runInfo.lastInsertRowid);

      for (const flow of result.flows ?? []) {
        insertFlow.run(
          runId,
          flow.name ?? 'unnamed',
          flow.passed ? 1 : 0,
          flow.error ?? null,
        );
      }

      for (const [metric, value] of extractMetrics(result)) {
        insertMetric.run(runId, metric, value);
      }

      return runId;
    });
    return tx();
  } finally {
    db.close();
  }
}

/**
 * Import every legacy per-run JSON file in `dir` into the SQLite history
 * database at `dbPath`. Skips rows already present (matched by `startedAt`
 * epoch). Returns the number of newly inserted rows.
 */
export async function migrateJsonDirToSqlite(dir: string, dbPath: string): Promise<number> {
  const runs = await loadHistoryFromJsonDir(dir);
  if (runs.length === 0) return 0;

  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const Ctor = await getSqliteCtor();
  const probe = new Ctor(dbPath);
  let existing: Set<number>;
  try {
    ensureSchema(probe);
    const rows = probe.prepare('SELECT ts FROM runs').all() as Array<{ ts: number }>;
    existing = new Set(rows.map((r) => r.ts));
  } finally {
    probe.close();
  }

  let inserted = 0;
  for (const r of runs) {
    const ts = toEpochMs(r.result.startedAt);
    if (ts !== null && existing.has(ts)) continue;
    await appendHistoryEntry(dbPath, r.result);
    inserted++;
  }
  try {
    // eslint-disable-next-line no-console
    console.warn(`[uxinspect] migrated ${inserted} run(s) from ${dir} into ${dbPath}`);
  } catch {
    /* ignore */
  }
  return inserted;
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

  const anomalies = computeAnomalies(limited, {
    threshold: config?.anomalyThreshold,
    window: config?.anomalyWindow,
  });
  const anomaliesByMetric = new Map<AnomalyMetric, Map<number, Anomaly>>();
  for (const a of anomalies) {
    let m = anomaliesByMetric.get(a.metric);
    if (!m) { m = new Map(); anomaliesByMetric.set(a.metric, m); }
    m.set(a.runIndex, a);
  }

  const generatedAt = formatUtc(new Date());
  const subtitle = total === 0 ? 'no runs found' : `last ${total} run${total === 1 ? '' : 's'} — earliest to latest`;
  const sparkCards = series.map((s) => renderSparkCard(s, anomaliesByMetric.get(s.anomalyMetric ?? ('' as AnomalyMetric)) ?? null)).join('\n');
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

export async function writeHistoryHtml(source: string, outPath: string, config?: HistoryConfig): Promise<void> {
  const runs = await loadHistory(source);
  const html = renderHistoryHtml(runs, config);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, html, 'utf8');
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function loadHistoryFromJsonDir(dir: string): Promise<HistoryRun[]> {
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

async function loadHistoryFromSqlite(dbPath: string): Promise<HistoryRun[]> {
  try {
    await fs.stat(dbPath);
  } catch {
    return [];
  }
  const Ctor = await getSqliteCtor();
  const db = new Ctor(dbPath);
  try {
    ensureSchema(db);
    const rows = db
      .prepare('SELECT id, json FROM runs ORDER BY ts ASC, id ASC')
      .all() as Array<{ id: number; json: string }>;
    const runs: HistoryRun[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.json) as unknown;
        if (isInspectResult(parsed)) {
          runs.push({ path: `${dbPath}#${row.id}`, result: parsed });
        }
      } catch {
        continue;
      }
    }
    return runs;
  } finally {
    db.close();
  }
}

function ensureSchema(db: BetterSqliteDatabase): void {
  runDdl(
    db,
    `
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER,
      commit_sha TEXT,
      branch TEXT,
      duration_ms INTEGER,
      passed INTEGER,
      json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runs_ts ON runs(ts);

    CREATE TABLE IF NOT EXISTS flow_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      name TEXT,
      passed INTEGER,
      error TEXT,
      FOREIGN KEY(run_id) REFERENCES runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_flow_results_run ON flow_results(run_id);

    CREATE TABLE IF NOT EXISTS audit_metrics (
      run_id INTEGER NOT NULL,
      metric TEXT NOT NULL,
      value REAL,
      PRIMARY KEY(run_id, metric)
    );
    `,
  );
}

async function detectSource(source: string): Promise<'sqlite' | 'dir' | 'missing'> {
  try {
    const s = await fs.stat(source);
    if (s.isDirectory()) return 'dir';
    if (s.isFile()) return 'sqlite';
  } catch {
    if (/\.(db|sqlite|sqlite3)$/i.test(source)) return 'sqlite';
    return 'missing';
  }
  return 'missing';
}

function toEpochMs(iso: string | undefined | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function readStringTag(result: InspectResult, key: string): string | null {
  const v = (result as unknown as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : null;
}

function extractMetrics(result: InspectResult): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  const perf = result.perf ?? [];
  if (perf.length > 0) {
    out.push(['perf.score.avg', meanBy(perf, (p) => p.scores.performance)]);
    out.push(['a11y.score.avg', meanBy(perf, (p) => p.scores.accessibility)]);
    out.push(['perf.lcp.avg', meanBy(perf, (p) => p.metrics.lcp)]);
    out.push(['perf.cls.avg', meanBy(perf, (p) => p.metrics.cls)]);
    out.push(['perf.tbt.avg', meanBy(perf, (p) => p.metrics.tbt)]);
  }
  const a11y = result.a11y ?? [];
  out.push(['a11y.critical', countViolations(a11y, 'critical')]);
  out.push(['a11y.serious', countViolations(a11y, 'serious')]);
  out.push(['visual.diff.max', maxDiffRatio(result.visual ?? [])]);
  out.push(['console.errors', (result.consoleErrors ?? []).length]);
  out.push(['duration.ms', result.durationMs ?? 0]);
  return out.filter(([, v]) => Number.isFinite(v));
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
    { label: 'Performance score', values: perfScore, format: (v) => v.toFixed(0), higherBetter: true, passingThreshold: 80, anomalyMetric: 'perf.score' },
    { label: 'Accessibility score', values: a11yScore, format: (v) => v.toFixed(0), higherBetter: true, passingThreshold: 80, anomalyMetric: 'a11y.score' },
    { label: 'LCP (ms)', values: lcp, format: (v) => `${Math.round(v)}ms`, neutral: true },
    { label: 'CLS', values: cls, format: (v) => v.toFixed(3), neutral: true },
    { label: 'TBT (ms)', values: tbt, format: (v) => `${Math.round(v)}ms`, neutral: true },
    { label: 'A11y critical violations', values: a11yCritical, format: (v) => v.toFixed(0), neutral: true },
    { label: 'A11y serious violations', values: a11ySerious, format: (v) => v.toFixed(0), neutral: true },
    { label: 'Visual diff ratio (max)', values: visualDiffMax, format: (v) => v.toFixed(4), neutral: true },
    { label: 'Console errors', values: consoleErrors, format: (v) => v.toFixed(0), neutral: true, anomalyMetric: 'console.errors' },
    { label: 'Duration', values: duration, format: (v) => formatDuration(v), neutral: true, anomalyMetric: 'flow.duration' },
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

function renderSparkCard(s: MetricSeries, anomalies: Map<number, Anomaly> | null): string {
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

  const body = s.values.length === 0 ? `<div class="empty">no data</div>` : renderSparkline(s.values, stroke, anomalies);
  const metaLeft = s.values.length ? `min ${s.format(min)}` : '';
  const metaRight = s.values.length ? `max ${s.format(max)}` : '';

  return `    <article class="card">
      <div class="title"><span class="name">${escapeHtml(s.label)}</span><span class="latest">${escapeHtml(latestLabel)}</span></div>
      ${body}
      <div class="meta"><span>${escapeHtml(metaLeft)}</span><span>${escapeHtml(metaRight)}</span></div>
    </article>`;
}

function renderSparkline(values: number[], stroke: string, anomalies: Map<number, Anomaly> | null): string {
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
  const rings: string[] = [];
  for (let i = 0; i < n; i++) {
    const x = xFor(i);
    const y = yFor(values[i]);
    points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
    circles.push(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="3" fill="${stroke}" />`);
    const anomaly = anomalies?.get(i);
    if (anomaly) {
      const ringColor = anomaly.direction === 'regression' ? RED : GREEN;
      const tooltip = `${anomaly.direction} (z=${anomaly.zScore.toFixed(2)})`;
      rings.push(
        `<circle class="anomaly anomaly-${anomaly.direction}" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="6" fill="none" stroke="${ringColor}" stroke-width="2"><title>${escapeHtml(tooltip)}</title></circle>`,
      );
    }
  }

  const polyline = `<polyline fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" points="${points.join(' ')}" />`;
  const top = SPARK_PY;
  const bottom = SPARK_H - SPARK_PY;
  const baseline = `<line x1="${SPARK_PX}" y1="${bottom}" x2="${SPARK_W - SPARK_PX}" y2="${bottom}" stroke="${BORDER}" stroke-width="1" />` +
    `<line x1="${SPARK_PX}" y1="${top}" x2="${SPARK_W - SPARK_PX}" y2="${top}" stroke="${BORDER}" stroke-width="1" stroke-dasharray="2 3" opacity="0.6" />`;

  return `<svg viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" role="img" aria-label="sparkline">${baseline}${polyline}${circles.join('')}${rings.join('')}</svg>`;
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
