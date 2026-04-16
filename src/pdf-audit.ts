/**
 * P4 #43 — PDF / print audit.
 *
 * Renders the current page to a PDF via Chromium's `page.pdf()`, then inspects
 * the resulting bytes and the live DOM under `@media print` to flag common
 * print-output defects:
 *
 *   - Page count (blown-out expectations via `expectedMaxPages`).
 *   - Content that lands inside the header / footer margin strip
 *     (configurable top/bottom y-ranges in PostScript points).
 *   - Elements marked `break-inside: avoid` (heuristically) that straddle a
 *     hard page break.
 *   - Images whose rendered width exceeds the printable content width and
 *     would overflow the page box.
 *   - Screen-vs-print layout drift: elements whose computed box actually
 *     changes between `emulateMedia({ media: 'screen' })` and `'print'`.
 *
 * PDF parsing is delegated to `pdfjs-dist` — we dynamically import it so the
 * dependency stays OPTIONAL. Callers declare the peer dep; if it's not
 * installed the audit still runs and returns a single `pdfjs-missing` issue
 * rather than throwing.
 *
 * CHROMIUM-ONLY: `page.pdf()` is a CDP call and is not implemented by
 * Firefox or WebKit in Playwright. Passing a non-Chromium `Page` yields a
 * `wrong-browser` issue and `passed = false`. This is documented on
 * `PdfConfig.browser`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import type {
  PdfConfig,
  PdfResult,
  PdfIssue,
  PdfIssueType,
  PdfPage,
  PdfTextItem,
  PdfLayoutDrift,
} from './types.js';

// Re-export so callers can `import { PdfConfig } from './pdf-audit.js'` if they prefer.
export type { PdfConfig, PdfResult, PdfIssue, PdfIssueType, PdfPage, PdfTextItem, PdfLayoutDrift };

const DEFAULT_PAGE_SIZE = 'A4' as const;
const DEFAULT_OUT_DIR = path.join('.uxinspect', 'pdf');
// 1 inch = 72 pt. Chromium default margin = 0.4in (~29pt) top/bottom.
const DEFAULT_HEADER_STRIP_PT = 36; // top 36pt of every page is "header" land
const DEFAULT_FOOTER_STRIP_PT = 36; // bottom 36pt of every page is "footer" land
const DEFAULT_MAX_TEXT_ITEMS_PER_PAGE = 2000;
const DEFAULT_LAYOUT_SAMPLE_CAP = 50;

// Page sizes in PostScript points (1in = 72pt). Width × height of a single
// physical sheet, used to compute header / footer y-coordinates.
const PAGE_SIZES_PT: Record<'A4' | 'Letter', { w: number; h: number }> = {
  A4: { w: 595.28, h: 841.89 },
  Letter: { w: 612, h: 792 },
};

function resolvePageSize(size: PdfConfig['pageSize']): { w: number; h: number; label: string } {
  if (!size || size === 'A4') return { ...PAGE_SIZES_PT.A4, label: 'A4' };
  if (size === 'Letter') return { ...PAGE_SIZES_PT.Letter, label: 'Letter' };
  return { w: size.w, h: size.h, label: `${Math.round(size.w)}x${Math.round(size.h)}pt` };
}

interface PdfItemsByPage {
  pageCount: number;
  pages: PdfPage[];
  truncated: boolean;
}

/**
 * Dynamic pdfjs-dist loader. Keeps the dep optional so users who don't need
 * PDF analysis aren't forced to install ~3MB of legacy wasm.
 *
 * Typed as `any` because the module is declared in package.json but never
 * installed in CI — TypeScript's module-resolver would otherwise fail the
 * build on `import('pdfjs-dist/…')`.
 */
async function loadPdfjs(): Promise<Record<string, unknown> | null> {
  try {
    const specifier = 'pdfjs-dist/legacy/build/pdf.mjs';
    // Indirect specifier defeats TS' static module-resolution so the package
    // can remain an optional peer dep.
    const mod = await (Function('s', 'return import(s)') as (s: string) => Promise<Record<string, unknown>>)(specifier);
    return mod;
  } catch {
    return null;
  }
}

async function parsePdfBytes(
  bytes: Uint8Array,
  pageSize: { w: number; h: number },
): Promise<PdfItemsByPage | null> {
  const pdfjs = await loadPdfjs();
  if (!pdfjs) return null;

  // pdfjs mutates the buffer it's handed — copy first so callers can re-use bytes.
  const data = new Uint8Array(bytes.byteLength);
  data.set(bytes);

  const task = (pdfjs as any).getDocument({
    data,
    // Workers add noise to the error log in Node; force a main-thread run.
    disableWorker: true,
    // Keep the parser quiet.
    verbosity: 0,
  });
  const doc = await task.promise;
  const pages: PdfPage[] = [];
  let truncated = false;

  for (let i = 1; i <= doc.numPages; i += 1) {
    const pg = await doc.getPage(i);
    const viewport = pg.getViewport({ scale: 1 });
    const textContent = await pg.getTextContent();
    const items: PdfPage['items'] = [];
    for (const it of textContent.items as Array<{ str: string; transform: number[]; width: number; height: number }>) {
      if (items.length >= DEFAULT_MAX_TEXT_ITEMS_PER_PAGE) { truncated = true; break; }
      const t = it.transform;
      // pdfjs gives a 6-element affine matrix [a, b, c, d, e, f]. Baseline x=e, y=f.
      // Coordinates are PDF-space (origin bottom-left, y grows upward).
      const x = Number(t?.[4] ?? 0);
      const yFromBottom = Number(t?.[5] ?? 0);
      const yFromTop = viewport.height - yFromBottom;
      items.push({
        text: typeof it.str === 'string' ? it.str : '',
        x: Number.isFinite(x) ? x : 0,
        y: Number.isFinite(yFromTop) ? yFromTop : 0,
        width: Number(it.width ?? 0),
        height: Number(it.height ?? 0),
      });
    }
    pages.push({
      pageNumber: i,
      widthPt: Number(viewport.width ?? pageSize.w),
      heightPt: Number(viewport.height ?? pageSize.h),
      items,
    });
    try { pg.cleanup(); } catch { /* pdfjs version without cleanup */ }
  }
  try { await doc.destroy(); } catch { /* older pdfjs */ }
  return { pageCount: doc.numPages, pages, truncated };
}

interface BreakAvoidProbe {
  selector: string;
  topPx: number;
  bottomPx: number;
  heightPx: number;
}

interface LayoutProbe {
  selector: string;
  screen: { x: number; y: number; w: number; h: number; display: string; visible: boolean };
  print: { x: number; y: number; w: number; h: number; display: string; visible: boolean } | null;
  hasPrintRule: boolean;
}

/**
 * Collect DOM probes we need while under print emulation:
 *   1. `@page` rules (size / margin declarations) detected via `document.styleSheets`.
 *   2. Images whose rendered width exceeds a content-width threshold.
 *   3. Elements with `break-inside: avoid` / `page-break-inside: avoid`, with
 *      their scrollY-absolute top/bottom in CSS px (later mapped to PDF pages).
 *   4. Font size of documentElement — helps diagnose "12pt minimum" rules.
 */
async function collectPrintDom(
  page: Page,
  contentWidthPx: number,
): Promise<{
  pageRules: { size?: string; margin?: string }[];
  overflowImages: { selector: string; widthPx: number }[];
  breakAvoid: BreakAvoidProbe[];
  scrollHeightPx: number;
  viewportPx: { w: number; h: number };
}> {
  return await page.evaluate((cfg: { contentWidthPx: number }) => {
    const describe = (el: Element): string => {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : '';
      const cls = typeof el.className === 'string' && el.className.trim()
        ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
        : '';
      return `${tag}${id}${cls}`.slice(0, 120);
    };

    const pageRules: { size?: string; margin?: string }[] = [];
    const walk = (rules: CSSRuleList | undefined): void => {
      if (!rules) return;
      for (let i = 0; i < rules.length; i += 1) {
        const r = rules[i] as CSSRule;
        // CSSPageRule (type 6) isn't always in the lib dom — duck-type it.
        const anyR = r as unknown as { type?: number; style?: CSSStyleDeclaration; cssRules?: CSSRuleList };
        if (anyR.type === 6 && anyR.style) {
          pageRules.push({
            size: anyR.style.getPropertyValue('size') || undefined,
            margin: anyR.style.getPropertyValue('margin') || undefined,
          });
        } else if (anyR.cssRules) {
          walk(anyR.cssRules);
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try { walk(sheet.cssRules); } catch { /* cross-origin */ }
    }

    const overflowImages: { selector: string; widthPx: number }[] = [];
    for (const img of Array.from(document.querySelectorAll('img'))) {
      const rect = img.getBoundingClientRect();
      if (rect.width > cfg.contentWidthPx + 4) {
        overflowImages.push({ selector: describe(img), widthPx: Math.round(rect.width) });
        if (overflowImages.length >= 20) break;
      }
    }

    const breakAvoid: Array<{ selector: string; topPx: number; bottomPx: number; heightPx: number }> = [];
    const all = document.querySelectorAll('body *');
    const pageYOffset = window.scrollY || window.pageYOffset || 0;
    for (const el of Array.from(all)) {
      const cs = window.getComputedStyle(el);
      const bi = cs.getPropertyValue('break-inside').trim().toLowerCase();
      const pbi = cs.getPropertyValue('page-break-inside').trim().toLowerCase();
      if (bi !== 'avoid' && pbi !== 'avoid') continue;
      const rect = el.getBoundingClientRect();
      if (rect.height <= 0) continue;
      breakAvoid.push({
        selector: describe(el),
        topPx: rect.top + pageYOffset,
        bottomPx: rect.bottom + pageYOffset,
        heightPx: rect.height,
      });
      if (breakAvoid.length >= 50) break;
    }

    return {
      pageRules,
      overflowImages,
      breakAvoid,
      scrollHeightPx: document.documentElement.scrollHeight,
      viewportPx: { w: window.innerWidth, h: window.innerHeight },
    };
  }, { contentWidthPx });
}

/**
 * Re-probe layout under both media modes for elements that have a dedicated
 * `@media print` rule. We simply sample N significant elements (id'd or
 * heading-level) and compare their bounding boxes between emulation modes.
 */
async function collectLayoutProbes(page: Page, sampleCap: number): Promise<LayoutProbe[]> {
  return await page.evaluate((cap: number) => {
    const describe = (el: Element): string => {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : '';
      const cls = typeof el.className === 'string' && el.className.trim()
        ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
        : '';
      return `${tag}${id}${cls}`.slice(0, 120);
    };
    const hasPrintRuleFor = (el: Element): boolean => {
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          const rules = sheet.cssRules;
          if (!rules) continue;
          for (let i = 0; i < rules.length; i += 1) {
            const r = rules[i];
            if (r instanceof CSSMediaRule && /print/i.test(r.media.mediaText || '')) {
              for (let j = 0; j < r.cssRules.length; j += 1) {
                const sub = r.cssRules[j] as CSSStyleRule;
                if (sub && sub.selectorText) {
                  try { if (el.matches(sub.selectorText)) return true; } catch { /* bad sel */ }
                }
              }
            }
          }
        } catch { /* cross-origin */ }
      }
      return false;
    };
    const cands = Array.from(document.querySelectorAll(
      'nav, header, footer, main, aside, h1, h2, [id], [class*="print"]',
    )).slice(0, cap);
    const probes: Array<{
      selector: string;
      top: number; left: number; w: number; h: number;
      display: string; visible: boolean;
      hasPrintRule: boolean;
    }> = [];
    for (const el of cands) {
      const cs = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      probes.push({
        selector: describe(el),
        top: rect.top, left: rect.left, w: rect.width, h: rect.height,
        display: cs.display,
        visible: cs.display !== 'none' && cs.visibility !== 'hidden',
        hasPrintRule: hasPrintRuleFor(el),
      });
    }
    return probes;
  }, sampleCap).then(probes => probes.map(p => ({
    selector: p.selector,
    screen: { x: p.left, y: p.top, w: p.w, h: p.h, display: p.display, visible: p.visible },
    print: null,
    hasPrintRule: p.hasPrintRule,
  } satisfies LayoutProbe)));
}

async function sampleLayoutForSelectors(
  page: Page,
  selectors: string[],
): Promise<Record<string, LayoutProbe['screen']>> {
  if (selectors.length === 0) return {};
  return await page.evaluate((sels: string[]) => {
    const out: Record<string, { x: number; y: number; w: number; h: number; display: string; visible: boolean }> = {};
    for (const sel of sels) {
      try {
        const el = document.querySelector(sel);
        if (!el) continue;
        const cs = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        out[sel] = {
          x: rect.left, y: rect.top, w: rect.width, h: rect.height,
          display: cs.display,
          visible: cs.display !== 'none' && cs.visibility !== 'hidden',
        };
      } catch { /* invalid sel */ }
    }
    return out;
  }, selectors);
}

function approxEqual(a: number, b: number, eps = 1.5): boolean {
  return Math.abs(a - b) <= eps;
}

function boxesEqual(a: LayoutProbe['screen'], b: LayoutProbe['screen']): boolean {
  return a.visible === b.visible
    && a.display === b.display
    && approxEqual(a.x, b.x)
    && approxEqual(a.y, b.y)
    && approxEqual(a.w, b.w)
    && approxEqual(a.h, b.h);
}

/**
 * Map CSS-px scrollY ranges to PDF page numbers by scaling total doc height
 * to total PDF height. Accurate within ~1 line for typical 1:1 print CSS.
 */
function rangeToPageSpan(
  topPx: number,
  bottomPx: number,
  totalPx: number,
  totalPages: number,
  pageHeightPt: number,
): { firstPage: number; lastPage: number } {
  if (totalPx <= 0 || totalPages <= 0) return { firstPage: 1, lastPage: 1 };
  const pxPerPage = totalPx / totalPages;
  const firstPage = Math.max(1, Math.floor(topPx / pxPerPage) + 1);
  const lastPage = Math.min(totalPages, Math.max(firstPage, Math.floor((bottomPx - 1) / pxPerPage) + 1));
  return { firstPage, lastPage };
}

/** Runs the PDF audit on the currently-loaded page. Chromium-only. */
export async function runPdfAudit(page: Page, opts: PdfConfig = {}): Promise<PdfResult> {
  const startedAt = new Date().toISOString();
  const issues: PdfIssue[] = [];
  const url = page.url();

  // ── 0. Chromium-only guard ────────────────────────────────────────────────
  const browserName = page.context().browser()?.browserType().name() ?? 'unknown';
  if (browserName !== 'chromium') {
    issues.push({
      type: 'wrong-browser',
      severity: 'error',
      detail: `runPdfAudit requires Chromium; got ${browserName}. page.pdf() is a CDP method.`,
    });
    return {
      page: url,
      startedAt,
      browser: browserName,
      pageCount: 0,
      pages: [],
      issues,
      layoutDrift: [],
      pdfPath: undefined,
      sizeBytes: 0,
      passed: false,
    };
  }

  const size = resolvePageSize(opts.pageSize);
  const headerStrip = opts.headerFooterAllowedYs?.top ?? DEFAULT_HEADER_STRIP_PT;
  const footerStrip = opts.headerFooterAllowedYs?.bottom ?? DEFAULT_FOOTER_STRIP_PT;
  const outDir = opts.outDir ?? DEFAULT_OUT_DIR;
  // Chromium's default margin = 0.4in. Content width in px (CSS px ≈ pt at 1x).
  const contentWidthPx = size.w - (headerStrip + footerStrip);

  // ── 1. Swap to print media ────────────────────────────────────────────────
  await sampleLayoutForSelectors(page, []).catch(() => ({})); // noop warm-up
  const screenProbes = await collectLayoutProbes(page, DEFAULT_LAYOUT_SAMPLE_CAP).catch(() => [] as LayoutProbe[]);

  let pdfPath: string | undefined;
  let sizeBytes = 0;
  let parsed: PdfItemsByPage | null = null;
  let domProbe: Awaited<ReturnType<typeof collectPrintDom>> | null = null;
  const layoutDrift: PdfLayoutDrift[] = [];

  try {
    await page.emulateMedia({ media: 'print' });

    // Re-sample the same selectors under print media.
    const printSample = await sampleLayoutForSelectors(
      page,
      screenProbes.map(p => p.selector),
    ).catch(() => ({} as Record<string, LayoutProbe['screen']>));

    for (const probe of screenProbes) {
      const printBox = printSample[probe.selector];
      if (!printBox) continue;
      probe.print = printBox;
      const unchanged = boxesEqual(probe.screen, printBox);
      if (probe.hasPrintRule && unchanged) {
        // A dedicated @media print rule exists for this selector yet nothing
        // moved — the rule is dead CSS.
        layoutDrift.push({
          selector: probe.selector,
          hadPrintRule: true,
          changed: false,
          screen: probe.screen,
          print: printBox,
        });
        issues.push({
          type: 'print-rule-no-effect',
          severity: 'warn',
          selector: probe.selector,
          detail: 'Matched @media print rule exists but computed box is identical to screen layout.',
        });
      } else if (!probe.hasPrintRule && !unchanged) {
        layoutDrift.push({
          selector: probe.selector,
          hadPrintRule: false,
          changed: true,
          screen: probe.screen,
          print: printBox,
        });
      } else if (probe.hasPrintRule && !unchanged) {
        layoutDrift.push({
          selector: probe.selector,
          hadPrintRule: true,
          changed: true,
          screen: probe.screen,
          print: printBox,
        });
      }
    }

    domProbe = await collectPrintDom(page, contentWidthPx).catch(() => null);

    // ── 2. Render PDF ─────────────────────────────────────────────────────
    let bytes: Uint8Array | null = null;
    try {
      const pdfOpts: Parameters<Page['pdf']>[0] = {
        printBackground: true,
      };
      if (opts.pageSize === 'A4' || opts.pageSize === 'Letter' || opts.pageSize == null) {
        pdfOpts.format = (opts.pageSize ?? DEFAULT_PAGE_SIZE) as 'A4' | 'Letter';
      } else {
        // page.pdf() accepts px/in/cm/mm — NOT pt. Convert pt→in (1pt = 1/72in).
        pdfOpts.width = `${(opts.pageSize.w / 72).toFixed(4)}in`;
        pdfOpts.height = `${(opts.pageSize.h / 72).toFixed(4)}in`;
      }
      const buf = await page.pdf(pdfOpts);
      bytes = new Uint8Array(buf);
      sizeBytes = buf.byteLength;

      if (opts.outDir !== null && opts.outDir !== '') {
        await fs.mkdir(outDir, { recursive: true }).catch(() => {});
        const fname = `pdf-audit-${Date.now()}.pdf`;
        pdfPath = path.join(outDir, fname);
        await fs.writeFile(pdfPath, buf).catch(() => { pdfPath = undefined; });
      }
    } catch (err) {
      issues.push({
        type: 'pdf-render-failed',
        severity: 'error',
        detail: `page.pdf() threw: ${(err as Error).message}`,
      });
    }

    // ── 3. Parse PDF bytes ────────────────────────────────────────────────
    if (bytes) {
      parsed = await parsePdfBytes(bytes, size).catch((err) => {
        issues.push({
          type: 'pdf-parse-failed',
          severity: 'warn',
          detail: `pdfjs-dist failed to parse the PDF: ${(err as Error).message}`,
        });
        return null;
      });
      if (!parsed) {
        issues.push({
          type: 'pdfjs-missing',
          severity: 'info',
          detail: 'pdfjs-dist is not installed. Install it to enable byte-level PDF checks: `npm i -D pdfjs-dist`.',
        });
      }
    }
  } finally {
    await page.emulateMedia({ media: 'screen' }).catch(() => {});
  }

  const pageCount = parsed?.pageCount ?? 0;
  const pdfPages: PdfPage[] = parsed?.pages ?? [];

  // ── 4. Content checks ───────────────────────────────────────────────────
  if (parsed) {
    // 4a. expectedMaxPages
    if (typeof opts.expectedMaxPages === 'number' && pageCount > opts.expectedMaxPages) {
      issues.push({
        type: 'too-many-pages',
        severity: 'warn',
        detail: `PDF has ${pageCount} pages, exceeds expectedMaxPages=${opts.expectedMaxPages}.`,
      });
    }
    // 4b. Header / footer bleed.
    for (const pg of pdfPages) {
      for (const item of pg.items) {
        const text = (item.text ?? '').trim();
        if (!text) continue;
        if (item.y < headerStrip) {
          issues.push({
            type: 'header-bleed',
            severity: 'warn',
            detail: `Page ${pg.pageNumber}: text "${text.slice(0, 40)}" at y=${item.y.toFixed(1)}pt lands inside header strip (< ${headerStrip}pt).`,
          });
          break;
        }
        const footerBoundary = pg.heightPt - footerStrip;
        if (item.y > footerBoundary) {
          issues.push({
            type: 'footer-bleed',
            severity: 'warn',
            detail: `Page ${pg.pageNumber}: text "${text.slice(0, 40)}" at y=${item.y.toFixed(1)}pt lands inside footer strip (> ${footerBoundary.toFixed(1)}pt).`,
          });
          break;
        }
      }
    }
  }

  // 4c. break-inside: avoid straddling a page break.
  if (domProbe && pageCount > 0) {
    for (const probe of domProbe.breakAvoid) {
      const { firstPage, lastPage } = rangeToPageSpan(
        probe.topPx,
        probe.bottomPx,
        domProbe.scrollHeightPx,
        pageCount,
        size.h,
      );
      if (firstPage !== lastPage) {
        issues.push({
          type: 'break-inside-straddle',
          severity: 'warn',
          selector: probe.selector,
          detail: `Element declares break-inside: avoid but spans pages ${firstPage}–${lastPage} (height ${Math.round(probe.heightPx)}px).`,
        });
      }
    }
  }

  // 4d. Images wider than the printable area.
  if (domProbe) {
    for (const img of domProbe.overflowImages) {
      issues.push({
        type: 'image-overflow',
        severity: 'warn',
        selector: img.selector,
        detail: `Image renders ${img.widthPx}px wide, exceeds printable content width (~${Math.round(contentWidthPx)}px for ${size.label}).`,
      });
    }
  }

  // 4e. Missing @page rule is a soft info.
  if (domProbe && domProbe.pageRules.length === 0) {
    issues.push({
      type: 'no-page-rule',
      severity: 'info',
      detail: 'No CSS @page rule found — relying on browser defaults for page size and margins.',
    });
  }

  const fatal = issues.some(i => i.severity === 'error');
  const passed = !fatal && !issues.some(i => i.type === 'header-bleed' || i.type === 'footer-bleed' || i.type === 'break-inside-straddle' || i.type === 'image-overflow');

  return {
    page: url,
    startedAt,
    browser: browserName,
    pageCount,
    pages: pdfPages,
    issues,
    layoutDrift,
    pdfPath,
    sizeBytes,
    passed,
  };
}
