import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';

export type PdfAuditIssueType =
  | 'page-break-mid-row'
  | 'page-break-mid-image'
  | 'page-break-mid-heading'
  | 'hidden-on-print-visible'
  | 'print-critical-missing'
  | 'color-adjust-missing'
  | 'overflow-page-width'
  | 'no-print-stylesheet'
  | 'pdf-generation-failed';

export interface PdfAuditIssue {
  type: PdfAuditIssueType;
  severity: 'info' | 'warn' | 'error';
  selector?: string;
  detail: string;
}

export interface PdfAuditOptions {
  url?: string;
  format?: 'A4' | 'Letter';
  landscape?: boolean;
  outDir?: string;
  selectors?: {
    hideOnPrint?: string[];
    showOnPrint?: string[];
  };
}

export interface PdfAuditResult {
  page: string;
  pdfPath?: string;
  pageCount: number;
  format: 'A4' | 'Letter';
  landscape: boolean;
  pageHeightPx: number;
  pageWidthPx: number;
  totalHeightPx: number;
  issues: PdfAuditIssue[];
  passed: boolean;
}

// CSS pixels at 96 DPI for Chromium PDF output
const PAGE_SIZES: Record<'A4' | 'Letter', { widthPx: number; heightPx: number }> = {
  A4: { widthPx: 794, heightPx: 1123 },
  Letter: { widthPx: 816, heightPx: 1056 },
};

const DEFAULT_HIDE_ON_PRINT = [
  'nav',
  '[role="navigation"]',
  'header nav',
  '[class*="ads" i]',
  '[class*="advert" i]',
  '[data-print="hide"]',
  'button:not([data-print="show"])',
];

function slugifyUrl(url: string): string {
  try {
    const u = new URL(url);
    const pathPart = u.pathname.replace(/\/$/, '').replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '');
    const slug = `${u.hostname}${pathPart ? '-' + pathPart : ''}`.toLowerCase();
    return slug.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'page';
  } catch {
    return 'page';
  }
}

interface SplitScan {
  splitRows: { selector: string; top: number; bottom: number }[];
  splitImages: { selector: string; top: number; bottom: number }[];
  splitHeadings: { selector: string; top: number; bottom: number; level: number }[];
  stillVisibleHidden: { selector: string; matched: string }[];
  missingCritical: string[];
  overflowRight: { selector: string; right: number }[];
  criticalBadges: { selector: string; color: string; bg: string; hasColorAdjust: boolean }[];
  bodyWidth: number;
  bodyHeight: number;
}

async function scanLayout(
  page: Page,
  pageHeightPx: number,
  pageWidthPx: number,
  hideOnPrint: string[],
  showOnPrint: string[],
): Promise<SplitScan> {
  return await page.evaluate(
    ({ pageHeightPx, pageWidthPx, hideOnPrint, showOnPrint }) => {
      const describe = (el: Element): string => {
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        const cls =
          typeof el.className === 'string' && el.className.trim()
            ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
            : '';
        return `${tag}${id}${cls}`.slice(0, 140);
      };

      const isVisible = (el: Element): boolean => {
        const cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        const o = Number(cs.opacity);
        if (!Number.isNaN(o) && o === 0) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const crossesPageBoundary = (top: number, bottom: number): boolean => {
        if (bottom - top >= pageHeightPx) return false;
        const topPage = Math.floor(top / pageHeightPx);
        const bottomPage = Math.floor((bottom - 1) / pageHeightPx);
        return topPage !== bottomPage;
      };

      const splitRows: { selector: string; top: number; bottom: number }[] = [];
      for (const el of Array.from(document.querySelectorAll('tr'))) {
        if (!isVisible(el)) continue;
        const rect = el.getBoundingClientRect();
        const top = rect.top + window.scrollY;
        const bottom = rect.bottom + window.scrollY;
        if (crossesPageBoundary(top, bottom)) {
          splitRows.push({ selector: describe(el), top: Math.round(top), bottom: Math.round(bottom) });
          if (splitRows.length >= 10) break;
        }
      }

      const splitImages: { selector: string; top: number; bottom: number }[] = [];
      for (const el of Array.from(document.querySelectorAll('img, svg, canvas, video, picture'))) {
        if (!isVisible(el)) continue;
        const rect = el.getBoundingClientRect();
        const top = rect.top + window.scrollY;
        const bottom = rect.bottom + window.scrollY;
        if (crossesPageBoundary(top, bottom)) {
          splitImages.push({ selector: describe(el), top: Math.round(top), bottom: Math.round(bottom) });
          if (splitImages.length >= 10) break;
        }
      }

      const splitHeadings: { selector: string; top: number; bottom: number; level: number }[] = [];
      for (const el of Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))) {
        if (!isVisible(el)) continue;
        const rect = el.getBoundingClientRect();
        const top = rect.top + window.scrollY;
        const bottom = rect.bottom + window.scrollY;
        const level = Number(el.tagName.substring(1));
        if (crossesPageBoundary(top, bottom)) {
          splitHeadings.push({
            selector: describe(el),
            top: Math.round(top),
            bottom: Math.round(bottom),
            level,
          });
          if (splitHeadings.length >= 10) break;
        }
      }

      const stillVisibleHidden: { selector: string; matched: string }[] = [];
      for (const sel of hideOnPrint) {
        try {
          for (const el of Array.from(document.querySelectorAll(sel))) {
            if (isVisible(el)) {
              stillVisibleHidden.push({ selector: describe(el), matched: sel });
              if (stillVisibleHidden.length >= 15) break;
            }
          }
        } catch {
          /* invalid selector */
        }
        if (stillVisibleHidden.length >= 15) break;
      }

      const missingCritical: string[] = [];
      // Only require showOnPrint selectors (user-specified); critical heuristics are advisory
      for (const sel of showOnPrint) {
        try {
          const el = document.querySelector(sel);
          if (!el || !isVisible(el)) missingCritical.push(sel);
        } catch {
          /* skip */
        }
      }

      const overflowRight: { selector: string; right: number }[] = [];
      for (const el of Array.from(document.querySelectorAll('body *'))) {
        if (!isVisible(el)) continue;
        const rect = el.getBoundingClientRect();
        const right = rect.right + window.scrollX;
        if (right > pageWidthPx + 2) {
          const cs = window.getComputedStyle(el);
          if (cs.position === 'fixed' || cs.position === 'sticky') continue;
          if (rect.width > pageWidthPx * 0.2) {
            overflowRight.push({ selector: describe(el), right: Math.round(right) });
            if (overflowRight.length >= 10) break;
          }
        }
      }

      const criticalBadges: {
        selector: string;
        color: string;
        bg: string;
        hasColorAdjust: boolean;
      }[] = [];
      const badgeSelectors = [
        '[class*="badge" i]',
        '[class*="status" i]',
        '[class*="tag" i]',
        '[class*="chip" i]',
        '[class*="pill" i]',
      ];
      for (const sel of badgeSelectors) {
        try {
          for (const el of Array.from(document.querySelectorAll(sel))) {
            if (!isVisible(el)) continue;
            const cs = window.getComputedStyle(el);
            const bg = cs.backgroundColor;
            const color = cs.color;
            if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') continue;
            const pca =
              (cs as unknown as { printColorAdjust?: string }).printColorAdjust ??
              (cs as unknown as { webkitPrintColorAdjust?: string }).webkitPrintColorAdjust ??
              cs.getPropertyValue('print-color-adjust') ??
              cs.getPropertyValue('-webkit-print-color-adjust') ??
              '';
            criticalBadges.push({
              selector: describe(el),
              color,
              bg,
              hasColorAdjust: pca === 'exact',
            });
            if (criticalBadges.length >= 10) break;
          }
        } catch {
          /* skip */
        }
        if (criticalBadges.length >= 10) break;
      }

      const bodyRect = document.body.getBoundingClientRect();
      return {
        splitRows,
        splitImages,
        splitHeadings,
        stillVisibleHidden,
        missingCritical,
        overflowRight,
        criticalBadges,
        bodyWidth: Math.round(bodyRect.width),
        bodyHeight: Math.round(
          Math.max(
            bodyRect.height,
            document.documentElement.scrollHeight,
            document.body.scrollHeight,
          ),
        ),
      };
    },
    { pageHeightPx, pageWidthPx, hideOnPrint, showOnPrint },
  );
}

async function hasPrintStylesheet(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    let found = false;
    const walk = (rules: CSSRuleList | undefined): void => {
      if (!rules || found) return;
      for (let i = 0; i < rules.length; i += 1) {
        const r = rules[i];
        if (r instanceof CSSMediaRule) {
          const text = (r.conditionText || r.media.mediaText || '').toLowerCase();
          if (text.includes('print')) {
            found = true;
            return;
          }
          walk(r.cssRules);
          continue;
        }
        const nested = r as unknown as { cssRules?: CSSRuleList };
        if (nested.cssRules) walk(nested.cssRules);
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        walk(sheet.cssRules);
      } catch {
        /* cross-origin */
      }
      if (found) break;
    }
    if (!found) {
      for (const link of Array.from(document.querySelectorAll('link[rel~="stylesheet"]'))) {
        const media = link.getAttribute('media') || '';
        if (/print/i.test(media)) {
          found = true;
          break;
        }
      }
    }
    return found;
  });
}

export async function auditPrintMedia(
  page: Page,
  opts: PdfAuditOptions = {},
): Promise<PdfAuditResult> {
  const url = opts.url ?? page.url();
  const format = opts.format ?? 'A4';
  const landscape = opts.landscape ?? false;
  const outDir = opts.outDir ?? '.uxinspect/print';
  const hideOnPrint = [...DEFAULT_HIDE_ON_PRINT, ...(opts.selectors?.hideOnPrint ?? [])];
  const showOnPrint = opts.selectors?.showOnPrint ?? [];

  const size = PAGE_SIZES[format];
  const pageWidthPx = landscape ? size.heightPx : size.widthPx;
  const pageHeightPx = landscape ? size.widthPx : size.heightPx;

  const issues: PdfAuditIssue[] = [];
  let pdfPath: string | undefined;
  let pageCount = 0;
  let totalHeightPx = 0;

  try {
    const hasPrint = await hasPrintStylesheet(page).catch(() => false);
    if (!hasPrint) {
      issues.push({
        type: 'no-print-stylesheet',
        severity: 'warn',
        detail: 'No @media print rules or <link media="print"> stylesheet detected.',
      });
    }

    await page.emulateMedia({ media: 'print' });

    const scan = await scanLayout(page, pageHeightPx, pageWidthPx, hideOnPrint, showOnPrint);
    totalHeightPx = scan.bodyHeight;
    pageCount = Math.max(1, Math.ceil(totalHeightPx / pageHeightPx));

    for (const row of scan.splitRows) {
      issues.push({
        type: 'page-break-mid-row',
        severity: 'warn',
        selector: row.selector,
        detail: `Table row splits across a page boundary (top=${row.top}px bottom=${row.bottom}px, page height=${pageHeightPx}px). Use break-inside: avoid.`,
      });
    }
    for (const img of scan.splitImages) {
      issues.push({
        type: 'page-break-mid-image',
        severity: 'warn',
        selector: img.selector,
        detail: `Image/media splits across a page boundary (top=${img.top}px bottom=${img.bottom}px). Use break-inside: avoid.`,
      });
    }
    for (const h of scan.splitHeadings) {
      issues.push({
        type: 'page-break-mid-heading',
        severity: 'warn',
        selector: h.selector,
        detail: `Heading h${h.level} is split across pages — use break-after: avoid or break-inside: avoid.`,
      });
    }
    for (const hidden of scan.stillVisibleHidden) {
      issues.push({
        type: 'hidden-on-print-visible',
        severity: 'warn',
        selector: hidden.selector,
        detail: `Element matching "${hidden.matched}" is visible under print media — add @media print { display: none }.`,
      });
    }
    for (const sel of scan.missingCritical) {
      issues.push({
        type: 'print-critical-missing',
        severity: 'error',
        selector: sel,
        detail: `Print-critical element "${sel}" is absent or hidden in the printed output.`,
      });
    }
    for (const o of scan.overflowRight) {
      issues.push({
        type: 'overflow-page-width',
        severity: 'warn',
        selector: o.selector,
        detail: `Content extends to ${o.right}px, beyond the ${pageWidthPx}px page width — may be clipped in PDF.`,
      });
    }
    for (const badge of scan.criticalBadges) {
      if (!badge.hasColorAdjust) {
        issues.push({
          type: 'color-adjust-missing',
          severity: 'info',
          selector: badge.selector,
          detail: `Coloured element (bg=${badge.bg}, color=${badge.color}) lacks print-color-adjust: exact — colours may be stripped by print.`,
        });
      }
    }

    try {
      await fs.mkdir(outDir, { recursive: true });
      const slug = slugifyUrl(url);
      const file = path.join(outDir, `${slug}.pdf`);
      await page.pdf({ path: file, format, landscape, printBackground: true });
      pdfPath = file;
      const stat = await fs.stat(file).catch(() => null);
      if (!stat || stat.size === 0) {
        issues.push({
          type: 'pdf-generation-failed',
          severity: 'error',
          detail: 'PDF file was written but is empty.',
        });
      }
    } catch (err) {
      issues.push({
        type: 'pdf-generation-failed',
        severity: 'error',
        detail: `PDF generation failed: ${(err as Error).message ?? String(err)}`,
      });
    }
  } finally {
    await page.emulateMedia({ media: 'screen' }).catch(() => {});
  }

  const passed = !issues.some((i) => i.severity === 'error');

  return {
    page: url,
    pdfPath,
    pageCount,
    format,
    landscape,
    pageHeightPx,
    pageWidthPx,
    totalHeightPx,
    issues,
    passed,
  };
}
