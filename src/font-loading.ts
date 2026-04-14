import type { Page } from 'playwright';

export type FontIssueType =
  | 'missing-font-display'
  | 'no-font-preload'
  | 'non-woff2-format'
  | 'too-many-families'
  | 'blocking-font-request'
  | 'large-font-file';

export interface FontFaceInfo {
  family: string;
  display: string;
  src?: string;
  unicodeRange?: string;
  weight?: string;
  style?: string;
  loaded: boolean;
  format?: string;
}

export interface FontIssue {
  type: FontIssueType;
  detail: string;
  target?: string;
}

export interface FontLoadingResult {
  page: string;
  fontFaces: FontFaceInfo[];
  preloadedFonts: string[];
  woff2Ratio: number;
  foitRisk: boolean;
  totalFontBytes: number;
  issues: FontIssue[];
  passed: boolean;
}

interface FontResourceEntry {
  name: string;
  transferSize: number;
  encodedBodySize: number;
  startTime: number;
  initiatorType: string;
  renderBlockingStatus?: string;
}

interface FontSnapshot {
  fontFaces: FontFaceInfo[];
  preloadedFonts: string[];
  resources: FontResourceEntry[];
  firstContentfulPaint: number | null;
}

const FONT_EXT_RE = /\.(woff2?|ttf|otf|eot)(\?|#|$)/i;
const LARGE_FONT_BYTES = 100 * 1024;
const MAX_FAMILIES = 4;

function detectFormatFromUrl(url: string): string | undefined {
  const lower = url.toLowerCase();
  if (lower.includes('.woff2')) return 'woff2';
  if (lower.includes('.woff')) return 'woff';
  if (lower.includes('.ttf')) return 'ttf';
  if (lower.includes('.otf')) return 'otf';
  if (lower.includes('.eot')) return 'eot';
  return undefined;
}

function isWoff2Url(url: string): boolean {
  const lower = url.toLowerCase();
  const queryIdx = lower.search(/[?#]/);
  const path = queryIdx === -1 ? lower : lower.slice(0, queryIdx);
  return path.endsWith('.woff2');
}

function stripFamilyQuotes(family: string): string {
  return family.replace(/^['"]|['"]$/g, '').trim();
}

export async function auditFontLoading(page: Page): Promise<FontLoadingResult> {
  const pageUrl = page.url();

  const snapshot = await page.evaluate((): FontSnapshot => {
    const faces: FontFaceInfo[] = [];
    try {
      const fontSet = document.fonts as unknown as Iterable<FontFace>;
      const list = Array.from(fontSet);
      for (const f of list) {
        const raw = f as unknown as {
          family?: string;
          display?: string;
          weight?: string;
          style?: string;
          unicodeRange?: string;
          status?: string;
          src?: string;
        };
        const familyRaw = raw.family || '';
        const family = familyRaw.replace(/^['"]|['"]$/g, '').trim();
        const display = typeof raw.display === 'string' ? raw.display : '';
        const info: FontFaceInfo = {
          family,
          display,
          loaded: raw.status === 'loaded',
        };
        if (typeof raw.weight === 'string' && raw.weight.length > 0) info.weight = raw.weight;
        if (typeof raw.style === 'string' && raw.style.length > 0) info.style = raw.style;
        if (typeof raw.unicodeRange === 'string' && raw.unicodeRange.length > 0) info.unicodeRange = raw.unicodeRange;
        if (typeof raw.src === 'string' && raw.src.length > 0) {
          info.src = raw.src;
          const m = raw.src.match(/url\(\s*["']?([^"')]+)["']?\s*\)/i);
          if (m && m[1]) {
            const url = m[1].toLowerCase();
            if (url.includes('.woff2')) info.format = 'woff2';
            else if (url.includes('.woff')) info.format = 'woff';
            else if (url.includes('.ttf')) info.format = 'ttf';
            else if (url.includes('.otf')) info.format = 'otf';
            else if (url.includes('.eot')) info.format = 'eot';
          }
          const fm = raw.src.match(/format\(\s*["']?([^"')]+)["']?\s*\)/i);
          if (fm && fm[1] && !info.format) info.format = fm[1].toLowerCase();
        }
        faces.push(info);
      }
    } catch {
      /* FontFaceSet not iterable or unavailable */
    }

    const preloadNodes = Array.from(
      document.querySelectorAll('link[rel="preload"][as="font"]')
    ) as HTMLLinkElement[];
    const preloadedFonts = preloadNodes
      .map((l) => l.href || l.getAttribute('href') || '')
      .filter((h) => h.length > 0);

    const resources: FontResourceEntry[] = [];
    try {
      const entries = performance.getEntriesByType('resource');
      for (const e of entries) {
        const r = e as PerformanceResourceTiming & { renderBlockingStatus?: string };
        const name = r.name || '';
        const initiatorType = r.initiatorType || '';
        const isFontByExt = /\.(woff2?|ttf|otf|eot)(\?|#|$)/i.test(name);
        const isFontByInitiator = initiatorType === 'css' && isFontByExt;
        if (!isFontByExt && !isFontByInitiator) continue;
        const entry: FontResourceEntry = {
          name,
          transferSize: typeof r.transferSize === 'number' ? r.transferSize : 0,
          encodedBodySize: typeof r.encodedBodySize === 'number' ? r.encodedBodySize : 0,
          startTime: typeof r.startTime === 'number' ? r.startTime : 0,
          initiatorType,
        };
        if (typeof r.renderBlockingStatus === 'string') {
          entry.renderBlockingStatus = r.renderBlockingStatus;
        }
        resources.push(entry);
      }
    } catch {
      /* performance API unavailable */
    }

    let fcp: number | null = null;
    try {
      const paintEntries = performance.getEntriesByType('paint');
      for (const p of paintEntries) {
        if (p.name === 'first-contentful-paint') {
          fcp = typeof p.startTime === 'number' ? p.startTime : null;
          break;
        }
      }
    } catch {
      /* paint timing unavailable */
    }

    return { fontFaces: faces, preloadedFonts, resources, firstContentfulPaint: fcp };
  });

  const issues: FontIssue[] = [];
  const fontFaces = snapshot.fontFaces;
  const preloadedFonts = snapshot.preloadedFonts;
  const resources = snapshot.resources;
  const fcp = snapshot.firstContentfulPaint;

  for (const f of fontFaces) {
    const display = (f.display || '').toLowerCase();
    if (display === '' || display === 'auto') {
      issues.push({
        type: 'missing-font-display',
        detail: `font-face for "${f.family}" has no \`font-display\` descriptor (defaults to auto/block)`,
        target: f.family,
      });
    }
  }

  const uniqueFamilies = new Set<string>();
  for (const f of fontFaces) {
    const name = stripFamilyQuotes(f.family);
    if (name.length > 0) uniqueFamilies.add(name.toLowerCase());
  }
  if (uniqueFamilies.size > MAX_FAMILIES) {
    issues.push({
      type: 'too-many-families',
      detail: `${uniqueFamilies.size} unique font families declared; keep to ${MAX_FAMILIES} or fewer to reduce payload`,
    });
  }

  for (const r of resources) {
    if (!FONT_EXT_RE.test(r.name)) continue;
    if (!isWoff2Url(r.name)) {
      issues.push({
        type: 'non-woff2-format',
        detail: `font served as ${detectFormatFromUrl(r.name) ?? 'non-woff2'}; woff2 is ~30% smaller and universally supported`,
        target: r.name,
      });
    }
  }

  if (fontFaces.length > 0 && preloadedFonts.length === 0) {
    issues.push({
      type: 'no-font-preload',
      detail: `${fontFaces.length} font-face(s) declared but no \`<link rel="preload" as="font">\` hint`,
    });
  }

  for (const r of resources) {
    const size = r.transferSize > 0 ? r.transferSize : r.encodedBodySize;
    if (size > LARGE_FONT_BYTES) {
      const kb = Math.round(size / 1024);
      issues.push({
        type: 'large-font-file',
        detail: `font file is ${kb} KB (>${Math.round(LARGE_FONT_BYTES / 1024)} KB); consider subsetting or unicode-range splitting`,
        target: r.name,
      });
    }
  }

  for (const r of resources) {
    const status = r.renderBlockingStatus;
    let blocking = false;
    if (typeof status === 'string' && status.length > 0) {
      blocking = status !== 'non-blocking';
    } else if (typeof fcp === 'number' && fcp > 0 && r.startTime > 0) {
      blocking = r.startTime < fcp;
    }
    if (blocking) {
      issues.push({
        type: 'blocking-font-request',
        detail: 'font request started before first-contentful-paint and may block text rendering',
        target: r.name,
      });
    }
  }

  const fontResourceCount = resources.length;
  const woff2Count = resources.filter((r) => isWoff2Url(r.name)).length;
  const woff2Ratio = fontResourceCount > 0 ? woff2Count / fontResourceCount : 0;

  const foitRisk = fontFaces.some((f) => {
    const d = (f.display || '').toLowerCase();
    return d === '' || d === 'auto' || d === 'block';
  });

  const totalFontBytes = resources.reduce((sum, r) => {
    const size = r.transferSize > 0 ? r.transferSize : r.encodedBodySize;
    return sum + (size > 0 ? size : 0);
  }, 0);

  return {
    page: pageUrl,
    fontFaces,
    preloadedFonts,
    woff2Ratio,
    foitRisk,
    totalFontBytes,
    issues,
    passed: issues.length === 0,
  };
}
