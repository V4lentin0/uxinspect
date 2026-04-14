import type { Page } from 'playwright';

export interface WebfontEntry {
  family: string;
  url?: string;
  format?: string;
  source: 'google' | 'adobe' | 'self-hosted' | 'system' | 'other';
  size?: number;
  loadDurationMs?: number;
  fontDisplay?: string;
  preloaded: boolean;
}

export interface WebfontIssue {
  type:
    | 'missing-font-display'
    | 'too-many-fonts'
    | 'no-preload-critical-font'
    | 'large-font-file'
    | 'using-google-fonts-css';
  target?: string;
  detail: string;
}

export interface WebfontsResult {
  page: string;
  fonts: WebfontEntry[];
  totalFontBytes: number;
  totalFontsLoaded: number;
  issues: WebfontIssue[];
  passed: boolean;
}

export async function auditWebfonts(page: Page): Promise<WebfontsResult> {
  const url = page.url();

  const { fonts, googleFontsCssLinks } = await page.evaluate(() => {
    function hostnameOf(u: string): string {
      try {
        return new URL(u, window.location.href).hostname;
      } catch {
        return '';
      }
    }

    function categorize(u: string | undefined): 'google' | 'adobe' | 'self-hosted' | 'system' | 'other' {
      if (!u) return 'system';
      const host = hostnameOf(u);
      if (!host) return 'other';
      if (host === 'fonts.googleapis.com' || host === 'fonts.gstatic.com') return 'google';
      if (
        host === 'use.typekit.net' ||
        host === 'use.fontawesome.com' ||
        host.endsWith('typekit.net') ||
        host.includes('adobe')
      ) return 'adobe';
      if (host === window.location.hostname) return 'self-hosted';
      return 'other';
    }

    function extractUrl(src: string): string | undefined {
      if (!src) return undefined;
      const m = src.match(/url\(\s*(['"]?)([^'")]+)\1\s*\)/);
      return m ? m[2] : undefined;
    }

    function extractFormat(src: string): string | undefined {
      if (!src) return undefined;
      const m = src.match(/format\(\s*(['"]?)([^'")]+)\1\s*\)/);
      return m ? m[2] : undefined;
    }

    // Preloaded font URLs
    const preloaded = new Set<string>();
    const preloadLinks = Array.from(document.querySelectorAll('link[rel="preload"][as="font"]'));
    for (const link of preloadLinks) {
      const href = (link as HTMLLinkElement).href;
      if (href) preloaded.add(href);
    }

    // Google Fonts CSS links (render-blocking)
    const googleFontsCssLinks: string[] = [];
    const allLinks = Array.from(document.querySelectorAll('link[href]'));
    for (const link of allLinks) {
      const href = (link as HTMLLinkElement).href;
      if (href && href.includes('fonts.googleapis.com')) {
        googleFontsCssLinks.push(href);
      }
    }

    // Gather @font-face rules from stylesheets to get src/format/font-display
    interface FaceInfo {
      family: string;
      url?: string;
      format?: string;
      fontDisplay?: string;
    }
    const faces: FaceInfo[] = [];

    const sheets = Array.from(document.styleSheets);
    for (const sheet of sheets) {
      let rules: CSSRuleList | null = null;
      try {
        rules = sheet.cssRules;
      } catch {
        // CORS-blocked stylesheet
        continue;
      }
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        if ((rule as CSSRule).constructor.name === 'CSSFontFaceRule' || (rule as { type?: number }).type === 5) {
          const style = (rule as CSSFontFaceRule).style;
          const rawFamily = style.getPropertyValue('font-family').trim().replace(/^['"]|['"]$/g, '');
          const src = style.getPropertyValue('src');
          const display = style.getPropertyValue('font-display').trim() || undefined;
          faces.push({
            family: rawFamily,
            url: extractUrl(src),
            format: extractFormat(src),
            fontDisplay: display,
          });
        }
      }
    }

    // FontFaceSet iteration
    const loaded: Array<{
      family: string;
      display?: string;
      status: string;
    }> = [];
    try {
      const fs = (document as Document & { fonts?: FontFaceSet }).fonts;
      if (fs) {
        fs.forEach((ff: FontFace) => {
          loaded.push({
            family: (ff.family || '').replace(/^['"]|['"]$/g, ''),
            display: ff.display,
            status: ff.status,
          });
        });
      }
    } catch {
      // ignore
    }

    // Resource timings for font files
    interface ResTiming {
      name: string;
      transferSize?: number;
      duration: number;
      initiatorType: string;
    }
    const resources: ResTiming[] = [];
    try {
      const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      for (const e of entries) {
        const isFontFile = /\.(woff2?|ttf|otf|eot)(\?|#|$)/i.test(e.name);
        const fromCss = e.initiatorType === 'css';
        if (isFontFile || fromCss) {
          resources.push({
            name: e.name,
            transferSize: e.transferSize,
            duration: e.duration,
            initiatorType: e.initiatorType,
          });
        }
      }
    } catch {
      // ignore
    }

    // Merge: one entry per font URL when present, else per family
    interface MergedFont {
      family: string;
      url?: string;
      format?: string;
      source: 'google' | 'adobe' | 'self-hosted' | 'system' | 'other';
      size?: number;
      loadDurationMs?: number;
      fontDisplay?: string;
      preloaded: boolean;
    }

    const merged: MergedFont[] = [];
    const seenUrls = new Set<string>();

    for (const face of faces) {
      const entry: MergedFont = {
        family: face.family,
        url: face.url,
        format: face.format,
        source: categorize(face.url),
        fontDisplay: face.fontDisplay,
        preloaded: false,
      };
      if (face.url) {
        const absolute = (() => {
          try {
            return new URL(face.url, window.location.href).href;
          } catch {
            return face.url;
          }
        })();
        entry.preloaded = preloaded.has(absolute);
        const res = resources.find(r => r.name === absolute || r.name.endsWith(face.url!));
        if (res) {
          entry.size = res.transferSize;
          entry.loadDurationMs = Math.round(res.duration);
        }
        seenUrls.add(absolute);
      }
      merged.push(entry);
    }

    // Add any font resource not covered by @font-face (CORS-blocked stylesheets)
    for (const res of resources) {
      if (!/\.(woff2?|ttf|otf|eot)(\?|#|$)/i.test(res.name)) continue;
      if (seenUrls.has(res.name)) continue;
      const matchedFace = loaded.find(l => l.family);
      merged.push({
        family: matchedFace?.family || 'unknown',
        url: res.name,
        format: (res.name.match(/\.(woff2?|ttf|otf|eot)/i)?.[1] || undefined)?.toLowerCase(),
        source: categorize(res.name),
        size: res.transferSize,
        loadDurationMs: Math.round(res.duration),
        fontDisplay: matchedFace?.display,
        preloaded: preloaded.has(res.name),
      });
      seenUrls.add(res.name);
    }

    // Also include FontFaceSet-only families that have no @font-face match (system or API-added)
    for (const l of loaded) {
      if (!l.family) continue;
      const exists = merged.some(m => m.family.toLowerCase() === l.family.toLowerCase());
      if (!exists) {
        merged.push({
          family: l.family,
          source: 'system',
          fontDisplay: l.display,
          preloaded: false,
        });
      }
    }

    return { fonts: merged, googleFontsCssLinks };
  });

  // Build issues
  const issues: WebfontIssue[] = [];

  for (const f of fonts) {
    if (f.url && (!f.fontDisplay || f.fontDisplay === 'auto' || f.fontDisplay === 'block')) {
      issues.push({
        type: 'missing-font-display',
        target: f.url || f.family,
        detail: `Font "${f.family}" has font-display: ${f.fontDisplay || 'not set'} (use swap, fallback, or optional)`,
      });
    }

    if (typeof f.size === 'number' && f.size > 100 * 1024) {
      issues.push({
        type: 'large-font-file',
        target: f.url || f.family,
        detail: `Font file is ${Math.round(f.size / 1024)}KB (>100KB)`,
      });
    }

    if (
      f.url &&
      !f.preloaded &&
      typeof f.loadDurationMs === 'number' &&
      f.loadDurationMs > 0 &&
      // approximate "critical / above-the-fold" = loaded in first 1000ms
      f.loadDurationMs <= 1000
    ) {
      issues.push({
        type: 'no-preload-critical-font',
        target: f.url,
        detail: `Critical font "${f.family}" loaded quickly but is not preloaded`,
      });
    }
  }

  const distinctFontFiles = new Set(fonts.filter(f => f.url).map(f => f.url!));
  if (distinctFontFiles.size > 4) {
    issues.push({
      type: 'too-many-fonts',
      detail: `${distinctFontFiles.size} distinct font files loaded (>4)`,
    });
  }

  if (googleFontsCssLinks.length > 0) {
    for (const href of googleFontsCssLinks) {
      issues.push({
        type: 'using-google-fonts-css',
        target: href,
        detail: 'Google Fonts CSS link is render-blocking; self-host or use preconnect + font-display: swap',
      });
    }
  }

  const totalFontBytes = fonts.reduce((sum, f) => sum + (typeof f.size === 'number' ? f.size : 0), 0);
  const totalFontsLoaded = fonts.filter(f => f.url).length;

  return {
    page: url,
    fonts,
    totalFontBytes,
    totalFontsLoaded,
    issues,
    passed: issues.length === 0,
  };
}
