export interface SitemapAuditOptions {
  checkUrls?: boolean;
  sampleSize?: number;
  timeoutMs?: number;
}

export interface SitemapIssue {
  level: 'error' | 'warn' | 'info';
  message: string;
  url?: string;
}

export interface SitemapAuditResult {
  baseUrl: string;
  sitemapUrl?: string;
  sitemapFound: boolean;
  robotsTxtFound: boolean;
  robotsBlockedCritical: string[];
  urlsInSitemap: number;
  urlsChecked: number;
  brokenUrls: { url: string; status: number }[];
  issues: SitemapIssue[];
  passed: boolean;
}

function fetchWithTimeout(url: string, ms: number, method = 'GET'): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { method, signal: ctrl.signal, redirect: 'follow' }).finally(() => clearTimeout(timer));
}

async function concurrentMap<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function extractLocs(xml: string): string[] {
  const locs: string[] = [];
  const re = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) locs.push(m[1]);
  return locs;
}

function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex/i.test(xml);
}

export async function auditSitemap(baseUrl: string, opts?: SitemapAuditOptions): Promise<SitemapAuditResult> {
  const checkUrls = opts?.checkUrls ?? true;
  const sampleSize = opts?.sampleSize ?? 100;
  const timeoutMs = opts?.timeoutMs ?? 5000;

  const issues: SitemapIssue[] = [];
  const result: SitemapAuditResult = {
    baseUrl,
    sitemapFound: false,
    robotsTxtFound: false,
    robotsBlockedCritical: [],
    urlsInSitemap: 0,
    urlsChecked: 0,
    brokenUrls: [],
    issues,
    passed: false,
  };

  const base = baseUrl.replace(/\/$/, '');

  let robotsSitemapUrl: string | undefined;

  try {
    const robotsRes = await fetchWithTimeout(`${base}/robots.txt`, timeoutMs);
    if (robotsRes.ok) {
      result.robotsTxtFound = true;
      const text = await robotsRes.text();
      const sitemapLine = text.match(/^Sitemap:\s*(.+)$/im);
      if (sitemapLine) robotsSitemapUrl = sitemapLine[1].trim();

      const disallows = [...text.matchAll(/^Disallow:\s*(.+)$/gim)].map(m => m[1].trim());
      const critical = ['/', '/api/', '/checkout', '/payment'];
      for (const path of critical) {
        if (disallows.some(d => d === path || path.startsWith(d))) {
          result.robotsBlockedCritical.push(path);
          issues.push({ level: 'warn', message: `robots.txt blocks critical path: ${path}` });
        }
      }
    } else {
      issues.push({ level: 'warn', message: 'robots.txt not found or not accessible' });
    }
  } catch {
    issues.push({ level: 'warn', message: 'Failed to fetch robots.txt' });
  }

  const sitemapUrl = robotsSitemapUrl ?? `${base}/sitemap.xml`;
  result.sitemapUrl = sitemapUrl;

  let allUrls: string[] = [];

  try {
    const smRes = await fetchWithTimeout(sitemapUrl, timeoutMs);
    if (!smRes.ok) {
      issues.push({ level: 'error', message: `Sitemap not accessible (HTTP ${smRes.status})`, url: sitemapUrl });
    } else {
      result.sitemapFound = true;
      const contentLength = smRes.headers.get('content-length');
      if (contentLength && parseInt(contentLength) > 50 * 1024 * 1024) {
        issues.push({ level: 'warn', message: 'Sitemap exceeds 50MB' });
      }

      const xml = await smRes.text();

      if (isSitemapIndex(xml)) {
        const subUrls = extractLocs(xml);
        const subXmls = await concurrentMap(subUrls, 8, async (u) => {
          try {
            const r = await fetchWithTimeout(u, timeoutMs);
            return r.ok ? r.text() : Promise.resolve('');
          } catch { return ''; }
        });
        for (const subXml of subXmls) allUrls.push(...extractLocs(subXml));
      } else {
        allUrls = extractLocs(xml);
      }

      result.urlsInSitemap = allUrls.length;

      if (allUrls.length > 50000) {
        issues.push({ level: 'warn', message: `Sitemap contains ${allUrls.length} URLs (>50000)` });
      }

      if (!robotsSitemapUrl && sitemapUrl === `${base}/sitemap.xml`) {
        issues.push({ level: 'info', message: 'Sitemap found at /sitemap.xml but not referenced in robots.txt' });
      }
    }
  } catch {
    issues.push({ level: 'error', message: 'Failed to fetch sitemap', url: sitemapUrl });
  }

  if (checkUrls && allUrls.length > 0) {
    const sample = allUrls.slice(0, sampleSize);
    result.urlsChecked = sample.length;

    const statuses = await concurrentMap(sample, 8, async (url) => {
      try {
        const r = await fetchWithTimeout(url, timeoutMs, 'HEAD');
        return { url, status: r.status };
      } catch {
        return { url, status: 0 };
      }
    });

    for (const { url, status } of statuses) {
      if (status < 200 || status >= 300) {
        result.brokenUrls.push({ url, status });
        issues.push({ level: 'error', message: `Broken URL (${status || 'timeout'})`, url });
      }
    }
  }

  result.passed = !issues.some(i => i.level === 'error');
  return result;
}
