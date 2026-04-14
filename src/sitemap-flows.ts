import type { Flow, Step } from './types.js';

export interface SitemapFlowOptions {
  maxUrls?: number;
  sameOriginOnly?: boolean;
  includePattern?: string;
  excludePattern?: string;
  flowNamePrefix?: string;
  screenshot?: boolean;
}

const FETCH_TIMEOUT_MS = 10_000;
const MAX_CHILD_SITEMAPS = 10;
const DEFAULT_MAX_URLS = 50;
const SLUG_MAX_LEN = 60;

function extractLocs(xml: string): string[] {
  const locs: string[] = [];
  const re = /<(?:[a-zA-Z0-9_-]+:)?loc\s*>\s*([\s\S]*?)\s*<\/(?:[a-zA-Z0-9_-]+:)?loc\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const val = m[1].trim();
    if (val) locs.push(decodeXmlEntities(val));
  }
  return locs;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function isSitemapIndex(xml: string): boolean {
  return /<(?:[a-zA-Z0-9_-]+:)?sitemapindex\b/i.test(xml);
}

async function fetchText(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch sitemap ${url}: ${msg}`);
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch sitemap ${url}: HTTP ${res.status}`);
  }
  try {
    return await res.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read sitemap body ${url}: ${msg}`);
  }
}

function dedupePreserveOrder(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

export async function fetchSitemapUrls(sitemapUrl: string): Promise<string[]> {
  const xml = await fetchText(sitemapUrl);

  if (isSitemapIndex(xml)) {
    const childSitemaps = dedupePreserveOrder(extractLocs(xml)).slice(0, MAX_CHILD_SITEMAPS);
    const collected: string[] = [];
    const results = await Promise.all(
      childSitemaps.map(async (child) => {
        try {
          return await fetchText(child);
        } catch {
          return '';
        }
      })
    );
    for (const childXml of results) {
      if (!childXml) continue;
      collected.push(...extractLocs(childXml));
    }
    return dedupePreserveOrder(collected);
  }

  return dedupePreserveOrder(extractLocs(xml));
}

function safeParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function slugifyPath(urlStr: string): string {
  const u = safeParseUrl(urlStr);
  const rawPath = u ? u.pathname : urlStr.split('?')[0].split('#')[0];
  let slug = rawPath.toLowerCase();
  slug = slug.replace(/\//g, '-');
  slug = slug.replace(/[^a-z0-9-]+/g, '-');
  slug = slug.replace(/-+/g, '-');
  slug = slug.replace(/^-+|-+$/g, '');
  if (slug.length > SLUG_MAX_LEN) slug = slug.slice(0, SLUG_MAX_LEN).replace(/-+$/g, '');
  return slug;
}

function compileRegex(pattern: string | undefined): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

export function urlsToFlows(urls: string[], baseUrl: string, opts?: SitemapFlowOptions): Flow[] {
  const maxUrls = opts?.maxUrls ?? DEFAULT_MAX_URLS;
  const sameOriginOnly = opts?.sameOriginOnly ?? true;
  const prefix = opts?.flowNamePrefix ?? 'page';
  const includeScreenshot = opts?.screenshot ?? true;

  const includeRe = compileRegex(opts?.includePattern);
  const excludeRe = compileRegex(opts?.excludePattern);

  const baseParsed = safeParseUrl(baseUrl);
  const baseOrigin = baseParsed?.origin ?? null;

  const deduped = dedupePreserveOrder(urls);

  const filtered: string[] = [];
  for (const raw of deduped) {
    const parsed = safeParseUrl(raw);
    if (!parsed) continue;

    if (sameOriginOnly) {
      if (!baseOrigin) continue;
      if (parsed.origin !== baseOrigin) continue;
    }

    if (includeRe && !includeRe.test(raw)) continue;
    if (excludeRe && excludeRe.test(raw)) continue;

    filtered.push(raw);
    if (filtered.length >= maxUrls) break;
  }

  const flows: Flow[] = filtered.map((url, i) => {
    const idx = String(i + 1).padStart(3, '0');
    const pathSlug = slugifyPath(url);
    const name = pathSlug ? `${prefix}-${idx}-${pathSlug}` : `${prefix}-${idx}`;

    const steps: Step[] = [{ goto: url }];
    if (includeScreenshot) {
      steps.push({ screenshot: `${prefix}-${idx}.png` });
    }
    return { name, steps };
  });

  return flows;
}

export async function sitemapToFlows(sitemapUrl: string, opts?: SitemapFlowOptions): Promise<Flow[]> {
  const urls = await fetchSitemapUrls(sitemapUrl);
  return urlsToFlows(urls, sitemapUrl, opts);
}
