import { promises as fs, readFileSync, existsSync } from 'node:fs';
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

export interface CrossBrowserReport {
  url: string;
  engines: BrowserEngine[];
  outcomes: EngineOutcome[];
  screenshotDiffs: ScreenshotDiff[];
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

  const allEnginesPassed = outcomes.every((o) => o.passed);
  const allDiffsUnderThreshold = screenshotDiffs.every((d) => d.diffRatio <= threshold);
  const passed = allEnginesPassed && allDiffsUnderThreshold;

  return {
    url: config.url,
    engines,
    outcomes,
    screenshotDiffs,
    metricDeltas,
    divergent,
    passed,
    outDir,
  };
}

function xbEscape(s: string): string {
  return (s ?? '').toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readPngDataUri(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    const bytes = readFileSync(filePath);
    return `data:image/png;base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}

function collectFlowViewportsFromReport(report: CrossBrowserReport): Array<{ flow: string; viewport: string }> {
  const seen = new Set<string>();
  const out: Array<{ flow: string; viewport: string }> = [];
  for (const d of report.screenshotDiffs) {
    const key = `${d.flow}\u0000${d.viewport}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ flow: d.flow, viewport: d.viewport });
  }
  if (out.length === 0) {
    out.push({ flow: 'load', viewport: 'desktop' });
  }
  return out;
}

function renderOutcomeSummary(report: CrossBrowserReport): string {
  const rows = report.outcomes.map((o) => {
    const statusClass = o.passed ? 'xb-pass' : 'xb-fail';
    const statusLabel = o.passed ? 'PASS' : 'FAIL';
    const lcp = typeof o.perfLcp === 'number' ? `${o.perfLcp}ms` : '—';
    const cls = typeof o.perfCls === 'number' ? o.perfCls.toFixed(3) : '—';
    return `<tr>
      <td><strong>${xbEscape(o.engine)}</strong></td>
      <td><span class="xb-pill ${statusClass}">${statusLabel}</span></td>
      <td>${(o.durationMs / 1000).toFixed(1)}s</td>
      <td>${lcp}</td>
      <td>${cls}</td>
      <td>${o.a11yCriticals}</td>
      <td>${o.visualDiffs}</td>
      <td>${o.consoleErrorCount}</td>
      ${o.error ? `<td class="xb-err">${xbEscape(o.error)}</td>` : '<td></td>'}
    </tr>`;
  }).join('');
  return `<table class="xb-table">
    <thead>
      <tr>
        <th>Engine</th>
        <th>Status</th>
        <th>Duration</th>
        <th>LCP</th>
        <th>CLS</th>
        <th>A11y crit</th>
        <th>Visual diffs</th>
        <th>Console err</th>
        <th>Error</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderMatrixRow(
  report: CrossBrowserReport,
  outDir: string,
  flow: string,
  viewport: string,
  index: number,
): string {
  const engines = report.engines;
  const cellId = (engine: BrowserEngine): string => `xb-cell-${index}-${engine}`;
  const cells = engines.map((engine) => {
    const shotPath = path.join(outDir, engine, 'report', 'current', `${flow}-${viewport}.png`);
    const shotUri = readPngDataUri(shotPath);
    const baseLabel = `${engine}`;
    if (!shotUri) {
      return `<td class="xb-cell">
        <div class="xb-cell-head">${xbEscape(baseLabel)}</div>
        <div class="xb-empty">screenshot unavailable</div>
      </td>`;
    }
    return `<td class="xb-cell" id="${cellId(engine)}">
      <div class="xb-cell-head">${xbEscape(baseLabel)}</div>
      <div class="xb-stack">
        <img class="xb-base" src="${shotUri}" alt="${xbEscape(`${engine} ${flow} ${viewport}`)}" />
        <img class="xb-diff" data-cell="${cellId(engine)}" src="" alt="" style="display:none" />
      </div>
    </td>`;
  }).join('');

  // Build diff toggle buttons: one button per (engineA-vs-engineB) pair for this flow/viewport
  const pairs = report.screenshotDiffs.filter((d) => d.flow === flow && d.viewport === viewport);
  const toggleButtons = pairs.map((p) => {
    const diffUri = readPngDataUri(p.diffPath);
    if (!diffUri) return '';
    const targetA = cellId(p.engineA);
    const targetB = cellId(p.engineB);
    const pct = (p.diffRatio * 100).toFixed(2);
    return `<button type="button" class="xb-btn xb-diff-btn"
      data-diff="${diffUri}"
      data-target-a="${targetA}"
      data-target-b="${targetB}">
      ${xbEscape(p.engineA)} vs ${xbEscape(p.engineB)}
      <span class="xb-meta">${pct}%</span>
    </button>`;
  }).join('');

  const sliderId = `xb-slider-${index}`;
  const hasDiffs = pairs.length > 0;
  const controls = hasDiffs ? `
    <div class="xb-controls">
      <div class="xb-btn-row">
        <button type="button" class="xb-btn xb-btn-clear" data-row="${index}">clear</button>
        ${toggleButtons}
      </div>
      <label class="xb-slider-label" for="${sliderId}">overlay opacity
        <input type="range" id="${sliderId}" class="xb-slider" data-row="${index}" min="0" max="100" value="60" />
        <span class="xb-slider-val" data-for="${sliderId}">60%</span>
      </label>
    </div>
  ` : '';

  return `<section class="xb-flow" data-row="${index}">
    <h4 class="xb-flow-title">${xbEscape(flow)} <span class="xb-vp">· ${xbEscape(viewport)}</span></h4>
    <table class="xb-matrix">
      <thead>
        <tr>${engines.map((e) => `<th>${xbEscape(e)}</th>`).join('')}</tr>
      </thead>
      <tbody><tr>${cells}</tr></tbody>
    </table>
    ${controls}
  </section>`;
}

function renderDivergence(report: CrossBrowserReport): string {
  if (!report.divergent.length) {
    return '<p class="xb-empty">No divergences detected across engines.</p>';
  }
  const items = report.divergent.map((d) => `<li>${xbEscape(d)}</li>`).join('');
  return `<ul class="xb-divergent">${items}</ul>`;
}

const CROSS_BROWSER_STYLES = `
<style>
  .xb-root { --xb-bg:#FAFAFA; --xb-card:#FFFFFF; --xb-border:#E5E7EB; --xb-text:#1D1D1F;
             --xb-muted:#6B7280; --xb-green:#10B981; --xb-green-bg:#ECFDF5;
             --xb-blue:#3B82F6; --xb-blue-bg:#EFF6FF; --xb-red:#EF4444;
             background: var(--xb-card); border: 1px solid var(--xb-border); border-radius: 8px;
             padding: 16px; margin-bottom: 16px; font-family: 'Inter', system-ui, sans-serif;
             color: var(--xb-text); }
  .xb-root h3 { font-size: 16px; margin: 0 0 12px; }
  .xb-root h4 { font-size: 14px; margin: 12px 0 8px; }
  .xb-root .xb-vp { color: var(--xb-muted); font-weight: 400; font-size: 13px; }
  .xb-root .xb-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 12px; }
  .xb-root .xb-table th, .xb-root .xb-table td { text-align: left; padding: 6px 8px;
    border-bottom: 1px solid var(--xb-border); vertical-align: top; }
  .xb-root .xb-table th { color: var(--xb-muted); font-weight: 600; font-size: 11px;
    text-transform: uppercase; letter-spacing: 0.04em; background: #F9FAFB; }
  .xb-root .xb-matrix { width: 100%; border-collapse: separate; border-spacing: 8px;
    table-layout: fixed; margin-top: 6px; }
  .xb-root .xb-matrix th { color: var(--xb-muted); font-weight: 600; font-size: 11px;
    text-transform: uppercase; letter-spacing: 0.04em; text-align: left; padding: 4px 8px; }
  .xb-root .xb-cell { background: #F9FAFB; border: 1px solid var(--xb-border); border-radius: 6px;
    padding: 8px; vertical-align: top; }
  .xb-root .xb-cell-head { font-size: 11px; color: var(--xb-muted); text-transform: uppercase;
    letter-spacing: 0.04em; margin-bottom: 6px; font-weight: 600; }
  .xb-root .xb-stack { position: relative; line-height: 0; }
  .xb-root .xb-stack img { width: 100%; height: auto; border-radius: 4px; display: block; }
  .xb-root .xb-diff { position: absolute; top: 0; left: 0; pointer-events: none;
    mix-blend-mode: normal; }
  .xb-root .xb-empty { color: var(--xb-muted); font-style: italic; font-size: 13px;
    padding: 12px; background: #F9FAFB; border-radius: 4px; text-align: center; }
  .xb-root .xb-controls { margin-top: 8px; display: flex; flex-direction: column; gap: 6px;
    padding: 8px; background: #F9FAFB; border: 1px solid var(--xb-border); border-radius: 6px; }
  .xb-root .xb-btn-row { display: flex; flex-wrap: wrap; gap: 6px; }
  .xb-root .xb-btn { font-family: inherit; font-size: 12px; padding: 4px 10px;
    background: var(--xb-card); border: 1px solid var(--xb-border); border-radius: 6px;
    cursor: pointer; color: var(--xb-text); display: inline-flex; align-items: center; gap: 6px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.03); }
  .xb-root .xb-btn:hover { background: var(--xb-green-bg); border-color: var(--xb-green); }
  .xb-root .xb-btn.active { background: var(--xb-green-bg); border-color: var(--xb-green);
    color: var(--xb-green); }
  .xb-root .xb-btn-clear { background: var(--xb-card); }
  .xb-root .xb-meta { font-size: 11px; color: var(--xb-muted); }
  .xb-root .xb-slider-label { display: flex; align-items: center; gap: 8px; font-size: 12px;
    color: var(--xb-muted); }
  .xb-root .xb-slider { flex: 1; max-width: 280px; accent-color: var(--xb-green); }
  .xb-root .xb-slider-val { font-variant-numeric: tabular-nums; color: var(--xb-text);
    font-weight: 600; min-width: 38px; text-align: right; }
  .xb-root .xb-pill { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px;
    font-weight: 600; }
  .xb-root .xb-pass { background: var(--xb-green-bg); color: var(--xb-green); }
  .xb-root .xb-fail { background: #FEF2F2; color: #991B1B; }
  .xb-root .xb-err { color: var(--xb-red); font-size: 11px; max-width: 240px; word-break: break-word; }
  .xb-root .xb-divergent { margin: 8px 0; padding-left: 20px; font-size: 13px; }
  .xb-root .xb-divergent li { margin-bottom: 4px; }
  .xb-root .xb-header-meta { display: flex; flex-wrap: wrap; gap: 8px; font-size: 12px;
    color: var(--xb-muted); margin-bottom: 8px; }
</style>`;

const CROSS_BROWSER_SCRIPT = `
<script>
(function(){
  var root = document.currentScript && document.currentScript.parentElement;
  if (!root) root = document.querySelector('.xb-root');
  if (!root) return;
  var sliders = root.querySelectorAll('.xb-slider');
  sliders.forEach(function(s){
    s.addEventListener('input', function(){
      var val = parseInt(s.value, 10);
      var row = s.getAttribute('data-row');
      var labelSel = '.xb-slider-val[data-for="' + s.id + '"]';
      var lbl = root.querySelector(labelSel);
      if (lbl) lbl.textContent = val + '%';
      var imgs = root.querySelectorAll('.xb-flow[data-row="' + row + '"] .xb-diff');
      imgs.forEach(function(img){ img.style.opacity = String(val/100); });
    });
  });
  var btns = root.querySelectorAll('.xb-diff-btn');
  btns.forEach(function(btn){
    btn.addEventListener('click', function(){
      var diff = btn.getAttribute('data-diff');
      var ta = btn.getAttribute('data-target-a');
      var tb = btn.getAttribute('data-target-b');
      var section = btn.closest('.xb-flow');
      if (!section) return;
      var allBtns = section.querySelectorAll('.xb-diff-btn');
      allBtns.forEach(function(b){ b.classList.remove('active'); });
      btn.classList.add('active');
      var allDiffs = section.querySelectorAll('.xb-diff');
      allDiffs.forEach(function(img){
        var cell = img.getAttribute('data-cell');
        if (cell === ta || cell === tb) {
          img.src = diff;
          img.style.display = 'block';
          var slider = section.querySelector('.xb-slider');
          img.style.opacity = slider ? String(parseInt(slider.value, 10)/100) : '0.6';
        } else {
          img.src = '';
          img.style.display = 'none';
        }
      });
    });
  });
  var clears = root.querySelectorAll('.xb-btn-clear');
  clears.forEach(function(btn){
    btn.addEventListener('click', function(){
      var section = btn.closest('.xb-flow');
      if (!section) return;
      section.querySelectorAll('.xb-diff-btn').forEach(function(b){ b.classList.remove('active'); });
      section.querySelectorAll('.xb-diff').forEach(function(img){
        img.src = '';
        img.style.display = 'none';
      });
    });
  });
})();
</script>`;

export function renderCrossBrowserHtml(report: CrossBrowserReport, outDir: string): string {
  const baseDir = path.resolve(outDir);
  const pairs = collectFlowViewportsFromReport(report);
  const matrixRows = pairs
    .map((p, idx) => renderMatrixRow(report, baseDir, p.flow, p.viewport, idx))
    .join('');
  const overallStatus = report.passed ? 'PASS' : 'FAIL';
  const overallClass = report.passed ? 'xb-pass' : 'xb-fail';
  return `<section class="xb-root">
  ${CROSS_BROWSER_STYLES}
  <h3>Cross-browser matrix <span class="xb-pill ${overallClass}">${overallStatus}</span></h3>
  <div class="xb-header-meta">
    <span><strong>URL:</strong> ${xbEscape(report.url)}</span>
    <span><strong>Engines:</strong> ${report.engines.map(xbEscape).join(' / ')}</span>
  </div>
  ${renderOutcomeSummary(report)}
  <h4>Divergences</h4>
  ${renderDivergence(report)}
  <h4>Screenshots</h4>
  ${matrixRows}
  ${CROSS_BROWSER_SCRIPT}
</section>`;
}
