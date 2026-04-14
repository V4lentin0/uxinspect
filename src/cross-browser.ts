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
