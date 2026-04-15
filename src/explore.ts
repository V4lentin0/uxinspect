import path from 'node:path';
import type { Page } from 'playwright';
import type { ExploreResult } from './types.js';
import { generateExploreHeatmap } from './heatmap.js';

export interface ExploreOptions {
  maxClicks?: number;
  maxPages?: number;
  sameOrigin?: boolean;
  submitForms?: boolean;
  heatmap?: boolean | { outDir?: string };
}

export async function explore(page: Page, opts: ExploreOptions = {}): Promise<ExploreResult> {
  const maxClicks = opts.maxClicks ?? 50;
  const maxPages = opts.maxPages ?? 20;
  const sameOrigin = opts.sameOrigin ?? true;
  const submitForms = opts.submitForms ?? true;
  const heatmapEnabled = Boolean(opts.heatmap);
  const heatmapOutDir =
    typeof opts.heatmap === 'object' && opts.heatmap?.outDir
      ? opts.heatmap.outDir
      : undefined;
  const startOrigin = new URL(page.url()).origin;

  const consoleErrors: string[] = [];
  const networkErrors: string[] = [];
  const errors: string[] = [];
  let buttonsClicked = 0;
  let formsSubmitted = 0;
  const pagesVisited = new Set<string>([page.url()]);
  const tried = new Set<string>();
  // Track keys that were actually clicked (not just attempted), per visited URL.
  const clickedByUrl = new Map<string, Set<string>>();
  const ensureClickedSet = (url: string): Set<string> => {
    let s = clickedByUrl.get(url);
    if (!s) {
      s = new Set<string>();
      clickedByUrl.set(url, s);
    }
    return s;
  };

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('response', (res) => {
    if (res.status() >= 400) networkErrors.push(`${res.status()} ${res.url()}`);
  });

  if (submitForms) {
    formsSubmitted += await fillAndSubmitForms(page, errors);
  }

  for (let i = 0; i < maxClicks; i++) {
    if (pagesVisited.size >= maxPages) break;
    const target = await pickNextClickable(page, tried);
    if (!target) break;
    tried.add(target.key);
    try {
      const before = page.url();
      await target.locator.click({ timeout: 5000, noWaitAfter: true });
      buttonsClicked++;
      ensureClickedSet(before).add(target.key);
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
      const after = page.url();
      if (after !== before) {
        if (sameOrigin && new URL(after).origin !== startOrigin) {
          await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
        } else {
          pagesVisited.add(after);
          if (submitForms) formsSubmitted += await fillAndSubmitForms(page, errors);
        }
      }
    } catch {
      // click failed — skip
    }
  }

  let heatmaps: ExploreResult['heatmaps'];
  if (heatmapEnabled) {
    heatmaps = [];
    const urls = Array.from(pagesVisited);
    const outDir = heatmapOutDir ?? path.join(process.cwd(), '.uxinspect', 'heatmaps');
    for (const url of urls) {
      try {
        if (page.url() !== url) {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
        }
        const clicked = clickedByUrl.get(url) ?? new Set<string>();
        const shotPath = path.join(outDir, `${slugForShot(url)}.png`);
        const result = await generateExploreHeatmap(page, clicked, shotPath, { outDir });
        heatmaps.push({ url: result.url, svgPath: result.svgPath, percent: result.percent });
      } catch (e) {
        errors.push(`heatmap: ${(e as Error).message}`);
      }
    }
  }

  return {
    pagesVisited: pagesVisited.size,
    buttonsClicked,
    formsSubmitted,
    errors,
    consoleErrors,
    networkErrors,
    ...(heatmaps ? { heatmaps } : {}),
  };
}

function slugForShot(url: string): string {
  try {
    const u = new URL(url);
    const s = `${u.host}${u.pathname}`.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
    return (s || 'page').slice(0, 120).toLowerCase();
  } catch {
    return 'page';
  }
}

async function pickNextClickable(
  page: Page,
  tried: Set<string>,
): Promise<{ locator: import('playwright').Locator; key: string } | null> {
  const candidates = await page
    .locator('button:visible, a:visible, [role="button"]:visible')
    .all()
    .catch(() => []);
  for (const loc of candidates) {
    const key = await loc
      .evaluate((el) => {
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        const cls = el.className && typeof el.className === 'string' ? `.${el.className.slice(0, 40)}` : '';
        const txt = (el.textContent ?? '').trim().slice(0, 40);
        const href = (el as HTMLAnchorElement).href ?? '';
        return `${tag}${id}${cls}|${txt}|${href}`;
      })
      .catch(() => '');
    if (!key || tried.has(key)) continue;
    return { locator: loc, key };
  }
  return null;
}

async function fillAndSubmitForms(page: Page, errors: string[]): Promise<number> {
  const forms = await page.locator('form:visible').all().catch(() => []);
  let submitted = 0;
  for (const form of forms) {
    try {
      const inputs = await form.locator('input:visible:not([type="hidden"]), textarea:visible, select:visible').all();
      for (const input of inputs) {
        const type = (await input.getAttribute('type').catch(() => null)) ?? 'text';
        if (type === 'submit' || type === 'button' || type === 'reset' || type === 'file') continue;
        if (type === 'checkbox' || type === 'radio') {
          await input.check({ timeout: 1000 }).catch(() => {});
          continue;
        }
        if (type === 'email') {
          await input.fill('test@uxinspect.dev', { timeout: 1000 }).catch(() => {});
        } else if (type === 'number' || type === 'tel') {
          await input.fill('1234567890', { timeout: 1000 }).catch(() => {});
        } else if (type === 'url') {
          await input.fill('https://uxinspect.com', { timeout: 1000 }).catch(() => {});
        } else {
          await input.fill('uxinspect', { timeout: 1000 }).catch(() => {});
        }
      }
      const submitBtn = form
        .locator('button:not([type="button"]):not([type="reset"]), input[type="submit"], input[type="image"]')
        .first();
      if (await submitBtn.count().catch(() => 0)) {
        const before = page.url();
        await submitBtn.click({ timeout: 5000, noWaitAfter: true }).catch(() => {});
        submitted++;
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
        if (page.url() !== before) await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
      }
    } catch (e) {
      errors.push(`form submit: ${(e as Error).message}`);
    }
  }
  return submitted;
}
