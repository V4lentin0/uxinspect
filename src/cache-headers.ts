import type { Page } from 'playwright';

export type CacheCategory = 'html' | 'js' | 'css' | 'image' | 'font' | 'other';

export type CacheIssueType =
  | 'no-cache-control'
  | 'short-max-age'
  | 'missing-etag'
  | 'no-immutable-on-hashed'
  | 'html-cached-too-long';

export interface CacheHeadersResource {
  url: string;
  cacheControl?: string;
  etag?: string;
  lastModified?: string;
  expires?: string;
  age?: string;
  ageSeconds?: number;
  maxAge?: number;
  immutable: boolean;
  noCache: boolean;
  public: boolean;
  private: boolean;
  mustRevalidate: boolean;
  staleWhileRevalidate?: number;
  category: CacheCategory;
}

export interface CacheHeadersIssue {
  type: CacheIssueType;
  target: string;
  detail?: string;
}

export interface CacheHeadersResult {
  page: string;
  resources: CacheHeadersResource[];
  issues: CacheHeadersIssue[];
  passed: boolean;
}

interface ResourceEntry {
  name: string;
  initiatorType: string;
}

interface ParsedCacheControl {
  raw?: string;
  maxAge?: number;
  sMaxAge?: number;
  staleWhileRevalidate?: number;
  immutable: boolean;
  noCache: boolean;
  noStore: boolean;
  public: boolean;
  private: boolean;
  mustRevalidate: boolean;
}

const CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 5000;
const MIN_STATIC_MAX_AGE = 3600;
const MAX_HTML_MAX_AGE = 3600;

function parseCacheControl(value: string | undefined | null): ParsedCacheControl {
  const out: ParsedCacheControl = {
    raw: value || undefined,
    immutable: false,
    noCache: false,
    noStore: false,
    public: false,
    private: false,
    mustRevalidate: false,
  };
  if (!value) return out;
  const tokens = value.split(',').map((t) => t.trim()).filter(Boolean);
  for (const token of tokens) {
    const eq = token.indexOf('=');
    const key = (eq >= 0 ? token.slice(0, eq) : token).toLowerCase();
    const rawVal = eq >= 0 ? token.slice(eq + 1).trim().replace(/^"|"$/g, '') : '';
    switch (key) {
      case 'max-age': {
        const n = Number.parseInt(rawVal, 10);
        if (Number.isFinite(n)) out.maxAge = n;
        break;
      }
      case 's-maxage': {
        const n = Number.parseInt(rawVal, 10);
        if (Number.isFinite(n)) out.sMaxAge = n;
        break;
      }
      case 'stale-while-revalidate': {
        const n = Number.parseInt(rawVal, 10);
        if (Number.isFinite(n)) out.staleWhileRevalidate = n;
        break;
      }
      case 'immutable': out.immutable = true; break;
      case 'no-cache': out.noCache = true; break;
      case 'no-store': out.noStore = true; break;
      case 'public': out.public = true; break;
      case 'private': out.private = true; break;
      case 'must-revalidate': out.mustRevalidate = true; break;
    }
  }
  return out;
}

function categorizeUrl(url: string, isPageUrl: boolean): CacheCategory {
  if (isPageUrl) return 'html';
  let pathname = '';
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    pathname = url.toLowerCase();
  }
  if (pathname.endsWith('.html') || pathname.endsWith('.htm')) return 'html';
  if (pathname.endsWith('.js') || pathname.endsWith('.mjs') || pathname.endsWith('.cjs')) return 'js';
  if (pathname.endsWith('.css')) return 'css';
  if (/\.(woff2?|ttf|otf|eot)$/.test(pathname)) return 'font';
  if (/\.(png|jpe?g|webp|svg|gif|avif|ico|bmp)$/.test(pathname)) return 'image';
  return 'other';
}

function isHashedAsset(url: string): boolean {
  let pathname = '';
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }
  const base = pathname.split('/').pop() || '';
  // Matches filenames like: main.abc123.js, chunk-a1b2c3d4.css, app.1a2b3c4d5e6f.woff2
  // Requires a hash segment (hex or base36-ish) of length >= 6 between dots before extension.
  return /\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9]+$/.test(base) ||
    /[.-][A-Fa-f0-9]{8,}\.[A-Za-z0-9]+$/.test(base);
}

function isFetchableUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

async function fetchHeaders(url: string): Promise<Headers | null> {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return res.headers;
  } catch {
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return res.headers;
    } catch {
      return null;
    }
  }
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const runners: Promise<void>[] = [];
  const spawn = async (): Promise<void> => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      try {
        const value = await worker(items[idx]!);
        results[idx] = { status: 'fulfilled', value };
      } catch (reason) {
        results[idx] = { status: 'rejected', reason };
      }
    }
  };
  for (let i = 0; i < Math.min(limit, items.length); i++) runners.push(spawn());
  await Promise.all(runners);
  return results;
}

function buildResource(url: string, headers: Headers | null, isPageUrl: boolean): CacheHeadersResource {
  const category = categorizeUrl(url, isPageUrl);
  const cacheControl = headers?.get('cache-control') || undefined;
  const parsed = parseCacheControl(cacheControl);
  const etag = headers?.get('etag') || undefined;
  const lastModified = headers?.get('last-modified') || undefined;
  const expires = headers?.get('expires') || undefined;
  const age = headers?.get('age') || undefined;
  let ageSeconds: number | undefined;
  if (age) {
    const n = Number.parseInt(age, 10);
    if (Number.isFinite(n)) ageSeconds = n;
  }
  return {
    url,
    cacheControl,
    etag,
    lastModified,
    expires,
    age,
    ageSeconds,
    maxAge: parsed.maxAge,
    immutable: parsed.immutable,
    noCache: parsed.noCache,
    public: parsed.public,
    private: parsed.private,
    mustRevalidate: parsed.mustRevalidate,
    staleWhileRevalidate: parsed.staleWhileRevalidate,
    category,
  };
}

function evaluateIssues(resources: CacheHeadersResource[]): CacheHeadersIssue[] {
  const issues: CacheHeadersIssue[] = [];
  for (const r of resources) {
    const isStatic = r.category === 'js' || r.category === 'css' || r.category === 'image' || r.category === 'font';

    if (isStatic) {
      if (!r.cacheControl) {
        issues.push({ type: 'no-cache-control', target: r.url, detail: 'static asset has no Cache-Control header' });
      } else if (typeof r.maxAge !== 'number' || r.maxAge < MIN_STATIC_MAX_AGE) {
        issues.push({
          type: 'short-max-age',
          target: r.url,
          detail: `max-age=${r.maxAge ?? 'unset'} < ${MIN_STATIC_MAX_AGE}s recommended for static assets`,
        });
      }

      if (isHashedAsset(r.url) && !r.immutable) {
        issues.push({
          type: 'no-immutable-on-hashed',
          target: r.url,
          detail: 'hashed filename should include the immutable Cache-Control directive',
        });
      }

      if (!r.etag && !r.lastModified) {
        issues.push({
          type: 'missing-etag',
          target: r.url,
          detail: 'static asset missing both ETag and Last-Modified validators',
        });
      }
    }

    if (r.category === 'html') {
      if (
        typeof r.maxAge === 'number' &&
        r.maxAge > MAX_HTML_MAX_AGE &&
        typeof r.staleWhileRevalidate !== 'number'
      ) {
        issues.push({
          type: 'html-cached-too-long',
          target: r.url,
          detail: `HTML max-age=${r.maxAge}s without stale-while-revalidate`,
        });
      }
    }
  }
  return issues;
}

export async function auditCacheHeaders(page: Page): Promise<CacheHeadersResult> {
  const pageUrl = page.url();

  const entries = await page.evaluate((): ResourceEntry[] =>
    (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).map((r) => ({
      name: r.name,
      initiatorType: r.initiatorType,
    })),
  );

  const urlSet = new Set<string>();
  const urls: string[] = [];
  const addUrl = (u: string): void => {
    if (!isFetchableUrl(u)) return;
    if (urlSet.has(u)) return;
    urlSet.add(u);
    urls.push(u);
  };

  if (isFetchableUrl(pageUrl)) addUrl(pageUrl);
  for (const e of entries) addUrl(e.name);

  const settled = await runWithConcurrency(urls, CONCURRENCY, async (url) => {
    const headers = await fetchHeaders(url);
    return { url, headers };
  });

  const resources: CacheHeadersResource[] = [];
  for (const r of settled) {
    if (r.status !== 'fulfilled') continue;
    const { url, headers } = r.value;
    const isPageUrl = url === pageUrl;
    resources.push(buildResource(url, headers, isPageUrl));
  }

  const issues = evaluateIssues(resources);

  return {
    page: pageUrl,
    resources,
    issues,
    passed: issues.length === 0,
  };
}
