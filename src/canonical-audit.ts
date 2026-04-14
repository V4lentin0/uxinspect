import type { Page, BrowserContext } from 'playwright';
import { URL } from 'node:url';

export type CanonicalIssueType =
  | 'missing-canonical'
  | 'relative-canonical'
  | 'protocol-mismatch'
  | 'host-mismatch'
  | 'trailing-slash-mismatch'
  | 'case-mismatch'
  | 'query-param-mismatch'
  | 'canonical-chain'
  | 'canonical-points-to-redirect'
  | 'canonical-points-to-404'
  | 'self-referential-fragment'
  | 'multiple-canonicals'
  | 'canonical-not-in-head'
  | 'canonical-mismatches-og-url';

export interface CanonicalIssue {
  type: CanonicalIssueType;
  severity: 'info' | 'warn' | 'error';
  detail: string;
}

export interface CanonicalAuditResult {
  page: string;
  canonical: string | null;
  effectiveCanonical: string | null;
  ogUrl: string | null;
  issues: CanonicalIssue[];
  passed: boolean;
}

interface CanonicalDom {
  hrefs: string[];
  inHead: boolean[];
  ogUrl: string | null;
}

interface CanonicalFetchResult {
  status: number;
  redirectLocation: string | null;
  finalUrl: string;
  body: string;
}

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'utm_id', 'fbclid', 'gclid', 'ref', 'session', 'sid',
]);

const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' };

function stripDefaultPort(u: URL): void {
  if (u.port && DEFAULT_PORTS[u.protocol] === u.port) u.port = '';
}

function stripTrackingParams(u: URL): void {
  const keep: [string, string][] = [];
  u.searchParams.forEach((v, k) => {
    if (!TRACKING_PARAMS.has(k.toLowerCase())) keep.push([k, v]);
  });
  u.search = '';
  for (const [k, v] of keep) u.searchParams.append(k, v);
}

function stripWww(host: string): string {
  return host.startsWith('www.') ? host.slice(4) : host;
}

function normalizeUrl(raw: string): string {
  const u = new URL(raw);
  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();
  stripDefaultPort(u);
  stripTrackingParams(u);
  u.hash = '';
  return u.toString();
}

function nonTrackingParams(u: URL): string[] {
  const out: string[] = [];
  u.searchParams.forEach((_v, k) => {
    if (!TRACKING_PARAMS.has(k.toLowerCase())) out.push(k);
  });
  return out;
}

function trailingSlash(path: string): boolean {
  return path.length > 1 && path.endsWith('/');
}

async function readDom(page: Page): Promise<CanonicalDom> {
  return await page.evaluate(() => {
    const links = Array.from(
      document.querySelectorAll('link[rel="canonical"]'),
    ) as HTMLLinkElement[];
    const hrefs: string[] = [];
    const inHead: boolean[] = [];
    for (const link of links) {
      hrefs.push(link.getAttribute('href') ?? '');
      inHead.push(link.parentElement?.tagName?.toLowerCase() === 'head');
    }
    const og = document.querySelector('meta[property="og:url"]') as HTMLMetaElement | null;
    return { hrefs, inHead, ogUrl: og?.getAttribute('content') ?? null };
  });
}

async function fetchCanonical(
  ctx: BrowserContext,
  url: string,
  maxRedirects: number,
): Promise<CanonicalFetchResult | null> {
  try {
    const res = await ctx.request.get(url, { maxRedirects, failOnStatusCode: false });
    let body = '';
    try { body = await res.text(); } catch { body = ''; }
    const headers = res.headers();
    return {
      status: res.status(),
      redirectLocation: headers['location'] ?? null,
      finalUrl: res.url(),
      body,
    };
  } catch {
    return null;
  }
}

function extractCanonicalFromHtml(html: string): string | null {
  const tag = /<link[^>]+rel\s*=\s*["']?canonical["']?[^>]*>/i.exec(html);
  if (!tag) return null;
  const m = /href\s*=\s*["']([^"']+)["']/i.exec(tag[0]);
  return m ? m[1] : null;
}

function pushIssue(
  issues: CanonicalIssue[],
  type: CanonicalIssueType,
  severity: CanonicalIssue['severity'],
  detail: string,
): void {
  issues.push({ type, severity, detail });
}

export async function auditCanonical(
  page: Page,
  opts?: { followChain?: boolean },
): Promise<CanonicalAuditResult> {
  const followChain = opts?.followChain ?? true;
  const pageUrl = page.url();
  const issues: CanonicalIssue[] = [];

  const dom = await readDom(page);
  const ogUrl = dom.ogUrl;

  if (dom.hrefs.length === 0) {
    pushIssue(issues, 'missing-canonical', 'error', 'no link[rel="canonical"] found');
    return { page: pageUrl, canonical: null, effectiveCanonical: null, ogUrl, issues, passed: false };
  }

  if (dom.hrefs.length > 1) {
    pushIssue(issues, 'multiple-canonicals', 'error',
      `found ${dom.hrefs.length} canonical links; using first`);
  }

  const rawCanonical = dom.hrefs[0];

  if (!dom.inHead[0]) {
    pushIssue(issues, 'canonical-not-in-head', 'warn', 'canonical link is not inside <head>');
  }

  if (!/^[a-z][a-z0-9+.-]*:/i.test(rawCanonical)) {
    pushIssue(issues, 'relative-canonical', 'warn', `canonical "${rawCanonical}" is relative`);
  }

  let canonicalAbs: URL;
  try {
    canonicalAbs = new URL(rawCanonical, pageUrl);
  } catch {
    pushIssue(issues, 'missing-canonical', 'error',
      `canonical "${rawCanonical}" is not a valid URL`);
    return {
      page: pageUrl, canonical: rawCanonical, effectiveCanonical: rawCanonical,
      ogUrl, issues, passed: false,
    };
  }

  const pageU = new URL(pageUrl);

  if (canonicalAbs.hash) {
    pushIssue(issues, 'self-referential-fragment', 'error',
      `canonical contains fragment "${canonicalAbs.hash}"`);
  }

  if (canonicalAbs.protocol !== pageU.protocol) {
    pushIssue(issues, 'protocol-mismatch', 'error',
      `page is ${pageU.protocol} but canonical is ${canonicalAbs.protocol}`);
  }

  const cHost = canonicalAbs.hostname.toLowerCase();
  const pHost = pageU.hostname.toLowerCase();
  if (cHost !== pHost && stripWww(cHost) !== stripWww(pHost)) {
    pushIssue(issues, 'host-mismatch', 'warn',
      `canonical host "${canonicalAbs.hostname}" differs from page host "${pageU.hostname}"`);
  }

  if (trailingSlash(canonicalAbs.pathname) !== trailingSlash(pageU.pathname)) {
    pushIssue(issues, 'trailing-slash-mismatch', 'info',
      `canonical path "${canonicalAbs.pathname}" trailing slash differs from page "${pageU.pathname}"`);
  }

  if (
    canonicalAbs.pathname !== pageU.pathname &&
    canonicalAbs.pathname.toLowerCase() === pageU.pathname.toLowerCase()
  ) {
    pushIssue(issues, 'case-mismatch', 'info', 'canonical path case differs from page path');
  }

  const cParams = nonTrackingParams(canonicalAbs);
  const pParams = nonTrackingParams(pageU);
  if (cParams.length === 0 && pParams.length > 0) {
    pushIssue(issues, 'query-param-mismatch', 'warn',
      `page has non-tracking params [${pParams.join(', ')}] but canonical has none`);
  }

  let effectiveCanonical = canonicalAbs.toString();

  if (followChain) {
    const ctx = page.context();
    const initial = await fetchCanonical(ctx, canonicalAbs.toString(), 0);
    if (initial) {
      if (initial.status >= 300 && initial.status < 400) {
        pushIssue(issues, 'canonical-points-to-redirect', 'error',
          `canonical "${canonicalAbs.toString()}" returned ${initial.status}` +
          (initial.redirectLocation ? ` -> ${initial.redirectLocation}` : ''));
        const followed = await fetchCanonical(ctx, canonicalAbs.toString(), 5);
        if (followed) {
          effectiveCanonical = followed.finalUrl;
          const targetCanonical = extractCanonicalFromHtml(followed.body);
          if (targetCanonical) {
            let targetAbs: string;
            try { targetAbs = new URL(targetCanonical, followed.finalUrl).toString(); }
            catch { targetAbs = targetCanonical; }
            try {
              if (normalizeUrl(targetAbs) !== normalizeUrl(canonicalAbs.toString())) {
                pushIssue(issues, 'canonical-chain', 'error',
                  `canonical -> redirect target declares different canonical "${targetAbs}"`);
              }
            } catch { /* normalization failed; skip chain comparison */ }
          }
        }
      } else if (initial.status >= 400) {
        pushIssue(issues, 'canonical-points-to-404', 'error',
          `canonical "${canonicalAbs.toString()}" returned ${initial.status}`);
      }
    }
  }

  if (ogUrl) {
    try {
      const ogAbs = new URL(ogUrl, pageUrl).toString();
      if (normalizeUrl(ogAbs) !== normalizeUrl(canonicalAbs.toString())) {
        pushIssue(issues, 'canonical-mismatches-og-url', 'warn',
          `og:url "${ogUrl}" differs from canonical "${canonicalAbs.toString()}"`);
      }
    } catch { /* og:url not a valid URL; ignore */ }
  }

  return {
    page: pageUrl,
    canonical: canonicalAbs.toString(),
    effectiveCanonical,
    ogUrl,
    issues,
    passed: issues.every((i) => i.severity !== 'error'),
  };
}
