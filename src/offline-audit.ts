import type { Page } from 'playwright';

export interface OfflineModeResult {
  renders: boolean;
  swActive: boolean;
  cachedResources: string[];
  bodyTextLength: number;
  error?: string;
}

export interface SlowNetworkResult {
  showsSkeleton: boolean;
  ttfb: number;
  loadCompleted: boolean;
  error?: string;
}

export interface FlakyNetworkResult {
  showsError: boolean;
  hasRetry: boolean;
  totalRequests: number;
  failedRequests: number;
  error?: string;
}

export interface OfflineAuditIssue {
  type:
    | 'offline-blank'
    | 'no-service-worker'
    | 'no-offline-cache'
    | 'slow-blank'
    | 'flaky-silent';
  detail: string;
}

export interface OfflineResult {
  page: string;
  offline: OfflineModeResult;
  slowNetwork: SlowNetworkResult;
  flakyNetwork: FlakyNetworkResult;
  issues: OfflineAuditIssue[];
  passed: boolean;
}

export interface OfflineAuditOptions {
  url?: string;
  checkOffline?: boolean;
  checkSlow?: boolean;
  checkFlaky?: boolean;
  slowDelayMs?: number;
  flakyFailRate?: number;
  skeletonWaitMs?: number;
}

const DEFAULT_SLOW_DELAY_MS = 2000;
const DEFAULT_FLAKY_FAIL_RATE = 0.5;
const DEFAULT_SKELETON_WAIT_MS = 3000;
const NAV_TIMEOUT_MS = 20_000;

function asTextLen(text: string | null | undefined): number {
  if (!text) return 0;
  return text.trim().length;
}

async function checkOfflineMode(page: Page): Promise<OfflineModeResult> {
  const ctx = page.context();
  const result: OfflineModeResult = {
    renders: false,
    swActive: false,
    cachedResources: [],
    bodyTextLength: 0,
  };

  const swInfo = await page
    .evaluate(async () => {
      if (!('serviceWorker' in navigator)) {
        return { hasController: false, cachedUrls: [] as string[] };
      }
      try {
        const hasController = !!(navigator as any).serviceWorker.controller;
        let cachedUrls: string[] = [];
        if ('caches' in (self as any)) {
          try {
            const names: string[] = await (self as any).caches.keys();
            for (const name of names) {
              try {
                const cache = await (self as any).caches.open(name);
                const reqs: Request[] = await cache.keys();
                for (const r of reqs) cachedUrls.push(r.url);
              } catch {
                // ignore cache open errors
              }
            }
          } catch {
            // ignore caches enumeration errors
          }
        }
        return { hasController, cachedUrls };
      } catch {
        return { hasController: false, cachedUrls: [] };
      }
    })
    .catch(() => ({ hasController: false, cachedUrls: [] as string[] }));

  result.swActive = swInfo.hasController;
  result.cachedResources = swInfo.cachedUrls.slice(0, 50);

  try {
    await ctx.setOffline(true);
    try {
      await page.reload({ timeout: NAV_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
      const bodyLen = await page
        .evaluate(() => document.body?.innerText ?? '')
        .then(asTextLen)
        .catch(() => 0);
      result.bodyTextLength = bodyLen;
      result.renders = bodyLen > 0;
    } catch (e) {
      result.error = e instanceof Error ? e.message : String(e);
      result.renders = false;
    }
  } finally {
    try {
      await ctx.setOffline(false);
    } catch {
      // ignore
    }
  }

  return result;
}

async function checkSlowNetwork(
  page: Page,
  delayMs: number,
  skeletonWaitMs: number,
): Promise<SlowNetworkResult> {
  const ctx = page.context();
  const result: SlowNetworkResult = {
    showsSkeleton: false,
    ttfb: 0,
    loadCompleted: false,
  };

  const pattern = '**/*';
  const handler = async (route: any): Promise<void> => {
    setTimeout(() => {
      route.continue().catch(() => {});
    }, delayMs);
  };

  try {
    await ctx.route(pattern, handler);
    const start = Date.now();
    const navPromise = page
      .reload({ timeout: NAV_TIMEOUT_MS, waitUntil: 'load' })
      .catch((e: unknown) => {
        result.error = e instanceof Error ? e.message : String(e);
      });

    await new Promise((r) => setTimeout(r, skeletonWaitMs));
    const midLoadBody = await page
      .evaluate(() => {
        const body = document.body;
        if (!body) return { text: '', hasSkeleton: false };
        const text = body.innerText ?? '';
        const skeletonEls = document.querySelectorAll(
          '[class*="skeleton" i], [class*="loading" i], [class*="spinner" i], [role="progressbar"], [aria-busy="true"]',
        );
        return { text, hasSkeleton: skeletonEls.length > 0 };
      })
      .catch(() => ({ text: '', hasSkeleton: false }));

    result.showsSkeleton = midLoadBody.hasSkeleton || asTextLen(midLoadBody.text) > 0;
    result.ttfb = Date.now() - start;

    await navPromise;
    result.loadCompleted = !result.error;
  } catch (e) {
    if (!result.error) result.error = e instanceof Error ? e.message : String(e);
  } finally {
    try {
      await ctx.unroute(pattern, handler);
    } catch {
      // ignore
    }
  }

  return result;
}

async function checkFlakyNetwork(
  page: Page,
  failRate: number,
): Promise<FlakyNetworkResult> {
  const ctx = page.context();
  const result: FlakyNetworkResult = {
    showsError: false,
    hasRetry: false,
    totalRequests: 0,
    failedRequests: 0,
  };

  const pattern = '**/*';
  const mainUrl = page.url();
  const handler = async (route: any, request: any): Promise<void> => {
    result.totalRequests += 1;
    // Never fail the main document navigation — that would prevent measuring UI response.
    if (request.url() === mainUrl || request.resourceType() === 'document') {
      return route.continue().catch(() => {});
    }
    if (Math.random() < failRate) {
      result.failedRequests += 1;
      return route.abort('failed').catch(() => {});
    }
    return route.continue().catch(() => {});
  };

  try {
    await ctx.route(pattern, handler);
    try {
      await page.reload({ timeout: NAV_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
    } catch (e) {
      result.error = e instanceof Error ? e.message : String(e);
    }

    // Let the app render error / retry UI.
    await page.waitForTimeout(1500).catch(() => {});

    const ui = await page
      .evaluate(() => {
        const bodyText = (document.body?.innerText ?? '').toLowerCase();
        const errorRegex = /\b(error|failed|offline|try again|something went wrong|couldn'?t|cannot|unable)\b/;
        const showsError =
          errorRegex.test(bodyText) ||
          document.querySelector(
            '[role="alert"], [class*="error" i], [class*="toast" i], [data-error], [aria-live="assertive"]',
          ) !== null;
        const hasRetry =
          document.querySelector(
            'button, a',
          ) !== null &&
          (/\b(retry|try again|reload|refresh)\b/i.test(bodyText) ||
            document.querySelector('[data-retry], [class*="retry" i]') !== null);
        return { showsError, hasRetry };
      })
      .catch(() => ({ showsError: false, hasRetry: false }));

    result.showsError = ui.showsError;
    result.hasRetry = ui.hasRetry;
  } catch (e) {
    if (!result.error) result.error = e instanceof Error ? e.message : String(e);
  } finally {
    try {
      await ctx.unroute(pattern, handler);
    } catch {
      // ignore
    }
  }

  return result;
}

/**
 * Audit how a page behaves under offline, slow, and flaky network conditions.
 *
 * Warms the cache with an initial online navigation, then re-loads the page
 * under each condition and probes the rendered DOM for signs of graceful
 * degradation (cached content, skeletons, error toasts, retry UI).
 */
export async function auditOfflineBehavior(
  page: Page,
  opts: OfflineAuditOptions = {},
): Promise<OfflineResult> {
  const url = opts.url ?? page.url();
  const checkOffline = opts.checkOffline !== false;
  const checkSlow = opts.checkSlow !== false;
  const checkFlaky = opts.checkFlaky !== false;
  const slowDelay = opts.slowDelayMs ?? DEFAULT_SLOW_DELAY_MS;
  const flakyRate = opts.flakyFailRate ?? DEFAULT_FLAKY_FAIL_RATE;
  const skeletonWait = opts.skeletonWaitMs ?? DEFAULT_SKELETON_WAIT_MS;

  // Warm cache and register service worker (if any).
  if (url && url !== 'about:blank') {
    try {
      await page.goto(url, { timeout: NAV_TIMEOUT_MS, waitUntil: 'load' });
    } catch {
      // if initial goto fails, we continue anyway so result captures the failure downstream
    }
    // Give the service worker a moment to activate.
    await page.waitForTimeout(400).catch(() => {});
  }

  const pageUrl = page.url();
  const issues: OfflineAuditIssue[] = [];

  let offline: OfflineModeResult = {
    renders: false,
    swActive: false,
    cachedResources: [],
    bodyTextLength: 0,
  };
  if (checkOffline) {
    offline = await checkOfflineMode(page);
    if (!offline.renders) {
      issues.push({
        type: 'offline-blank',
        detail: 'page is blank or errored when offline — no cached fallback rendered',
      });
    }
    if (!offline.swActive) {
      issues.push({
        type: 'no-service-worker',
        detail: 'no active service worker controller — cannot serve cached content offline',
      });
    }
    if (offline.cachedResources.length === 0) {
      issues.push({
        type: 'no-offline-cache',
        detail: 'no Cache Storage entries — nothing available for offline use',
      });
    }

    // Re-navigate online so subsequent checks are not starting from a dead page.
    try {
      if (url && url !== 'about:blank') {
        await page.goto(url, { timeout: NAV_TIMEOUT_MS, waitUntil: 'load' });
      }
    } catch {
      // ignore
    }
  }

  let slowNetwork: SlowNetworkResult = {
    showsSkeleton: false,
    ttfb: 0,
    loadCompleted: false,
  };
  if (checkSlow) {
    slowNetwork = await checkSlowNetwork(page, slowDelay, skeletonWait);
    if (!slowNetwork.showsSkeleton) {
      issues.push({
        type: 'slow-blank',
        detail: `no loading/skeleton indicator shown within ${skeletonWait}ms on slow network`,
      });
    }
    // Re-navigate online.
    try {
      if (url && url !== 'about:blank') {
        await page.goto(url, { timeout: NAV_TIMEOUT_MS, waitUntil: 'load' });
      }
    } catch {
      // ignore
    }
  }

  let flakyNetwork: FlakyNetworkResult = {
    showsError: false,
    hasRetry: false,
    totalRequests: 0,
    failedRequests: 0,
  };
  if (checkFlaky) {
    flakyNetwork = await checkFlakyNetwork(page, flakyRate);
    if (flakyNetwork.failedRequests > 0 && !flakyNetwork.showsError && !flakyNetwork.hasRetry) {
      issues.push({
        type: 'flaky-silent',
        detail: `${flakyNetwork.failedRequests}/${flakyNetwork.totalRequests} requests failed but app showed no error or retry UI`,
      });
    }
  }

  const passed = issues.length === 0;

  return {
    page: pageUrl || url || '',
    offline,
    slowNetwork,
    flakyNetwork,
    issues,
    passed,
  };
}
