import { chromium, type Browser, type BrowserContext, type Locator } from 'playwright';

export interface CrawlOptions {
  maxDepth?: number;
  maxPages?: number;
  sameOriginOnly?: boolean;
  include?: string[];
  exclude?: string[];
  concurrency?: number;
  timeoutMs?: number;
}

export interface CrawlPageInfo {
  url: string;
  status: number;
  depth: number;
  title?: string;
  parentUrl?: string;
  internalLinks: string[];
  externalLinks: string[];
  loadTimeMs: number;
  error?: string;
}

export interface CrawlResult {
  seed: string;
  pagesVisited: number;
  pages: CrawlPageInfo[];
  durationMs: number;
  graph: Record<string, string[]>;
}

interface QueueItem {
  url: string;
  depth: number;
  parentUrl?: string;
}

function normalizeUrl(raw: string, base?: string): string | null {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    let s = u.toString();
    if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
    return s;
  } catch {
    return null;
  }
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function matchesAny(url: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(url));
}

function compile(patterns?: string[]): RegExp[] {
  return (patterns ?? []).map((p) => new RegExp(p));
}

async function collectHrefs(anchors: Locator): Promise<string[]> {
  const count = await anchors.count();
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const href = await anchors.nth(i).getAttribute('href');
    if (href) out.push(href);
  }
  return out;
}

async function visitPage(
  context: BrowserContext,
  item: QueueItem,
  seed: string,
  opts: Required<CrawlOptions>,
  includeRe: RegExp[],
  excludeRe: RegExp[],
): Promise<CrawlPageInfo> {
  const page = await context.newPage();
  const start = Date.now();
  const info: CrawlPageInfo = {
    url: item.url,
    status: 0,
    depth: item.depth,
    parentUrl: item.parentUrl,
    internalLinks: [],
    externalLinks: [],
    loadTimeMs: 0,
  };
  try {
    const resp = await page.goto(item.url, {
      waitUntil: 'domcontentloaded',
      timeout: opts.timeoutMs,
    });
    info.status = resp?.status() ?? 0;
    info.title = await page.title().catch(() => undefined);
    const hrefs = await collectHrefs(page.locator('a[href]'));
    const internal = new Set<string>();
    const external = new Set<string>();
    for (const h of hrefs) {
      const n = normalizeUrl(h, item.url);
      if (!n) continue;
      if (!sameOrigin(n, seed)) {
        external.add(n);
        continue;
      }
      if (includeRe.length && !matchesAny(n, includeRe)) continue;
      if (excludeRe.length && matchesAny(n, excludeRe)) continue;
      internal.add(n);
    }
    info.internalLinks = [...internal];
    info.externalLinks = [...external];
  } catch (err) {
    info.error = err instanceof Error ? err.message : String(err);
  } finally {
    info.loadTimeMs = Date.now() - start;
    await page.close().catch(() => {});
  }
  return info;
}

export async function crawlSite(seedUrl: string, opts?: CrawlOptions): Promise<CrawlResult> {
  const startTime = Date.now();
  const normalizedSeed = normalizeUrl(seedUrl);
  if (!normalizedSeed) throw new Error(`Invalid seed URL: ${seedUrl}`);

  const resolved: Required<CrawlOptions> = {
    maxDepth: opts?.maxDepth ?? 2,
    maxPages: opts?.maxPages ?? 50,
    sameOriginOnly: opts?.sameOriginOnly ?? true,
    include: opts?.include ?? [],
    exclude: opts?.exclude ?? [],
    concurrency: Math.max(1, opts?.concurrency ?? 4),
    timeoutMs: opts?.timeoutMs ?? 15000,
  };
  const includeRe = compile(resolved.include);
  const excludeRe = compile(resolved.exclude);

  const visited = new Set<string>();
  const queue: QueueItem[] = [{ url: normalizedSeed, depth: 0 }];
  const pages: CrawlPageInfo[] = [];
  const graph: Record<string, string[]> = {};

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();

    while (queue.length > 0 && visited.size < resolved.maxPages) {
      const batch: QueueItem[] = [];
      while (
        queue.length > 0 &&
        batch.length < resolved.concurrency &&
        visited.size + batch.length < resolved.maxPages
      ) {
        const next = queue.shift()!;
        if (visited.has(next.url)) continue;
        visited.add(next.url);
        batch.push(next);
      }
      if (batch.length === 0) break;

      const results = await Promise.all(
        batch.map((it) => visitPage(context, it, normalizedSeed, resolved, includeRe, excludeRe)),
      );

      for (const info of results) {
        pages.push(info);
        graph[info.url] = info.internalLinks;
        if (info.depth < resolved.maxDepth) {
          for (const link of info.internalLinks) {
            if (!visited.has(link)) {
              queue.push({ url: link, depth: info.depth + 1, parentUrl: info.url });
            }
          }
        }
      }
    }

    await context.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return {
    seed: normalizedSeed,
    pagesVisited: pages.length,
    pages,
    durationMs: Date.now() - startTime,
    graph,
  };
}
