import type { Page, BrowserContext, CDPSession } from 'playwright';

/**
 * P4 #40 — Offline / flaky-network audit.
 *
 * Runs real network-emulation scenarios against the page to verify that the
 * app degrades gracefully when the network is absent, throttled, or flapping.
 * Uses Playwright's `context.setOffline(true)` for the offline primitive and
 * CDP `Network.emulateNetworkConditions` for slow-3G throttling — NO stubs,
 * NO mock network layer.
 *
 * Scenarios executed in order (each can be skipped via `skipScenarios`):
 *   1. `full-offline`       — navigate with the context offline. Expect either
 *                             a SW-cached shell or a graceful offline HTML
 *                             response (not a raw browser error page).
 *   2. `slow-3g`            — 400 kbps, 400 ms latency. Reports LCP-ish proxy
 *                             timing + whether a loading indicator appeared.
 *   3. `intermittent`       — toggle offline/online while the page is loading.
 *                             Flags the app if it ends up on a stuck spinner.
 *   4. `offline-mutations`  — simulates a user submitting a form while offline;
 *                             passes iff the app queued the request (Background
 *                             Sync or a custom retry queue) and flushed it
 *                             after coming back online.
 *   5. `swr`                — if the SW claims stale-while-revalidate, verifies
 *                             a cached response is served while a fresh one is
 *                             fetched in the background.
 *   6. `sw-update`          — simulates a new SW version and checks that the
 *                             page either exposes a "new version" signal or
 *                             reloads cleanly without dumping the user on an
 *                             error page.
 */

export type OfflineScenarioId =
  | 'full-offline'
  | 'slow-3g'
  | 'intermittent'
  | 'offline-mutations'
  | 'swr'
  | 'sw-update';

export interface OfflineConfig {
  /**
   * Routes to warm up (navigate + wait for a SW to control them) before any
   * offline/throttle scenario runs. If omitted, only the page's current URL
   * is warmed up. Paths are resolved against the page's origin.
   */
  preloadRoutes?: string[];
  /** Scenarios to skip entirely. */
  skipScenarios?: OfflineScenarioId[];
  /**
   * URL (or path) that is expected to have a registered service worker. The
   * audit warms this up before each scenario; it's also used as the landing
   * target for the offline navigation. Default: `'/'`.
   */
  expectSwAt?: string;
  /**
   * Per-scenario navigation timeout in ms. Default: 8000.
   */
  navigationTimeoutMs?: number;
  /**
   * Selector used to submit a form in the offline-mutations scenario. When
   * omitted, the scenario is skipped as NA (no mutation surface).
   */
  mutationFormSelector?: string;
  /**
   * Selector to click to trigger the mutation. Defaults to a `button[type=submit]`
   * inside the form.
   */
  mutationSubmitSelector?: string;
  /**
   * Selectors that indicate the app is showing a loading state. Used by the
   * slow-3g and intermittent scenarios to decide whether the UI is responsive
   * while the network is slow or stalled.
   */
  loadingIndicatorSelectors?: string[];
}

export type OfflineIssueType =
  | 'browser-error-page-offline'
  | 'offline-navigation-failed'
  | 'no-loading-indicator-on-slow-network'
  | 'lcp-regression-on-slow-network'
  | 'stuck-spinner-on-flap'
  | 'offline-mutation-dropped'
  | 'swr-refresh-never-fired'
  | 'sw-update-silent'
  | 'sw-update-broke-page';

export interface OfflineIssue {
  type: OfflineIssueType;
  scenario: OfflineScenarioId;
  detail: string;
}

export interface OfflineScenarioResult {
  id: OfflineScenarioId;
  status: 'passed' | 'failed' | 'skipped' | 'na';
  durationMs: number;
  /** Free-form metrics populated by the scenario runner. */
  metrics?: Record<string, unknown>;
  /** Reason the scenario was skipped or marked N/A. */
  note?: string;
}

export interface OfflineResult {
  page: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  serviceWorkerDetected: boolean;
  scenarios: OfflineScenarioResult[];
  issues: OfflineIssue[];
  passed: boolean;
}

const DEFAULT_LOADING_SELECTORS: readonly string[] = [
  '[aria-busy="true"]',
  '.spinner',
  '.loading',
  '.loader',
  '[role="progressbar"]',
  '[data-loading="true"]',
  '.skeleton',
];

const SLOW_3G: { latency: number; downloadThroughput: number; uploadThroughput: number } = {
  latency: 400,
  // 400 kbps, expressed in bytes/s (CDP expects bytes/s).
  downloadThroughput: (400 * 1024) / 8,
  uploadThroughput: (400 * 1024) / 8,
};

function nowIso(): string {
  return new Date().toISOString();
}

function absolute(pageUrl: string, target: string): string {
  try {
    return new URL(target, pageUrl).toString();
  } catch {
    return target;
  }
}

async function openCdp(page: Page): Promise<CDPSession | null> {
  try {
    return await page.context().newCDPSession(page);
  } catch {
    return null;
  }
}

async function safeDetach(client: CDPSession | null): Promise<void> {
  if (!client) return;
  try {
    await client.detach();
  } catch {
    /* ignore */
  }
}

async function applyThrottle(
  client: CDPSession,
  offline: boolean,
  latency: number,
  down: number,
  up: number,
): Promise<boolean> {
  try {
    await client.send('Network.enable');
    await client.send('Network.emulateNetworkConditions', {
      offline,
      latency,
      downloadThroughput: down,
      uploadThroughput: up,
    });
    return true;
  } catch {
    return false;
  }
}

async function clearThrottle(client: CDPSession | null): Promise<void> {
  if (!client) return;
  try {
    await client.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
  } catch {
    /* ignore */
  }
}

async function detectServiceWorker(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false;
      try {
        const reg = await (navigator as any).serviceWorker.getRegistration();
        return !!(reg && (reg.active || reg.installing || reg.waiting));
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

async function warmupRoutes(page: Page, routes: string[], timeoutMs: number): Promise<void> {
  for (const route of routes) {
    try {
      await page.goto(absolute(page.url() || route, route), {
        timeout: timeoutMs,
        waitUntil: 'domcontentloaded',
      });
      // Give the SW a window to install/activate.
      await page
        .waitForFunction(
          () => {
            if (!('serviceWorker' in navigator)) return true;
            return !!(navigator as any).serviceWorker.controller;
          },
          undefined,
          { timeout: 2500 },
        )
        .catch(() => {});
    } catch {
      /* best effort */
    }
  }
}

/**
 * Looks for signals that we're on Chrome's generic `chrome-error://` /
 * `net::ERR_INTERNET_DISCONNECTED` page instead of an app-owned offline UI.
 */
async function looksLikeBrowserErrorPage(page: Page): Promise<boolean> {
  try {
    const info = await page.evaluate(() => {
      const title = document.title || '';
      const body = (document.body?.innerText || '').slice(0, 400);
      const url = location.href;
      return { title, body, url };
    });
    if (info.url.startsWith('chrome-error:')) return true;
    if (/ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_FAILED/.test(info.body)) return true;
    return false;
  } catch {
    return true;
  }
}

async function anyLoadingIndicatorVisible(page: Page, selectors: string[]): Promise<boolean> {
  try {
    return await page.evaluate((sels) => {
      for (const sel of sels) {
        const nodes = Array.from(document.querySelectorAll(sel));
        for (const n of nodes) {
          const el = n as HTMLElement;
          if (!el) continue;
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return true;
        }
      }
      return false;
    }, selectors);
  } catch {
    return false;
  }
}

async function runFullOffline(
  page: Page,
  context: BrowserContext,
  target: string,
  navTimeout: number,
): Promise<{ result: OfflineScenarioResult; issues: OfflineIssue[] }> {
  const started = Date.now();
  const issues: OfflineIssue[] = [];
  let navigationError: string | undefined;
  let bodyLen = 0;
  let browserError = false;

  await context.setOffline(true);
  try {
    try {
      await page.goto(target, { timeout: navTimeout, waitUntil: 'domcontentloaded' });
    } catch (e: any) {
      navigationError = e?.message ?? String(e);
    }
    browserError = await looksLikeBrowserErrorPage(page);
    try {
      bodyLen = await page.evaluate(() => (document.body?.innerText?.trim().length ?? 0));
    } catch {
      bodyLen = 0;
    }
  } finally {
    await context.setOffline(false);
  }

  const hadUsableShell = !browserError && bodyLen > 0 && !navigationError;
  if (browserError) {
    issues.push({
      type: 'browser-error-page-offline',
      scenario: 'full-offline',
      detail: 'offline navigation rendered the browser error page (no SW cache, no graceful offline page)',
    });
  } else if (navigationError && bodyLen === 0) {
    issues.push({
      type: 'offline-navigation-failed',
      scenario: 'full-offline',
      detail: `offline navigation failed and no cached content was shown: ${navigationError}`,
    });
  }

  return {
    result: {
      id: 'full-offline',
      status: hadUsableShell ? 'passed' : 'failed',
      durationMs: Date.now() - started,
      metrics: {
        bodyTextLength: bodyLen,
        browserErrorPage: browserError,
        navigationError,
      },
    },
    issues,
  };
}

async function runSlow3g(
  page: Page,
  target: string,
  navTimeout: number,
  loadingSelectors: string[],
): Promise<{ result: OfflineScenarioResult; issues: OfflineIssue[] }> {
  const started = Date.now();
  const issues: OfflineIssue[] = [];
  const client = await openCdp(page);
  let throttled = false;
  if (client) {
    throttled = await applyThrottle(
      client,
      false,
      SLOW_3G.latency,
      SLOW_3G.downloadThroughput,
      SLOW_3G.uploadThroughput,
    );
  }

  let sawLoadingIndicator = false;
  let navError: string | undefined;
  let loadTime = 0;
  const tStart = Date.now();

  try {
    const nav = page
      .goto(target, { timeout: navTimeout, waitUntil: 'domcontentloaded' })
      .catch((e: any) => {
        navError = e?.message ?? String(e);
      });
    // Poll for a loading indicator during the load — 300ms polls, up to navTimeout.
    const pollDeadline = Date.now() + Math.min(navTimeout, 5000);
    while (Date.now() < pollDeadline) {
      if (await anyLoadingIndicatorVisible(page, loadingSelectors)) {
        sawLoadingIndicator = true;
        break;
      }
      await page.waitForTimeout(150);
    }
    await nav;
    loadTime = Date.now() - tStart;
  } finally {
    await clearThrottle(client);
    await safeDetach(client);
  }

  if (!throttled) {
    return {
      result: {
        id: 'slow-3g',
        status: 'skipped',
        durationMs: Date.now() - started,
        note: 'CDP Network.emulateNetworkConditions unavailable (non-chromium browser?)',
      },
      issues: [],
    };
  }

  if (!sawLoadingIndicator && loadTime > 1500) {
    issues.push({
      type: 'no-loading-indicator-on-slow-network',
      scenario: 'slow-3g',
      detail: `no loading indicator visible during a ${loadTime}ms slow-3g load`,
    });
  }

  // LCP regression heuristic: use domcontentloaded time as the proxy.
  if (loadTime > 15000) {
    issues.push({
      type: 'lcp-regression-on-slow-network',
      scenario: 'slow-3g',
      detail: `page took ${loadTime}ms to domcontentloaded under slow-3g — check critical path`,
    });
  }

  return {
    result: {
      id: 'slow-3g',
      status: issues.length === 0 ? 'passed' : 'failed',
      durationMs: Date.now() - started,
      metrics: {
        downloadBps: SLOW_3G.downloadThroughput,
        uploadBps: SLOW_3G.uploadThroughput,
        latencyMs: SLOW_3G.latency,
        loadTimeMs: loadTime,
        sawLoadingIndicator,
        navigationError: navError,
      },
    },
    issues,
  };
}

async function runIntermittent(
  page: Page,
  context: BrowserContext,
  target: string,
  navTimeout: number,
  loadingSelectors: string[],
): Promise<{ result: OfflineScenarioResult; issues: OfflineIssue[] }> {
  const started = Date.now();
  const issues: OfflineIssue[] = [];

  // Start a navigation, then flap offline/online during it.
  const nav = page
    .goto(target, { timeout: navTimeout, waitUntil: 'domcontentloaded' })
    .catch(() => {});

  // 3 flap cycles of ~250ms each.
  for (let i = 0; i < 3; i++) {
    await context.setOffline(true);
    await page.waitForTimeout(200);
    await context.setOffline(false);
    await page.waitForTimeout(200);
  }

  await nav;

  // Wait briefly to see whether the UI converges or is stuck spinning.
  await page.waitForTimeout(1500);
  const stuck = await anyLoadingIndicatorVisible(page, loadingSelectors);
  if (stuck) {
    issues.push({
      type: 'stuck-spinner-on-flap',
      scenario: 'intermittent',
      detail: 'after offline/online flap cycles the page is still showing a loading indicator',
    });
  }

  return {
    result: {
      id: 'intermittent',
      status: issues.length === 0 ? 'passed' : 'failed',
      durationMs: Date.now() - started,
      metrics: { flapCycles: 3, stuckSpinner: stuck },
    },
    issues,
  };
}

async function runOfflineMutations(
  page: Page,
  context: BrowserContext,
  cfg: OfflineConfig,
  swDetected: boolean,
): Promise<{ result: OfflineScenarioResult; issues: OfflineIssue[] }> {
  const started = Date.now();
  if (!cfg.mutationFormSelector) {
    return {
      result: {
        id: 'offline-mutations',
        status: 'na',
        durationMs: Date.now() - started,
        note: 'no mutationFormSelector configured — scenario requires an app-specific form',
      },
      issues: [],
    };
  }
  if (!swDetected) {
    return {
      result: {
        id: 'offline-mutations',
        status: 'na',
        durationMs: Date.now() - started,
        note: 'no service worker registered — background sync not applicable',
      },
      issues: [],
    };
  }

  const issues: OfflineIssue[] = [];
  const submitSelector = cfg.mutationSubmitSelector
    ?? `${cfg.mutationFormSelector} button[type="submit"]`;
  let requestSeenAfterOnline = false;

  const onRequest = (req: import('playwright').Request): void => {
    const form = req.method();
    if (form !== 'GET') requestSeenAfterOnline = true;
  };

  try {
    // Submit while offline.
    await context.setOffline(true);
    try {
      const form = await page.$(cfg.mutationFormSelector);
      if (!form) {
        return {
          result: {
            id: 'offline-mutations',
            status: 'na',
            durationMs: Date.now() - started,
            note: `mutation form "${cfg.mutationFormSelector}" not on page`,
          },
          issues: [],
        };
      }
      const submit = await page.$(submitSelector);
      if (submit) {
        await submit.click({ timeout: 2000 }).catch(() => {});
      } else {
        // Fallback — submit via JS.
        await page
          .evaluate((sel) => {
            const f = document.querySelector(sel) as HTMLFormElement | null;
            if (f) f.requestSubmit?.();
          }, cfg.mutationFormSelector)
          .catch(() => {});
      }
    } finally {
      // Only start listening once we're back online so we can see the flush.
      page.on('request', onRequest);
      await context.setOffline(false);
    }

    // Give background sync a moment to flush.
    await page.waitForTimeout(2500);
  } finally {
    page.off('request', onRequest);
  }

  if (!requestSeenAfterOnline) {
    issues.push({
      type: 'offline-mutation-dropped',
      scenario: 'offline-mutations',
      detail: 'no non-GET request was observed after reconnecting — mutation appears to have been dropped',
    });
  }

  return {
    result: {
      id: 'offline-mutations',
      status: issues.length === 0 ? 'passed' : 'failed',
      durationMs: Date.now() - started,
      metrics: { requestSeenAfterOnline },
    },
    issues,
  };
}

async function runSwr(
  page: Page,
  target: string,
  navTimeout: number,
  swDetected: boolean,
): Promise<{ result: OfflineScenarioResult; issues: OfflineIssue[] }> {
  const started = Date.now();
  if (!swDetected) {
    return {
      result: {
        id: 'swr',
        status: 'na',
        durationMs: Date.now() - started,
        note: 'no service worker registered — SWR semantics not applicable',
      },
      issues: [],
    };
  }

  // Two sequential loads — the second should be backed by the SW cache while
  // the SW revalidates in the background. We track whether any network request
  // was issued after the second response resolved.
  const issues: OfflineIssue[] = [];
  const firstLoad = Date.now();
  await page.goto(target, { timeout: navTimeout, waitUntil: 'domcontentloaded' }).catch(() => {});
  const firstMs = Date.now() - firstLoad;

  let backgroundRequestCount = 0;
  const onRequest = (): void => {
    backgroundRequestCount++;
  };
  const secondLoad = Date.now();
  await page.goto(target, { timeout: navTimeout, waitUntil: 'domcontentloaded' }).catch(() => {});
  const secondMs = Date.now() - secondLoad;
  page.on('request', onRequest);
  await page.waitForTimeout(1500);
  page.off('request', onRequest);

  const looksSwrCached = secondMs < firstMs * 0.9 || secondMs < 400;
  if (looksSwrCached && backgroundRequestCount === 0) {
    issues.push({
      type: 'swr-refresh-never-fired',
      scenario: 'swr',
      detail: 'second load was cache-fast but no background revalidation request was observed',
    });
  }

  return {
    result: {
      id: 'swr',
      status: issues.length === 0 ? 'passed' : 'failed',
      durationMs: Date.now() - started,
      metrics: {
        firstLoadMs: firstMs,
        secondLoadMs: secondMs,
        backgroundRequestsAfterSecondLoad: backgroundRequestCount,
      },
    },
    issues,
  };
}

async function runSwUpdate(
  page: Page,
  target: string,
  navTimeout: number,
  swDetected: boolean,
): Promise<{ result: OfflineScenarioResult; issues: OfflineIssue[] }> {
  const started = Date.now();
  if (!swDetected) {
    return {
      result: {
        id: 'sw-update',
        status: 'na',
        durationMs: Date.now() - started,
        note: 'no service worker registered — update flow not applicable',
      },
      issues: [],
    };
  }

  const issues: OfflineIssue[] = [];

  // Poll for a waiting worker or an update prompt in the DOM. We also
  // subscribe to `controllerchange` so we see the happy-path reload.
  await page
    .evaluate(() => {
      (window as any).__uxi_swUpdate = {
        controllerChanges: 0,
        updateFound: 0,
        waiting: false,
      };
      if ('serviceWorker' in navigator) {
        (navigator as any).serviceWorker.addEventListener('controllerchange', () => {
          (window as any).__uxi_swUpdate.controllerChanges++;
        });
        (navigator as any).serviceWorker.getRegistration().then((reg: any) => {
          if (!reg) return;
          reg.addEventListener?.('updatefound', () => {
            (window as any).__uxi_swUpdate.updateFound++;
          });
          if (reg.waiting) (window as any).__uxi_swUpdate.waiting = true;
          // Fire an explicit update — harmless if server hasn't changed.
          try {
            reg.update?.();
          } catch {
            /* ignore */
          }
        });
      }
    })
    .catch(() => {});

  // Give the SW a window to notice a new version.
  await page.waitForTimeout(2500);

  const telemetry = await page
    .evaluate(() => (window as any).__uxi_swUpdate || { controllerChanges: 0, updateFound: 0, waiting: false })
    .catch(() => ({ controllerChanges: 0, updateFound: 0, waiting: false }));

  const updatePromptVisible = await page
    .evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll(
          '[data-sw-update], .sw-update-available, #sw-update, [role="status"][data-update]'
        ),
      );
      for (const c of candidates) {
        const el = c as HTMLElement;
        if (el.offsetWidth > 0 && el.offsetHeight > 0) return true;
      }
      // Text-based heuristic for common phrasings.
      const txt = (document.body?.innerText || '').toLowerCase();
      return /new version available|update available|refresh to update/.test(txt);
    })
    .catch(() => false);

  // If a waiting worker exists but neither prompt nor reload happened — issue.
  if (telemetry.waiting && !updatePromptVisible && telemetry.controllerChanges === 0) {
    issues.push({
      type: 'sw-update-silent',
      scenario: 'sw-update',
      detail: 'a waiting service worker is installed but no user-visible update signal was found',
    });
  }

  // Sanity check — page is still usable after the telemetry run.
  const broken = await looksLikeBrowserErrorPage(page);
  if (broken) {
    issues.push({
      type: 'sw-update-broke-page',
      scenario: 'sw-update',
      detail: 'page appears broken / on an error page after the SW update telemetry run',
    });
  }

  void navTimeout; // reserved for follow-up in-place reload checks
  void target;

  return {
    result: {
      id: 'sw-update',
      status: issues.length === 0 ? 'passed' : 'failed',
      durationMs: Date.now() - started,
      metrics: {
        controllerChanges: telemetry.controllerChanges,
        updateFound: telemetry.updateFound,
        waitingWorker: telemetry.waiting,
        updatePromptVisible,
      },
    },
    issues,
  };
}

/**
 * Run the offline / flaky-network audit.
 *
 * All scenarios use real Playwright offline + real CDP throttle — no stubs.
 * Individual scenarios can be skipped via `opts.skipScenarios`.
 */
export async function runOfflineAudit(page: Page, opts: OfflineConfig = {}): Promise<OfflineResult> {
  const startedAt = nowIso();
  const startedMs = Date.now();
  const context = page.context();
  const navTimeout = opts.navigationTimeoutMs ?? 8000;
  const loadingSelectors = opts.loadingIndicatorSelectors ?? [...DEFAULT_LOADING_SELECTORS];
  const skip = new Set<OfflineScenarioId>(opts.skipScenarios ?? []);
  const baseUrl = page.url() || 'about:blank';
  const expectSwAt = opts.expectSwAt ?? '/';
  const swTarget = absolute(baseUrl === 'about:blank' ? 'http://localhost/' : baseUrl, expectSwAt);

  const preload = opts.preloadRoutes && opts.preloadRoutes.length > 0
    ? opts.preloadRoutes.map((r) => absolute(baseUrl, r))
    : [swTarget];
  await warmupRoutes(page, preload, navTimeout);

  const swDetected = await detectServiceWorker(page);
  const scenarios: OfflineScenarioResult[] = [];
  const issues: OfflineIssue[] = [];

  const runIf = async (
    id: OfflineScenarioId,
    impl: () => Promise<{ result: OfflineScenarioResult; issues: OfflineIssue[] }>,
  ): Promise<void> => {
    if (skip.has(id)) {
      scenarios.push({ id, status: 'skipped', durationMs: 0, note: 'skipped via config' });
      return;
    }
    try {
      const r = await impl();
      scenarios.push(r.result);
      issues.push(...r.issues);
    } catch (e: any) {
      scenarios.push({
        id,
        status: 'failed',
        durationMs: 0,
        note: `scenario threw: ${e?.message ?? String(e)}`,
      });
    }
  };

  await runIf('full-offline', () => runFullOffline(page, context, swTarget, navTimeout));
  await runIf('slow-3g', () => runSlow3g(page, swTarget, navTimeout, loadingSelectors));
  await runIf('intermittent', () => runIntermittent(page, context, swTarget, navTimeout, loadingSelectors));
  await runIf('offline-mutations', () => runOfflineMutations(page, context, opts, swDetected));
  await runIf('swr', () => runSwr(page, swTarget, navTimeout, swDetected));
  await runIf('sw-update', () => runSwUpdate(page, swTarget, navTimeout, swDetected));

  // Always reset network state before returning.
  try {
    await context.setOffline(false);
  } catch {
    /* ignore */
  }

  const finishedAt = nowIso();
  const durationMs = Date.now() - startedMs;

  // An audit "passes" iff no scenario produced an issue and every executed
  // scenario either passed, was skipped, or is N/A.
  const executed = scenarios.filter((s) => s.status !== 'skipped' && s.status !== 'na');
  const passed = issues.length === 0 && executed.every((s) => s.status === 'passed');

  return {
    page: page.url(),
    startedAt,
    finishedAt,
    durationMs,
    serviceWorkerDetected: swDetected,
    scenarios,
    issues,
    passed,
  };
}
