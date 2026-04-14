import type { Page, BrowserContext, Cookie } from 'playwright';

export interface CookieRecord {
  name: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None' | undefined;
  partitioned?: boolean;
  sessionOnly: boolean;
  likelyTracking: boolean;
}

export interface CookieIssue {
  name: string;
  kind:
    | 'missing-secure'
    | 'missing-httponly'
    | 'samesite-none-insecure'
    | 'no-samesite'
    | 'long-expiry'
    | 'tracking-no-consent'
    | 'session-key-insecure';
  detail: string;
}

export interface CookieFlagsResult {
  page: string;
  httpsPage: boolean;
  cookies: CookieRecord[];
  issues: CookieIssue[];
  stats: {
    total: number;
    secure: number;
    httpOnly: number;
    sameSiteStrict: number;
    sameSiteLax: number;
    sameSiteNone: number;
  };
  passed: boolean;
}

type CookieWithPartitioned = Cookie & { partitioned?: boolean };

const SESSION_KEY_PATTERN = /session|auth|token|jwt|sid|csrf/i;
const TRACKING_PATTERN =
  /_ga|_gid|_fbp|_pinterest_ct|optimizelyEndUser|mp_|amplitude|hotjar/i;
const CONSENT_PATTERN = /cookie_consent|consent|gdpr_consent|osano/i;
const TWO_YEARS_SECONDS = 60 * 60 * 24 * 365 * 2;

function normalizeSameSite(
  value: Cookie['sameSite']
): 'Strict' | 'Lax' | 'None' | undefined {
  if (value === 'Strict' || value === 'Lax' || value === 'None') {
    return value;
  }
  return undefined;
}

function hasPartitioned(cookie: Cookie): boolean | undefined {
  if (!('partitioned' in cookie)) {
    return undefined;
  }
  const withFlag = cookie as CookieWithPartitioned;
  if (typeof withFlag.partitioned !== 'boolean') {
    return undefined;
  }
  return withFlag.partitioned;
}

function buildRecord(cookie: Cookie): CookieRecord {
  const sameSite = normalizeSameSite(cookie.sameSite);
  const expires = typeof cookie.expires === 'number' ? cookie.expires : -1;
  const sessionOnly = expires === -1;
  const likelyTracking = TRACKING_PATTERN.test(cookie.name);
  const record: CookieRecord = {
    name: cookie.name,
    domain: cookie.domain,
    path: cookie.path,
    expires,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite,
    sessionOnly,
    likelyTracking,
  };
  const partitioned = hasPartitioned(cookie);
  if (partitioned !== undefined) {
    record.partitioned = partitioned;
  }
  return record;
}

function detectConsent(records: CookieRecord[]): boolean {
  for (const record of records) {
    if (CONSENT_PATTERN.test(record.name)) {
      return true;
    }
  }
  return false;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function evaluateCookie(
  record: CookieRecord,
  httpsPage: boolean,
  consentPresent: boolean,
  now: number
): CookieIssue[] {
  const issues: CookieIssue[] = [];
  const isSessionKey = SESSION_KEY_PATTERN.test(record.name);

  if (httpsPage && record.secure === false) {
    issues.push({
      name: record.name,
      kind: 'missing-secure',
      detail: `Cookie "${record.name}" lacks Secure on HTTPS origin`,
    });
  }

  if (isSessionKey && record.httpOnly === false) {
    issues.push({
      name: record.name,
      kind: 'missing-httponly',
      detail: `Session key "${record.name}" is not HttpOnly; exposed to JS`,
    });
    issues.push({
      name: record.name,
      kind: 'session-key-insecure',
      detail: `Session key "${record.name}" should be HttpOnly + Secure + SameSite`,
    });
  }

  if (record.sameSite === 'None' && !record.secure) {
    issues.push({
      name: record.name,
      kind: 'samesite-none-insecure',
      detail: `SameSite=None requires Secure; browsers will reject "${record.name}"`,
    });
  }

  if (httpsPage && record.sameSite === undefined) {
    issues.push({
      name: record.name,
      kind: 'no-samesite',
      detail: `Cookie "${record.name}" has no explicit SameSite attribute`,
    });
  }

  if (record.expires > 0 && record.expires - now > TWO_YEARS_SECONDS) {
    const years = ((record.expires - now) / (60 * 60 * 24 * 365)).toFixed(1);
    issues.push({
      name: record.name,
      kind: 'long-expiry',
      detail: `Cookie "${record.name}" expires in ~${years}y (>2y)`,
    });
  }

  if (record.likelyTracking && !consentPresent) {
    issues.push({
      name: record.name,
      kind: 'tracking-no-consent',
      detail: `Tracking cookie "${record.name}" set without consent marker`,
    });
  }

  return issues;
}

function computeStats(records: CookieRecord[]): CookieFlagsResult['stats'] {
  let secure = 0;
  let httpOnly = 0;
  let sameSiteStrict = 0;
  let sameSiteLax = 0;
  let sameSiteNone = 0;
  for (const record of records) {
    if (record.secure) secure += 1;
    if (record.httpOnly) httpOnly += 1;
    if (record.sameSite === 'Strict') sameSiteStrict += 1;
    else if (record.sameSite === 'Lax') sameSiteLax += 1;
    else if (record.sameSite === 'None') sameSiteNone += 1;
  }
  return {
    total: records.length,
    secure,
    httpOnly,
    sameSiteStrict,
    sameSiteLax,
    sameSiteNone,
  };
}

function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

export async function auditCookieFlags(
  page: Page,
  ctx: BrowserContext
): Promise<CookieFlagsResult> {
  const pageUrl = page.url();
  const httpsPage = isHttpsUrl(pageUrl);
  const rawCookies = await ctx.cookies(pageUrl);
  const records: CookieRecord[] = rawCookies.map(buildRecord);
  const consentPresent = detectConsent(records);
  const now = nowSeconds();
  const issues: CookieIssue[] = [];
  for (const record of records) {
    const cookieIssues = evaluateCookie(record, httpsPage, consentPresent, now);
    for (const issue of cookieIssues) {
      issues.push(issue);
    }
  }
  const stats = computeStats(records);
  const passed = issues.length === 0;
  return {
    page: pageUrl,
    httpsPage,
    cookies: records,
    issues,
    stats,
    passed,
  };
}
