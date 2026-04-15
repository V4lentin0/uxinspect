import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import type { InspectConfig, InspectResult } from './types.js';

export type BrowserEngine = 'chromium' | 'firefox' | 'webkit';

export interface EngineOutcome {
  engine: BrowserEngine;
  passed: boolean;
  durationMs: number;
  perfLcp?: number;
  perfCls?: number;
  a11yCriticals: number;
  visualDiffs: number;
  consoleErrorCount: number;
  error?: string;
}

export interface ScreenshotDiff {
  engineA: BrowserEngine;
  engineB: BrowserEngine;
  flow: string;
  viewport: string;
  diffRatio: number;
  diffPixels: number;
  diffPath: string;
}

/** Per-engine capture for a flow+viewport combo, used by the HTML report grid. */
export interface EngineShot {
  engine: BrowserEngine;
  /** Absolute path to the raw screenshot PNG for this engine. Absent if engine failed. */
  screenshotPath?: string;
  /** Absolute path to the pixel-diff PNG vs baseline engine (first engine). Only set for non-baseline engines when a diff exists. */
  diffPath?: string;
  /** Fraction of pixels differing vs baseline engine (0..1). */
  diffRatio?: number;
}

/** One flow+viewport row in the cross-browser report grid. */
export interface FlowShots {
  flow: string;
  viewport: string;
  /** Baseline engine used for diff comparison (first engine in the matrix). */
  baseline: BrowserEngine;
  shots: EngineShot[];
}

export interface CrossBrowserReport {
  url: string;
  engines: BrowserEngine[];
  outcomes: EngineOutcome[];
  screenshotDiffs: ScreenshotDiff[];
  /** Per flow+viewport captures for each engine with optional pixel-diff overlay (P2 #21). */
  flowShots: FlowShots[];
  metricDeltas: Array<{
    metric: string;
    engineA: BrowserEngine;
    engineB: BrowserEngine;
    delta: number;
    ratio: number;
  }>;
  divergent: string[];
  passed: boolean;
  outDir: string;
}

interface InspectModule {
  inspect: (config: InspectConfig) => Promise<InspectResult>;
}

const DEFAULT_ENGINES: BrowserEngine[] = ['chromium', 'firefox', 'webkit'];
const DEFAULT_PIXEL_THRESHOLD = 0.02;
const PIXELMATCH_THRESHOLD = 0.1;

const METRIC_LABELS = {
  perfLcp: 'perfLcp',
  perfCls: 'perfCls',
  a11yCriticals: 'a11yCriticals',
  visualDiffs: 'visualDiffs',
  consoleErrorCount: 'consoleErrorCount',
} as const;

type MetricKey = keyof typeof METRIC_LABELS;

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readPng(p: string): Promise<PNG | null> {
  try {
    const bytes = await fs.readFile(p);
    return PNG.sync.read(bytes);
  } catch {
    return null;
  }
}

function cloneConfigForEngine(
  config: InspectConfig,
  engine: BrowserEngine,
  engineOutDir: string,
): InspectConfig {
  return {
    ...config,
    browser: engine,
    output: {
      ...(config.output ?? {}),
      dir: path.join(engineOutDir, 'report'),
      baselineDir: path.join(engineOutDir, 'baselines'),
    },
  };
}

function countA11yCriticals(result: InspectResult): number {
  if (!result.a11y) return 0;
  let n = 0;
  for (const page of result.a11y) {
    for (const v of page.violations) {
      if (v.impact === 'critical') n++;
    }
  }
  return n;
}

function countVisualDiffs(result: InspectResult): number {
  if (!result.visual) return 0;
  let n = 0;
  for (const v of result.visual) {
    if (!v.passed) n++;
  }
  return n;
}

function countConsoleErrors(result: InspectResult): number {
  if (!result.consoleErrors) return 0;
  let n = 0;
  for (const c of result.consoleErrors) n += c.errorCount;
  return n;
}

function avgLcp(result: InspectResult): number | undefined {
  if (!result.perf || result.perf.length === 0) return undefined;
  let sum = 0;
  for (const p of result.perf) sum += p.metrics.lcp;
  return Math.round(sum / result.perf.length);
}

function avgCls(result: InspectResult): number | undefined {
  if (!result.perf || result.perf.length === 0) return undefined;
  let sum = 0;
  for (const p of result.perf) sum += p.metrics.cls;
  return sum / result.perf.length;
}

function summarizeResult(
  engine: BrowserEngine,
  result: InspectResult,
  durationMs: number,
): EngineOutcome {
  return {
    engine,
    passed: result.passed,
    durationMs,
    perfLcp: avgLcp(result),
    perfCls: avgCls(result),
    a11yCriticals: countA11yCriticals(result),
    visualDiffs: countVisualDiffs(result),
    consoleErrorCount: countConsoleErrors(result),
  };
}

function enumerateFlowViewports(
  config: InspectConfig,
): Array<{ flow: string; viewport: string }> {
  const flows = config.flows ?? [{ name: 'load', steps: [{ goto: config.url }] }];
  const viewports = config.viewports ?? [{ name: 'desktop', width: 1280, height: 800 }];
  const pairs: Array<{ flow: string; viewport: string }> = [];
  for (const f of flows) {
    for (const v of viewports) {
      pairs.push({ flow: f.name, viewport: v.name });
    }
  }
  return pairs;
}

function screenshotPath(outDir: string, engine: BrowserEngine, flow: string, viewport: string): string {
  return path.join(outDir, engine, 'report', 'current', `${flow}-${viewport}.png`);
}

async function diffPair(
  outDir: string,
  engineA: BrowserEngine,
  engineB: BrowserEngine,
  flow: string,
  viewport: string,
): Promise<ScreenshotDiff | null> {
  const pathA = screenshotPath(outDir, engineA, flow, viewport);
  const pathB = screenshotPath(outDir, engineB, flow, viewport);
  const existsA = await fileExists(pathA);
  const existsB = await fileExists(pathB);
  if (!existsA || !existsB) return null;

  const pngA = await readPng(pathA);
  const pngB = await readPng(pathB);
  if (!pngA || !pngB) return null;

  const diffDir = path.join(outDir, 'diffs', `${engineA}-vs-${engineB}`);
  await fs.mkdir(diffDir, { recursive: true });
  const diffPath = path.join(diffDir, `${flow}-${viewport}.png`);

  if (pngA.width !== pngB.width || pngA.height !== pngB.height) {
    const w = Math.max(pngA.width, pngB.width);
    const h = Math.max(pngA.height, pngB.height);
    const marker = new PNG({ width: w, height: h });
    await fs.writeFile(diffPath, PNG.sync.write(marker));
    return {
      engineA,
      engineB,
      flow,
      viewport,
      diffRatio: 1,
      diffPixels: w * h,
      diffPath,
    };
  }

  const { width, height } = pngA;
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(pngA.data, pngB.data, diff.data, width, height, {
    threshold: PIXELMATCH_THRESHOLD,
  });
  await fs.writeFile(diffPath, PNG.sync.write(diff));
  const diffRatio = width * height > 0 ? diffPixels / (width * height) : 0;
  return { engineA, engineB, flow, viewport, diffRatio, diffPixels, diffPath };
}

function numericOutcomeValue(outcome: EngineOutcome, key: MetricKey): number {
  const v = outcome[key];
  return typeof v === 'number' ? v : 0;
}

function buildMetricDeltas(outcomes: EngineOutcome[]): CrossBrowserReport['metricDeltas'] {
  const deltas: CrossBrowserReport['metricDeltas'] = [];
  const keys: MetricKey[] = Object.keys(METRIC_LABELS) as MetricKey[];
  for (let i = 0; i < outcomes.length; i++) {
    for (let j = i + 1; j < outcomes.length; j++) {
      const a = outcomes[i];
      const b = outcomes[j];
      if (!a || !b) continue;
      for (const key of keys) {
        const aVal = numericOutcomeValue(a, key);
        const bVal = numericOutcomeValue(b, key);
        if (a[key] === undefined && b[key] === undefined) continue;
        const delta = Math.abs(aVal - bVal);
        const denom = Math.max(aVal, bVal, 1);
        deltas.push({
          metric: METRIC_LABELS[key],
          engineA: a.engine,
          engineB: b.engine,
          delta,
          ratio: delta / denom,
        });
      }
    }
  }
  return deltas;
}

function buildDivergenceLines(
  config: InspectConfig,
  perEngineResults: Map<BrowserEngine, InspectResult | null>,
  outcomes: EngineOutcome[],
): string[] {
  const lines: string[] = [];
  const outcomeByEngine = new Map<BrowserEngine, EngineOutcome>();
  for (const o of outcomes) outcomeByEngine.set(o.engine, o);

  const statuses = outcomes.map((o) => `${o.engine}:${o.passed ? 'pass' : 'fail'}`);
  const uniqueStatuses = new Set(outcomes.map((o) => o.passed));
  if (uniqueStatuses.size > 1) {
    lines.push(`overall: engines diverge (${statuses.join(', ')})`);
  }

  const pairs = enumerateFlowViewports(config);
  for (const { flow, viewport } of pairs) {
    const perEngine: Array<{ engine: BrowserEngine; passed: boolean | null }> = [];
    for (const [engine, result] of perEngineResults.entries()) {
      if (!result) {
        perEngine.push({ engine, passed: null });
        continue;
      }
      const flowResult = result.flows.find((f) => f.name === flow);
      const visualResult = result.visual?.find(
        (v) => v.viewport === viewport && (v.current.includes(`${flow}-${viewport}`) || v.baseline.includes(`${flow}-${viewport}`)),
      );
      const passed =
        flowResult === undefined
          ? null
          : flowResult.passed && (visualResult ? visualResult.passed : true);
      perEngine.push({ engine, passed });
    }

    const known = perEngine.filter((p) => p.passed !== null);
    if (known.length < 2) continue;
    const distinct = new Set(known.map((p) => p.passed));
    if (distinct.size > 1) {
      const passes = known.filter((p) => p.passed === true).map((p) => p.engine);
      const fails = known.filter((p) => p.passed === false).map((p) => p.engine);
      lines.push(
        `flow ${flow} @ ${viewport}: passed on ${passes.join('+') || 'none'}, failed on ${fails.join('+') || 'none'}`,
      );
    }
  }

  return lines;
}

async function loadInspect(): Promise<InspectModule['inspect']> {
  const mod = (await import('./index.js')) as InspectModule;
  return mod.inspect;
}

export async function runCrossBrowser(
  config: InspectConfig,
  opts: { outDir: string; engines?: BrowserEngine[]; pixelDiffThreshold?: number },
): Promise<CrossBrowserReport> {
  const engines = opts.engines ?? DEFAULT_ENGINES;
  const threshold = opts.pixelDiffThreshold ?? DEFAULT_PIXEL_THRESHOLD;
  const outDir = path.resolve(opts.outDir);
  await fs.mkdir(outDir, { recursive: true });

  const inspect = await loadInspect();
  const outcomes: EngineOutcome[] = [];
  const perEngineResults = new Map<BrowserEngine, InspectResult | null>();

  for (const engine of engines) {
    const engineOutDir = path.join(outDir, engine);
    await fs.mkdir(engineOutDir, { recursive: true });
    const engineConfig = cloneConfigForEngine(config, engine, engineOutDir);
    const started = Date.now();
    try {
      const result = await inspect(engineConfig);
      const durationMs = Date.now() - started;
      perEngineResults.set(engine, result);
      outcomes.push(summarizeResult(engine, result, durationMs));
    } catch (err) {
      const durationMs = Date.now() - started;
      const message = err instanceof Error ? err.message : String(err);
      perEngineResults.set(engine, null);
      outcomes.push({
        engine,
        passed: false,
        durationMs,
        a11yCriticals: 0,
        visualDiffs: 0,
        consoleErrorCount: 0,
        error: message,
      });
    }
  }

  const flowVpPairs = enumerateFlowViewports(config);
  const pairJobs: Array<Promise<ScreenshotDiff | null>> = [];
  for (let i = 0; i < engines.length; i++) {
    for (let j = i + 1; j < engines.length; j++) {
      const a = engines[i];
      const b = engines[j];
      if (!a || !b) continue;
      const resA = perEngineResults.get(a);
      const resB = perEngineResults.get(b);
      if (!resA || !resB) continue;
      for (const { flow, viewport } of flowVpPairs) {
        pairJobs.push(diffPair(outDir, a, b, flow, viewport));
      }
    }
  }
  const diffResults = await Promise.all(pairJobs);
  const screenshotDiffs: ScreenshotDiff[] = [];
  for (const d of diffResults) {
    if (d) screenshotDiffs.push(d);
  }

  const metricDeltas = buildMetricDeltas(outcomes);
  const divergent = buildDivergenceLines(config, perEngineResults, outcomes);
  const flowShots = await buildFlowShots(outDir, engines, perEngineResults, flowVpPairs, screenshotDiffs);

  const allEnginesPassed = outcomes.every((o) => o.passed);
  const allDiffsUnderThreshold = screenshotDiffs.every((d) => d.diffRatio <= threshold);
  const passed = allEnginesPassed && allDiffsUnderThreshold;

  return {
    url: config.url,
    engines,
    outcomes,
    screenshotDiffs,
    flowShots,
    metricDeltas,
    divergent,
    passed,
    outDir,
  };
}

async function buildFlowShots(
  outDir: string,
  engines: BrowserEngine[],
  perEngineResults: Map<BrowserEngine, InspectResult | null>,
  flowVpPairs: Array<{ flow: string; viewport: string }>,
  screenshotDiffs: ScreenshotDiff[],
): Promise<FlowShots[]> {
  const baseline = engines[0];
  if (!baseline) return [];
  // Index diffs by (baseline vs other engine) for quick lookup.
  const diffIndex = new Map<string, ScreenshotDiff>();
  for (const d of screenshotDiffs) {
    if (d.engineA !== baseline) continue;
    diffIndex.set(`${d.engineB}|${d.flow}|${d.viewport}`, d);
  }
  const out: FlowShots[] = [];
  for (const { flow, viewport } of flowVpPairs) {
    const shots: EngineShot[] = [];
    for (const engine of engines) {
      const ran = perEngineResults.get(engine);
      const shotPath = screenshotPath(outDir, engine, flow, viewport);
      const exists = ran ? await fileExists(shotPath) : false;
      const shot: EngineShot = {
        engine,
        ...(exists ? { screenshotPath: shotPath } : {}),
      };
      if (engine !== baseline) {
        const d = diffIndex.get(`${engine}|${flow}|${viewport}`);
        if (d) {
          shot.diffPath = d.diffPath;
          shot.diffRatio = d.diffRatio;
        }
      }
      shots.push(shot);
    }
    out.push({ flow, viewport, baseline, shots });
  }
  return out;
}

/**
 * Emits a standalone `cross-browser.html` into `report.outDir` that renders a
 * 3-column grid of chromium | firefox | webkit thumbnails per flow+viewport
 * with a Raw/Diff toggle in the enlarged lightbox view (P2 #21).
 *
 * When only a single engine ran, the grid collapses to a single column.
 * Returns the absolute path to the written HTML file.
 */
export async function writeCrossBrowserHtmlReport(
  report: CrossBrowserReport,
  opts?: { htmlPath?: string },
): Promise<string> {
  const htmlPath = opts?.htmlPath ?? path.join(report.outDir, 'cross-browser.html');
  const html = renderCrossBrowserHtml(report, path.dirname(htmlPath));
  await fs.mkdir(path.dirname(htmlPath), { recursive: true });
  await fs.writeFile(htmlPath, html);
  return htmlPath;
}

function esc(s: string): string {
  return (s ?? '').toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function relFrom(fromDir: string, target: string): string {
  return path.relative(fromDir, target).split(path.sep).join('/');
}

export function renderCrossBrowserHtml(report: CrossBrowserReport, fromDir: string): string {
  const status = report.passed ? 'PASS' : 'FAIL';
  const statusColor = report.passed ? '#10B981' : '#EF4444';
  const engineCount = report.engines.length;
  const cols = Math.max(1, Math.min(3, engineCount));
  const outcomesByEngine = new Map(report.outcomes.map((o) => [o.engine, o]));

  const outcomeCards = report.engines.map((engine) => {
    const o = outcomesByEngine.get(engine);
    const passed = o?.passed ?? false;
    const dur = o ? `${Math.round(o.durationMs / 100) / 10}s` : '—';
    const err = o?.error ? `<div class="mono" style="color:var(--red);font-size:11px;margin-top:4px">${esc(o.error)}</div>` : '';
    return `<div class="card">
      <div class="label">${esc(engine)}</div>
      <div class="stat ${passed ? 'pass' : 'fail'}">${passed ? 'PASS' : 'FAIL'}</div>
      <div class="label" style="margin-top:4px">${dur} · a11y ${o?.a11yCriticals ?? 0} · vis ${o?.visualDiffs ?? 0}</div>
      ${err}
    </div>`;
  }).join('');

  const rowsHtml = report.flowShots.map((row) => {
    const cells = row.shots.map((shot) => {
      const engine = shot.engine;
      const isBaseline = engine === row.baseline;
      const raw = shot.screenshotPath ? relFrom(fromDir, shot.screenshotPath) : '';
      const diff = shot.diffPath ? relFrom(fromDir, shot.diffPath) : '';
      const diffPct = typeof shot.diffRatio === 'number'
        ? `${(shot.diffRatio * 100).toFixed(2)}% diff`
        : '';
      const badge = isBaseline
        ? `<span class="pill pill-baseline">baseline</span>`
        : diff
          ? `<span class="pill ${shot.diffRatio! > 0.02 ? 'pill-fail' : 'pill-ok'}">${esc(diffPct)}</span>`
          : `<span class="pill pill-ok">match</span>`;
      const noShot = !raw
        ? `<div class="thumb empty">n/a</div>`
        : `<button type="button" class="thumb"
            data-raw="${esc(raw)}"
            data-diff="${esc(diff)}"
            data-engine="${esc(engine)}"
            data-flow="${esc(row.flow)}"
            data-viewport="${esc(row.viewport)}">
            <img src="${esc(raw)}" alt="${esc(engine)} ${esc(row.flow)} ${esc(row.viewport)}" loading="lazy">
          </button>`;
      return `<div class="cell">
        <div class="cell-head"><span class="engine">${esc(engine)}</span> ${badge}</div>
        ${noShot}
      </div>`;
    }).join('');
    return `<div class="flow-row">
      <div class="flow-head">
        <strong>${esc(row.flow)}</strong>
        <span class="label">${esc(row.viewport)}</span>
      </div>
      <div class="grid-shots" style="grid-template-columns: repeat(${cols}, 1fr);">${cells}</div>
    </div>`;
  }).join('');

  const divergenceHtml = report.divergent.length
    ? `<h2>Divergence</h2><div class="section"><ul>${report.divergent.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></div>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>uxinspect cross-browser — ${esc(report.url)}</title>
<link rel="preconnect" href="https://rsms.me/">
<link rel="stylesheet" href="https://rsms.me/inter/inter.css">
<style>
  :root { --bg:#FAFAFA; --card:#FFFFFF; --border:#E5E7EB; --text:#1D1D1F; --muted:#6B7280;
          --green:#10B981; --green-bg:#ECFDF5; --blue:#3B82F6; --blue-bg:#EFF6FF; --red:#EF4444; --red-bg:#FEF2F2; }
  * { box-sizing: border-box; }
  body { font-family: 'Inter', system-ui, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 32px; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  h2 { font-size: 13px; margin: 28px 0 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
  .url { color: var(--muted); margin-bottom: 20px; font-size: 13px; }
  .badge { display: inline-block; padding: 4px 12px; border-radius: 6px; font-weight: 600; color: white; background: ${statusColor}; margin-left: 8px; font-size: 13px; vertical-align: 2px; }
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 16px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; box-shadow: 0 1px 2px rgba(0,0,0,0.03); }
  .stat { font-size: 22px; font-weight: 700; margin-top: 2px; }
  .label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .pass { color: var(--green); }
  .fail { color: var(--red); }
  .section { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 16px; box-shadow: 0 1px 2px rgba(0,0,0,0.03); }
  .flow-row { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 16px; box-shadow: 0 1px 2px rgba(0,0,0,0.03); }
  .flow-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; }
  .grid-shots { display: grid; gap: 16px; }
  .cell { display: flex; flex-direction: column; gap: 8px; }
  .cell-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 13px; }
  .engine { font-weight: 600; text-transform: capitalize; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .pill-baseline { background: var(--blue-bg); color: var(--blue); }
  .pill-ok { background: var(--green-bg); color: var(--green); }
  .pill-fail { background: var(--red-bg); color: var(--red); }
  .thumb { width: 100%; height: 150px; padding: 0; border: 1px solid var(--border); border-radius: 6px; background: #F9FAFB; overflow: hidden; cursor: zoom-in; font-family: inherit; transition: border-color .12s ease, box-shadow .12s ease; }
  .thumb:hover { border-color: var(--green); box-shadow: 0 0 0 3px var(--green-bg); }
  .thumb img { width: 100%; height: 100%; object-fit: cover; object-position: top; display: block; }
  .thumb.empty { display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: 12px; cursor: default; background: #F3F4F6; }
  ul { margin: 4px 0; padding-left: 20px; font-size: 13px; }
  /* Lightbox */
  #lb { position: fixed; inset: 0; background: rgba(0,0,0,0.72); display: none; align-items: center; justify-content: center; z-index: 1000; padding: 32px; }
  #lb.open { display: flex; flex-direction: column; }
  #lb-head { display: flex; align-items: center; justify-content: space-between; width: min(100%, 1200px); color: white; margin-bottom: 12px; font-size: 14px; gap: 12px; }
  #lb-title { font-weight: 600; }
  .toggle-group { display: inline-flex; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.18); border-radius: 6px; overflow: hidden; }
  .toggle-group button { background: transparent; color: #D1D5DB; border: none; padding: 6px 14px; font-family: inherit; font-size: 12px; cursor: pointer; font-weight: 600; }
  .toggle-group button.active { background: var(--green); color: white; }
  .toggle-group button:disabled { opacity: 0.35; cursor: not-allowed; }
  #lb-close { background: transparent; color: white; border: 1px solid rgba(255,255,255,0.3); border-radius: 6px; padding: 6px 12px; cursor: pointer; font-family: inherit; font-size: 12px; }
  #lb-img-wrap { flex: 1; width: min(100%, 1200px); display: flex; align-items: center; justify-content: center; overflow: auto; background: white; border-radius: 6px; }
  #lb-img { max-width: 100%; max-height: 100%; display: block; }
  .mono { font-family: ui-monospace, Menlo, Consolas, monospace; }
</style>
</head>
<body>
  <h1>Cross-browser matrix <span class="badge">${status}</span></h1>
  <div class="url">${esc(report.url)} · ${report.engines.length} engines · baseline ${esc(report.engines[0] ?? '')}</div>

  <div class="summary-grid">${outcomeCards}</div>
  ${divergenceHtml}

  ${report.flowShots.length ? `<h2>Flows</h2>${rowsHtml}` : '<div class="section"><div class="label">No captures available.</div></div>'}

  <div id="lb" role="dialog" aria-modal="true" aria-labelledby="lb-title">
    <div id="lb-head">
      <div id="lb-title"></div>
      <div class="toggle-group" role="tablist" aria-label="View mode">
        <button type="button" id="lb-raw" class="active" role="tab">Raw</button>
        <button type="button" id="lb-diff" role="tab">Diff</button>
      </div>
      <button type="button" id="lb-close" aria-label="Close">Close</button>
    </div>
    <div id="lb-img-wrap"><img id="lb-img" alt=""></div>
  </div>

<script>
(function(){
  var lb = document.getElementById('lb');
  var lbImg = document.getElementById('lb-img');
  var lbTitle = document.getElementById('lb-title');
  var btnRaw = document.getElementById('lb-raw');
  var btnDiff = document.getElementById('lb-diff');
  var btnClose = document.getElementById('lb-close');
  var cur = { raw: '', diff: '' };

  function setMode(mode) {
    if (mode === 'diff' && !cur.diff) return;
    lbImg.src = mode === 'diff' ? cur.diff : cur.raw;
    btnRaw.classList.toggle('active', mode === 'raw');
    btnDiff.classList.toggle('active', mode === 'diff');
  }
  function open(raw, diff, title) {
    cur.raw = raw; cur.diff = diff;
    lbTitle.textContent = title;
    btnDiff.disabled = !diff;
    btnDiff.title = diff ? '' : 'No diff (baseline engine)';
    setMode('raw');
    lb.classList.add('open');
  }
  function close() { lb.classList.remove('open'); lbImg.src = ''; }

  document.querySelectorAll('.thumb').forEach(function(btn){
    if (btn.classList.contains('empty')) return;
    btn.addEventListener('click', function(){
      open(
        btn.getAttribute('data-raw') || '',
        btn.getAttribute('data-diff') || '',
        (btn.getAttribute('data-engine')||'') + ' · ' + (btn.getAttribute('data-flow')||'') + ' @ ' + (btn.getAttribute('data-viewport')||'')
      );
    });
  });
  btnRaw.addEventListener('click', function(){ setMode('raw'); });
  btnDiff.addEventListener('click', function(){ setMode('diff'); });
  btnClose.addEventListener('click', close);
  lb.addEventListener('click', function(e){ if (e.target === lb) close(); });
  document.addEventListener('keydown', function(e){
    if (!lb.classList.contains('open')) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') setMode('raw');
    else if (e.key === 'ArrowRight') setMode('diff');
  });
})();
</script>
</body>
</html>`;
}
