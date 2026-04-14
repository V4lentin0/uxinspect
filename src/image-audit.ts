import type { Page } from 'playwright';

export type ImageFormat = 'jpg' | 'png' | 'webp' | 'avif' | 'gif' | 'svg' | 'other';

export type ImageIssueType =
  | 'missing-alt'
  | 'broken-image'
  | 'oversized-image'
  | 'no-modern-format'
  | 'no-lazy-loading'
  | 'missing-dimensions'
  | 'no-responsive-srcset';

export interface ImageRecord {
  src: string;
  alt?: string;
  hasAlt: boolean;
  emptyAlt: boolean;
  decorative: boolean;
  loading?: string;
  width?: number;
  height?: number;
  naturalWidth?: number;
  naturalHeight?: number;
  bytes?: number;
  format?: ImageFormat;
  oversized: boolean;
  responsive: boolean;
}

export interface ImageIssue {
  type: ImageIssueType;
  target: string;
  detail?: string;
}

export interface ImageAuditStats {
  total: number;
  withAlt: number;
  broken: number;
  oversized: number;
  modernFormat: number;
  lazyLoaded: number;
}

export interface ImageAuditResult {
  page: string;
  images: ImageRecord[];
  issues: ImageIssue[];
  stats: ImageAuditStats;
  passed: boolean;
}

export async function auditImages(page: Page): Promise<ImageAuditResult> {
  const url = page.url();

  const { images, issues, stats } = await page.evaluate(() => {
    type FormatLocal = 'jpg' | 'png' | 'webp' | 'avif' | 'gif' | 'svg' | 'other';

    type IssueTypeLocal =
      | 'missing-alt'
      | 'broken-image'
      | 'oversized-image'
      | 'no-modern-format'
      | 'no-lazy-loading'
      | 'missing-dimensions'
      | 'no-responsive-srcset';

    interface ImageRecordLocal {
      src: string;
      alt?: string;
      hasAlt: boolean;
      emptyAlt: boolean;
      decorative: boolean;
      loading?: string;
      width?: number;
      height?: number;
      naturalWidth?: number;
      naturalHeight?: number;
      bytes?: number;
      format?: FormatLocal;
      oversized: boolean;
      responsive: boolean;
    }

    interface IssueLocal {
      type: IssueTypeLocal;
      target: string;
      detail?: string;
    }

    function buildSelector(el: Element): string {
      const id = el.id;
      if (id) return `#${CSS.escape(id)}`;
      const testid = el.getAttribute('data-testid');
      if (testid) return `[data-testid="${testid}"]`;
      const tag = el.tagName.toLowerCase();
      const classes = Array.from(el.classList).slice(0, 3);
      return classes.length ? `${tag}.${classes.map((c) => CSS.escape(c)).join('.')}` : tag;
    }

    function detectFormat(srcUrl: string, contentType?: string): FormatLocal {
      if (contentType) {
        const ct = contentType.toLowerCase();
        if (ct.includes('avif')) return 'avif';
        if (ct.includes('webp')) return 'webp';
        if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
        if (ct.includes('png')) return 'png';
        if (ct.includes('gif')) return 'gif';
        if (ct.includes('svg')) return 'svg';
      }
      try {
        const u = new URL(srcUrl, window.location.href);
        const path = u.pathname.toLowerCase();
        const ext = path.split('.').pop() || '';
        if (ext === 'jpg' || ext === 'jpeg') return 'jpg';
        if (ext === 'png') return 'png';
        if (ext === 'webp') return 'webp';
        if (ext === 'avif') return 'avif';
        if (ext === 'gif') return 'gif';
        if (ext === 'svg') return 'svg';
      } catch {
        // ignore URL parse errors
      }
      if (srcUrl.startsWith('data:')) {
        const m = /^data:image\/([a-z0-9+.-]+)/i.exec(srcUrl);
        if (m) {
          const kind = m[1].toLowerCase();
          if (kind.includes('avif')) return 'avif';
          if (kind.includes('webp')) return 'webp';
          if (kind.includes('jpeg') || kind.includes('jpg')) return 'jpg';
          if (kind.includes('png')) return 'png';
          if (kind.includes('gif')) return 'gif';
          if (kind.includes('svg')) return 'svg';
        }
      }
      return 'other';
    }

    const dpr = window.devicePixelRatio || 1;
    const viewportHeight = window.innerHeight;

    const resourceMap = new Map<string, { bytes?: number; contentType?: string }>();
    try {
      const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      for (const entry of entries) {
        if (entry.initiatorType === 'img' || /\.(jpe?g|png|webp|avif|gif|svg)(\?|$)/i.test(entry.name)) {
          const size = entry.encodedBodySize || entry.transferSize || entry.decodedBodySize || undefined;
          resourceMap.set(entry.name, { bytes: size });
        }
      }
    } catch {
      // performance API not available
    }

    const imgEls = Array.from(document.querySelectorAll('img'));
    const images: ImageRecordLocal[] = [];
    const issues: IssueLocal[] = [];

    let withAlt = 0;
    let broken = 0;
    let oversizedCount = 0;
    let modernFormat = 0;
    let lazyLoaded = 0;

    for (const img of imgEls) {
      const rawSrc = img.currentSrc || img.getAttribute('src') || '';
      if (!rawSrc) continue;

      const selector = buildSelector(img);
      const altAttr = img.getAttribute('alt');
      const hasAlt = altAttr !== null;
      const emptyAlt = altAttr === '';
      const role = img.getAttribute('role');
      const ariaHidden = img.getAttribute('aria-hidden');
      const decorative = emptyAlt && (role === 'presentation' || ariaHidden === 'true');

      const loadingAttr = img.getAttribute('loading') || undefined;
      const widthAttr = img.getAttribute('width');
      const heightAttr = img.getAttribute('height');
      const width = widthAttr ? Number(widthAttr) : undefined;
      const height = heightAttr ? Number(heightAttr) : undefined;

      const naturalWidth = img.naturalWidth || 0;
      const naturalHeight = img.naturalHeight || 0;
      const clientWidth = img.clientWidth || 0;

      const complete = img.complete;
      const isBroken = !complete || naturalWidth === 0;

      const resolvedUrl = (() => {
        try {
          return new URL(rawSrc, window.location.href).href;
        } catch {
          return rawSrc;
        }
      })();

      const resource = resourceMap.get(resolvedUrl) || resourceMap.get(rawSrc);
      const bytes = resource?.bytes;
      const format = detectFormat(resolvedUrl, resource?.contentType);

      const srcsetAttr = img.getAttribute('srcset');
      const hasSrcset = !!(srcsetAttr && srcsetAttr.trim().length > 0);

      const effectiveClientWidth = clientWidth > 0 ? clientWidth : width || 0;
      const oversizedByPixels =
        naturalWidth > 0 && effectiveClientWidth > 0 && naturalWidth > 2 * effectiveClientWidth * dpr;
      const oversizedByBytes = typeof bytes === 'number' && bytes > 500 * 1024;
      const isOversized = oversizedByPixels || oversizedByBytes;

      const rect = img.getBoundingClientRect();
      const belowFold = rect.top > viewportHeight;

      const record: ImageRecordLocal = {
        src: resolvedUrl,
        alt: hasAlt ? altAttr ?? undefined : undefined,
        hasAlt,
        emptyAlt,
        decorative,
        loading: loadingAttr,
        width,
        height,
        naturalWidth: naturalWidth || undefined,
        naturalHeight: naturalHeight || undefined,
        bytes,
        format,
        oversized: isOversized,
        responsive: hasSrcset,
      };
      images.push(record);

      if (hasAlt) withAlt++;
      if (isBroken) broken++;
      if (isOversized) oversizedCount++;
      if (format === 'webp' || format === 'avif' || format === 'svg') modernFormat++;
      if (loadingAttr === 'lazy') lazyLoaded++;

      if (!hasAlt && !decorative) {
        issues.push({ type: 'missing-alt', target: selector, detail: resolvedUrl });
      }

      if (isBroken) {
        issues.push({
          type: 'broken-image',
          target: selector,
          detail: !complete ? 'image did not finish loading' : 'naturalWidth is 0',
        });
      }

      if (isOversized) {
        const parts: string[] = [];
        if (oversizedByPixels) {
          parts.push(
            `natural ${naturalWidth}px vs rendered ${Math.round(effectiveClientWidth * dpr)}px (dpr ${dpr})`
          );
        }
        if (oversizedByBytes && typeof bytes === 'number') {
          parts.push(`${Math.round(bytes / 1024)}KB`);
        }
        issues.push({ type: 'oversized-image', target: selector, detail: parts.join('; ') || undefined });
      }

      if ((format === 'jpg' || format === 'png') && typeof bytes === 'number' && bytes > 100 * 1024) {
        issues.push({
          type: 'no-modern-format',
          target: selector,
          detail: `${format} ${Math.round(bytes / 1024)}KB, consider webp/avif`,
        });
      }

      if (belowFold && loadingAttr !== 'lazy') {
        issues.push({
          type: 'no-lazy-loading',
          target: selector,
          detail: `below-the-fold (top=${Math.round(rect.top)}px)`,
        });
      }

      if (!widthAttr || !heightAttr) {
        issues.push({
          type: 'missing-dimensions',
          target: selector,
          detail: 'missing width/height attrs causes CLS',
        });
      }

      if (!hasSrcset && naturalWidth > 600) {
        issues.push({
          type: 'no-responsive-srcset',
          target: selector,
          detail: `naturalWidth ${naturalWidth}px without srcset`,
        });
      }
    }

    const stats = {
      total: images.length,
      withAlt,
      broken,
      oversized: oversizedCount,
      modernFormat,
      lazyLoaded,
    };

    return { images, issues, stats };
  });

  const passed =
    issues.filter((i) => i.type === 'broken-image' || i.type === 'missing-alt').length === 0;

  return {
    page: url,
    images,
    issues,
    stats,
    passed,
  };
}
