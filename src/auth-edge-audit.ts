import type { Page, BrowserContext, Cookie } from 'playwright';

/**
 * P4 #39 — Auth-edge audit.
 *
 * Simulates the nasty corners of session lifecycle that bite in production:
 * expired access tokens, refresh flows, logout cleanup, session fixation,
 * CSRF token rotation, and concurrent logout across tabs.
 *
 * These scenarios run against a real running app using the shared Playwright
 * BrowserContext — no mocks, no intercepted responses. Each scenario mutates
 * real storage (cookies, localStorage, sessionStorage) and observes the
 * network + response status to decide pass/fail.
 */

export type AuthEdgeScenario =
  | 'expired'
  | 'refresh'
  | 'logout'
  | 'fixation'
  | 'csrf'
  | 'concurrent';

export interface AuthEdgeConfig {
  /** Full URL of the login page. Used to navigate for sign-in + to check redirects. */
  loginUrl: string;
  /**
   * Selector for the logout button / link. Required for `logout` and
   * `concurrent` scenarios. If omitted, both scenarios are skipped.
   */
  logoutSelector?: string;
  /**
   * Full URL of a route that requires authentication. The audit hits this
   * after manipulating state and inspects the response status.
   */
  gatedRoute: string;
  /**
   * Known storage keys that carry auth material (access / refresh tokens, etc.).
   * Defaults cover the common industry names (access_token, id_token, refreshToken,
   * Authorization, jwt, session, auth).
   */
  authStorageKeys?: string[];
  /** Header the app expects for CSRF. Defaults to `X-CSRF-Token`. */
  csrfHeaderName?: string;
  /**
   * URL pattern (string or RegExp) for the refresh endpoint. Defaults to any
   * path containing `/refresh` or `/token`.
   */
  refreshEndpoint?: string | RegExp;
  /**
   * Optional page-side login helper. Given a fresh `Page`, it must perform a
   * full sign-in and leave the app in an authenticated state. If not provided,
   * the audit reuses the existing `page`'s storage state (assumes the caller
   * already logged in).
   */
  performLogin?: (page: Page) => Promise<void>;
  /** Scenarios to explicitly skip. */
  skipScenarios?: AuthEdgeScenario[];
  /** Per-request network timeout in ms. Defaults to 15000. */
  requestTimeoutMs?: number;
}

export type AuthEdgeIssueKind =
  | 'expired-token-silent-failure'
  | 'expired-token-no-redirect'
  | 'refresh-not-triggered'
  | 'refresh-failed'
  | 'refresh-token-not-rotated'
  | 'logout-storage-not-cleared'
  | 'logout-refresh-not-revoked'
  | 'session-fixation'
  | 'csrf-token-static'
  | 'csrf-token-reuse-across-sessions'
  | 'concurrent-logout-still-valid'
  | 'scenario-error';

export interface AuthEdgeIssue {
  scenario: AuthEdgeScenario;
  kind: AuthEdgeIssueKind;
  severity: 'high' | 'medium' | 'low';
  detail: string;
}

export interface AuthEdgeScenarioResult {
  scenario: AuthEdgeScenario;
  ran: boolean;
  passed: boolean;
  durationMs: number;
  observations: Record<string, unknown>;
  issues: AuthEdgeIssue[];
  error?: string;
}

export interface AuthEdgeResult {
  page: string;
  scenarios: AuthEdgeScenarioResult[];
  issues: AuthEdgeIssue[];
  passed: boolean;
}

const DEFAULT_AUTH_STORAGE_KEYS = [
  'access_token',
  'accessToken',
  'id_token',
  'idToken',
  'refresh_token',
  'refreshToken',
  'Authorization',
  'authorization',
  'jwt',
  'token',
  'session',
  'auth',
];

const DEFAULT_CSRF_HEADER = 'X-CSRF-Token';
const DEFAULT_REQUEST_TIMEOUT = 15_000;
const DEFAULT_REFRESH_PATTERN = /\/(refresh|token|oauth\/token|auth\/refresh)(\b|\?|$)/i;
const AUTH_COOKIE_PATTERN = /(session|sid|auth|token|jwt|csrf|xsrf)/i;

function nowMs(): number {
  return Date.now();
}

function matchesUrlPattern(url: string, pattern: string | RegExp): boolean {
  if (pattern instanceof RegExp) return pattern.test(url);
  if (pattern.startsWith('regex:')) return new RegExp(pattern.slice(6)).test(url);
  return url.includes(pattern);
}

async function readStorage(page: Page): Promise<{
  local: Record<string, string>;
  session: Record<string, string>;
}> {
  return page
    .evaluate(() => {
      const dump = (s: Storage): Record<string, string> => {
        const out: Record<string, string> = {};
        for (let i = 0; i < s.length; i++) {
          const key = s.key(i);
          if (key !== null) out[key] = s.getItem(key) ?? '';
        }
        return out;
      };
      return { local: dump(localStorage), session: dump(sessionStorage) };
    })
    .catch(() => ({ local: {}, session: {} }));
}

function findAuthStorageValues(
  storage: { local: Record<string, string>; session: Record<string, string> },
  keys: string[],
): { key: string; value: string; scope: 'local' | 'session' }[] {
  const hits: { key: string; value: string; scope: 'local' | 'session' }[] = [];
  for (const [k, v] of Object.entries(storage.local)) {
    if (keys.some((ak) => k.toLowerCase().includes(ak.toLowerCase())) && v) {
      hits.push({ key: k, value: v, scope: 'local' });
    }
  }
  for (const [k, v] of Object.entries(storage.session)) {
    if (keys.some((ak) => k.toLowerCase().includes(ak.toLowerCase())) && v) {
      hits.push({ key: k, value: v, scope: 'session' });
    }
  }
  return hits;
}

function findAuthCookies(cookies: Cookie[]): Cookie[] {
  return cookies.filter((c) => AUTH_COOKIE_PATTERN.test(c.name));
}

function corruptTokenValue(value: string): string {
  // If the token looks like a JWT (three dot-separated segments), corrupt the
  // signature to make it invalid. Otherwise, flip the last characters.
  const parts = value.split('.');
  if (parts.length === 3) {
    return `${parts[0]}.${parts[1]}.corrupted`;
  }
  if (value.length <= 4) return 'x'.repeat(value.length);
  return `${value.slice(0, -4)}XXXX`;
}

async function writeStorageKey(
  page: Page,
  scope: 'local' | 'session',
  key: string,
  value: string,
): Promise<void> {
  await page
    .evaluate(
      ({ scope, key, value }) => {
        const s = scope === 'local' ? localStorage : sessionStorage;
        s.setItem(key, value);
      },
      { scope, key, value },
    )
    .catch(() => {});
}

async function fetchStatus(
  page: Page,
  url: string,
  extraHeaders: Record<string, string> = {},
  timeoutMs = DEFAULT_REQUEST_TIMEOUT,
  method: 'GET' | 'POST' = 'GET',
): Promise<{ status: number; url: string; redirected: boolean }> {
  const result = await page.evaluate(
    async ({ url, headers, timeoutMs, method }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method,
          credentials: 'include',
          headers,
          redirect: 'manual',
          signal: controller.signal,
          body: method === 'POST' ? '{}' : undefined,
        });
        return {
          status: res.status,
          url: res.url || url,
          redirected: res.status >= 300 && res.status < 400,
        };
      } catch (err) {
        return { status: 0, url, redirected: false, error: String(err) };
      } finally {
        clearTimeout(timer);
      }
    },
    { url, headers: extraHeaders, timeoutMs, method },
  );
  return result as { status: number; url: string; redirected: boolean };
}

async function navigateToGatedRoute(
  page: Page,
  url: string,
  timeoutMs: number,
): Promise<{ finalUrl: string; status: number | null }> {
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    return { finalUrl: page.url(), status: resp?.status() ?? null };
  } catch {
    return { finalUrl: page.url(), status: null };
  }
}

async function clearAuthFromStorage(
  page: Page,
  ctx: BrowserContext,
  keys: string[],
): Promise<void> {
  await page
    .evaluate((keys) => {
      for (const k of Object.keys(localStorage)) {
        if (keys.some((ak: string) => k.toLowerCase().includes(ak.toLowerCase()))) {
          localStorage.removeItem(k);
        }
      }
      for (const k of Object.keys(sessionStorage)) {
        if (keys.some((ak: string) => k.toLowerCase().includes(ak.toLowerCase()))) {
          sessionStorage.removeItem(k);
        }
      }
    }, keys)
    .catch(() => {});
  await ctx.clearCookies().catch(() => {});
}

async function doLogin(page: Page, cfg: AuthEdgeConfig): Promise<void> {
  if (cfg.performLogin) {
    await page.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await cfg.performLogin(page);
  }
  // If performLogin is not supplied, we assume the caller supplied a page
  // that is already authenticated via stored credentials / storageState.
}

// ─────────────────────────────────────────────────────────────────────────────
//  Scenario runners
// ─────────────────────────────────────────────────────────────────────────────

async function runExpiredTokenScenario(
  page: Page,
  ctx: BrowserContext,
  cfg: AuthEdgeConfig,
): Promise<AuthEdgeScenarioResult> {
  const started = nowMs();
  const issues: AuthEdgeIssue[] = [];
  const keys = cfg.authStorageKeys ?? DEFAULT_AUTH_STORAGE_KEYS;
  const timeout = cfg.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT;
  const observations: Record<string, unknown> = {};

  try {
    await doLogin(page, cfg);

    // Snapshot auth material.
    const preStorage = await readStorage(page);
    const preTokens = findAuthStorageValues(preStorage, keys);
    const preCookies = findAuthCookies(await ctx.cookies());
    observations.preTokenCount = preTokens.length;
    observations.preAuthCookieCount = preCookies.length;

    if (preTokens.length === 0 && preCookies.length === 0) {
      // Nothing to corrupt — cannot test the scenario meaningfully.
      return {
        scenario: 'expired',
        ran: true,
        passed: false,
        durationMs: nowMs() - started,
        observations,
        issues: [
          {
            scenario: 'expired',
            kind: 'scenario-error',
            severity: 'low',
            detail: 'No auth tokens or session cookies found after login — cannot test expiry',
          },
        ],
      };
    }

    // Corrupt in-place: flip tokens and cookie values to a guaranteed-invalid shape.
    for (const t of preTokens) {
      await writeStorageKey(page, t.scope, t.key, corruptTokenValue(t.value));
    }
    if (preCookies.length) {
      const mutated = preCookies.map((c) => ({
        ...c,
        value: corruptTokenValue(c.value),
      }));
      await ctx.addCookies(mutated).catch(() => {});
    }

    // Hit the gated route from a fresh page using the same context so the mutated
    // cookies / storage are applied.
    const probe = await ctx.newPage();
    let finalUrl = '';
    let status: number | null = null;
    try {
      const nav = await navigateToGatedRoute(probe, cfg.gatedRoute, timeout);
      finalUrl = nav.finalUrl;
      status = nav.status;
    } finally {
      await probe.close().catch(() => {});
    }

    observations.gatedStatus = status;
    observations.finalUrl = finalUrl;

    const loginOrigin = (() => {
      try {
        return new URL(cfg.loginUrl).pathname;
      } catch {
        return cfg.loginUrl;
      }
    })();
    const gatedOrigin = (() => {
      try {
        return new URL(cfg.gatedRoute).pathname;
      } catch {
        return cfg.gatedRoute;
      }
    })();

    const redirectedToLogin = finalUrl.includes(loginOrigin) && loginOrigin !== gatedOrigin;
    const gotAuthFailure = status !== null && (status === 401 || status === 403);

    if (!gotAuthFailure && !redirectedToLogin) {
      issues.push({
        scenario: 'expired',
        kind: 'expired-token-silent-failure',
        severity: 'high',
        detail: `Expired token accepted silently — final status ${status ?? 'unknown'} at ${finalUrl}`,
      });
    } else if (gotAuthFailure && !redirectedToLogin) {
      issues.push({
        scenario: 'expired',
        kind: 'expired-token-no-redirect',
        severity: 'medium',
        detail: `Server rejected expired token (${status}) but UI did not redirect to login`,
      });
    }
    observations.redirectedToLogin = redirectedToLogin;
    observations.gotAuthFailure = gotAuthFailure;

    return {
      scenario: 'expired',
      ran: true,
      passed: issues.length === 0,
      durationMs: nowMs() - started,
      observations,
      issues,
    };
  } catch (err) {
    return {
      scenario: 'expired',
      ran: true,
      passed: false,
      durationMs: nowMs() - started,
      observations,
      issues: [
        {
          scenario: 'expired',
          kind: 'scenario-error',
          severity: 'low',
          detail: err instanceof Error ? err.message : String(err),
        },
      ],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runRefreshFlowScenario(
  page: Page,
  ctx: BrowserContext,
  cfg: AuthEdgeConfig,
): Promise<AuthEdgeScenarioResult> {
  const started = nowMs();
  const issues: AuthEdgeIssue[] = [];
  const observations: Record<string, unknown> = {};
  const keys = cfg.authStorageKeys ?? DEFAULT_AUTH_STORAGE_KEYS;
  const timeout = cfg.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT;

  try {
    await doLogin(page, cfg);
    const preStorage = await readStorage(page);
    const preTokens = findAuthStorageValues(preStorage, keys);
    const preAccessValues = preTokens.filter((t) => !/refresh/i.test(t.key)).map((t) => t.value);

    // Simulate near-expiry by corrupting the access token (but leaving the
    // refresh token intact). A correctly-implemented client should then call
    // the refresh endpoint and rotate the access token.
    for (const t of preTokens) {
      if (!/refresh/i.test(t.key)) {
        await writeStorageKey(page, t.scope, t.key, corruptTokenValue(t.value));
      }
    }

    const refreshCalls: { url: string; status: number }[] = [];
    const pattern = cfg.refreshEndpoint ?? DEFAULT_REFRESH_PATTERN;
    const onResponse = (url: string, status: number): void => {
      if (matchesUrlPattern(url, pattern)) {
        refreshCalls.push({ url, status });
      }
    };
    const listener = (r: Awaited<ReturnType<Page['goto']>>): void => {
      if (!r) return;
      onResponse(r.url(), r.status());
    };
    // Listen on the active SPA page (where fetch() is patched in real apps).
    page.on('response', listener);
    let gatedStatus: number | null = null;
    try {
      // Drive the request through the SPA's own fetch stack so that any
      // refresh-on-401 wrapper the app installed can kick in. Use `follow`
      // (the default) so auth-triggered redirects surface as their final
      // status; opaqueredirect would hide the real status behind 0.
      const result = await page
        .evaluate(
          async ({ url, timeoutMs }) => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
              const r = await fetch(url, {
                method: 'GET',
                credentials: 'include',
                redirect: 'follow',
                signal: controller.signal,
              });
              return { status: r.status, url: r.url || url };
            } catch (err) {
              return { status: 0, url, error: String(err) };
            } finally {
              clearTimeout(timer);
            }
          },
          { url: cfg.gatedRoute, timeoutMs: timeout },
        )
        .catch(() => ({ status: 0, url: cfg.gatedRoute }));
      gatedStatus = (result as { status: number }).status;
    } finally {
      page.off('response', listener);
    }

    const postStorage = await readStorage(page);
    const postTokens = findAuthStorageValues(postStorage, keys);
    const postAccessValues = postTokens.filter((t) => !/refresh/i.test(t.key)).map((t) => t.value);

    observations.refreshCallCount = refreshCalls.length;
    observations.gatedStatus = gatedStatus;
    observations.tokenRotated =
      postAccessValues.length > 0 &&
      postAccessValues.some((v) => !preAccessValues.includes(v));

    if (refreshCalls.length === 0) {
      issues.push({
        scenario: 'refresh',
        kind: 'refresh-not-triggered',
        severity: 'medium',
        detail:
          'Expected a call to the refresh endpoint after near-expiry access token, none observed',
      });
    } else if (refreshCalls.every((c) => c.status >= 400)) {
      issues.push({
        scenario: 'refresh',
        kind: 'refresh-failed',
        severity: 'high',
        detail: `Refresh endpoint returned ${refreshCalls[0]?.status} — token rotation failed`,
      });
    } else if (postAccessValues.length > 0 && preAccessValues.length > 0) {
      const rotated = postAccessValues.some((v) => !preAccessValues.includes(v));
      if (!rotated) {
        issues.push({
          scenario: 'refresh',
          kind: 'refresh-token-not-rotated',
          severity: 'medium',
          detail: 'Refresh succeeded but access token in storage did not change',
        });
      }
    }

    if (gatedStatus !== null && gatedStatus >= 400) {
      issues.push({
        scenario: 'refresh',
        kind: 'refresh-failed',
        severity: 'high',
        detail: `Gated route returned ${gatedStatus} after refresh cycle`,
      });
    }

    return {
      scenario: 'refresh',
      ran: true,
      passed: issues.length === 0,
      durationMs: nowMs() - started,
      observations,
      issues,
    };
  } catch (err) {
    return {
      scenario: 'refresh',
      ran: true,
      passed: false,
      durationMs: nowMs() - started,
      observations,
      issues: [
        {
          scenario: 'refresh',
          kind: 'scenario-error',
          severity: 'low',
          detail: err instanceof Error ? err.message : String(err),
        },
      ],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runLogoutScenario(
  page: Page,
  ctx: BrowserContext,
  cfg: AuthEdgeConfig,
): Promise<AuthEdgeScenarioResult> {
  const started = nowMs();
  const issues: AuthEdgeIssue[] = [];
  const observations: Record<string, unknown> = {};
  const keys = cfg.authStorageKeys ?? DEFAULT_AUTH_STORAGE_KEYS;
  const timeout = cfg.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT;

  if (!cfg.logoutSelector) {
    return {
      scenario: 'logout',
      ran: false,
      passed: true,
      durationMs: nowMs() - started,
      observations: { skipped: 'no logoutSelector configured' },
      issues: [],
    };
  }

  try {
    await doLogin(page, cfg);

    // Capture refresh token (if any) BEFORE logout so we can probe the refresh
    // endpoint afterwards and verify revocation.
    const preStorage = await readStorage(page);
    const preTokens = findAuthStorageValues(preStorage, keys);
    const refreshTokenValue =
      preTokens.find((t) => /refresh/i.test(t.key))?.value ?? null;

    await page.goto(cfg.gatedRoute, { waitUntil: 'domcontentloaded' }).catch(() => {});
    // Click logout.
    const clicked = await page
      .locator(cfg.logoutSelector)
      .first()
      .click({ timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    observations.logoutClicked = clicked;

    // Give the app a beat to finalize the logout network calls.
    await page.waitForTimeout(500);

    const postStorage = await readStorage(page);
    const postTokens = findAuthStorageValues(postStorage, keys);
    const postCookies = findAuthCookies(await ctx.cookies());
    observations.postTokenCount = postTokens.length;
    observations.postCookieCount = postCookies.length;

    const storageCleared = postTokens.length === 0;
    const cookiesCleared = postCookies.length === 0;

    if (!storageCleared) {
      issues.push({
        scenario: 'logout',
        kind: 'logout-storage-not-cleared',
        severity: 'high',
        detail: `Logout did not clear auth storage: ${postTokens
          .map((t) => `${t.scope}:${t.key}`)
          .join(', ')}`,
      });
    }
    if (!cookiesCleared) {
      issues.push({
        scenario: 'logout',
        kind: 'logout-storage-not-cleared',
        severity: 'high',
        detail: `Logout did not clear auth cookies: ${postCookies.map((c) => c.name).join(', ')}`,
      });
    }

    // If we captured a refresh token before logout, try to use it. It should
    // be rejected by the server — otherwise refresh-token revocation is broken.
    if (refreshTokenValue) {
      const refreshUrl =
        typeof cfg.refreshEndpoint === 'string' && !cfg.refreshEndpoint.startsWith('regex:')
          ? cfg.refreshEndpoint
          : null;
      if (refreshUrl) {
        try {
          const probe = await ctx.newPage();
          await probe.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
          const resp = await fetchStatus(
            probe,
            refreshUrl,
            { Authorization: `Bearer ${refreshTokenValue}`, 'Content-Type': 'application/json' },
            timeout,
            'POST',
          );
          observations.postLogoutRefreshStatus = resp.status;
          await probe.close().catch(() => {});
          if (resp.status > 0 && resp.status < 400) {
            issues.push({
              scenario: 'logout',
              kind: 'logout-refresh-not-revoked',
              severity: 'high',
              detail: `Refresh token still accepted after logout (status ${resp.status}) — server-side revocation missing`,
            });
          }
        } catch {
          // network failure probing refresh endpoint; don't fail the scenario
        }
      }
    }

    return {
      scenario: 'logout',
      ran: true,
      passed: issues.length === 0,
      durationMs: nowMs() - started,
      observations,
      issues,
    };
  } catch (err) {
    return {
      scenario: 'logout',
      ran: true,
      passed: false,
      durationMs: nowMs() - started,
      observations,
      issues: [
        {
          scenario: 'logout',
          kind: 'scenario-error',
          severity: 'low',
          detail: err instanceof Error ? err.message : String(err),
        },
      ],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runSessionFixationScenario(
  _page: Page,
  ctx: BrowserContext,
  cfg: AuthEdgeConfig,
): Promise<AuthEdgeScenarioResult> {
  const started = nowMs();
  const issues: AuthEdgeIssue[] = [];
  const observations: Record<string, unknown> = {};
  const keys = cfg.authStorageKeys ?? DEFAULT_AUTH_STORAGE_KEYS;

  try {
    // Fresh page: hit login page once WITHOUT logging in to capture any
    // pre-login session cookie / token.
    const preLoginPage = await ctx.newPage();
    try {
      await preLoginPage
        .goto(cfg.loginUrl, { waitUntil: 'domcontentloaded' })
        .catch(() => {});
      const preCookies = findAuthCookies(await ctx.cookies());
      const preCookieIds = preCookies.map((c) => `${c.name}=${c.value}`);
      const preStorage = await readStorage(preLoginPage);
      const preTokens = findAuthStorageValues(preStorage, keys);
      observations.preLoginSessionCookies = preCookieIds;
      observations.preLoginTokenKeys = preTokens.map((t) => `${t.scope}:${t.key}`);

      // Perform login in the same page.
      if (cfg.performLogin) {
        await cfg.performLogin(preLoginPage);
      }

      const postCookies = findAuthCookies(await ctx.cookies());
      const postCookieIds = postCookies.map((c) => `${c.name}=${c.value}`);
      observations.postLoginSessionCookies = postCookieIds;

      // Compare: any pre-login cookie that still has the same value after login
      // is a fixation risk (server kept the same session id across the auth boundary).
      const fixed = preCookieIds.filter((pre) => {
        const [preName, preVal] = pre.split('=');
        return postCookies.some(
          (c) => c.name === preName && c.value === preVal && preVal !== '',
        );
      });
      observations.fixatedCookies = fixed;

      if (fixed.length > 0) {
        issues.push({
          scenario: 'fixation',
          kind: 'session-fixation',
          severity: 'high',
          detail: `Session cookie kept same value across login boundary: ${fixed.join(', ')}`,
        });
      }

      // Also check that at least one new session cookie was issued on login.
      const rotated = postCookies.some(
        (c) => !preCookies.some((p) => p.name === c.name && p.value === c.value),
      );
      observations.sessionRotated = rotated;
      if (!rotated && postCookies.length > 0 && preCookies.length > 0) {
        issues.push({
          scenario: 'fixation',
          kind: 'session-fixation',
          severity: 'medium',
          detail: 'No new session cookie issued at login — potential fixation vector',
        });
      }
    } finally {
      await preLoginPage.close().catch(() => {});
    }

    return {
      scenario: 'fixation',
      ran: true,
      passed: issues.length === 0,
      durationMs: nowMs() - started,
      observations,
      issues,
    };
  } catch (err) {
    return {
      scenario: 'fixation',
      ran: true,
      passed: false,
      durationMs: nowMs() - started,
      observations,
      issues: [
        {
          scenario: 'fixation',
          kind: 'scenario-error',
          severity: 'low',
          detail: err instanceof Error ? err.message : String(err),
        },
      ],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runCsrfRotationScenario(
  page: Page,
  ctx: BrowserContext,
  cfg: AuthEdgeConfig,
): Promise<AuthEdgeScenarioResult> {
  const started = nowMs();
  const issues: AuthEdgeIssue[] = [];
  const observations: Record<string, unknown> = {};
  const csrfHeader = cfg.csrfHeaderName ?? DEFAULT_CSRF_HEADER;

  try {
    await doLogin(page, cfg);

    const readCsrfToken = async (): Promise<string | null> => {
      const value = await page
        .evaluate(
          ({ header }) => {
            // Prefer cookie over meta: cookies rotate naturally as the
            // server re-sets them, whereas meta tags are frozen at load time.
            const m = document.cookie.match(/(?:^|;\s*)(XSRF-TOKEN|csrftoken|_csrf)=([^;]+)/);
            if (m) return decodeURIComponent(m[2] ?? '');
            const ml = document.querySelector(
              `meta[name="${header}"], meta[name="csrf-token"], meta[name="_csrf"]`,
            );
            if (ml) return ml.getAttribute('content');
            return null;
          },
          { header: csrfHeader },
        )
        .catch(() => null);
      return value ?? null;
    };

    const preToken = await readCsrfToken();
    observations.preCsrfToken = preToken ? `${preToken.slice(0, 4)}...` : null;

    if (!preToken) {
      return {
        scenario: 'csrf',
        ran: true,
        passed: true,
        durationMs: nowMs() - started,
        observations: {
          ...observations,
          note: 'No CSRF token found in meta tag or XSRF cookie — CSRF rotation not applicable',
        },
        issues: [],
      };
    }

    // Perform a state-changing request and observe whether the token rotates.
    // We issue a POST to the gated route; many apps rotate after any state change.
    await page
      .evaluate(
        async ({ url, token, header }) => {
          try {
            await fetch(url, {
              method: 'POST',
              credentials: 'include',
              headers: { [header]: token, 'Content-Type': 'application/json' },
              body: JSON.stringify({}),
            });
          } catch {
            /* best effort */
          }
        },
        { url: cfg.gatedRoute, token: preToken, header: csrfHeader },
      )
      .catch(() => {});

    await page.waitForTimeout(250);
    const postToken = await readCsrfToken();
    observations.postCsrfToken = postToken ? `${postToken.slice(0, 4)}...` : null;
    observations.rotated = preToken !== postToken;

    // Cross-session reuse test: open a second context, try the token.
    const reuseContext = await ctx.browser()?.newContext();
    let reuseStatus = 0;
    if (reuseContext) {
      const reusePage = await reuseContext.newPage();
      try {
        const resp = await fetchStatus(
          reusePage,
          cfg.gatedRoute,
          { [csrfHeader]: preToken },
          cfg.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT,
        );
        reuseStatus = resp.status;
      } finally {
        await reusePage.close().catch(() => {});
        await reuseContext.close().catch(() => {});
      }
    }
    observations.crossSessionReuseStatus = reuseStatus;

    const tokenRotated = preToken !== postToken;
    const reuseBlocked = reuseStatus === 0 || reuseStatus >= 400;

    if (!tokenRotated && !reuseBlocked) {
      issues.push({
        scenario: 'csrf',
        kind: 'csrf-token-reuse-across-sessions',
        severity: 'high',
        detail: `CSRF token did not rotate and is still accepted in another session (status ${reuseStatus})`,
      });
    } else if (!tokenRotated) {
      issues.push({
        scenario: 'csrf',
        kind: 'csrf-token-static',
        severity: 'low',
        detail:
          'CSRF token did not rotate after state-change; rotation on auth boundary recommended',
      });
    }

    return {
      scenario: 'csrf',
      ran: true,
      passed: issues.filter((i) => i.severity !== 'low').length === 0,
      durationMs: nowMs() - started,
      observations,
      issues,
    };
  } catch (err) {
    return {
      scenario: 'csrf',
      ran: true,
      passed: false,
      durationMs: nowMs() - started,
      observations,
      issues: [
        {
          scenario: 'csrf',
          kind: 'scenario-error',
          severity: 'low',
          detail: err instanceof Error ? err.message : String(err),
        },
      ],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runConcurrentLogoutScenario(
  page: Page,
  ctx: BrowserContext,
  cfg: AuthEdgeConfig,
): Promise<AuthEdgeScenarioResult> {
  const started = nowMs();
  const issues: AuthEdgeIssue[] = [];
  const observations: Record<string, unknown> = {};
  const timeout = cfg.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT;

  if (!cfg.logoutSelector) {
    return {
      scenario: 'concurrent',
      ran: false,
      passed: true,
      durationMs: nowMs() - started,
      observations: { skipped: 'no logoutSelector configured' },
      issues: [],
    };
  }

  try {
    await doLogin(page, cfg);

    // Tab B: open a second tab on the gated route first so it has live auth state.
    const tabB = await ctx.newPage();
    try {
      await tabB.goto(cfg.gatedRoute, { waitUntil: 'domcontentloaded' }).catch(() => {});

      // Tab A (our page) logs out.
      await page.goto(cfg.gatedRoute, { waitUntil: 'domcontentloaded' }).catch(() => {});
      const clicked = await page
        .locator(cfg.logoutSelector)
        .first()
        .click({ timeout: 5000 })
        .then(() => true)
        .catch(() => false);
      observations.logoutInTabA = clicked;

      await page.waitForTimeout(500);

      // Next request on tab B to gated route should now 401.
      const resp = await fetchStatus(tabB, cfg.gatedRoute, {}, timeout);
      observations.tabBGatedStatus = resp.status;

      if (resp.status > 0 && resp.status < 400) {
        issues.push({
          scenario: 'concurrent',
          kind: 'concurrent-logout-still-valid',
          severity: 'high',
          detail: `After logout in tab A, tab B still received ${resp.status} from gated route — session not invalidated globally`,
        });
      }
    } finally {
      await tabB.close().catch(() => {});
    }

    return {
      scenario: 'concurrent',
      ran: true,
      passed: issues.length === 0,
      durationMs: nowMs() - started,
      observations,
      issues,
    };
  } catch (err) {
    return {
      scenario: 'concurrent',
      ran: true,
      passed: false,
      durationMs: nowMs() - started,
      observations,
      issues: [
        {
          scenario: 'concurrent',
          kind: 'scenario-error',
          severity: 'low',
          detail: err instanceof Error ? err.message : String(err),
        },
      ],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main entry
// ─────────────────────────────────────────────────────────────────────────────

const SCENARIO_ORDER: AuthEdgeScenario[] = [
  'fixation',
  'expired',
  'refresh',
  'logout',
  'csrf',
  'concurrent',
];

export async function runAuthEdgeAudit(
  page: Page,
  cfg: AuthEdgeConfig,
): Promise<AuthEdgeResult> {
  if (!cfg.loginUrl) throw new Error('runAuthEdgeAudit: loginUrl is required');
  if (!cfg.gatedRoute) throw new Error('runAuthEdgeAudit: gatedRoute is required');

  const ctx = page.context();
  const skip = new Set<AuthEdgeScenario>(cfg.skipScenarios ?? []);
  const results: AuthEdgeScenarioResult[] = [];

  for (const scenario of SCENARIO_ORDER) {
    if (skip.has(scenario)) {
      results.push({
        scenario,
        ran: false,
        passed: true,
        durationMs: 0,
        observations: { skipped: 'skipScenarios' },
        issues: [],
      });
      continue;
    }

    // Between scenarios, wipe cookies + auth storage so each one starts from a
    // clean slate. `performLogin` (or the caller's existing login) re-establishes
    // state as needed.
    if (cfg.performLogin) {
      await clearAuthFromStorage(
        page,
        ctx,
        cfg.authStorageKeys ?? DEFAULT_AUTH_STORAGE_KEYS,
      );
    }

    let result: AuthEdgeScenarioResult;
    switch (scenario) {
      case 'expired':
        result = await runExpiredTokenScenario(page, ctx, cfg);
        break;
      case 'refresh':
        result = await runRefreshFlowScenario(page, ctx, cfg);
        break;
      case 'logout':
        result = await runLogoutScenario(page, ctx, cfg);
        break;
      case 'fixation':
        result = await runSessionFixationScenario(page, ctx, cfg);
        break;
      case 'csrf':
        result = await runCsrfRotationScenario(page, ctx, cfg);
        break;
      case 'concurrent':
        result = await runConcurrentLogoutScenario(page, ctx, cfg);
        break;
    }
    results.push(result);
  }

  const issues: AuthEdgeIssue[] = [];
  for (const r of results) for (const i of r.issues) issues.push(i);
  const passed = results.every((r) => r.passed);

  return {
    page: page.url(),
    scenarios: results,
    issues,
    passed,
  };
}
