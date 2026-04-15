import type { Page } from 'playwright';
import type { ExploreResult, BrokenInteraction } from './types.js';
import {
  auditStuckSpinners,
  type StuckSpinnerOptions,
  type StuckSpinnerFinding,
} from './stuck-spinner-audit.js';
import {
  snapshotErrorState,
  diffErrorStateAppearance,
  DEFAULT_ERROR_STATE_SELECTORS,
} from './error-state-audit.js';
import { measureClickCoverage, listInteractiveElements } from './coverage.js';
import { attachFrustrationSignals, type FrustrationSignalResult, type FrustrationSignalOptions } from './frustration-signals.js';
import {
  logClick,
  logUntested,
  type ClickRecord,
  type UntestedRecord,
} from './heatmap.js';

export interface ExploreOptions {
  maxClicks?: number;
  maxPages?: number;
  sameOrigin?: boolean;
  submitForms?: boolean;
  /** Skip the stuck-spinner check that runs after every click. */
  skipStuckSpinner?: boolean;
  /** Options forwarded to `auditStuckSpinners` when run after clicks. */
  stuckSpinner?: StuckSpinnerOptions;
  errorState?: boolean;
  errorStateSelectors?: string[];
  frustrationSignals?: boolean | FrustrationSignalOptions;
}

export async function explore(
  page: Page,
  opts: ExploreOptions = {},
): Promise<ExploreResult & { frustrationSignals?: FrustrationSignalResult }> {
  const maxClicks = opts.maxClicks ?? 50;
  const maxPages = opts.maxPages ?? 20;
  const sameOrigin = opts.sameOrigin ?? true;
  const submitForms = opts.submitForms ?? true;
  const runStuckSpinner = opts.skipStuckSpinner !== true;
  const errorStateOn = opts.errorState ?? false;
  const errorStateSelectors = opts.errorStateSelectors ?? [...DEFAULT_ERROR_STATE_SELECTORS];
  const startOrigin = new URL(page.url()).origin;

  const frustrationHandle = opts.frustrationSignals
    ? await attachFrustrationSignals(
        page,
        typeof opts.frustrationSignals === 'object' ? opts.frustrationSignals : {},
      ).catch(() => null)
    : null;

  const consoleErrors: string[] = [];
  const networkErrors: string[] = [];
  const errors: string[] = [];
  const stuckSpinners: StuckSpinnerFinding[] = [];
  const brokenInteractions: BrokenInteraction[] = [];
  let buttonsClicked = 0;
  let formsSubmitted = 0;
  const pagesVisited = new Set<string>([page.url()]);
  const tried = new Set<string>();
  const clickedKeys = new Set<string>();
  const clickLog: ClickRecord[] = [];
  const untestedLog: UntestedRecord[] = [];
  // Capture bounding boxes of the baseline snapshot keyed by element key so we
  // can record coords for untested elements after the BFS completes without
  // re-querying a potentially-navigated page.
  const baselineBoxes = new Map<string, { x: number; y: number; w: number; h: number; selector: string }>();
  try {
    const boxes = await page.evaluate((selector: string) => {
      const els = Array.from(document.querySelectorAll<HTMLElement>(selector));
      const out: Array<{ key: string; x: number; y: number; w: number; h: number; selector: string }> = [];
      for (const el of els) {
        if ((el as HTMLInputElement | HTMLButtonElement).disabled) continue;
        if (el.getAttribute('aria-disabled') === 'true') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        const cls = el.className && typeof el.className === 'string' ? `.${el.className.slice(0, 40)}` : '';
        const txt = (el.textContent ?? '').trim().slice(0, 40);
        const href = (el as HTMLAnchorElement).href ?? '';
        const key = `${tag}${id}${cls}|${txt}|${href}`;
        const cssSelector = id ? `#${el.id}` : tag + (cls ? cls : '');
        out.push({ key, x: rect.x, y: rect.y, w: rect.width, h: rect.height, selector: cssSelector });
      }
      return out;
    }, 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=tab], [role=menuitem], [tabindex]:not([tabindex="-1"]), [onclick]');
    for (const b of boxes) {
      if (!baselineBoxes.has(b.key)) {
        baselineBoxes.set(b.key, { x: b.x, y: b.y, w: b.w, h: b.h, selector: b.selector });
      }
    }
  } catch {
    // evaluate failed; heatmap will be empty for this run
  }
  const viewportSize = page.viewportSize() ?? { width: 1280, height: 800 };

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('response', (res) => {
    if (res.status() >= 400) networkErrors.push(`${res.status()} ${res.url()}`);
  });

  // Snapshot the universe of interactive elements BEFORE we start clicking, so
  // navigation doesn't invalidate the total-for-this-route figure.
  const baseline = await measureClickCoverage(page).catch(() => ({ totalInteractive: 0, byTag: {} as Record<string, number> }));
  const baselineElements = await listInteractiveElements(page).catch(() => [] as Awaited<ReturnType<typeof listInteractiveElements>>);

  if (submitForms) {
    formsSubmitted += await fillAndSubmitForms(page, errors);
  }

  for (let i = 0; i < maxClicks; i++) {
    if (pagesVisited.size >= maxPages) break;
    const target = await pickNextClickable(page, tried);
    if (!target) break;
    tried.add(target.key);
    // Capture the bounding box BEFORE clicking — after a click the page may
    // navigate, re-render, or unmount the element so boundingBox() would fail.
    const box = await target.locator
      .boundingBox()
      .catch(() => null);
    try {
      const before = page.url();
      const errBefore = errorStateOn
        ? await snapshotErrorState(page, { selectors: errorStateSelectors }).catch(() => null)
        : null;
      await target.locator.click({ timeout: 5000, noWaitAfter: true });
      buttonsClicked++;
      clickedKeys.add(target.key);
      if (box) {
        logClick(clickLog, {
          x: box.x,
          y: box.y,
          w: box.width,
          h: box.height,
          selector: target.key.split('|')[0] ?? target.key,
          result: 'clicked',
        });
      } else {
        // Fall back to the baseline snapshot if boundingBox() raced.
        const fallback = baselineBoxes.get(target.key);
        if (fallback) {
          logClick(clickLog, { ...fallback, result: 'clicked' });
        }
      }
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
      const after = page.url();
      if (errBefore && after === before) {
        const diff = await diffErrorStateAppearance(page, errBefore).catch(() => null);
        if (diff && diff.newErrors.length) {
          brokenInteractions.push({
            key: target.key,
            reason: 'error-state-appeared',
            newErrors: diff.newErrors,
          });
        }
      }
      if (after !== before) {
        if (sameOrigin && new URL(after).origin !== startOrigin) {
          await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
        } else {
          pagesVisited.add(after);
          if (submitForms) formsSubmitted += await fillAndSubmitForms(page, errors);
        }
      }
      if (runStuckSpinner) {
        const stuck = await auditStuckSpinners(page, opts.stuckSpinner ?? {}).catch(() => null);
        if (stuck && stuck.stuck.length > 0) {
          for (const f of stuck.stuck) stuckSpinners.push(f);
        }
      }
    } catch {
      // click failed — record as a failed attempt so the heatmap surfaces it
      if (box) {
        logClick(clickLog, {
          x: box.x,
          y: box.y,
          w: box.width,
          h: box.height,
          selector: target.key.split('|')[0] ?? target.key,
          result: 'failed',
        });
      } else {
        const fallback = baselineBoxes.get(target.key);
        if (fallback) logClick(clickLog, { ...fallback, result: 'failed' });
      }
    }
  }

  const total = baseline.totalInteractive;
  const clicked = clickedKeys.size;
  const percent = total > 0 ? Math.round((clicked / total) * 10000) / 100 : 0;
  const missed = baselineElements
    .filter((e) => !clickedKeys.has(e.key))
    .slice(0, 50)
    .map((e) => ({ selector: e.selector, snippet: e.snippet }));

  // Record every baseline element we never clicked as "untested" on the heatmap.
  for (const [key, box] of baselineBoxes) {
    if (clickedKeys.has(key)) continue;
    logUntested(untestedLog, {
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      selector: box.selector,
    });
  }

  let frustrationResult: FrustrationSignalResult | undefined;
  if (frustrationHandle) {
    frustrationResult = await frustrationHandle.result().catch(() => undefined);
    frustrationHandle.detach();
  }

  return {
    pagesVisited: pagesVisited.size,
    buttonsClicked,
    formsSubmitted,
    errors,
    consoleErrors,
    networkErrors,
    stuckSpinners: runStuckSpinner ? stuckSpinners : undefined,
    brokenInteractions,
    coverage: {
      clicked,
      total,
      percent,
      byTag: baseline.byTag,
      missed,
    },
    frustrationSignals: frustrationResult,
    heatmap:
      clickLog.length || untestedLog.length
        ? {
            viewport: {
              name: `${viewportSize.width}x${viewportSize.height}`,
              width: viewportSize.width,
              height: viewportSize.height,
            },
            clicks: clickLog,
            untested: untestedLog,
          }
        : undefined,
  };
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
