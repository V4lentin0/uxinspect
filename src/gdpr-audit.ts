import type { Page } from 'playwright';

export interface GdprCookie {
  name: string;
  domain: string;
  value: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  essential: boolean;
  tracker?: string;
}

export interface GdprIssue {
  phase: 'preconsent' | 'reject' | 'declared';
  kind:
    | 'tracking-before-consent'
    | 'tracker-set-after-reject'
    | 'undeclared-cookie'
    | 'missing-banner'
    | 'declaration-fetch-failed';
  detail: string;
  cookie?: string;
}

export interface GdprResult {
  page: string;
  bannerDetected: boolean;
  acceptClicked: boolean;
  rejectClicked: boolean;
  preconsentCookies: GdprCookie[];
  acceptedCookies: GdprCookie[];
  rejectedButSetCookies: GdprCookie[];
  undeclaredCookies: GdprCookie[];
  declaredCookieNames?: string[];
  issues: GdprIssue[];
  passed: boolean;
}

export interface GdprAuditOptions {
  acceptSelectors?: string[];
  rejectSelectors?: string[];
  consentDeclarationUrl?: string;
  consentTimeoutMs?: number;
}

// Cookies generally considered essential/first-party functional under GDPR recital 66a / ePrivacy art. 5(3).
const ESSENTIAL_COOKIE_PATTERNS: RegExp[] = [
  /^PHPSESSID$/i,
  /^JSESSIONID$/i,
  /^ASP\.NET_SessionId$/i,
  /session/i,
  /^sid$/i,
  /^connect\.sid$/i,
  /csrf/i,
  /xsrf/i,
  /^_csrf/i,
  /^cf_/i, // Cloudflare functional
  /^__cf_bm$/i,
  /^__Secure-/i,
  /^__Host-/i,
  /^auth/i,
  /^token$/i,
  /^lang$/i,
  /^locale$/i,
  /^currency$/i,
  /^cookie_consent/i,
  /^cookieconsent/i,
  /^gdpr_/i,
  /^osano_/i,
  /^OptanonConsent$/i,
  /^OptanonAlertBoxClosed$/i,
  /^CookieConsent$/i,
  /^CookieScriptConsent$/i,
  /^cky-consent/i,
];

const TRACKER_COOKIE_PATTERNS: Array<{ pattern: RegExp; vendor: string }> = [
  { pattern: /^_ga(_|$)/, vendor: 'google-analytics' },
  { pattern: /^_gid$/, vendor: 'google-analytics' },
  { pattern: /^_gat/, vendor: 'google-analytics' },
  { pattern: /^_dc_gtm/, vendor: 'google-tag-manager' },
  { pattern: /^_gcl_/, vendor: 'google-ads' },
  { pattern: /^IDE$/, vendor: 'doubleclick' },
  { pattern: /^DSID$/, vendor: 'doubleclick' },
  { pattern: /^_fbp$/, vendor: 'facebook' },
  { pattern: /^_fbc$/, vendor: 'facebook' },
  { pattern: /^fr$/, vendor: 'facebook' },
  { pattern: /^_pin_unauth$/, vendor: 'pinterest' },
  { pattern: /^_pinterest_ct/, vendor: 'pinterest' },
  { pattern: /^_hjid$/, vendor: 'hotjar' },
  { pattern: /^_hjSession/, vendor: 'hotjar' },
  { pattern: /^_hjFirstSeen$/, vendor: 'hotjar' },
  { pattern: /^_scid$/, vendor: 'snapchat' },
  { pattern: /^_ttp$/, vendor: 'tiktok' },
  { pattern: /^mp_/, vendor: 'mixpanel' },
  { pattern: /^amplitude_/, vendor: 'amplitude' },
  { pattern: /^intercom-/, vendor: 'intercom' },
  { pattern: /^ajs_/, vendor: 'segment' },
  { pattern: /^_uetsid$/, vendor: 'bing-ads' },
  { pattern: /^_uetvid$/, vendor: 'bing-ads' },
  { pattern: /^MUID$/, vendor: 'microsoft' },
  { pattern: /^optimizelyEndUserId$/, vendor: 'optimizely' },
  { pattern: /^_clck$/, vendor: 'microsoft-clarity' },
  { pattern: /^_clsk$/, vendor: 'microsoft-clarity' },
  { pattern: /^yt-remote/, vendor: 'youtube' },
  { pattern: /^VISITOR_INFO/, vendor: 'youtube' },
];

const DEFAULT_ACCEPT_SELECTORS = [
  'button:has-text("Accept all")',
  'button:has-text("Accept All")',
  'button:has-text("Accept")',
  'button:has-text("Allow all")',
  'button:has-text("Allow All")',
  'button:has-text("Allow")',
  'button:has-text("I agree")',
  'button:has-text("Agree")',
  'button:has-text("Got it")',
  'button:has-text("OK")',
  '#onetrust-accept-btn-handler',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  'button[aria-label*="Accept" i]',
  'a:has-text("Accept all")',
  'a:has-text("Accept")',
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
  'button:has-text("Only essential")',
  'button:has-text("Only necessary")',
  '#onetrust-reject-all-handler',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll',
  'button[aria-label*="Reject" i]',
  'button[aria-label*="Decline" i]',
  'a:has-text("Reject all")',
  'a:has-text("Reject")',
];

function classifyCookie(name: string): { essential: boolean; tracker?: string } {
  for (const t of TRACKER_COOKIE_PATTERNS) {
    if (t.pattern.test(name)) return { essential: false, tracker: t.vendor };
  }
  for (const p of ESSENTIAL_COOKIE_PATTERNS) {
    if (p.test(name)) return { essential: true };
  }
  return { essential: false };
}

function normalizeSameSite(v: unknown): 'Strict' | 'Lax' | 'None' | undefined {
  return v === 'Strict' || v === 'Lax' || v === 'None' ? v : undefined;
}

interface RawCookie {
  name: string;
  domain: string;
  value: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: unknown;
}

function toGdprCookie(raw: RawCookie): GdprCookie {
  const c = classifyCookie(raw.name);
  const g: GdprCookie = {
    name: raw.name,
    domain: raw.domain,
    value: raw.value,
    expires: typeof raw.expires === 'number' ? raw.expires : -1,
    httpOnly: !!raw.httpOnly,
    secure: !!raw.secure,
    essential: c.essential,
  };
  const ss = normalizeSameSite(raw.sameSite);
  if (ss) g.sameSite = ss;
  if (c.tracker) g.tracker = c.tracker;
  return g;
}

async function tryClickFirst(page: Page, selectors: string[], timeoutMs: number): Promise<boolean> {
  for (const sel of selectors) {
    try {
      const locator = page.locator(sel).first();
      const count = await locator.count();
      if (count === 0) continue;
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) continue;
      await locator.click({ timeout: timeoutMs }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => {});
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

async function fetchDeclaredCookieNames(url: string): Promise<string[] | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    const body = await res.text();
    if (ct.includes('application/json') || /^\s*[\{\[]/.test(body)) {
      try {
        const parsed = JSON.parse(body);
        return extractNamesFromJson(parsed);
      } catch {
        // fall through to text scan
      }
    }
    return extractNamesFromText(body);
  } catch {
    return null;
  }
}

function extractNamesFromJson(data: unknown): string[] {
  const names = new Set<string>();
  const walk = (node: unknown): void => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        const v = obj[key];
        if ((key === 'name' || key === 'cookieName' || key === 'cookie_name') && typeof v === 'string') {
          names.add(v.trim());
        }
        walk(v);
      }
    }
  };
  walk(data);
  return Array.from(names);
}

function extractNamesFromText(text: string): string[] {
  const names = new Set<string>();
  const cookieLikeRx = /\b([A-Za-z_][A-Za-z0-9_.-]{1,63})\b/g;
  // Restrict to plausible cookie-row lines (tables, lists) containing a name before a domain/purpose column.
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!/(cookie|name|domain|expires|purpose|duration)/i.test(line) && !/[<>]/.test(line)) continue;
    const stripped = line.replace(/<[^>]+>/g, ' ');
    const matches = stripped.match(cookieLikeRx) ?? [];
    for (const m of matches) {
      // common tracker/session prefixes
      if (/^(_ga|_gid|_gat|_fbp|_hjid|_hjSession|PHPSESSID|JSESSIONID|CookieConsent|OptanonConsent)/i.test(m)) {
        names.add(m);
      }
    }
  }
  return Array.from(names);
}

async function snapshotCookies(page: Page): Promise<GdprCookie[]> {
  const raw = (await page.context().cookies()) as RawCookie[];
  return raw.map(toGdprCookie);
}

async function loadFresh(page: Page, url: string): Promise<void> {
  await page.context().clearCookies();
  await page.goto(url, { waitUntil: 'networkidle' }).catch(async () => {
    await page.goto(url).catch(() => {});
  });
}

export async function auditGdprConsent(
  page: Page,
  opts: GdprAuditOptions = {},
): Promise<GdprResult> {
  const pageUrl = page.url();
  const acceptSelectors = [
    ...(opts.acceptSelectors ?? []),
    ...DEFAULT_ACCEPT_SELECTORS,
  ];
  const rejectSelectors = [
    ...(opts.rejectSelectors ?? []),
    ...DEFAULT_REJECT_SELECTORS,
  ];
  const timeoutMs = opts.consentTimeoutMs ?? 3000;

  // ------- Phase 1: pre-consent cookies (no clicks) -------
  const preconsentCookies = await snapshotCookies(page);

  // ------- Phase 2: accept all -------
  let acceptClicked = false;
  let acceptedCookies: GdprCookie[] = [];
  try {
    acceptClicked = await tryClickFirst(page, acceptSelectors, timeoutMs);
    // allow any deferred cookies to be set
    await page.waitForTimeout(300);
    acceptedCookies = await snapshotCookies(page);
  } catch {
    acceptedCookies = [...preconsentCookies];
  }

  // ------- Phase 3: reject all (fresh context) -------
  let rejectClicked = false;
  let rejectedButSetCookies: GdprCookie[] = [];
  try {
    await loadFresh(page, pageUrl);
    rejectClicked = await tryClickFirst(page, rejectSelectors, timeoutMs);
    await page.waitForTimeout(300);
    const rejectCookies = await snapshotCookies(page);
    // GDPR violation = tracker cookies set despite reject
    rejectedButSetCookies = rejectCookies.filter((c) => !!c.tracker);
  } catch {
    rejectedButSetCookies = [];
  }

  // ------- Phase 4: declared cookies match -------
  let declaredCookieNames: string[] | undefined;
  let undeclaredCookies: GdprCookie[] = [];
  const issues: GdprIssue[] = [];

  if (opts.consentDeclarationUrl) {
    const names = await fetchDeclaredCookieNames(opts.consentDeclarationUrl);
    if (names === null) {
      issues.push({
        phase: 'declared',
        kind: 'declaration-fetch-failed',
        detail: `could not fetch or parse consent declaration at ${opts.consentDeclarationUrl}`,
      });
    } else {
      declaredCookieNames = names;
      const declaredSet = new Set(names.map((n) => n.toLowerCase()));
      const seen = new Set<string>();
      for (const c of acceptedCookies) {
        const key = `${c.name}:${c.domain}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (c.essential) continue;
        if (!declaredSet.has(c.name.toLowerCase())) {
          undeclaredCookies.push(c);
        }
      }
    }
  }

  // ------- Issue synthesis -------
  const preTrackers = preconsentCookies.filter((c) => !c.essential);
  for (const c of preTrackers) {
    issues.push({
      phase: 'preconsent',
      kind: 'tracking-before-consent',
      cookie: c.name,
      detail: `non-essential cookie "${c.name}" (${c.tracker ?? 'non-essential'}) set before any consent interaction`,
    });
  }

  for (const c of rejectedButSetCookies) {
    issues.push({
      phase: 'reject',
      kind: 'tracker-set-after-reject',
      cookie: c.name,
      detail: `tracker cookie "${c.name}" (${c.tracker ?? 'tracker'}) set despite user rejecting consent`,
    });
  }

  for (const c of undeclaredCookies) {
    issues.push({
      phase: 'declared',
      kind: 'undeclared-cookie',
      cookie: c.name,
      detail: `cookie "${c.name}" set after consent but not listed in the declaration`,
    });
  }

  if (!acceptClicked && !rejectClicked && (preTrackers.length > 0)) {
    issues.push({
      phase: 'preconsent',
      kind: 'missing-banner',
      detail: 'no consent banner detected with Accept or Reject controls, yet non-essential cookies are present',
    });
  }

  const passed = issues.length === 0;

  const result: GdprResult = {
    page: pageUrl,
    bannerDetected: acceptClicked || rejectClicked,
    acceptClicked,
    rejectClicked,
    preconsentCookies,
    acceptedCookies,
    rejectedButSetCookies,
    undeclaredCookies,
    issues,
    passed,
  };
  if (declaredCookieNames) result.declaredCookieNames = declaredCookieNames;
  return result;
}
