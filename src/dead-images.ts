import type { Page } from 'playwright';

export type DeadImageIssueType =
  | 'broken-img'
  | '404-response'
  | 'cross-origin-tainted'
  | 'placeholder-only'
  | 'missing-src'
  | 'low-resolution-for-display'
  | 'unused-srcset'
  | 'picture-no-fallback'
  | 'background-image-404';

export interface DeadImageIssue {
  type: DeadImageIssueType;
  severity: 'info' | 'warn' | 'error';
  src: string;
  selector: string;
  detail: string;
}

export interface DeadImageResult {
  page: string;
  imagesChecked: number;
  brokenCount: number;
  issues: DeadImageIssue[];
  passed: boolean;
}

interface FailedResource {
  url: string;
  reason: 'zero-bytes' | 'cross-origin';
}

interface ImgRecord {
  src: string;
  currentSrc: string;
  resolvedSrc: string;
  naturalWidth: number;
  renderedWidth: number;
  complete: boolean;
  srcset: string;
  selector: string;
}

interface BackgroundImage {
  url: string;
  selector: string;
}

interface PageScan {
  failedResources: FailedResource[];
  images: ImgRecord[];
  pictureMissingFallback: string[];
  backgrounds: BackgroundImage[];
  devicePixelRatio: number;
}

const PLACEHOLDER_PATTERNS: RegExp[] = [
  /^data:image\/gif;base64,R0lGODlhAQABA/i,
  /^data:image\/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCA/i,
  /^data:image\/svg\+xml(;|,)/i,
];

function isPlaceholder(src: string): boolean {
  for (const pat of PLACEHOLDER_PATTERNS) {
    if (pat.test(src)) return true;
  }
  return false;
}

export async function detectDeadImages(page: Page): Promise<DeadImageResult> {
  const pageUrl = page.url();

  const scan: PageScan = await page.evaluate((): PageScan => {
    function buildSelector(el: Element): string {
      const id = el.id;
      if (id) return `#${CSS.escape(id)}`;
      const testid = el.getAttribute('data-testid');
      if (testid) return `[data-testid="${testid}"]`;
      const tag = el.tagName.toLowerCase();
      const parent = el.parentElement;
      if (!parent) return tag;
      const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
      if (same.length === 1) return tag;
      return `${tag}:nth-of-type(${same.indexOf(el) + 1})`;
    }

    function resolveUrl(raw: string): string {
      if (!raw) return '';
      try {
        return new URL(raw, window.location.href).href;
      } catch {
        return raw;
      }
    }

    const failedResources: FailedResource[] = [];
    try {
      const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      for (const entry of entries) {
        const isImageEntry =
          entry.initiatorType === 'img' ||
          entry.initiatorType === 'image' ||
          entry.initiatorType === 'css' ||
          /\.(png|jpe?g|gif|webp|svg|avif)(\?|#|$)/i.test(entry.name);
        if (!isImageEntry) continue;
        const transfer = entry.transferSize ?? 0;
        const decoded = entry.decodedBodySize ?? 0;
        const encoded = entry.encodedBodySize ?? 0;
        const dur = entry.duration ?? 0;
        if (transfer === 0 && decoded === 0 && encoded === 0 && dur > 0) {
          failedResources.push({ url: entry.name, reason: 'zero-bytes' });
        } else if (transfer > 0 && decoded === 0 && encoded === 0) {
          failedResources.push({ url: entry.name, reason: 'cross-origin' });
        }
      }
    } catch {
      // performance API unavailable
    }

    const images: ImgRecord[] = Array.from(document.querySelectorAll('img')).map((img) => {
      const rawSrc = img.getAttribute('src') ?? '';
      const currentSrc = img.currentSrc ?? '';
      return {
        src: rawSrc,
        currentSrc,
        resolvedSrc: resolveUrl(currentSrc || rawSrc),
        naturalWidth: img.naturalWidth || 0,
        renderedWidth: img.clientWidth || 0,
        complete: img.complete === true,
        srcset: img.getAttribute('srcset') ?? '',
        selector: buildSelector(img),
      };
    });

    const pictureMissingFallback: string[] = [];
    for (const pic of Array.from(document.querySelectorAll('picture'))) {
      if (!pic.querySelector('img')) pictureMissingFallback.push(buildSelector(pic));
    }

    const backgrounds: BackgroundImage[] = [];
    const seenBg = new Set<string>();
    for (const el of Array.from(document.querySelectorAll('*'))) {
      let bg = '';
      try {
        bg = window.getComputedStyle(el).backgroundImage;
      } catch {
        continue;
      }
      if (!bg || bg === 'none') continue;
      for (const match of bg.matchAll(/url\((["']?)([^"')]+)\1\)/g)) {
        const raw = match[2];
        if (!raw || raw.startsWith('data:')) continue;
        const resolved = resolveUrl(raw);
        const sel = buildSelector(el);
        const key = `${resolved}|${sel}`;
        if (seenBg.has(key)) continue;
        seenBg.add(key);
        backgrounds.push({ url: resolved, selector: sel });
      }
    }

    return {
      failedResources,
      images,
      pictureMissingFallback,
      backgrounds,
      devicePixelRatio: window.devicePixelRatio || 1,
    };
  });

  const issues: DeadImageIssue[] = [];
  const failedUrlSet = new Set<string>(scan.failedResources.map((f) => f.url));
  const crossOriginSet = new Set<string>(
    scan.failedResources.filter((f) => f.reason === 'cross-origin').map((f) => f.url),
  );
  let brokenCount = 0;

  for (const img of scan.images) {
    const sel = img.selector;
    const display = img.resolvedSrc || img.src || '(no src)';

    if (!img.src || img.src.trim() === '') {
      issues.push({
        type: 'missing-src',
        severity: 'error',
        src: '',
        selector: sel,
        detail: 'img element has no src attribute or empty src',
      });
      brokenCount++;
      continue;
    }

    if (img.complete && img.naturalWidth === 0) {
      const inFailed = failedUrlSet.has(img.resolvedSrc);
      issues.push({
        type: 'broken-img',
        severity: 'error',
        src: display,
        selector: sel,
        detail: inFailed
          ? 'naturalWidth=0 and resource failed network load'
          : 'naturalWidth=0 after image marked complete',
      });
      brokenCount++;
      if (inFailed) {
        issues.push({
          type: '404-response',
          severity: 'error',
          src: display,
          selector: sel,
          detail: 'matching resource entry shows zero bytes transferred (likely 404 or blocked)',
        });
      }
      if (crossOriginSet.has(img.resolvedSrc)) {
        issues.push({
          type: 'cross-origin-tainted',
          severity: 'error',
          src: display,
          selector: sel,
          detail: 'transferSize > 0 but decoded body empty (CORS / opaque response)',
        });
      }
      continue;
    }

    if (isPlaceholder(img.src) || isPlaceholder(img.currentSrc)) {
      issues.push({
        type: 'placeholder-only',
        severity: 'info',
        src: display,
        selector: sel,
        detail: 'image source is a 1x1 / inline placeholder, may indicate stalled lazy load',
      });
    }

    if (img.srcset.trim().length > 0 && img.currentSrc && img.src) {
      let resolvedBase = img.src;
      try { resolvedBase = new URL(img.src, pageUrl).href; } catch { /* keep raw */ }
      if (img.currentSrc === img.src || img.currentSrc === resolvedBase) {
        issues.push({
          type: 'unused-srcset',
          severity: 'info',
          src: display,
          selector: sel,
          detail: 'srcset declared but currentSrc resolved to base src (no candidate picked)',
        });
      }
    }

    if (
      img.naturalWidth > 0 &&
      img.renderedWidth > 100 &&
      img.naturalWidth * 2 < img.renderedWidth * scan.devicePixelRatio
    ) {
      issues.push({
        type: 'low-resolution-for-display',
        severity: 'warn',
        src: display,
        selector: sel,
        detail: `natural ${img.naturalWidth}px served into ${img.renderedWidth}px slot at dpr ${scan.devicePixelRatio}`,
      });
    }
  }

  for (const sel of scan.pictureMissingFallback) {
    issues.push({
      type: 'picture-no-fallback',
      severity: 'error',
      src: '(picture)',
      selector: sel,
      detail: '<picture> element has no <img> fallback child',
    });
    brokenCount++;
  }

  for (const bg of scan.backgrounds) {
    if (failedUrlSet.has(bg.url)) {
      issues.push({
        type: 'background-image-404',
        severity: 'error',
        src: bg.url,
        selector: bg.selector,
        detail: 'CSS background-image url() failed to load (zero bytes / no body)',
      });
      brokenCount++;
    }
  }

  return {
    page: pageUrl,
    imagesChecked: scan.images.length,
    brokenCount,
    issues,
    passed: issues.every((i) => i.severity !== 'error'),
  };
}
