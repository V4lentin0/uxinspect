import type { Page, Browser, BrowserContext } from 'playwright';
import { chromium } from 'playwright';

export interface ConcurrencyAction {
  action: (page: Page) => Promise<void>;
  expectedAfter?: (page: Page) => Promise<boolean>;
}

export interface ConcurrencyActions {
  conflictingSave?: {
    editA: (page: Page) => Promise<void>;
    editB: (page: Page) => Promise<void>;
    saveA: (page: Page) => Promise<void>;
    saveB: (page: Page) => Promise<void>;
    warningDetector?: (page: Page) => Promise<boolean>;
  };
  crossTabLogout?: {
    logout: (page: Page) => Promise<void>;
    authedAction: (page: Page) => Promise<void>;
    actionSucceeded?: (page: Page) => Promise<boolean>;
  };
  sessionSwap?: {
    loginOther: (page: Page) => Promise<void>;
    probeIdentity: (page: Page) => Promise<string | null>;
  };
}

export interface ConcurrencyAuditOptions {
  url: string;
  storageStatePath?: string;
  actions?: ConcurrencyActions;
  /** Back-compat with signature described in spec. */
  conflictingActions?: Array<{
    action: (page: Page) => Promise<void>;
    expectedAfter?: (page: Page) => Promise<boolean>;
  }>;
  navTimeoutMs?: number;
}

export interface ConcurrencyEvidence {
  test: 'conflicting-saves' | 'cross-tab-logout' | 'session-swap';
  detail: string;
}

export interface ConcurrencyResult {
  url: string;
  silentOverwrite: boolean;
  crossTabLogoutBroken: boolean;
  sessionSyncBroken: boolean;
  ranConflictingSaves: boolean;
  ranCrossTabLogout: boolean;
  ranSessionSwap: boolean;
  evidence: ConcurrencyEvidence[];
  passed: boolean;
}

const DEFAULT_NAV_TIMEOUT_MS = 15_000;

async function closeQuietly(target: Page | BrowserContext | Browser | null): Promise<void> {
  if (!target) return;
  try {
    await target.close();
  } catch {
    /* ignore */
  }
}

async function openTwoContexts(
  browser: Browser,
  storageStatePath: string | undefined,
  url: string,
  navTimeoutMs: number,
): Promise<{ ctxA: BrowserContext; ctxB: BrowserContext; pageA: Page; pageB: Page }> {
  const ctxOpts = storageStatePath ? { storageState: storageStatePath } : undefined;
  const ctxA = await browser.newContext(ctxOpts);
  const ctxB = await browser.newContext(ctxOpts);
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await Promise.all([
    pageA.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs }).catch(() => null),
    pageB.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs }).catch(() => null),
  ]);
  return { ctxA, ctxB, pageA, pageB };
}

async function runConflictingSaves(
  browser: Browser,
  opts: ConcurrencyAuditOptions,
  spec: NonNullable<ConcurrencyActions['conflictingSave']>,
): Promise<{ silentOverwrite: boolean; evidence: ConcurrencyEvidence[] }> {
  const evidence: ConcurrencyEvidence[] = [];
  const navTimeout = opts.navTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS;
  const { ctxA, ctxB, pageA, pageB } = await openTwoContexts(
    browser,
    opts.storageStatePath,
    opts.url,
    navTimeout,
  );

  let silentOverwrite = false;
  try {
    await spec.editA(pageA);
    await spec.editB(pageB);
    await spec.saveA(pageA);
    await spec.saveB(pageB);

    let warned = false;
    if (spec.warningDetector) {
      try {
        warned = await spec.warningDetector(pageB);
      } catch (err) {
        evidence.push({
          test: 'conflicting-saves',
          detail: `warningDetector threw: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    if (!warned) {
      silentOverwrite = true;
      evidence.push({
        test: 'conflicting-saves',
        detail: spec.warningDetector
          ? 'both tabs saved same field but no stale-write warning surfaced in tab B'
          : 'no warningDetector provided — assuming silent overwrite because no signal of conflict detection',
      });
    } else {
      evidence.push({
        test: 'conflicting-saves',
        detail: 'tab B surfaced a stale-write warning as expected',
      });
    }
  } catch (err) {
    evidence.push({
      test: 'conflicting-saves',
      detail: `exception while exercising conflicting saves: ${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    await closeQuietly(pageA);
    await closeQuietly(pageB);
    await closeQuietly(ctxA);
    await closeQuietly(ctxB);
  }

  return { silentOverwrite, evidence };
}

async function runCrossTabLogout(
  browser: Browser,
  opts: ConcurrencyAuditOptions,
  spec: NonNullable<ConcurrencyActions['crossTabLogout']>,
): Promise<{ crossTabLogoutBroken: boolean; evidence: ConcurrencyEvidence[] }> {
  const evidence: ConcurrencyEvidence[] = [];
  const navTimeout = opts.navTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS;
  const { ctxA, ctxB, pageA, pageB } = await openTwoContexts(
    browser,
    opts.storageStatePath,
    opts.url,
    navTimeout,
  );

  let crossTabLogoutBroken = false;
  try {
    await spec.logout(pageA);
    await spec.authedAction(pageB);

    let succeeded = true;
    if (spec.actionSucceeded) {
      try {
        succeeded = await spec.actionSucceeded(pageB);
      } catch (err) {
        evidence.push({
          test: 'cross-tab-logout',
          detail: `actionSucceeded threw (treated as degraded auth): ${err instanceof Error ? err.message : String(err)}`,
        });
        succeeded = false;
      }
    }

    if (succeeded) {
      crossTabLogoutBroken = true;
      evidence.push({
        test: 'cross-tab-logout',
        detail: 'tab B performed an authenticated action after tab A logged out — session not revoked',
      });
    } else {
      evidence.push({
        test: 'cross-tab-logout',
        detail: 'tab B was rejected / redirected after tab A logout as expected',
      });
    }
  } catch (err) {
    evidence.push({
      test: 'cross-tab-logout',
      detail: `tab B threw while attempting authed action (treated as graceful): ${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    await closeQuietly(pageA);
    await closeQuietly(pageB);
    await closeQuietly(ctxA);
    await closeQuietly(ctxB);
  }

  return { crossTabLogoutBroken, evidence };
}

async function runSessionSwap(
  browser: Browser,
  opts: ConcurrencyAuditOptions,
  spec: NonNullable<ConcurrencyActions['sessionSwap']>,
): Promise<{ sessionSyncBroken: boolean; evidence: ConcurrencyEvidence[] }> {
  const evidence: ConcurrencyEvidence[] = [];
  const navTimeout = opts.navTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS;
  // For session swap, we intentionally share storage so tab B should pick up tab A's new session.
  const ctxOpts = opts.storageStatePath ? { storageState: opts.storageStatePath } : undefined;
  const ctx = await browser.newContext(ctxOpts);
  const pageA = await ctx.newPage();
  const pageB = await ctx.newPage();
  await Promise.all([
    pageA.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: navTimeout }).catch(() => null),
    pageB.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: navTimeout }).catch(() => null),
  ]);

  let sessionSyncBroken = false;
  try {
    const before = await spec.probeIdentity(pageB).catch(() => null);
    await spec.loginOther(pageA);
    // Force a fresh read in tab B.
    await pageB.reload({ waitUntil: 'domcontentloaded', timeout: navTimeout }).catch(() => null);
    const after = await spec.probeIdentity(pageB).catch(() => null);

    if (before !== null && after !== null && before === after) {
      sessionSyncBroken = true;
      evidence.push({
        test: 'session-swap',
        detail: `tab B still reports identity "${before}" after tab A logged in as a different account`,
      });
    } else {
      evidence.push({
        test: 'session-swap',
        detail: `tab B identity moved from "${before ?? 'null'}" to "${after ?? 'null'}" after session swap`,
      });
    }
  } catch (err) {
    evidence.push({
      test: 'session-swap',
      detail: `exception during session swap probe: ${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    await closeQuietly(pageA);
    await closeQuietly(pageB);
    await closeQuietly(ctx);
  }

  return { sessionSyncBroken, evidence };
}

async function runFallbackConflictingActions(
  browser: Browser,
  opts: ConcurrencyAuditOptions,
  actions: NonNullable<ConcurrencyAuditOptions['conflictingActions']>,
): Promise<{ silentOverwrite: boolean; evidence: ConcurrencyEvidence[] }> {
  const evidence: ConcurrencyEvidence[] = [];
  if (actions.length === 0) return { silentOverwrite: false, evidence };

  const navTimeout = opts.navTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS;
  const { ctxA, ctxB, pageA, pageB } = await openTwoContexts(
    browser,
    opts.storageStatePath,
    opts.url,
    navTimeout,
  );

  let silentOverwrite = false;
  try {
    const first = actions[0];
    const second = actions[1] ?? actions[0];
    if (!first || !second) {
      return { silentOverwrite: false, evidence };
    }

    await first.action(pageA);
    await second.action(pageB);

    let aOk = true;
    let bOk = true;
    if (first.expectedAfter) {
      try {
        aOk = await first.expectedAfter(pageA);
      } catch {
        aOk = false;
      }
    }
    if (second.expectedAfter) {
      try {
        bOk = await second.expectedAfter(pageB);
      } catch {
        bOk = false;
      }
    }

    if (!aOk && bOk) {
      silentOverwrite = true;
      evidence.push({
        test: 'conflicting-saves',
        detail: 'tab A expected post-state was violated after tab B acted on the same record (silent overwrite)',
      });
    } else {
      evidence.push({
        test: 'conflicting-saves',
        detail: `both tabs reported expected post-state (A=${aOk}, B=${bOk})`,
      });
    }
  } catch (err) {
    evidence.push({
      test: 'conflicting-saves',
      detail: `exception in fallback conflictingActions flow: ${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    await closeQuietly(pageA);
    await closeQuietly(pageB);
    await closeQuietly(ctxA);
    await closeQuietly(ctxB);
  }

  return { silentOverwrite, evidence };
}

export async function auditConcurrency(
  browserOrPage: Page | Browser,
  opts: ConcurrencyAuditOptions,
): Promise<ConcurrencyResult> {
  let ownsBrowser = false;
  let browser: Browser;
  if ('newContext' in browserOrPage) {
    browser = browserOrPage as Browser;
  } else {
    const page = browserOrPage as Page;
    const candidate = page.context().browser();
    if (candidate) {
      browser = candidate;
    } else {
      browser = await chromium.launch({ headless: true });
      ownsBrowser = true;
    }
  }

  const result: ConcurrencyResult = {
    url: opts.url,
    silentOverwrite: false,
    crossTabLogoutBroken: false,
    sessionSyncBroken: false,
    ranConflictingSaves: false,
    ranCrossTabLogout: false,
    ranSessionSwap: false,
    evidence: [],
    passed: true,
  };

  try {
    if (opts.actions?.conflictingSave) {
      result.ranConflictingSaves = true;
      const r = await runConflictingSaves(browser, opts, opts.actions.conflictingSave);
      result.silentOverwrite = r.silentOverwrite;
      for (const e of r.evidence) result.evidence.push(e);
    } else if (opts.conflictingActions && opts.conflictingActions.length > 0) {
      result.ranConflictingSaves = true;
      const r = await runFallbackConflictingActions(browser, opts, opts.conflictingActions);
      result.silentOverwrite = r.silentOverwrite;
      for (const e of r.evidence) result.evidence.push(e);
    }

    if (opts.actions?.crossTabLogout) {
      result.ranCrossTabLogout = true;
      const r = await runCrossTabLogout(browser, opts, opts.actions.crossTabLogout);
      result.crossTabLogoutBroken = r.crossTabLogoutBroken;
      for (const e of r.evidence) result.evidence.push(e);
    }

    if (opts.actions?.sessionSwap) {
      result.ranSessionSwap = true;
      const r = await runSessionSwap(browser, opts, opts.actions.sessionSwap);
      result.sessionSyncBroken = r.sessionSyncBroken;
      for (const e of r.evidence) result.evidence.push(e);
    }
  } finally {
    if (ownsBrowser) await closeQuietly(browser);
  }

  result.passed =
    !result.silentOverwrite && !result.crossTabLogoutBroken && !result.sessionSyncBroken;
  return result;
}
