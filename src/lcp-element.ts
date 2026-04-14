import type { Page } from 'playwright';

export interface LcpCandidate {
  element: string;
  selector: string;
  url?: string;
  size: number;
  renderTime: number;
  loadTime: number;
  startTime: number;
  isImage: boolean;
  outerHTML: string;
}

export interface LcpElementResult {
  page: string;
  lcp: number | null;
  candidates: LcpCandidate[];
  lcpCandidate: LcpCandidate | null;
  hints: string[];
  passed: boolean;
}

interface RawLcpEntry {
  element: string;
  selector: string;
  url?: string;
  size: number;
  renderTime: number;
  loadTime: number;
  startTime: number;
  isImage: boolean;
  outerHTML: string;
  hasFetchPriorityHigh: boolean;
  hasPreload: boolean;
  sameOrigin: boolean;
}

interface CollectedLcp {
  entries: RawLcpEntry[];
}

export async function auditLcpElement(page: Page): Promise<LcpElementResult> {
  const collected = await page.evaluate<CollectedLcp>(() => {
    const IMAGE_TAGS = new Set(['IMG', 'IMAGE', 'VIDEO', 'PICTURE']);

    const cssEscape = (val: string): string => {
      const fn = (window as unknown as { CSS?: { escape?: (v: string) => string } }).CSS?.escape;
      if (typeof fn === 'function') return fn(val);
      return val.replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
    };

    const buildSelector = (el: Element | null): string => {
      if (!el) return '(none)';
      const segments: string[] = [];
      let node: Element | null = el;
      let depth = 0;
      while (node && node.nodeType === 1 && depth < 6) {
        let seg = node.tagName.toLowerCase();
        const id = node.getAttribute('id');
        if (id) {
          seg = seg + '#' + cssEscape(id);
          segments.unshift(seg);
          break;
        }
        const testId = node.getAttribute('data-testid');
        if (testId) {
          seg = seg + '[data-testid="' + testId + '"]';
        } else {
          const cls = (node.getAttribute('class') || '')
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .map(cssEscape)
            .join('.');
          if (cls) seg += '.' + cls;
          const parent: Element | null = node.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children).filter(
              (c) => c.tagName === node!.tagName,
            );
            if (siblings.length > 1) {
              const idx = siblings.indexOf(node) + 1;
              seg += ':nth-of-type(' + String(idx) + ')';
            }
          }
        }
        segments.unshift(seg);
        node = node.parentElement;
        depth += 1;
      }
      return segments.join(' > ');
    };

    const resolveUrl = (el: Element | null): string | undefined => {
      if (!el) return undefined;
      const tag = el.tagName.toUpperCase();
      if (tag === 'IMG') {
        const src = (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src;
        return src || undefined;
      }
      if (tag === 'VIDEO') {
        const poster = (el as HTMLVideoElement).poster;
        if (poster) return poster;
        const src = (el as HTMLVideoElement).currentSrc;
        return src || undefined;
      }
      const bg = window.getComputedStyle(el).backgroundImage;
      if (bg && bg !== 'none') {
        const match = bg.match(/url\(["']?([^"')]+)["']?\)/);
        if (match) return match[1];
      }
      return undefined;
    };

    const computeSize = (el: Element | null, isImage: boolean, fallback: number): number => {
      if (!el) return fallback;
      if (isImage && el.tagName.toUpperCase() === 'IMG') {
        const img = el as HTMLImageElement;
        if (img.naturalWidth && img.naturalHeight) {
          return img.naturalWidth * img.naturalHeight;
        }
      }
      const rect = el.getBoundingClientRect();
      const area = Math.round(rect.width * rect.height);
      return area || fallback;
    };

    const hasPreloadFor = (url: string | undefined): boolean => {
      if (!url) return false;
      const links = document.querySelectorAll('link[rel="preload"]');
      for (const link of Array.from(links)) {
        const href = (link as HTMLLinkElement).href;
        if (href && href === url) return true;
      }
      return false;
    };

    const isSameOrigin = (url: string | undefined): boolean => {
      if (!url) return false;
      try {
        const u = new URL(url, document.baseURI);
        return u.origin === window.location.origin;
      } catch {
        return false;
      }
    };

    const toEntry = (entry: PerformanceEntry): RawLcpEntry | null => {
      const lcp = entry as PerformanceEntry & {
        element?: Element | null;
        url?: string;
        size?: number;
        renderTime?: number;
        loadTime?: number;
      };
      const el = lcp.element ?? null;
      const tag = (el?.tagName || 'UNKNOWN').toUpperCase();
      const isImage =
        IMAGE_TAGS.has(tag) ||
        Boolean(lcp.url) ||
        (el ? window.getComputedStyle(el).backgroundImage !== 'none' : false);
      const url = lcp.url || resolveUrl(el);
      const outerHTML = el ? (el.outerHTML || '').slice(0, 300) : '';
      const fetchPriority = (el as HTMLImageElement | null)?.getAttribute?.('fetchpriority') || '';
      return {
        element: tag,
        selector: buildSelector(el),
        url,
        size: computeSize(el, isImage, lcp.size ?? 0),
        renderTime: lcp.renderTime ?? 0,
        loadTime: lcp.loadTime ?? 0,
        startTime: entry.startTime,
        isImage,
        outerHTML,
        hasFetchPriorityHigh: fetchPriority.toLowerCase() === 'high',
        hasPreload: hasPreloadFor(url),
        sameOrigin: isSameOrigin(url),
      };
    };

    const entries: RawLcpEntry[] = [];
    const seen = new Set<number>();

    const buffered = performance.getEntriesByType('largest-contentful-paint');
    for (const entry of buffered) {
      const converted = toEntry(entry);
      if (converted && !seen.has(converted.startTime)) {
        seen.add(converted.startTime);
        entries.push(converted);
      }
    }

    return new Promise<CollectedLcp>((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        try {
          observer.disconnect();
        } catch {
          /* ignore */
        }
        entries.sort((a, b) => a.startTime - b.startTime);
        resolve({ entries });
      };

      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const converted = toEntry(entry);
          if (converted && !seen.has(converted.startTime)) {
            seen.add(converted.startTime);
            entries.push(converted);
          }
        }
      });

      try {
        observer.observe({ type: 'largest-contentful-paint', buffered: true });
      } catch {
        finish();
        return;
      }

      setTimeout(finish, 1500);
      if (document.readyState === 'complete') {
        setTimeout(finish, 500);
      } else {
        window.addEventListener('load', () => setTimeout(finish, 500), { once: true });
      }
    });
  });

  const rawEntries = collected.entries;
  const candidates: LcpCandidate[] = rawEntries.map((e) => ({
    element: e.element,
    selector: e.selector,
    url: e.url,
    size: e.size,
    renderTime: e.renderTime,
    loadTime: e.loadTime,
    startTime: e.startTime,
    isImage: e.isImage,
    outerHTML: e.outerHTML,
  }));

  let finalIdx = -1;
  if (rawEntries.length > 0) {
    let bestSize = -1;
    let bestStart = -1;
    for (let i = 0; i < rawEntries.length; i += 1) {
      const entry = rawEntries[i];
      if (entry.size > bestSize || (entry.size === bestSize && entry.startTime > bestStart)) {
        bestSize = entry.size;
        bestStart = entry.startTime;
        finalIdx = i;
      }
    }
  }

  const finalRaw = finalIdx >= 0 ? rawEntries[finalIdx] : null;
  const lcpCandidate = finalIdx >= 0 ? candidates[finalIdx] : null;
  const lcp = lcpCandidate
    ? lcpCandidate.renderTime || lcpCandidate.loadTime || lcpCandidate.startTime
    : null;

  const hints: string[] = [];
  if (finalRaw) {
    if (finalRaw.isImage) {
      if (!finalRaw.hasFetchPriorityHigh) hints.push('use fetchpriority="high"');
      if (!finalRaw.hasPreload) hints.push('preload this image');
      if (finalRaw.sameOrigin) hints.push('consider WebP/AVIF + responsive srcset');
    } else {
      hints.push('inline critical text styles, defer non-critical CSS');
    }
    if (finalRaw.startTime > 1000) hints.push('reduce server TTFB');
  }

  return {
    page: page.url(),
    lcp,
    candidates,
    lcpCandidate,
    hints,
    passed: lcp !== null && lcp <= 2500,
  };
}
