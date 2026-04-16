import type { Page, BrowserContext, Cookie, Request as PwRequest } from 'playwright';

export type CookiePurpose = 'necessary' | 'analytics' | 'marketing' | 'preferences';

export interface ConsentDeclaration {
  /** Pattern matched against cookie name. RegExp or literal substring. */
  pattern: RegExp | string;
  /** Declared purpose for this cookie. */
  purpose: CookiePurpose;
  /** Maximum declared duration in seconds. Cookies exceeding this are flagged. */
  maxAgeSeconds?: number;
  /** If true, cookie is claimed to be HttpOnly — flag if it isn't. */
  httpOnly?: boolean;
}

export interface GdprConfig {
  /** Selector for the accept button. If omitted, a library of common selectors is tried. */
  acceptSelector?: string;
  /** Selector for the reject button. If omitted, a library of common selectors is tried. */
  rejectSelector?: string;
  /**
   * Map of cookie patterns to declared purpose. Used in the accept path to
   * verify every cookie written corresponds to a declared purpose, and in the
   * reject path to treat anything non-necessary as a violation.
   */
  declaredCookies: ConsentDeclaration[];
  /**
   * Hosts that must not be requested on the reject path. Exact match or suffix
   * match against request URL hostname.
   */
  trackingDomains?: string[];
  /** Max time to wait for banner to appear, ms. Default 5000. */
  bannerTimeoutMs?: number;
  /** Time to wait after clicking / loading to let cookies settle, ms. Default 1500. */
  settleTimeMs?: number;
}

export interface CookieSnapshot {
  name: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  /** Duration until expiry in seconds at time of capture, or -1 if session. */
  durationSeconds: number;
  /** Matched declaration, if any. */
  purpose?: CookiePurpose;
}

export type ViolationKind =
  | 'tracker-cookie-before-reject'
  | 'tracker-cookie-after-reject'
  | 'tracker-request-after-reject'
  | 'undeclared-cookie-after-accept'
  | 'silent-cookie-matches-accept'
  | 'duration-exceeds-declared'
  | 'samesite-none-without-secure'
  | 'auth-cookie-missing-httponly'
  | 'declared-httponly-missing'
  | 'no-banner-found'
  | 'no-reject-control'
  | 'no-accept-control';

export interface CookieViolation {
  kind: ViolationKind;
  cookie?: string;
  domain?: string;
  purpose?: CookiePurpose;
  detail: string;
}

export interface PathResult {
  bannerFound: boolean;
  controlClicked: boolean;
  clickedSelector?: string;
  cookies: CookieSnapshot[];
  thirdPartyRequests: string[];
  violations: CookieViolation[];
}

export interface GdprResult {
  page: string;
  rejectPath: PathResult;
  acceptPath: PathResult;
  silencePath: PathResult;
  violations: CookieViolation[];
  passed: boolean;
}

/** Default selectors covering the common consent UIs. No third-party brand names. */
const DEFAULT_ACCEPT_SELECTORS = [
  'button:has-text("Accept all")',
  'button:has-text("Accept All")',
  'button:has-text("Accept")',
  'button:has-text("Allow all")',
  'button:has-text("Allow All")',
  'button:has-text("Allow")',
  'button:has-text("Agree")',
  'button:has-text("I agree")',
  'button:has-text("Got it")',
  'button:has-text("OK")',
  'button:has-text("Okay")',
  '[aria-label*="accept" i]',
  '[aria-label*="agree" i]',
  '[data-testid*="accept" i]',
  '[id*="accept" i][role="button"]',
  '[id*="accept-all" i]',
  '[class*="accept" i][role="button"]',
];

const DEFAULT_REJECT_SELECTORS = [
  'button:has-text("Reject all")',
  'button:has-text("Reject All")',
  'button:has-text("Reject")',
  'button:has-text("Decline all")',
  'button:has-text("Decline All")',
  'button:has-text("Decline")',
  'button:has-text("Deny")',
  'button:has-text("Refuse")',
  'button:has-text("No thanks")',
  'button:has-text("Disagree")',
  'button:has-text("Only necessary")',
  'button:has-text("Only essential")',
  '[aria-label*="reject" i]',
  '[aria-label*="decline" i]',
  '[aria-label*="deny" i]',
  '[data-testid*="reject" i]',
  '[data-testid*="decline" i]',
  '[id*="reject" i][role="button"]',
  '[id*="reject-all" i]',
  '[class*="reject" i][role="button"]',
];

const AUTH_COOKIE_RX = /session|auth|token|jwt|sid|login/i;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function matchesPattern(name: string, pattern: RegExp | string): boolean {
  if (pattern instanceof RegExp) return pattern.test(name);
  return name.includes(pattern);
}

function findDeclaration(name: string, declared: ConsentDeclaration[]): ConsentDeclaration | undefined {
  for (const d of declared) {
    if (matchesPattern(name, d.pattern)) return d;
  }
  return undefined;
}

function normalizeSameSite(v: Cookie['sameSite']): 'Strict' | 'Lax' | 'None' | undefined {
  if (v === 'Strict' || v === 'Lax' || v === 'None') return v;
  return undefined;
}

function snapshotCookies(raw: Cookie[], declared: ConsentDeclaration[]): CookieSnapshot[] {
  const now = nowSeconds();
  return raw.map((c) => {
    const decl = findDeclaration(c.name, declared);
    const durationSeconds = typeof c.expires === 'number' && c.expires > 0 ? c.expires - now : -1;
    const snap: CookieSnapshot = {
      name: c.name,
      domain: c.domain,
      path: c.path,
      expires: typeof c.expires === 'number' ? c.expires : -1,
      httpOnly: c.httpOnly,
      secure: c.secure,
      durationSeconds,
    };
    const ss = normalizeSameSite(c.sameSite);
    if (ss !== undefined) snap.sameSite = ss;
    if (decl) snap.purpose = decl.purpose;
    return snap;
  });
}

function hostMatchesTrackingDomain(urlString: string, hosts: string[]): string | undefined {
  let host: string;
  try {
    host = new URL(urlString).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  for (const h of hosts) {
    const needle = h.toLowerCase();
    if (host === needle || host.endsWith('.' + needle) || host.endsWith(needle)) return host;
  }
  return undefined;
}

async function clickFirstMatch(
  page: Page,
  primary: string | undefined,
  fallbacks: string[],
  timeoutMs: number,
): Promise<string | undefined> {
  const candidates = primary ? [primary, ...fallbacks] : fallbacks;
  for (const sel of candidates) {
    try {
      const locator = page.locator(sel).first();
      await locator.waitFor({ state: 'visible', timeout: Math.min(timeoutMs, 1200) });
      await locator.click({ timeout: 1500 });
      return sel;
    } catch {
      // keep trying
    }
  }
  return undefined;
}

async function detectBanner(page: Page, timeoutMs: number): Promise<boolean> {
  const selectors = [
    '#cookie-banner',
    '#cookie-notice',
    '#gdpr-banner',
    '.cookie-consent',
    '#cookieConsent',
    '.cc-window',
    '[role="dialog"][aria-label*="cookie" i]',
    '[role="alertdialog"][aria-label*="cookie" i]',
    '[id*="consent" i]',
    '[class*="consent" i]',
    '[id*="cookie" i]',
  ];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 100 }).catch(() => false)) return true;
      } catch {
        // keep scanning
      }
    }
    // Also look for common banner text on body
    try {
      const bodyText = (await page.locator('body').innerText({ timeout: 200 })).slice(0, 4000);
      if (/cookie|gdpr|consent|privacy/i.test(bodyText) && /accept|reject|agree|decline/i.test(bodyText)) {
        return true;
      }
    } catch {
      // ignore
    }
    await page.waitForTimeout(100);
  }
  return false;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface PathCaptureOptions {
  cfg: GdprConfig;
  url: string;
  context: BrowserContext;
  page: Page;
  settleTimeMs: number;
  bannerTimeoutMs: number;
  action: 'reject' | 'accept' | 'silence';
}

async function runPath(opts: PathCaptureOptions): Promise<PathResult> {
  const { cfg, url, context, page, settleTimeMs, bannerTimeoutMs, action } = opts;
  const thirdPartyRequests: string[] = [];
  const seenRequests = new Set<string>();

  const onRequest = (req: PwRequest): void => {
    const u = req.url();
    if (seenRequests.has(u)) return;
    seenRequests.add(u);
    if (cfg.trackingDomains && cfg.trackingDomains.length > 0) {
      if (hostMatchesTrackingDomain(u, cfg.trackingDomains)) {
        thirdPartyRequests.push(u);
      }
    }
  };
  page.on('request', onRequest);

  try {
    await page.goto(url, { waitUntil: 'load' }).catch(() => {
      // Best-effort load; some test pages use setContent.
    });
    await sleepMs(Math.min(settleTimeMs, 300));
  } catch {
    // goto errors shouldn't crash the audit
  }

  const bannerFound = await detectBanner(page, bannerTimeoutMs).catch(() => false);
  let controlClicked = false;
  let clickedSelector: string | undefined;

  if (action === 'reject') {
    const sel = await clickFirstMatch(page, cfg.rejectSelector, DEFAULT_REJECT_SELECTORS, bannerTimeoutMs);
    if (sel) {
      controlClicked = true;
      clickedSelector = sel;
    }
  } else if (action === 'accept') {
    const sel = await clickFirstMatch(page, cfg.acceptSelector, DEFAULT_ACCEPT_SELECTORS, bannerTimeoutMs);
    if (sel) {
      controlClicked = true;
      clickedSelector = sel;
    }
  }
  // silence path: no interaction.

  await sleepMs(settleTimeMs);

  const rawCookies = await context.cookies();
  const cookies = snapshotCookies(rawCookies, cfg.declaredCookies);

  page.off('request', onRequest);

  const violations: CookieViolation[] = [];
  const result: PathResult = {
    bannerFound,
    controlClicked,
    cookies,
    thirdPartyRequests,
    violations,
  };
  if (clickedSelector) result.clickedSelector = clickedSelector;
  return result;
}

function auditCookieFlags(cookies: CookieSnapshot[], declared: ConsentDeclaration[]): CookieViolation[] {
  const out: CookieViolation[] = [];
  for (const c of cookies) {
    const decl = findDeclaration(c.name, declared);

    // SameSite=None requires Secure (modern browser rejection reason).
    if (c.sameSite === 'None' && !c.secure) {
      out.push({
        kind: 'samesite-none-without-secure',
        cookie: c.name,
        domain: c.domain,
        detail: `cookie "${c.name}" has SameSite=None but no Secure flag`,
      });
    }

    // Auth-ish cookies should be HttpOnly.
    if (AUTH_COOKIE_RX.test(c.name) && !c.httpOnly) {
      out.push({
        kind: 'auth-cookie-missing-httponly',
        cookie: c.name,
        domain: c.domain,
        detail: `authentication-style cookie "${c.name}" is not HttpOnly — exposed to JS`,
      });
    }

    if (decl) {
      // Declared duration check.
      if (typeof decl.maxAgeSeconds === 'number' && c.durationSeconds > decl.maxAgeSeconds) {
        const days = (c.durationSeconds / 86400).toFixed(1);
        const declaredDays = (decl.maxAgeSeconds / 86400).toFixed(1);
        out.push({
          kind: 'duration-exceeds-declared',
          cookie: c.name,
          domain: c.domain,
          purpose: decl.purpose,
          detail: `cookie "${c.name}" persists ~${days}d, declared max ~${declaredDays}d`,
        });
      }
      // Declared HttpOnly claim not met.
      if (decl.httpOnly === true && !c.httpOnly) {
        out.push({
          kind: 'declared-httponly-missing',
          cookie: c.name,
          domain: c.domain,
          purpose: decl.purpose,
          detail: `declaration claims "${c.name}" is HttpOnly but browser cookie is not`,
        });
      }
    }
  }
  return out;
}

/**
 * Run a full GDPR consent flow audit: reject path, accept path, silence path.
 * Each path uses a fresh BrowserContext so cookie state is not contaminated.
 */
export async function runGdprAudit(page: Page, opts: GdprConfig): Promise<GdprResult> {
  const url = page.url();
  const browser = page.context().browser();
  if (!browser) {
    throw new Error('runGdprAudit requires a page attached to a real browser');
  }

  const bannerTimeoutMs = opts.bannerTimeoutMs ?? 5000;
  const settleTimeMs = opts.settleTimeMs ?? 1500;

  // Reject path: fresh context.
  const rejectCtx = await browser.newContext();
  const rejectPage = await rejectCtx.newPage();
  let rejectPath: PathResult;
  try {
    rejectPath = await runPath({
      cfg: opts,
      url,
      context: rejectCtx,
      page: rejectPage,
      settleTimeMs,
      bannerTimeoutMs,
      action: 'reject',
    });
  } finally {
    await rejectPage.close().catch(() => {});
    await rejectCtx.close().catch(() => {});
  }

  // Accept path: fresh context.
  const acceptCtx = await browser.newContext();
  const acceptPage = await acceptCtx.newPage();
  let acceptPath: PathResult;
  try {
    acceptPath = await runPath({
      cfg: opts,
      url,
      context: acceptCtx,
      page: acceptPage,
      settleTimeMs,
      bannerTimeoutMs,
      action: 'accept',
    });
  } finally {
    await acceptPage.close().catch(() => {});
    await acceptCtx.close().catch(() => {});
  }

  // Silence path: fresh context, no banner interaction.
  const silenceCtx = await browser.newContext();
  const silencePage = await silenceCtx.newPage();
  let silencePath: PathResult;
  try {
    silencePath = await runPath({
      cfg: opts,
      url,
      context: silenceCtx,
      page: silencePage,
      settleTimeMs,
      bannerTimeoutMs,
      action: 'silence',
    });
  } finally {
    await silencePage.close().catch(() => {});
    await silenceCtx.close().catch(() => {});
  }

  // Reject path: any cookie classified as analytics/marketing/preferences,
  // or any cookie that matches NO declaration but is non-necessary, is a violation.
  for (const c of rejectPath.cookies) {
    if (c.purpose && c.purpose !== 'necessary') {
      rejectPath.violations.push({
        kind: 'tracker-cookie-after-reject',
        cookie: c.name,
        domain: c.domain,
        purpose: c.purpose,
        detail: `non-essential cookie "${c.name}" (${c.purpose}) written after user rejected consent`,
      });
    }
  }

  // Reject path: tracking-domain requests are violations.
  for (const u of rejectPath.thirdPartyRequests) {
    rejectPath.violations.push({
      kind: 'tracker-request-after-reject',
      detail: `tracking request sent after reject: ${u}`,
    });
  }

  // If no banner at all and cookies are present, flag.
  if (!rejectPath.bannerFound) {
    rejectPath.violations.push({
      kind: 'no-banner-found',
      detail: 'no consent banner detected on reject path; cannot verify consent lifecycle',
    });
  }
  if (rejectPath.bannerFound && !rejectPath.controlClicked) {
    rejectPath.violations.push({
      kind: 'no-reject-control',
      detail: 'banner found but no reject control could be clicked — GDPR requires equal-prominence reject',
    });
  }

  // Accept path: every cookie set should map to a declaration.
  for (const c of acceptPath.cookies) {
    if (!c.purpose) {
      acceptPath.violations.push({
        kind: 'undeclared-cookie-after-accept',
        cookie: c.name,
        domain: c.domain,
        detail: `cookie "${c.name}" is not covered by any declared consent purpose`,
      });
    }
  }
  if (acceptPath.bannerFound && !acceptPath.controlClicked) {
    acceptPath.violations.push({
      kind: 'no-accept-control',
      detail: 'banner found but no accept control could be clicked',
    });
  }

  // Silence path: any non-necessary cookie that ALSO appears in accept path is evidence
  // that "doing nothing" is treated as consent.
  const acceptNames = new Set(acceptPath.cookies.map((c) => c.name));
  for (const c of silencePath.cookies) {
    if (c.purpose && c.purpose !== 'necessary' && acceptNames.has(c.name)) {
      silencePath.violations.push({
        kind: 'silent-cookie-matches-accept',
        cookie: c.name,
        domain: c.domain,
        purpose: c.purpose,
        detail: `non-essential cookie "${c.name}" set without user interaction (matches accept path)`,
      });
    }
  }

  // Flag cookies that exist before any click on reject path as "before consent".
  // On the reject path, we navigated and then clicked reject. Cookies captured
  // after reject include both "before reject" and "after reject" — for that
  // distinction we rely on purpose classification. Additionally, if banner was
  // never found but tracking cookies exist, flag as before-reject.
  if (!rejectPath.bannerFound) {
    for (const c of rejectPath.cookies) {
      if (c.purpose && c.purpose !== 'necessary') {
        rejectPath.violations.push({
          kind: 'tracker-cookie-before-reject',
          cookie: c.name,
          domain: c.domain,
          purpose: c.purpose,
          detail: `non-essential cookie "${c.name}" set before consent could be given`,
        });
      }
    }
  }

  // Cookie age/scope audit on all three paths.
  const flagAll: CookieViolation[] = [];
  for (const path of [rejectPath, acceptPath, silencePath]) {
    const flagIssues = auditCookieFlags(path.cookies, opts.declaredCookies);
    path.violations.push(...flagIssues);
    flagAll.push(...flagIssues);
  }

  const allViolations: CookieViolation[] = [
    ...rejectPath.violations,
    ...acceptPath.violations,
    ...silencePath.violations,
  ];

  return {
    page: url,
    rejectPath,
    acceptPath,
    silencePath,
    violations: allViolations,
    passed: allViolations.length === 0,
  };
}
