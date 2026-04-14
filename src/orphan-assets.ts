import type { Page } from 'playwright';

export interface OrphanCandidate {
  url: string;
  type: 'script' | 'style' | 'image' | 'font' | 'xhr' | 'other';
  sizeBytes: number;
  referencedInHtml: boolean;
  referencedInCss: boolean;
  lazyInjected: boolean;
}

export interface OrphanAssetResult {
  page: string;
  assets: OrphanCandidate[];
  totalOrphanBytes: number;
  passed: boolean;
}

interface RawResource {
  url: string;
  initiatorType: string;
  sizeBytes: number;
  pathname: string;
  basename: string;
}

interface ScanPayload {
  html: string;
  cssText: string;
  resources: RawResource[];
}

const TRACKER_PATTERNS: RegExp[] = [
  /google-analytics\.com\/(collect|g\/collect|r\/collect)/i,
  /googletagmanager\.com\/gtag\/js/i,
  /doubleclick\.net\/(pagead|gtm)/i,
  /facebook\.com\/tr(\/|\?)/i,
  /connect\.facebook\.net\/.*\/fbevents\.js/i,
  /hotjar\.com\/c\/hotjar/i,
  /segment\.(com|io)\/v1\/(t|p|i|g)/i,
  /mixpanel\.com\/(track|engage)/i,
  /amplitude\.com\/2\/httpapi/i,
  /sentry\.io\/api\/.*\/(envelope|store)/i,
  /intercom\.io\/messenger/i,
  /bat\.bing\.com\/bat\.js/i,
  /cloudflareinsights\.com\/beacon/i,
];

const SIZE_THRESHOLDS = {
  totalBytes: 100 * 1024,
  singleAssetBytes: 50 * 1024,
} as const;

function isSkippableUrl(url: string): boolean {
  if (!url) return true;
  if (url.startsWith('data:')) return true;
  if (url.startsWith('about:')) return true;
  if (url.startsWith('blob:')) return true;
  if (url.startsWith('javascript:')) return true;
  for (const pat of TRACKER_PATTERNS) {
    if (pat.test(url)) return true;
  }
  return false;
}

function classifyType(initiatorType: string): OrphanCandidate['type'] {
  switch (initiatorType) {
    case 'script':
      return 'script';
    case 'css':
    case 'link':
      return 'style';
    case 'img':
    case 'image':
    case 'imageset':
      return 'image';
    case 'font':
      return 'font';
    case 'xmlhttprequest':
    case 'fetch':
      return 'xhr';
    default:
      return 'other';
  }
}

export async function detectOrphanAssets(page: Page): Promise<OrphanAssetResult> {
  const pageUrl = page.url();

  const scan: ScanPayload = await page.evaluate((): ScanPayload => {
    function extractPathname(raw: string): string {
      try {
        return new URL(raw, window.location.href).pathname;
      } catch {
        return raw;
      }
    }

    function extractBasename(pathname: string): string {
      const idx = pathname.lastIndexOf('/');
      if (idx < 0) return pathname;
      return pathname.slice(idx + 1);
    }

    const html = document.documentElement.outerHTML;

    let cssText = '';
    try {
      const sheets = Array.from(document.styleSheets);
      for (const sheet of sheets) {
        let rules: CSSRuleList | null = null;
        try {
          rules = sheet.cssRules;
        } catch {
          continue;
        }
        if (!rules) continue;
        for (const rule of Array.from(rules)) {
          try {
            cssText += rule.cssText + '\n';
          } catch {
            continue;
          }
        }
      }
    } catch {
      // styleSheets API unavailable
    }

    const resources: RawResource[] = [];
    try {
      const entries = performance.getEntriesByType(
        'resource',
      ) as PerformanceResourceTiming[];
      for (const entry of entries) {
        const url = entry.name;
        if (!url) continue;
        const encoded = entry.encodedBodySize ?? 0;
        const transfer = entry.transferSize ?? 0;
        const sizeBytes = encoded > 0 ? encoded : transfer;
        const pathname = extractPathname(url);
        const basename = extractBasename(pathname);
        resources.push({
          url,
          initiatorType: entry.initiatorType ?? '',
          sizeBytes,
          pathname,
          basename,
        });
      }
    } catch {
      // performance API unavailable
    }

    return { html, cssText, resources };
  });

  const assets: OrphanCandidate[] = [];
  const seen = new Set<string>();
  const html = scan.html;
  const css = scan.cssText;

  for (const res of scan.resources) {
    if (isSkippableUrl(res.url)) continue;
    if (res.url === pageUrl) continue;
    if (seen.has(res.url)) continue;
    seen.add(res.url);

    const pathname = res.pathname;
    const basename = res.basename;

    const referencedInHtml =
      (pathname.length > 1 && html.includes(pathname)) ||
      (basename.length > 0 && html.includes(basename)) ||
      html.includes(res.url);

    const referencedInCss =
      (pathname.length > 1 && css.includes(pathname)) ||
      (basename.length > 0 && css.includes(basename)) ||
      css.includes(res.url);

    if (referencedInHtml || referencedInCss) continue;

    const lazyInjected = res.initiatorType === 'script';

    assets.push({
      url: res.url,
      type: classifyType(res.initiatorType),
      sizeBytes: res.sizeBytes,
      referencedInHtml,
      referencedInCss,
      lazyInjected,
    });
  }

  let totalOrphanBytes = 0;
  let hasLargeOrphan = false;
  for (const a of assets) {
    totalOrphanBytes += a.sizeBytes;
    if (a.sizeBytes > SIZE_THRESHOLDS.singleAssetBytes) hasLargeOrphan = true;
  }

  const passed = totalOrphanBytes < SIZE_THRESHOLDS.totalBytes && !hasLargeOrphan;

  return {
    page: pageUrl,
    assets,
    totalOrphanBytes,
    passed,
  };
}
