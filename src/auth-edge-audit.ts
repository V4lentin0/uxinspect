import type { Page, BrowserContext, Cookie } from 'playwright';

export type AuthEdgeState = 'ok' | 'broken' | 'hung' | 'stale' | 'rotated' | 'fixed' | 'static' | 'missing' | 'skipped';

export interface AuthEdgeEvidence {
  scenario:
    | 'tokenExpiry'
    | 'refresh'
    | 'logoutCleanup'
    | 'sessionFixation'
    | 'csrf';
  severity: 'info' | 'warn' | 'fail';
  detail: string;
  data?: Record<string, unknown>;
}

export interface AuthEdgeResult {
  tokenExpiry: AuthEdgeState;
  refresh: AuthEdgeState;
  logoutCleanup: AuthEdgeState;
  sessionFixation: AuthEdgeState;
  csrf: AuthEdgeState;
  evidence: AuthEdgeEvidence[];
  passed: boolean;
}

export interface AuthEdgeOptions {
  storageStatePath: string;
  loginUrl: string;
  protectedUrl: string;
  logoutUrl?: string;
  csrfTokenSelector?: string;
  refreshUrlPattern?: string | RegExp;
  sessionCookieName?: string;
  loginCredentials?: { usernameSelector: string; username: string; passwordSelector: string; password: string; submitSelector: string };
  actionSelector?: string;
  timeoutMs?: number;
}

const DEFAULT_SESSION_COOKIE_NAMES = [
  'sessionid',
  'session',
  'session_id',
  'sid',
  'connect.sid',
  'PHPSESSID',
  'JSESSIONID',
  'ASP.NET_SessionId',
  'laravel_session',
];

const DEFAULT_REFRESH_PATTERN = /\/(auth|api)\/(refresh|token\/refresh|refresh[-_]?token)/i;

const DEFAULT_TIMEOUT_MS = 15_000;

function pickSessionCookie(cookies: Cookie[], preferredName?: string): Cookie | undefined {
  if (preferredName) {
    const match = cookies.find((c) => c.name === preferredName);
    if (match) return match;
  }
  for (const name of DEFAULT_SESSION_COOKIE_NAMES) {
    const match = cookies.find((c) => c.name === name);
    if (match) return match;
  }
  // Fallback: any httpOnly cookie (most likely session-carrying)
  return cookies.find((c) => c.httpOnly === true);
}

function redactCookieValue(raw: string): string {
  if (raw.length <= 8) return '***';
  return `${raw.slice(0, 4)}...${raw.slice(-4)}`;
}

async function expireAllCookies(ctx: BrowserContext): Promise<void> {
  const cookies = await ctx.cookies();
  await ctx.clearCookies();
  const expired = cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: 0,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: (c.sameSite === 'Strict' || c.sameSite === 'Lax' || c.sameSite === 'None' ? c.sameSite : 'Lax') as 'Strict' | 'Lax' | 'None',
  }));
  if (expired.length > 0) {
    await ctx.addCookies(expired);
  }
}

async function safeGoto(page: Page, url: string, timeoutMs: number): Promise<{ status: number; finalUrl: string; ok: boolean }> {
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    return {
      status: response?.status() ?? 0,
      finalUrl: page.url(),
      ok: response?.ok() ?? false,
    };
  } catch {
    return { status: 0, finalUrl: page.url(), ok: false };
  }
}

function urlLooksLikeLogin(url: string, loginUrl: string): boolean {
  try {
    const target = new URL(loginUrl);
    const current = new URL(url);
    if (current.pathname === target.pathname) return true;
    if (/\b(login|signin|auth)\b/i.test(current.pathname)) return true;
    return false;
  } catch {
    return /login|signin|auth/i.test(url);
  }
}

async function readCsrfToken(page: Page, selector: string): Promise<string | null> {
  try {
    const handle = await page.$(selector);
    if (!handle) return null;
    // Try value (input), content (meta), textContent (custom)
    const value = await handle.evaluate((el: Element) => {
      if (el instanceof HTMLInputElement) return el.value;
      if (el instanceof HTMLMetaElement) return el.content;
      return (el as HTMLElement).getAttribute('content') ?? (el as HTMLElement).getAttribute('value') ?? el.textContent ?? '';
    });
    const trimmed = (value ?? '').trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

async function checkTokenExpiry(
  page: Page,
  opts: AuthEdgeOptions,
  evidence: AuthEdgeEvidence[]
): Promise<AuthEdgeState> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ctx = page.context();
  await expireAllCookies(ctx);
  const result = await safeGoto(page, opts.protectedUrl, timeoutMs);
  const redirectedToLogin = urlLooksLikeLogin(result.finalUrl, opts.loginUrl);
  const rejected = result.status === 401 || result.status === 403 || redirectedToLogin;
  if (rejected) {
    evidence.push({
      scenario: 'tokenExpiry',
      severity: 'info',
      detail: `Expired auth cookies correctly blocked access to ${opts.protectedUrl}`,
      data: { status: result.status, finalUrl: result.finalUrl, redirectedToLogin },
    });
    return 'ok';
  }
  evidence.push({
    scenario: 'tokenExpiry',
    severity: 'fail',
    detail: `Protected URL still accessible after expiring auth cookies (status ${result.status})`,
    data: { status: result.status, finalUrl: result.finalUrl },
  });
  return 'broken';
}

async function checkRefresh(
  page: Page,
  opts: AuthEdgeOptions,
  evidence: AuthEdgeEvidence[]
): Promise<AuthEdgeState> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pattern = opts.refreshUrlPattern ?? DEFAULT_REFRESH_PATTERN;
  const matcher = (url: string): boolean => (pattern instanceof RegExp ? pattern.test(url) : url.includes(String(pattern)));
  let interceptCount = 0;
  const routeHandler = async (route: import('playwright').Route) => {
    const url = route.request().url();
    if (matcher(url)) {
      interceptCount += 1;
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'refresh_failed', message: 'forced failure' }),
      });
      return;
    }
    await route.continue();
  };
  await page.route('**/*', routeHandler);
  let state: AuthEdgeState = 'ok';
  try {
    const navResult = await safeGoto(page, opts.protectedUrl, timeoutMs);
    if (opts.actionSelector) {
      try {
        await page.click(opts.actionSelector, { timeout: Math.min(timeoutMs, 5_000) });
      } catch {
        // Click failure is fine — we care about the app response
      }
    }
    // Give the app a moment to attempt a refresh
    await page.waitForTimeout(500);
    const finalUrl = page.url();
    const redirectedToLogin = urlLooksLikeLogin(finalUrl, opts.loginUrl);
    const stillAuthed = !redirectedToLogin && navResult.status !== 0 && navResult.status < 400;
    if (interceptCount === 0) {
      evidence.push({
        scenario: 'refresh',
        severity: 'info',
        detail: 'No refresh-token requests observed during the session',
        data: { pattern: String(pattern) },
      });
      state = 'skipped';
    } else if (redirectedToLogin) {
      evidence.push({
        scenario: 'refresh',
        severity: 'info',
        detail: `App gracefully redirected to login after ${interceptCount} failed refresh attempt(s)`,
        data: { interceptCount, finalUrl },
      });
      state = 'ok';
    } else if (stillAuthed) {
      evidence.push({
        scenario: 'refresh',
        severity: 'fail',
        detail: 'Refresh token endpoint failed but user kept apparent access — broken state',
        data: { interceptCount, finalUrl, status: navResult.status },
      });
      state = 'broken';
    } else {
      evidence.push({
        scenario: 'refresh',
        severity: 'warn',
        detail: 'Refresh token failed and user was left on a non-login state',
        data: { interceptCount, finalUrl, status: navResult.status },
      });
      state = 'hung';
    }
  } finally {
    await page.unroute('**/*', routeHandler).catch(() => {});
  }
  return state;
}

async function checkLogoutCleanup(
  page: Page,
  opts: AuthEdgeOptions,
  evidence: AuthEdgeEvidence[]
): Promise<AuthEdgeState> {
  if (!opts.logoutUrl) {
    evidence.push({
      scenario: 'logoutCleanup',
      severity: 'info',
      detail: 'No logoutUrl provided — skipping logout cleanup check',
    });
    return 'skipped';
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  await safeGoto(page, opts.logoutUrl, timeoutMs);
  // Simulate back-button navigation to the protected URL
  const result = await safeGoto(page, opts.protectedUrl, timeoutMs);
  const redirectedToLogin = urlLooksLikeLogin(result.finalUrl, opts.loginUrl);
  const rejected = result.status === 401 || result.status === 403 || redirectedToLogin;
  if (rejected) {
    evidence.push({
      scenario: 'logoutCleanup',
      severity: 'info',
      detail: 'After logout, protected URL was correctly unreachable',
      data: { status: result.status, finalUrl: result.finalUrl },
    });
    return 'ok';
  }
  evidence.push({
    scenario: 'logoutCleanup',
    severity: 'fail',
    detail: 'Protected URL still accessible after logout (stale session)',
    data: { status: result.status, finalUrl: result.finalUrl },
  });
  return 'stale';
}

async function checkSessionFixation(
  page: Page,
  opts: AuthEdgeOptions,
  evidence: AuthEdgeEvidence[]
): Promise<AuthEdgeState> {
  if (!opts.loginCredentials) {
    evidence.push({
      scenario: 'sessionFixation',
      severity: 'info',
      detail: 'No loginCredentials provided — cannot exercise login boundary for session-fixation test',
    });
    return 'skipped';
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ctx = page.context();
  await ctx.clearCookies();
  await safeGoto(page, opts.loginUrl, timeoutMs);
  const preLoginCookies = await ctx.cookies();
  const preSession = pickSessionCookie(preLoginCookies, opts.sessionCookieName);
  try {
    const creds = opts.loginCredentials;
    await page.fill(creds.usernameSelector, creds.username).catch(() => {});
    await page.fill(creds.passwordSelector, creds.password).catch(() => {});
    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => {}),
      page.click(creds.submitSelector).catch(() => {}),
    ]);
  } catch {
    // Proceed to inspect anyway
  }
  const postLoginCookies = await ctx.cookies();
  const postSession = pickSessionCookie(postLoginCookies, opts.sessionCookieName);
  if (!preSession || !postSession) {
    evidence.push({
      scenario: 'sessionFixation',
      severity: 'info',
      detail: 'Could not locate a session cookie before/after login — skipping fixation comparison',
      data: { preCookieNames: preLoginCookies.map((c) => c.name), postCookieNames: postLoginCookies.map((c) => c.name) },
    });
    return 'skipped';
  }
  if (preSession.value === postSession.value && preSession.name === postSession.name) {
    evidence.push({
      scenario: 'sessionFixation',
      severity: 'fail',
      detail: `Session cookie "${preSession.name}" value did not change across login boundary (session fixation)`,
      data: { cookieName: preSession.name, value: redactCookieValue(preSession.value) },
    });
    return 'fixed';
  }
  evidence.push({
    scenario: 'sessionFixation',
    severity: 'info',
    detail: `Session cookie "${postSession.name}" rotated on login`,
    data: {
      before: redactCookieValue(preSession.value),
      after: redactCookieValue(postSession.value),
    },
  });
  return 'rotated';
}

async function checkCsrfRotation(
  page: Page,
  opts: AuthEdgeOptions,
  evidence: AuthEdgeEvidence[]
): Promise<AuthEdgeState> {
  if (!opts.csrfTokenSelector) {
    evidence.push({
      scenario: 'csrf',
      severity: 'info',
      detail: 'No csrfTokenSelector provided — skipping CSRF rotation check',
    });
    return 'skipped';
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  await safeGoto(page, opts.protectedUrl, timeoutMs);
  const first = await readCsrfToken(page, opts.csrfTokenSelector);
  if (!first) {
    evidence.push({
      scenario: 'csrf',
      severity: 'warn',
      detail: `CSRF token selector "${opts.csrfTokenSelector}" matched no element or empty value`,
    });
    return 'missing';
  }
  if (opts.actionSelector) {
    try {
      await page.click(opts.actionSelector, { timeout: Math.min(timeoutMs, 5_000) });
    } catch {
      // Fall through to reload
    }
  }
  // Re-navigate to force a fresh token issuance
  await safeGoto(page, opts.protectedUrl, timeoutMs);
  const second = await readCsrfToken(page, opts.csrfTokenSelector);
  if (!second) {
    evidence.push({
      scenario: 'csrf',
      severity: 'warn',
      detail: 'CSRF token disappeared after an action',
    });
    return 'missing';
  }
  if (first === second) {
    evidence.push({
      scenario: 'csrf',
      severity: 'fail',
      detail: 'CSRF token did not rotate between actions',
      data: { token: redactCookieValue(first) },
    });
    return 'static';
  }
  evidence.push({
    scenario: 'csrf',
    severity: 'info',
    detail: 'CSRF token rotated between actions',
    data: { before: redactCookieValue(first), after: redactCookieValue(second) },
  });
  return 'rotated';
}

function overallPassed(result: Omit<AuthEdgeResult, 'passed'>): boolean {
  if (result.tokenExpiry === 'broken') return false;
  if (result.refresh === 'broken') return false;
  if (result.logoutCleanup === 'stale') return false;
  if (result.sessionFixation === 'fixed') return false;
  if (result.csrf === 'static') return false;
  return true;
}

export async function auditAuthEdge(
  page: Page,
  opts: AuthEdgeOptions
): Promise<AuthEdgeResult> {
  const evidence: AuthEdgeEvidence[] = [];
  const ctx = page.context();

  async function reloadStorageState(): Promise<void> {
    try {
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(opts.storageStatePath, 'utf8');
      const parsed = JSON.parse(raw) as { cookies?: Cookie[]; origins?: { origin: string; localStorage?: { name: string; value: string }[] }[] };
      await ctx.clearCookies();
      if (Array.isArray(parsed.cookies) && parsed.cookies.length > 0) {
        await ctx.addCookies(
          parsed.cookies.map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            expires: c.expires,
            httpOnly: c.httpOnly,
            secure: c.secure,
            sameSite: (c.sameSite === 'Strict' || c.sameSite === 'Lax' || c.sameSite === 'None' ? c.sameSite : 'Lax') as 'Strict' | 'Lax' | 'None',
          }))
        );
      }
    } catch (e) {
      evidence.push({
        scenario: 'tokenExpiry',
        severity: 'warn',
        detail: `Could not reload storageState from ${opts.storageStatePath}: ${(e as Error).message}`,
      });
    }
  }

  await reloadStorageState();
  const tokenExpiry = await checkTokenExpiry(page, opts, evidence).catch((e) => {
    evidence.push({ scenario: 'tokenExpiry', severity: 'warn', detail: `tokenExpiry check errored: ${(e as Error).message}` });
    return 'skipped' as AuthEdgeState;
  });

  await reloadStorageState();
  const refresh = await checkRefresh(page, opts, evidence).catch((e) => {
    evidence.push({ scenario: 'refresh', severity: 'warn', detail: `refresh check errored: ${(e as Error).message}` });
    return 'skipped' as AuthEdgeState;
  });

  await reloadStorageState();
  const logoutCleanup = await checkLogoutCleanup(page, opts, evidence).catch((e) => {
    evidence.push({ scenario: 'logoutCleanup', severity: 'warn', detail: `logoutCleanup check errored: ${(e as Error).message}` });
    return 'skipped' as AuthEdgeState;
  });

  const sessionFixation = await checkSessionFixation(page, opts, evidence).catch((e) => {
    evidence.push({ scenario: 'sessionFixation', severity: 'warn', detail: `sessionFixation check errored: ${(e as Error).message}` });
    return 'skipped' as AuthEdgeState;
  });

  await reloadStorageState();
  const csrf = await checkCsrfRotation(page, opts, evidence).catch((e) => {
    evidence.push({ scenario: 'csrf', severity: 'warn', detail: `csrf check errored: ${(e as Error).message}` });
    return 'skipped' as AuthEdgeState;
  });

  const partial = { tokenExpiry, refresh, logoutCleanup, sessionFixation, csrf, evidence };
  return { ...partial, passed: overallPassed(partial) };
}
