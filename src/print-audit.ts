import type { Page } from 'playwright';

export type PrintIssueType =
  | 'no-print-stylesheet'
  | 'nav-visible-in-print'
  | 'footer-hidden'
  | 'page-break-issues'
  | 'links-no-url'
  | 'images-overflow'
  | 'background-colors-not-adjusted'
  | 'font-size-too-small'
  | 'layout-not-single-column'
  | 'fixed-positioning'
  | 'form-controls-visible';

export interface PrintIssue {
  type: PrintIssueType;
  severity: 'info' | 'warn' | 'error';
  selector?: string;
  detail: string;
}

export interface PrintAuditResult {
  page: string;
  hasPrintStylesheet: boolean;
  printRulesCount: number;
  issues: PrintIssue[];
  screenshotPath?: string;
  passed: boolean;
}

export interface PrintAuditOptions {
  screenshotPath?: string;
}

interface StylesheetScan {
  printRulesCount: number;
  hasPrintMediaRule: boolean;
  breakInsideAvoidCount: number;
  linkAfterRuleFound: boolean;
}

interface NavHit { selector: string; detail: string; }
interface ImageHit { selector: string; width: number; }
interface BgHit { selector: string; coverage: number; color: string; }

interface PrintScan {
  navVisible: NavHit[];
  footerHidden: boolean;
  fixedVisible: NavHit[];
  formControlsVisible: number;
  headingCount: number;
  imagesOverflow: ImageHit[];
  rootFontPx: number;
  bodyMultiColumn: { mode: string; columns: number } | null;
  heavyBackground: BgHit[];
  linkAfterUrlsCount: number;
  linksSampled: number;
}

const NAV_RX = /navbar|menu|sidebar/i;
const LIMITS = { nav: 5, fixed: 5, image: 5, bg: 5 } as const;
const HEADING_THRESHOLD = 5;
const IMAGE_WIDTH_LIMIT_PX = 700;
const MIN_PRINT_FONT_PX = 12;
const HEAVY_BG_COVERAGE = 0.4;
const LINK_SAMPLE_LIMIT = 20;

async function scanStylesheets(page: Page): Promise<StylesheetScan> {
  return await page.evaluate(() => {
    let printRulesCount = 0;
    let hasPrintMediaRule = false;
    let breakInsideAvoidCount = 0;
    let linkAfterRuleFound = false;

    const inspect = (rule: CSSStyleRule, insidePrint: boolean): void => {
      if (insidePrint) printRulesCount += 1;
      const sel = rule.selectorText || '';
      const bi = rule.style.getPropertyValue('break-inside').trim().toLowerCase();
      const pbi = rule.style.getPropertyValue('page-break-inside').trim().toLowerCase();
      if (bi === 'avoid' || pbi === 'avoid') breakInsideAvoidCount += 1;
      if (insidePrint && /a\b[^,{]*::?after/i.test(sel)) {
        if (/attr\(\s*href/i.test(rule.style.getPropertyValue('content'))) {
          linkAfterRuleFound = true;
        }
      }
    };

    const walk = (rules: CSSRuleList | undefined, insidePrint: boolean): void => {
      if (!rules) return;
      for (let i = 0; i < rules.length; i += 1) {
        const r = rules[i];
        if (r instanceof CSSMediaRule) {
          const text = (r.conditionText || r.media.mediaText || '').toLowerCase();
          const isPrint = text.includes('print');
          if (isPrint) hasPrintMediaRule = true;
          walk(r.cssRules, insidePrint || isPrint);
          continue;
        }
        if (r instanceof CSSStyleRule) { inspect(r, insidePrint); continue; }
        const nested = r as unknown as { cssRules?: CSSRuleList };
        if (nested.cssRules) walk(nested.cssRules, insidePrint);
      }
    };

    for (const sheet of Array.from(document.styleSheets)) {
      try { walk(sheet.cssRules, false); } catch { /* cross-origin */ }
    }
    const printLinks = Array.from(document.querySelectorAll('link[rel~="stylesheet"]'))
      .filter(l => /print/i.test(l.getAttribute('media') ?? ''));
    if (printLinks.length > 0) hasPrintMediaRule = true;

    return { printRulesCount, hasPrintMediaRule, breakInsideAvoidCount, linkAfterRuleFound };
  });
}

async function scanPrintState(page: Page): Promise<PrintScan> {
  return await page.evaluate(
    (cfg: { navRx: string; lim: { nav: number; fixed: number; image: number; bg: number };
            imgPx: number; bgCov: number; linkLim: number; }) => {
      const navRx = new RegExp(cfg.navRx, 'i');

      const isVisible = (el: Element): boolean => {
        const cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        const o = Number(cs.opacity);
        return Number.isNaN(o) || o !== 0;
      };

      const describe = (el: Element): string => {
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        const cls = typeof el.className === 'string' && el.className.trim()
          ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
        return `${tag}${id}${cls}`.slice(0, 120);
      };

      const navSet = new Set<Element>();
      for (const el of Array.from(document.querySelectorAll('nav, header nav, [role="navigation"]'))) {
        navSet.add(el);
      }
      for (const el of Array.from(document.querySelectorAll('[class], [id]'))) {
        const cls = typeof el.className === 'string' ? el.className : '';
        if (navRx.test(cls) || navRx.test(el.id || '')) navSet.add(el);
      }
      const navVisible: Array<{ selector: string; detail: string }> = [];
      for (const el of navSet) {
        if (navVisible.length >= cfg.lim.nav) break;
        if (isVisible(el)) navVisible.push({
          selector: describe(el),
          detail: 'Navigation element still rendered when print stylesheet is active.',
        });
      }

      const footerEls = Array.from(document.querySelectorAll('footer'));
      let footerHidden = footerEls.length > 0;
      for (const f of footerEls) if (isVisible(f)) { footerHidden = false; break; }

      const fixedVisible: Array<{ selector: string; detail: string }> = [];
      for (const el of Array.from(document.querySelectorAll('body *'))) {
        if (fixedVisible.length >= cfg.lim.fixed) break;
        const cs = window.getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
        if (!isVisible(el)) continue;
        fixedVisible.push({
          selector: describe(el),
          detail: `Element uses position: ${cs.position} which prints unpredictably.`,
        });
      }

      let formControlsVisible = 0;
      for (const el of Array.from(document.querySelectorAll('input, button, select, textarea'))) {
        if (isVisible(el)) formControlsVisible += 1;
      }

      const headingCount = document.querySelectorAll('h1, h2, h3, h4, h5, h6').length;

      const imagesOverflow: Array<{ selector: string; width: number }> = [];
      for (const img of Array.from(document.querySelectorAll('img'))) {
        if (imagesOverflow.length >= cfg.lim.image) break;
        if (!isVisible(img)) continue;
        const w = img.getBoundingClientRect().width;
        if (w > cfg.imgPx) imagesOverflow.push({ selector: describe(img), width: Math.round(w) });
      }

      const rootFontPx = parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;

      let bodyMultiColumn: { mode: string; columns: number } | null = null;
      const bs = window.getComputedStyle(document.body);
      if (bs.display === 'flex' || bs.display === 'grid') {
        const cc = Array.from(document.body.children).filter(c => isVisible(c)).length;
        if (cc > 1) bodyMultiColumn = { mode: bs.display, columns: cc };
      }

      const heavyBackground: Array<{ selector: string; coverage: number; color: string }> = [];
      const va = Math.max(1, window.innerWidth * window.innerHeight);
      const cands = Array.from(document.querySelectorAll('body, body > *, main, section, header, article'));
      for (const el of cands) {
        if (heavyBackground.length >= cfg.lim.bg) break;
        if (!isVisible(el)) continue;
        const bg = window.getComputedStyle(el).backgroundColor;
        if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') continue;
        const m = bg.match(/rgba?\s*\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)(?:[ ,/]+([\d.]+))?\s*\)/);
        if (!m) continue;
        const r = Number(m[1]), g = Number(m[2]), b = Number(m[3]);
        const a = m[4] === undefined ? 1 : Number(m[4]);
        if (a < 0.5) continue;
        if (r > 240 && g > 240 && b > 240) continue;
        const rect = el.getBoundingClientRect();
        const cov = (Math.max(0, rect.width) * Math.max(0, rect.height)) / va;
        if (cov > cfg.bgCov) heavyBackground.push({
          selector: describe(el), coverage: Number(cov.toFixed(2)), color: bg,
        });
      }

      const links = Array.from(document.querySelectorAll('a[href]')).slice(0, cfg.linkLim);
      let linkAfterUrlsCount = 0;
      for (const a of links) {
        try {
          const c = window.getComputedStyle(a, '::after').content || '';
          if (c && c !== 'none' && c !== 'normal') {
            if (/https?:|attr\(/i.test(c) || c.includes('://')) linkAfterUrlsCount += 1;
          }
        } catch { /* pseudo-element query failed */ }
      }

      return {
        navVisible, footerHidden, fixedVisible, formControlsVisible, headingCount,
        imagesOverflow, rootFontPx, bodyMultiColumn, heavyBackground,
        linkAfterUrlsCount, linksSampled: links.length,
      };
    },
    {
      navRx: NAV_RX.source, lim: LIMITS, imgPx: IMAGE_WIDTH_LIMIT_PX,
      bgCov: HEAVY_BG_COVERAGE, linkLim: LINK_SAMPLE_LIMIT,
    },
  );
}

export async function auditPrint(
  page: Page,
  opts?: PrintAuditOptions,
): Promise<PrintAuditResult> {
  const url = page.url();
  const issues: PrintIssue[] = [];
  let screenshotPath: string | undefined;

  const sheets = await scanStylesheets(page);
  const hasPrintStylesheet = sheets.hasPrintMediaRule || sheets.printRulesCount > 0;

  if (!hasPrintStylesheet) {
    issues.push({
      type: 'no-print-stylesheet',
      severity: 'error',
      detail: 'No @media print rules and no <link media="print"> stylesheet found.',
    });
  }

  try {
    await page.emulateMedia({ media: 'print' });
    const scan = await scanPrintState(page);

    if (opts?.screenshotPath) {
      await page.screenshot({ path: opts.screenshotPath, fullPage: true });
      screenshotPath = opts.screenshotPath;
    }

    for (const n of scan.navVisible) {
      issues.push({ type: 'nav-visible-in-print', severity: 'warn', selector: n.selector, detail: n.detail });
    }
    if (scan.footerHidden) {
      issues.push({
        type: 'footer-hidden', severity: 'info',
        detail: 'Footer is fully hidden in print — readers lose attribution and contact info.',
      });
    }
    for (const f of scan.fixedVisible) {
      issues.push({ type: 'fixed-positioning', severity: 'warn', selector: f.selector, detail: f.detail });
    }
    if (scan.formControlsVisible > 0) {
      issues.push({
        type: 'form-controls-visible', severity: 'info',
        detail: `${scan.formControlsVisible} interactive form controls still visible when print stylesheet runs.`,
      });
    }
    if (scan.headingCount > HEADING_THRESHOLD && sheets.breakInsideAvoidCount === 0) {
      issues.push({
        type: 'page-break-issues', severity: 'info',
        detail: `${scan.headingCount} headings present but no break-inside: avoid rules — sections may split across pages.`,
      });
    }
    for (const img of scan.imagesOverflow) {
      issues.push({
        type: 'images-overflow', severity: 'info', selector: img.selector,
        detail: `Image renders ${img.width}px wide in print, may overflow A4 / Letter page width.`,
      });
    }
    if (!sheets.linkAfterRuleFound && scan.linkAfterUrlsCount === 0 && scan.linksSampled > 0) {
      issues.push({
        type: 'links-no-url', severity: 'warn',
        detail: 'Links do not expand to show href URLs in print — readers cannot follow them on paper.',
      });
    }
    if (scan.rootFontPx < MIN_PRINT_FONT_PX) {
      issues.push({
        type: 'font-size-too-small', severity: 'info',
        detail: `Root font size is ${scan.rootFontPx.toFixed(1)}px (~${(scan.rootFontPx * 0.75).toFixed(1)}pt), below 9pt readability minimum.`,
      });
    }
    if (scan.bodyMultiColumn) {
      issues.push({
        type: 'layout-not-single-column', severity: 'info',
        detail: `Body uses display: ${scan.bodyMultiColumn.mode} with ${scan.bodyMultiColumn.columns} visible columns in print — flatten to single column.`,
      });
    }
    for (const bg of scan.heavyBackground) {
      issues.push({
        type: 'background-colors-not-adjusted', severity: 'info', selector: bg.selector,
        detail: `Heavy background ${bg.color} covers ~${Math.round(bg.coverage * 100)}% of viewport — wastes ink unless print:none.`,
      });
    }
  } finally {
    await page.emulateMedia({ media: 'screen' });
  }

  const passed = hasPrintStylesheet && issues.every(i => i.severity !== 'error');

  return {
    page: url,
    hasPrintStylesheet,
    printRulesCount: sheets.printRulesCount,
    issues,
    screenshotPath,
    passed,
  };
}
