import type { BrowserContext, Page, Response } from 'playwright';

export interface ErrorPageCheck {
  probedUrl: string;
  expectedKind: '404' | '500';
  actualStatus: number;
  hasBranding: boolean;
  hasHomeLink: boolean;
  hasSearch: boolean;
  hasNavigation: boolean;
  byteSize: number;
  wordCount: number;
  isSoftError: boolean;
}

export interface ErrorPageIssue {
  kind:
    | 'soft-404'
    | 'generic-error-page'
    | 'no-home-link'
    | 'no-search'
    | 'missing-error-page'
    | 'wrong-status';
  probedUrl: string;
  message: string;
}

export interface ErrorPageAuditResult {
  origin: string;
  checks: ErrorPageCheck[];
  issues: ErrorPageIssue[];
  passed: boolean;
}

interface PageSignals {
  hasBranding: boolean;
  hasHomeLink: boolean;
  hasSearch: boolean;
  hasNavigation: boolean;
  wordCount: number;
  bodyText: string;
}

interface ProbeSpec {
  url: string;
  expectedKind: '404' | '500';
}

const NAV_TIMEOUT_MS = 15_000;
const SOFT_404_WORD_THRESHOLD = 500;
const FATAL_ISSUE_KINDS: ReadonlySet<ErrorPageIssue['kind']> = new Set([
  'soft-404',
  'wrong-status',
  'missing-error-page',
]);

function randomToken(): string {
  const now = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${now}-${rand}`;
}

function normalizeOrigin(originUrl: string): string {
  try {
    const u = new URL(originUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return originUrl.replace(/\/+$/, '');
  }
}

function buildProbes(origin: string): ProbeSpec[] {
  const base = normalizeOrigin(origin);
  const token = randomToken();
  return [
    { url: `${base}/uxinspect-nonexistent-${token}`, expectedKind: '404' },
    { url: `${base}/does-not-exist-xyz-abc`, expectedKind: '404' },
    { url: `${base}/uxinspect-trigger-500?x=${token}`, expectedKind: '500' },
  ];
}

async function collectSignals(page: Page): Promise<PageSignals> {
  return await page.evaluate((): PageSignals => {
    const hasLogoImg = document.querySelector('img[alt*="logo" i]') !== null;
    const iconLink = document.querySelector(
      'link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]',
    );
    let iconHasHref = false;
    if (iconLink instanceof HTMLLinkElement) {
      iconHasHref = iconLink.getAttribute('href') !== null && iconLink.getAttribute('href')!.trim().length > 0;
    }
    const hasBranding = hasLogoImg || iconHasHref;

    const homeLink =
      document.querySelector('a[href="/"]') !== null ||
      document.querySelector('a[href="/home"]') !== null;

    const hasSearch =
      document.querySelector('input[type="search"]') !== null ||
      document.querySelector('form[role="search"]') !== null;

    const hasNavigation =
      document.querySelector('nav') !== null ||
      document.querySelector('[role="navigation"]') !== null;

    const body = document.body;
    const raw = body ? (body.innerText ?? '') : '';
    const trimmed = raw.trim();
    const words = trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;

    return {
      hasBranding,
      hasHomeLink: homeLink,
      hasSearch,
      hasNavigation,
      wordCount: words,
      bodyText: trimmed,
    };
  });
}

function looksLikeErrorText(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.includes('404')) return true;
  if (lower.includes('not found')) return true;
  return false;
}

async function measureByteSize(response: Response | null): Promise<number> {
  if (!response) return 0;
  try {
    const body = await response.body();
    return body.byteLength;
  } catch {
    return 0;
  }
}

function buildFailedCheck(spec: ProbeSpec): ErrorPageCheck {
  return {
    probedUrl: spec.url,
    expectedKind: spec.expectedKind,
    actualStatus: 0,
    hasBranding: false,
    hasHomeLink: false,
    hasSearch: false,
    hasNavigation: false,
    byteSize: 0,
    wordCount: 0,
    isSoftError: false,
  };
}

async function closeQuietly(page: Page): Promise<void> {
  try {
    await page.close();
  } catch {
    /* ignore */
  }
}

async function probeOne(
  ctx: BrowserContext,
  spec: ProbeSpec,
): Promise<{ check: ErrorPageCheck; issues: ErrorPageIssue[] }> {
  const issues: ErrorPageIssue[] = [];
  let page: Page;
  try {
    page = await ctx.newPage();
  } catch {
    issues.push({
      kind: 'missing-error-page',
      probedUrl: spec.url,
      message: 'failed to open probe page in browser context',
    });
    return { check: buildFailedCheck(spec), issues };
  }

  let response: Response | null = null;
  let navError: string | null = null;
  try {
    response = await page.goto(spec.url, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT_MS,
    });
  } catch (err) {
    navError = err instanceof Error ? err.message : 'navigation failed';
  }

  if (!response || navError) {
    issues.push({
      kind: 'missing-error-page',
      probedUrl: spec.url,
      message: navError ?? 'no response received',
    });
    await closeQuietly(page);
    return { check: buildFailedCheck(spec), issues };
  }

  const actualStatus = response.status();
  const byteSize = await measureByteSize(response);

  let signals: PageSignals;
  try {
    signals = await collectSignals(page);
  } catch {
    signals = {
      hasBranding: false,
      hasHomeLink: false,
      hasSearch: false,
      hasNavigation: false,
      wordCount: 0,
      bodyText: '',
    };
  }

  const bodyLooksLikeError = looksLikeErrorText(signals.bodyText);
  const isSoftError =
    spec.expectedKind === '404' &&
    actualStatus === 200 &&
    signals.wordCount < SOFT_404_WORD_THRESHOLD;

  if (spec.expectedKind === '404' && actualStatus === 200 && bodyLooksLikeError) {
    issues.push({
      kind: 'wrong-status',
      probedUrl: spec.url,
      message: `page body looks like an error (contains "404"/"not found") but server returned 200`,
    });
  }

  if (isSoftError) {
    issues.push({
      kind: 'soft-404',
      probedUrl: spec.url,
      message: `expected 404 but got 200 with only ${signals.wordCount} words — likely a soft 404`,
    });
  }

  if (!signals.hasBranding) {
    issues.push({
      kind: 'generic-error-page',
      probedUrl: spec.url,
      message: 'no logo image or icon link detected — page looks generic/unbranded',
    });
  }

  if (!signals.hasHomeLink) {
    issues.push({
      kind: 'no-home-link',
      probedUrl: spec.url,
      message: 'no <a href="/"> or <a href="/home"> link found',
    });
  }

  if (!signals.hasSearch) {
    issues.push({
      kind: 'no-search',
      probedUrl: spec.url,
      message: 'no search input or search form detected (advisory)',
    });
  }

  const check: ErrorPageCheck = {
    probedUrl: spec.url,
    expectedKind: spec.expectedKind,
    actualStatus,
    hasBranding: signals.hasBranding,
    hasHomeLink: signals.hasHomeLink,
    hasSearch: signals.hasSearch,
    hasNavigation: signals.hasNavigation,
    byteSize,
    wordCount: signals.wordCount,
    isSoftError,
  };

  await closeQuietly(page);
  return { check, issues };
}

export async function auditErrorPages(
  ctx: BrowserContext,
  originUrl: string,
): Promise<ErrorPageAuditResult> {
  const origin = normalizeOrigin(originUrl);
  const probes = buildProbes(origin);
  const checks: ErrorPageCheck[] = [];
  const issues: ErrorPageIssue[] = [];

  for (const spec of probes) {
    const { check, issues: probeIssues } = await probeOne(ctx, spec);
    checks.push(check);
    for (const issue of probeIssues) issues.push(issue);
  }

  const passed = !issues.some((i) => FATAL_ISSUE_KINDS.has(i.kind));

  return { origin, checks, issues, passed };
}
