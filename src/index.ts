import path from 'node:path';
import { Driver, networkPresets } from './driver.js';
import { checkA11y, annotateA11y } from './a11y.js';
import { checkPerf } from './perf.js';
import { checkVisual } from './visual.js';
import { explore } from './explore.js';
import { checkSeo } from './seo.js';
import { checkLinks } from './links.js';
import { checkPwa } from './pwa.js';
import { checkSecurityHeaders } from './security.js';
import { checkBudget } from './budget.js';
import { notify } from './notify.js';
import { AIHelper } from './ai.js';
import { writeReport } from './report.js';
import { r2StoreFromEnv } from './store.js';
import { runApiFlows } from './api.js';
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
export { Driver, networkPresets } from './driver.js';
export { AIHelper } from './ai.js';
export { checkSeo } from './seo.js';
export { checkLinks } from './links.js';
export { checkPwa } from './pwa.js';
export { checkSecurityHeaders } from './security.js';
export { checkBudget } from './budget.js';
export { notify } from './notify.js';
export { runApiFlows } from './api.js';

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
  const seoResults: InspectResult['seo'] = [];
  const linkResults: InspectResult['links'] = [];
  const pwaResults: InspectResult['pwa'] = [];
  let securityResult: InspectResult['security'];
  let exploreResult: InspectResult['explore'];

  try {
    for (const vp of viewports) {
      await driver.launch({
        viewport: { width: vp.width, height: vp.height },
        headless: !config.headed && !config.debug,
        storageState: config.storageState,
        browser: config.browser,
        device: config.device,
        locale: config.locale,
        timezoneId: config.timezoneId,
        geolocation: config.geolocation,
        throttle: config.network ? networkPresets[config.network] : undefined,
        recordVideo: config.video ? path.join(outputDir, 'video') : undefined,
        recordHar: config.har ? path.join(outputDir, 'trace.har') : undefined,
        trace: config.trace ? path.join(outputDir, 'trace.zip') : undefined,
        slowMo: config.slowMo ?? (config.debug ? 500 : undefined),
        mocks: config.mocks,
      });
      const ai = new AIHelper({
        model: config.ai?.model,
        cachePath: path.join(outputDir, 'ai-cache.json'),
      });

      const runOne = async (flow: { name: string; steps: Step[] }): Promise<{
        flow: FlowResult;
        a11y?: A11yResult;
        visual?: VisualResult;
        seo?: InspectResult['seo'] extends Array<infer T> | undefined ? T : never;
        links?: InspectResult['links'] extends Array<infer T> | undefined ? T : never;
        pwa?: InspectResult['pwa'] extends Array<infer T> | undefined ? T : never;
      }> => {
        const page = await driver.newPage();
        if (config.ai?.enabled) await ai.init(page);
        const flowResult = await runFlow(page, flow.name, flow.steps, ai);
        const a11y = checks.a11y ? await checkA11y(page).catch((e) => emptyA11y(page.url(), e)) : undefined;
        if (a11y && a11y.violations.length > 0) {
          await annotateA11y(page, a11y, path.join(outputDir, 'a11y', `${flow.name}-${vp.name}.png`)).catch(() => {});
        }
        const visual = checks.visual
          ? await checkVisual(page, flow.name, vp.name, { baselineDir, outputDir, store: store ?? undefined }).catch((e) => emptyVisual(page.url(), vp.name, e))
          : undefined;
        const seoR = checks.seo ? await checkSeo(page).catch(() => undefined) : undefined;
        const linksR = checks.links
          ? await checkLinks(page, typeof checks.links === 'object' ? checks.links : {}).catch(() => undefined)
          : undefined;
        const pwaR = checks.pwa ? await checkPwa(page).catch(() => undefined) : undefined;
        if (!config.parallel) await page.close();
        return { flow: flowResult, a11y, visual, seo: seoR as any, links: linksR as any, pwa: pwaR as any };
      };

      const results = config.parallel ? await Promise.all(flows.map(runOne)) : [];
      if (!config.parallel) for (const flow of flows) results.push(await runOne(flow));
      for (const r of results) {
        flowResults.push(r.flow);
        if (r.a11y) a11yResults.push(r.a11y);
        if (r.visual) visualResults.push(r.visual);
        if (r.seo) seoResults!.push(r.seo as any);
        if (r.links) linkResults!.push(r.links as any);
        if (r.pwa) pwaResults!.push(r.pwa as any);
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

      if (checks.security) {
        securityResult = await checkSecurityHeaders(config.url).catch(() => undefined);
      }

      await ai.close();
      await driver.close();
    }
  } finally {
    await driver.close();
  }

  const finishedAt = new Date();
  const baselinePassed =
    flowResults.every((f) => f.passed) &&
    a11yResults.every((a) => a.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious').length === 0) &&
    visualResults.every((v) => v.passed) &&
    (!checks.links || (linkResults ?? []).every((l) => l.passed)) &&
    (!checks.security || securityResult?.passed !== false);

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
    seo: checks.seo ? seoResults : undefined,
    links: checks.links ? linkResults : undefined,
    pwa: checks.pwa ? pwaResults : undefined,
    security: securityResult,
    passed: baselinePassed,
  };

  if (config.apiFlows?.length) {
    const apiResults = await runApiFlows(config.apiFlows).catch(() => []);
    result.apiFlows = apiResults;
    if (apiResults.some((r) => !r.passed)) result.passed = false;
  }

  if (config.budget) {
    const violations = checkBudget(result, config.budget);
    result.budget = violations;
    if (violations.length > 0) result.passed = false;
  }

  await writeReport(result, outputDir, config.reporters);

  if (config.notify) {
    const shouldNotify = !config.notify.onlyOnFail || !result.passed;
    if (shouldNotify) {
      await notify(result, config.notify).catch(() => {});
    }
  }

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
  } else if ('drag' in step) {
    await page.dragAndDrop(step.drag.from, step.drag.to);
  } else if ('upload' in step) {
    await page.setInputFiles(step.upload.selector, step.upload.files);
  } else if ('dialog' in step) {
    const d = step.dialog;
    page.once('dialog', (dlg) => {
      const accept = typeof d === 'string' ? d === 'accept' : (d.accept ?? true);
      const text = typeof d === 'object' ? d.text : undefined;
      if (accept) dlg.accept(text); else dlg.dismiss();
    });
  } else if ('scroll' in step) {
    const s = step.scroll;
    if (s.selector) await page.locator(s.selector).scrollIntoViewIfNeeded();
    else await page.evaluate(({ x, y }) => window.scrollTo(x ?? 0, y ?? 0), { x: s.x, y: s.y });
  } else if ('select' in step) {
    await page.selectOption(step.select.selector, step.select.value as any);
  } else if ('key' in step) {
    await page.keyboard.press(step.key);
  } else if ('eval' in step) {
    await page.evaluate(step.eval);
  } else if ('waitForResponse' in step) {
    const s = step.waitForResponse;
    const urlPat = typeof s === 'string' ? s : s.url;
    await page.waitForResponse((res) => {
      const matches = res.url().includes(urlPat) || new RegExp(urlPat).test(res.url());
      if (typeof s === 'object' && s.status) return matches && res.status() === s.status;
      return matches;
    });
  } else if ('waitForRequest' in step) {
    await page.waitForRequest((req) => req.url().includes(step.waitForRequest) || new RegExp(step.waitForRequest).test(req.url()));
  } else if ('hover' in step) {
    await page.hover(step.hover);
  } else if ('check' in step) {
    await page.check(step.check);
  } else if ('uncheck' in step) {
    await page.uncheck(step.uncheck);
  } else if ('focus' in step) {
    await page.focus(step.focus);
  } else if ('blur' in step) {
    await page.locator(step.blur).evaluate((el: any) => el.blur());
  } else if ('reload' in step) {
    await page.reload({ waitUntil: 'domcontentloaded' });
  } else if ('back' in step) {
    await page.goBack({ waitUntil: 'domcontentloaded' });
  } else if ('forward' in step) {
    await page.goForward({ waitUntil: 'domcontentloaded' });
  } else if ('newTab' in step) {
    const ctx = page.context();
    const p = await ctx.newPage();
    await p.goto(step.newTab, { waitUntil: 'domcontentloaded' });
  } else if ('switchTab' in step) {
    const pages = page.context().pages();
    const target = typeof step.switchTab === 'number'
      ? pages[step.switchTab]
      : pages.find((p) => p.url().includes(String(step.switchTab)));
    if (target) await target.bringToFront();
  } else if ('closeTab' in step) {
    await page.close();
  } else if ('iframe' in step) {
    const frame = page.frameLocator(step.iframe.selector);
    for (const s of step.iframe.steps) {
      await runIframeStep(frame, s);
    }
  } else if ('sleep' in step) {
    await page.waitForTimeout(step.sleep);
  } else if ('waitForDownload' in step) {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click(step.waitForDownload.trigger)]);
    await dl.saveAs(step.waitForDownload.saveAs);
  } else if ('waitForPopup' in step) {
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.click(step.waitForPopup.trigger)]);
    await popup.waitForLoadState('domcontentloaded');
    if (step.waitForPopup.switchTo) await popup.bringToFront();
  } else if ('cookie' in step) {
    const c = step.cookie;
    const url = new URL(page.url());
    await page.context().addCookies([{
      name: c.name,
      value: c.value,
      domain: c.domain ?? url.hostname,
      path: c.path ?? '/',
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    }]);
  } else if ('clearCookies' in step) {
    await page.context().clearCookies();
  }
}

async function runIframeStep(frame: import('playwright').FrameLocator, step: Step): Promise<void> {
  if ('click' in step) await frame.locator(step.click).click();
  else if ('fill' in step) await frame.locator(step.fill.selector).fill(step.fill.text);
  else if ('type' in step) await frame.locator(step.type.selector).type(step.type.text);
  else if ('waitFor' in step) await frame.locator(step.waitFor).waitFor();
  else if ('hover' in step) await frame.locator(step.hover).hover();
  else if ('check' in step) await frame.locator(step.check).check();
  else if ('uncheck' in step) await frame.locator(step.uncheck).uncheck();
  else if ('select' in step) await frame.locator(step.select.selector).selectOption(step.select.value as any);
  else if ('key' in step) await frame.locator('body').press(step.key);
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
