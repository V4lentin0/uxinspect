/**
 * worker-runtime — browserless subset of uxinspect checks.
 * Runs on any Fetch API environment using only fetch, URL, Headers.
 * No browser, no keys, no third-party deps.
 */

export interface WorkerRuntimeOptions {
  url: string;
  checks?: {
    redirects?: boolean;
    robotsAudit?: boolean;
    sitemap?: boolean;
    security?: boolean;
    canonical?: boolean;
    exposedPaths?: boolean | { extraPaths?: string[]; concurrency?: number };
    mixedContent?: boolean;
    meta?: boolean;
    bundleSize?: boolean;
    openGraph?: boolean;
    cacheHeaders?: boolean;
    compression?: boolean;
  };
  userAgent?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface RedirectHopInfo { from: string; to: string; status: number }

export interface WorkerRuntimeResult {
  url: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  redirects?: { hops: number; finalUrl: string; chain: RedirectHopInfo[]; passed: boolean };
  robotsAudit?: { present: boolean; allows: string[]; disallows: string[]; sitemaps: string[]; passed: boolean };
  sitemap?: { present: boolean; urlCount: number; passed: boolean };
  security?: { headers: Record<string, string>; missing: string[]; passed: boolean };
  canonical?: { canonical: string | null; matchesUrl: boolean; passed: boolean };
  exposedPaths?: { found: Array<{ path: string; status: number }>; passed: boolean };
  mixedContent?: { httpsPage: boolean; insecure: string[]; passed: boolean };
  meta?: { title: string; description: string; ogTitle: string; ogImage: string; twitterCard: string };
  bundleSize?: { totalJsBytes: number; totalCssBytes: number; fileCount: number; passed: boolean };
  openGraph?: { hasOgTitle: boolean; hasOgImage: boolean; hasOgDescription: boolean; passed: boolean };
  cacheHeaders?: { cacheable: number; noCache: number; maxAgeAvg: number; passed: boolean };
  compression?: { gzip: boolean; brotli: boolean; encoding: string; passed: boolean };
  passed: boolean;
}

export interface ExtractedMeta {
  title: string;
  description: string;
  ogTitle: string;
  ogImage: string;
  ogDescription: string;
  twitterCard: string;
  canonical: string | null;
}

export interface ExtractedAssets { js: string[]; css: string[]; images: string[] }

const DEFAULT_USER_AGENT = 'uxinspect-worker/1';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REDIRECT_HOPS = 20;
const DEFAULT_EXPOSED_CONCURRENCY = 5;
const BUNDLE_BUDGET = 1_500_000;

const DEFAULT_EXPOSED_PATHS: readonly string[] = [
  '.env', '.git/config', '.htaccess', 'backup.zip', 'wp-admin/',
  'phpinfo.php', '.DS_Store', 'package-lock.json', 'debug.log', '.svn/',
];

const REQUIRED_SECURITY_HEADERS: readonly string[] = [
  'strict-transport-security', 'content-security-policy', 'x-frame-options',
  'x-content-type-options', 'referrer-policy', 'permissions-policy',
];

interface FetchDeps { fetchImpl: typeof fetch; userAgent: string; timeoutMs: number }

function buildDeps(opts: WorkerRuntimeOptions): FetchDeps {
  return {
    fetchImpl: opts.fetchImpl ?? globalThis.fetch.bind(globalThis),
    userAgent: opts.userAgent ?? DEFAULT_USER_AGENT,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

async function doFetch(deps: FetchDeps, input: string, init: RequestInit = {}): Promise<Response> {
  const headers = init.headers instanceof Headers
    ? init.headers
    : new Headers(init.headers as Record<string, string> | undefined);
  if (!headers.has('user-agent')) headers.set('user-agent', deps.userAgent);
  return deps.fetchImpl(input, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(deps.timeoutMs),
  });
}

function resolveUrl(base: string, href: string): string | null {
  try { return new URL(href, base).toString(); } catch { return null; }
}

function attr(html: string, tagRe: RegExp, attrName: string): string | null {
  const m = html.match(tagRe);
  if (!m) return null;
  const am = m[0].match(new RegExp(`${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  if (!am) return null;
  return am[1] ?? am[2] ?? am[3] ?? null;
}

export function extractMeta(html: string): ExtractedMeta {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return {
    title: titleMatch ? titleMatch[1].trim() : '',
    description: attr(html, /<meta[^>]+name\s*=\s*["']description["'][^>]*>/i, 'content') ?? '',
    ogTitle: attr(html, /<meta[^>]+property\s*=\s*["']og:title["'][^>]*>/i, 'content') ?? '',
    ogImage: attr(html, /<meta[^>]+property\s*=\s*["']og:image["'][^>]*>/i, 'content') ?? '',
    ogDescription: attr(html, /<meta[^>]+property\s*=\s*["']og:description["'][^>]*>/i, 'content') ?? '',
    twitterCard: attr(html, /<meta[^>]+name\s*=\s*["']twitter:card["'][^>]*>/i, 'content') ?? '',
    canonical: attr(html, /<link[^>]+rel\s*=\s*["']canonical["'][^>]*>/i, 'href'),
  };
}

export function extractAssets(html: string, baseUrl: string): ExtractedAssets {
  const js: string[] = [];
  const css: string[] = [];
  const images: string[] = [];

  const scriptRe = /<script\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = scriptRe.exec(html)) !== null) {
    const abs = resolveUrl(baseUrl, m[1] ?? m[2] ?? m[3]);
    if (abs) js.push(abs);
  }

  const linkRe = /<link\b[^>]*>/gi;
  while ((m = linkRe.exec(html)) !== null) {
    const tag = m[0];
    const relAttr = tag.match(/\brel\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
    const rel = (relAttr?.[1] ?? relAttr?.[2] ?? relAttr?.[3] ?? '').toLowerCase();
    if (!rel.split(/\s+/).includes('stylesheet')) continue;
    const hrefAttr = tag.match(/\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
    const href = hrefAttr?.[1] ?? hrefAttr?.[2] ?? hrefAttr?.[3];
    if (!href) continue;
    const abs = resolveUrl(baseUrl, href);
    if (abs) css.push(abs);
  }

  const imgRe = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/gi;
  while ((m = imgRe.exec(html)) !== null) {
    const abs = resolveUrl(baseUrl, m[1] ?? m[2] ?? m[3]);
    if (abs) images.push(abs);
  }

  return { js, css, images };
}

async function runConcurrent<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let idx = 0;
  const n = Math.max(1, Math.min(concurrency, tasks.length));
  const workers: Promise<void>[] = [];
  for (let w = 0; w < n; w++) {
    workers.push((async () => {
      while (idx < tasks.length) {
        const i = idx++;
        results[i] = await tasks[i]();
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

async function checkRedirects(deps: FetchDeps, url: string): Promise<NonNullable<WorkerRuntimeResult['redirects']>> {
  const chain: RedirectHopInfo[] = [];
  let current = url;
  let hops = 0;
  let finalStatus = 0;

  for (let i = 0; i < MAX_REDIRECT_HOPS; i++) {
    let res: Response;
    try {
      res = await doFetch(deps, current, { method: 'GET', redirect: 'manual' });
    } catch { break; }
    finalStatus = res.status;
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) break;
      const next = resolveUrl(current, loc);
      if (!next || next === current) break;
      chain.push({ from: current, to: next, status: res.status });
      current = next;
      hops++;
      continue;
    }
    break;
  }

  const passed = hops <= 3 && (finalStatus === 0 || finalStatus < 400);
  return { hops, finalUrl: current, chain, passed };
}

async function checkRobots(deps: FetchDeps, url: string): Promise<NonNullable<WorkerRuntimeResult['robotsAudit']>> {
  const robotsUrl = `${new URL(url).origin}/robots.txt`;
  const allows: string[] = [];
  const disallows: string[] = [];
  const sitemaps: string[] = [];
  let present = false;

  try {
    const res = await doFetch(deps, robotsUrl, { method: 'GET' });
    if (res.status === 200) {
      present = true;
      const body = await res.text();
      for (const rawLine of body.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const sep = line.indexOf(':');
        if (sep < 0) continue;
        const key = line.slice(0, sep).trim().toLowerCase();
        const value = line.slice(sep + 1).trim();
        if (!value) continue;
        if (key === 'allow') allows.push(value);
        else if (key === 'disallow') disallows.push(value);
        else if (key === 'sitemap') sitemaps.push(value);
      }
    }
  } catch { /* absent */ }

  return { present, allows, disallows, sitemaps, passed: present };
}

async function checkSitemap(deps: FetchDeps, url: string, sitemapUrls: string[]): Promise<NonNullable<WorkerRuntimeResult['sitemap']>> {
  const candidates = sitemapUrls.length > 0 ? sitemapUrls : [`${new URL(url).origin}/sitemap.xml`];
  for (const candidate of candidates) {
    try {
      const res = await doFetch(deps, candidate, { method: 'GET' });
      if (res.status !== 200) continue;
      const body = await res.text();
      const urlCount = (body.match(/<url\b/gi)?.length ?? 0) + (body.match(/<sitemap\b/gi)?.length ?? 0);
      if (urlCount > 0 || /<urlset\b/i.test(body) || /<sitemapindex\b/i.test(body)) {
        return { present: true, urlCount, passed: urlCount > 0 };
      }
    } catch { /* try next */ }
  }
  return { present: false, urlCount: 0, passed: false };
}

async function checkSecurity(deps: FetchDeps, url: string): Promise<NonNullable<WorkerRuntimeResult['security']>> {
  const headers: Record<string, string> = {};
  const missing: string[] = [];
  try {
    const res = await doFetch(deps, url, { method: 'GET', redirect: 'follow' });
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  } catch {
    return { headers, missing: [...REQUIRED_SECURITY_HEADERS], passed: false };
  }
  for (const h of REQUIRED_SECURITY_HEADERS) if (!headers[h]) missing.push(h);
  return { headers, missing, passed: missing.length === 0 };
}

function normaliseUrl(u: string): string {
  try {
    const parsed = new URL(u);
    parsed.hash = '';
    const out = parsed.toString();
    return out.endsWith('/') ? out.slice(0, -1) : out;
  } catch { return u; }
}

function collectInsecure(html: string): string[] {
  const insecure = new Set<string>();
  const re = /\b(?:src|href)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const val = m[1] ?? m[2] ?? m[3];
    if (val && /^http:\/\//i.test(val)) insecure.add(val);
  }
  return [...insecure];
}

async function checkExposedPaths(
  deps: FetchDeps, url: string, extra: string[], concurrency: number,
): Promise<NonNullable<WorkerRuntimeResult['exposedPaths']>> {
  const base = new URL(url).origin;
  const paths = [...DEFAULT_EXPOSED_PATHS, ...extra.map((p) => p.replace(/^\//, ''))];
  const tasks = paths.map((p) => async (): Promise<{ path: string; status: number } | null> => {
    try {
      const res = await doFetch(deps, `${base}/${p}`, { method: 'HEAD', redirect: 'manual' });
      if (res.status === 200 || res.status === 206) return { path: p, status: res.status };
      return null;
    } catch { return null; }
  });
  const raw = await runConcurrent(tasks, concurrency);
  const found = raw.filter((r): r is { path: string; status: number } => r !== null);
  return { found, passed: found.length === 0 };
}

interface AssetStats {
  bundle: NonNullable<WorkerRuntimeResult['bundleSize']>;
  cache: NonNullable<WorkerRuntimeResult['cacheHeaders']>;
}

async function bundleSizes(deps: FetchDeps, assets: ExtractedAssets): Promise<AssetStats> {
  const targets = [...assets.js, ...assets.css];
  let totalJs = 0;
  let totalCss = 0;
  let cacheable = 0;
  let noCache = 0;
  let maxAgeSum = 0;
  let maxAgeCount = 0;

  const tasks = targets.map((href, i) => async (): Promise<void> => {
    try {
      const res = await doFetch(deps, href, { method: 'HEAD' });
      const len = Number.parseInt(res.headers.get('content-length') ?? '0', 10);
      const size = Number.isFinite(len) && len > 0 ? len : 0;
      if (i < assets.js.length) totalJs += size;
      else totalCss += size;

      const cc = (res.headers.get('cache-control') ?? '').toLowerCase();
      if (!cc || /no-store|no-cache/.test(cc)) {
        noCache++;
      } else {
        const ma = cc.match(/max-age\s*=\s*(\d+)/);
        const age = ma ? Number.parseInt(ma[1], 10) : 0;
        if (age > 0 || /public|immutable/.test(cc)) cacheable++;
        else noCache++;
        if (age > 0) { maxAgeSum += age; maxAgeCount++; }
      }
    } catch { /* skip */ }
  });

  await runConcurrent(tasks, 5);

  return {
    bundle: {
      totalJsBytes: totalJs,
      totalCssBytes: totalCss,
      fileCount: targets.length,
      passed: totalJs + totalCss <= BUNDLE_BUDGET,
    },
    cache: {
      cacheable,
      noCache,
      maxAgeAvg: maxAgeCount > 0 ? Math.round(maxAgeSum / maxAgeCount) : 0,
      passed: targets.length === 0 ? true : cacheable >= noCache,
    },
  };
}

function compressionFrom(headers: Headers): NonNullable<WorkerRuntimeResult['compression']> {
  const encoding = (headers.get('content-encoding') ?? '').toLowerCase();
  return {
    gzip: /gzip/.test(encoding),
    brotli: /\bbr\b/.test(encoding),
    encoding,
    passed: /gzip/.test(encoding) || /\bbr\b/.test(encoding),
  };
}

export async function runWorkerRuntime(opts: WorkerRuntimeOptions): Promise<WorkerRuntimeResult> {
  const deps = buildDeps(opts);
  const checks = opts.checks ?? {};
  const startedAt = new Date();

  let primaryHtml = '';
  let primaryHeaders = new Headers();
  try {
    const res = await doFetch(deps, opts.url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'accept-encoding': 'gzip, br' },
    });
    primaryHeaders = res.headers;
    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    if (ct.includes('text/html') || ct.includes('xml')) primaryHtml = await res.text();
  } catch { primaryHtml = ''; }

  const meta = extractMeta(primaryHtml);
  const assets = extractAssets(primaryHtml, opts.url);
  const result: WorkerRuntimeResult = {
    url: opts.url,
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    durationMs: 0,
    passed: true,
  };

  if (checks.redirects) result.redirects = await checkRedirects(deps, opts.url);

  let robotsSitemaps: string[] = [];
  if (checks.robotsAudit) {
    result.robotsAudit = await checkRobots(deps, opts.url);
    robotsSitemaps = result.robotsAudit.sitemaps;
  }
  if (checks.sitemap) result.sitemap = await checkSitemap(deps, opts.url, robotsSitemaps);
  if (checks.security) result.security = await checkSecurity(deps, opts.url);

  if (checks.canonical) {
    const canonical = meta.canonical;
    const matchesUrl = canonical ? normaliseUrl(canonical) === normaliseUrl(opts.url) : false;
    result.canonical = { canonical, matchesUrl, passed: canonical !== null && matchesUrl };
  }

  if (checks.exposedPaths) {
    const cfg = typeof checks.exposedPaths === 'object' ? checks.exposedPaths : {};
    result.exposedPaths = await checkExposedPaths(
      deps, opts.url, cfg.extraPaths ?? [], cfg.concurrency ?? DEFAULT_EXPOSED_CONCURRENCY,
    );
  }

  if (checks.mixedContent) {
    const httpsPage = opts.url.toLowerCase().startsWith('https://');
    const insecure = httpsPage ? collectInsecure(primaryHtml) : [];
    result.mixedContent = { httpsPage, insecure, passed: !httpsPage || insecure.length === 0 };
  }

  if (checks.meta) {
    result.meta = {
      title: meta.title,
      description: meta.description,
      ogTitle: meta.ogTitle,
      ogImage: meta.ogImage,
      twitterCard: meta.twitterCard,
    };
  }

  if (checks.bundleSize || checks.cacheHeaders) {
    const { bundle, cache } = await bundleSizes(deps, assets);
    if (checks.bundleSize) result.bundleSize = bundle;
    if (checks.cacheHeaders) result.cacheHeaders = cache;
  }

  if (checks.openGraph) {
    const hasOgTitle = meta.ogTitle.length > 0;
    const hasOgImage = meta.ogImage.length > 0;
    const hasOgDescription = meta.ogDescription.length > 0;
    result.openGraph = {
      hasOgTitle, hasOgImage, hasOgDescription,
      passed: hasOgTitle && hasOgImage && hasOgDescription,
    };
  }

  if (checks.compression) result.compression = compressionFrom(primaryHeaders);

  const finishedAt = new Date();
  result.finishedAt = finishedAt.toISOString();
  result.durationMs = finishedAt.getTime() - startedAt.getTime();
  result.passed = [
    result.redirects?.passed,
    result.robotsAudit?.passed,
    result.sitemap?.passed,
    result.security?.passed,
    result.canonical?.passed,
    result.exposedPaths?.passed,
    result.mixedContent?.passed,
    result.bundleSize?.passed,
    result.openGraph?.passed,
    result.cacheHeaders?.passed,
    result.compression?.passed,
  ].every((v) => v === undefined || v === true);

  return result;
}
