import { Driver } from './driver.js';
import { checkA11y } from './a11y.js';
import { checkPerf } from './perf.js';
import { checkVisual } from './visual.js';
import { explore } from './explore.js';
import { AIHelper } from './ai.js';
import { writeReport } from './report.js';
import { r2StoreFromEnv } from './store.js';
import type {
  InspectConfig,
  InspectResult,
  FlowResult,
  StepResult,
  Step,
  A11yResult,
  PerfResult,
  VisualResult,
} from './types.js';
import type { Page } from 'playwright';

export * from './types.js';
export { Driver } from './driver.js';
export { AIHelper } from './ai.js';

export async function inspect(config: InspectConfig): Promise<InspectResult> {
  const startedAt = new Date();
  const viewports = config.viewports ?? [{ name: 'desktop', width: 1280, height: 800 }];
  const checks = config.checks ?? { a11y: true, perf: false, visual: true, explore: false };
  const outputDir = config.output?.dir ?? './uxinspect-report';
  const baselineDir = config.output?.baselineDir ?? './uxinspect-baselines';
  const store = r2StoreFromEnv();
  const flows = config.flows ?? [{ name: 'load', steps: [{ goto: config.url }] }];

  const driver = new Driver();
  const flowResults: FlowResult[] = [];
  const a11yResults: A11yResult[] = [];
  const perfResults: PerfResult[] = [];
  const visualResults: VisualResult[] = [];
  let exploreResult: InspectResult['explore'];

  try {
    for (const vp of viewports) {
      await driver.launch({
        viewport: { width: vp.width, height: vp.height },
        headless: !config.headed,
        storageState: config.storageState,
      });
      const ai = new AIHelper({ model: config.ai?.model });

      const runOne = async (flow: { name: string; steps: Step[] }): Promise<{ flow: FlowResult; a11y?: A11yResult; visual?: VisualResult }> => {
        const page = await driver.newPage();
        if (config.ai?.enabled) await ai.init(page);
        const flowResult = await runFlow(page, flow.name, flow.steps, ai);
        const a11y = checks.a11y ? await checkA11y(page).catch((e) => emptyA11y(page.url(), e)) : undefined;
        const visual = checks.visual
          ? await checkVisual(page, flow.name, vp.name, { baselineDir, outputDir, store: store ?? undefined }).catch((e) => emptyVisual(page.url(), vp.name, e))
          : undefined;
        if (!config.parallel) await page.close();
        return { flow: flowResult, a11y, visual };
      };

      const results = config.parallel ? await Promise.all(flows.map(runOne)) : [];
      if (!config.parallel) for (const flow of flows) results.push(await runOne(flow));
      for (const r of results) {
        flowResults.push(r.flow);
        if (r.a11y) a11yResults.push(r.a11y);
        if (r.visual) visualResults.push(r.visual);
      }

      if (checks.perf) {
        const port = driver.cdpPort;
        if (port) {
          perfResults.push(await checkPerf(config.url, port).catch((e) => emptyPerf(config.url, e)));
        } else {
          perfResults.push(emptyPerf(config.url, new Error('no CDP port available')));
        }
      }

      if (checks.explore) {
        const opts = typeof checks.explore === 'object' ? checks.explore : {};
        const ePage = await driver.newPage();
        await ePage.goto(config.url);
        exploreResult = await explore(ePage, opts);
        await ePage.close();
      }

      await ai.close();
      await driver.close();
    }
  } finally {
    await driver.close();
  }

  const finishedAt = new Date();
  const passed =
    flowResults.every((f) => f.passed) &&
    a11yResults.every((a) => a.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious').length === 0) &&
    visualResults.every((v) => v.passed);

  const result: InspectResult = {
    url: config.url,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    flows: flowResults,
    a11y: checks.a11y ? a11yResults : undefined,
    perf: checks.perf ? perfResults : undefined,
    visual: checks.visual ? visualResults : undefined,
    explore: exploreResult,
    passed,
  };

  await writeReport(result, outputDir, config.reporters);
  return result;
}

async function runFlow(page: Page, name: string, steps: Step[], ai: AIHelper): Promise<FlowResult> {
  const stepResults: StepResult[] = [];
  const screenshots: string[] = [];
  let passed = true;
  let error: string | undefined;

  for (const step of steps) {
    const start = Date.now();
    try {
      await runStep(page, step, ai);
      stepResults.push({ step, passed: true, durationMs: Date.now() - start });
    } catch (e: any) {
      passed = false;
      error = e?.message ?? String(e);
      stepResults.push({ step, passed: false, durationMs: Date.now() - start, error });
      break;
    }
  }

  return { name, passed, steps: stepResults, screenshots, error };
}

async function runStep(page: Page, step: Step, ai: AIHelper): Promise<void> {
  if ('goto' in step) {
    await page.goto(step.goto, { waitUntil: 'domcontentloaded' });
  } else if ('click' in step) {
    await page.click(step.click);
  } else if ('type' in step) {
    await page.type(step.type.selector, step.type.text);
  } else if ('fill' in step) {
    await page.fill(step.fill.selector, step.fill.text);
  } else if ('waitFor' in step) {
    await page.waitForSelector(step.waitFor);
  } else if ('screenshot' in step) {
    await page.screenshot({ path: step.screenshot, fullPage: true });
  } else if ('ai' in step) {
    if (!ai.isAvailable()) throw new Error('AI step requested but AI helper not initialized');
    const ok = await ai.act(step.ai);
    if (!ok) throw new Error(`AI step failed: ${step.ai}`);
  }
}

function emptyA11y(url: string, e: unknown): A11yResult {
  return { page: url, violations: [], passed: false, ...({ error: String(e) } as any) };
}
function emptyPerf(url: string, e: unknown): PerfResult {
  return {
    page: url,
    scores: { performance: 0, accessibility: 0, bestPractices: 0, seo: 0 },
    metrics: { lcp: 0, fcp: 0, cls: 0, tbt: 0, si: 0 },
    ...({ error: String(e) } as any),
  };
}
function emptyVisual(url: string, vp: string, e: unknown): VisualResult {
  return {
    page: url,
    viewport: vp,
    baseline: '',
    current: '',
    diffPixels: 0,
    diffRatio: 0,
    passed: false,
    ...({ error: String(e) } as any),
  };
}
