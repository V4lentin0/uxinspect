import type { Page } from 'playwright';

export interface CriticalCssStats {
  totalCssBytes: number;
  criticalCssBytes: number;
  savingsRatio: number;
  sheetCount: number;
  selectorCount: number;
  criticalSelectorCount: number;
}

export interface CriticalCssResult {
  page: string;
  css: string;
  stats: CriticalCssStats;
  recommendations: string[];
  passed: boolean;
}

export interface CriticalCssOptions {
  viewport?: { width: number; height: number };
  scrollProbe?: boolean;
}

interface RuleCapture {
  type: 'style' | 'media' | 'supports' | 'keyframes' | 'fontface';
  selector?: string;
  cssText: string;
  mediaCondition?: string;
  supportsCondition?: string;
  keyframesName?: string;
  matches: boolean;
  fontFamilies?: string[];
  animationsUsed?: string[];
}

interface SheetCapture {
  href: string | null;
  inlineBytes: number;
  accessible: boolean;
  rules: RuleCapture[];
}

interface ExtractionSnapshot {
  viewportHeight: number;
  viewportWidth: number;
  sheets: SheetCapture[];
  totalSelectors: number;
  activeFontFamilies: string[];
  activeAnimationNames: string[];
}

interface EvaluateArgs {
  viewportHeight: number;
  viewportWidth: number;
  scrollOffsets: number[];
}

const MIN_BLOCKING_KB = 4;

function buildSnapshotInBrowser(args: EvaluateArgs): ExtractionSnapshot {
  const { viewportHeight, viewportWidth, scrollOffsets } = args;

  const isAboveFold = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    if (r.bottom < 0 || r.right < 0) return false;
    if (r.top >= viewportHeight || r.left >= viewportWidth) return false;
    return true;
  };

  const sampleSelector = (selector: string): boolean => {
    if (!selector) return false;
    const cleaned = selector.replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, '').trim();
    const effective = cleaned.length > 0 ? cleaned : selector;
    let nodes: Element[];
    try {
      nodes = Array.from(document.querySelectorAll(effective));
    } catch {
      return false;
    }
    for (const n of nodes) {
      if (isAboveFold(n)) return true;
    }
    return false;
  };

  const extractFontFamilies = (text: string): string[] => {
    const out: string[] = [];
    const m = text.match(/font-family\s*:\s*([^;}]+)/i);
    if (!m || !m[1]) return out;
    for (const p of m[1].split(',')) {
      const c = p.replace(/^['"]|['"]$/g, '').trim();
      if (c.length > 0) out.push(c.toLowerCase());
    }
    return out;
  };

  const reservedAnim = /^(infinite|alternate|forwards|backwards|both|none|linear|ease|ease-in|ease-out|ease-in-out|paused|running|normal|reverse|alternate-reverse|step-start|step-end|initial|inherit|unset)$/i;

  const extractAnimationNames = (text: string): string[] => {
    const out: string[] = [];
    const matches = text.match(/\banimation(?:-name)?\s*:\s*([^;}]+)/gi);
    if (!matches) return out;
    for (const full of matches) {
      const idx = full.indexOf(':');
      if (idx === -1) continue;
      for (const t of full.slice(idx + 1).split(/[\s,]+/)) {
        const c = t.trim();
        if (c.length === 0 || reservedAnim.test(c)) continue;
        if (/^\d/.test(c) || c.startsWith('cubic-bezier') || c.startsWith('steps')) continue;
        out.push(c);
      }
    }
    return out;
  };

  const activeFontFamilies = new Set<string>();
  const activeAnimationNames = new Set<string>();
  const collect = (el: Element): void => {
    try {
      const cs = getComputedStyle(el);
      if (cs.fontFamily) for (const p of cs.fontFamily.split(',')) {
        const c = p.replace(/^['"]|['"]$/g, '').trim().toLowerCase();
        if (c.length > 0) activeFontFamilies.add(c);
      }
      if (cs.animationName && cs.animationName !== 'none') for (const n of cs.animationName.split(',')) {
        const c = n.trim();
        if (c.length > 0 && c !== 'none') activeAnimationNames.add(c);
      }
    } catch { /* ignore */ }
  };

  const foldElements = Array.from(document.querySelectorAll('*')).filter(isAboveFold);
  for (const el of foldElements) collect(el);
  const initialScrollY = window.scrollY;
  const visited = new WeakSet<Element>();
  for (const el of foldElements) visited.add(el);
  for (const offset of scrollOffsets.filter((y) => y > 0)) {
    try {
      window.scrollTo(0, offset);
      for (const el of Array.from(document.querySelectorAll('*')).filter(isAboveFold)) {
        if (!visited.has(el)) { visited.add(el); collect(el); }
      }
    } catch { /* ignore */ }
  }
  try { window.scrollTo(0, initialScrollY); } catch { /* ignore */ }

  const sheets: SheetCapture[] = [];
  let totalSelectors = 0;

  const walkRules = (list: CSSRuleList, into: RuleCapture[], media?: string, supports?: string): void => {
    for (let i = 0; i < list.length; i += 1) {
      const rule = list[i];
      if (!rule) continue;
      const k = rule.type;
      if (k === 1) {
        const s = rule as CSSStyleRule;
        const selectorText = s.selectorText || '';
        for (const sel of selectorText.split(',').map((x) => x.trim()).filter((x) => x.length > 0)) {
          totalSelectors += 1;
          const entry: RuleCapture = {
            type: 'style',
            selector: sel,
            cssText: `${sel}{${s.style.cssText}}`,
            matches: sampleSelector(sel),
            fontFamilies: extractFontFamilies(s.style.cssText),
            animationsUsed: extractAnimationNames(s.style.cssText),
          };
          if (media !== undefined) entry.mediaCondition = media;
          if (supports !== undefined) entry.supportsCondition = supports;
          into.push(entry);
        }
      } else if (k === 4) {
        const m = rule as CSSMediaRule;
        const cond = m.conditionText || m.media.mediaText || '';
        walkRules(m.cssRules, into, cond, supports);
      } else if (k === 12) {
        const sp = rule as CSSSupportsRule;
        walkRules(sp.cssRules, into, media, sp.conditionText || '');
      } else if (k === 7) {
        const kf = rule as CSSKeyframesRule;
        into.push({ type: 'keyframes', keyframesName: kf.name, cssText: kf.cssText, matches: false });
      } else if (k === 5) {
        const ff = rule as CSSFontFaceRule;
        into.push({
          type: 'fontface',
          cssText: ff.cssText,
          matches: false,
          fontFamilies: extractFontFamilies(ff.style.cssText),
        });
      }
    }
  };

  for (const sheet of Array.from(document.styleSheets)) {
    const ownerNode = sheet.ownerNode as (Element | null);
    const inlineBytes = ownerNode && ownerNode.nodeName === 'STYLE' ? (ownerNode.textContent || '').length : 0;
    const captured: SheetCapture = { href: sheet.href, inlineBytes, accessible: false, rules: [] };
    let rulesList: CSSRuleList | null = null;
    try {
      rulesList = sheet.cssRules;
      captured.accessible = true;
    } catch {
      captured.accessible = false;
    }
    if (rulesList) walkRules(rulesList, captured.rules);
    sheets.push(captured);
  }

  return {
    viewportHeight,
    viewportWidth,
    sheets,
    totalSelectors,
    activeFontFamilies: Array.from(activeFontFamilies),
    activeAnimationNames: Array.from(activeAnimationNames),
  };
}

function minifyCss(input: string): string {
  let out = input.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.replace(/\s+/g, ' ');
  out = out.replace(/\s*([{};:,>+~])\s*/g, '$1');
  out = out.replace(/;}/g, '}');
  return out.trim();
}

function wrapRule(rule: RuleCapture): string {
  let core = rule.cssText;
  if (rule.supportsCondition) core = `@supports ${rule.supportsCondition}{${core}}`;
  if (rule.mediaCondition) core = `@media ${rule.mediaCondition}{${core}}`;
  return core;
}

async function fetchSheetBytes(page: Page, href: string): Promise<number> {
  try {
    const response = await page.request.get(href, { timeout: 5000 });
    if (!response.ok()) return 0;
    const body = await response.body();
    return body.length;
  } catch {
    return 0;
  }
}

function emptyResult(pageUrl: string): CriticalCssResult {
  return {
    page: pageUrl,
    css: '',
    stats: {
      totalCssBytes: 0,
      criticalCssBytes: 0,
      savingsRatio: 0,
      sheetCount: 0,
      selectorCount: 0,
      criticalSelectorCount: 0,
    },
    recommendations: [],
    passed: true,
  };
}

export async function extractCriticalCss(
  page: Page,
  opts?: CriticalCssOptions,
): Promise<CriticalCssResult> {
  const pageUrl = page.url();
  const currentViewport = page.viewportSize();
  const viewport = opts?.viewport ?? currentViewport ?? { width: 1280, height: 720 };
  const scrollProbe = opts?.scrollProbe === true;

  interface PageWithCoverage {
    coverage?: { startCSSCoverage: (options?: { resetOnNavigation?: boolean }) => Promise<void> };
  }
  const pageWithCoverage = page as unknown as PageWithCoverage;
  if (pageWithCoverage.coverage && typeof pageWithCoverage.coverage.startCSSCoverage === 'function') {
    try {
      await pageWithCoverage.coverage.startCSSCoverage({ resetOnNavigation: false });
    } catch {
      /* already running or unsupported — fall back to DOM inspection */
    }
  }

  let scrollOffsets: number[] = [];
  if (scrollProbe) {
    try {
      const scrollHeight = await page.evaluate(() => document.body.scrollHeight || 0);
      if (scrollHeight > 0) {
        scrollOffsets = [Math.floor(scrollHeight / 3), Math.floor((scrollHeight * 2) / 3)];
      }
    } catch {
      scrollOffsets = [];
    }
  }

  let snapshot: ExtractionSnapshot;
  try {
    snapshot = await page.evaluate(buildSnapshotInBrowser, {
      viewportHeight: viewport.height,
      viewportWidth: viewport.width,
      scrollOffsets,
    });
  } catch {
    return emptyResult(pageUrl);
  }

  let totalCssBytes = 0;
  for (const sheet of snapshot.sheets) totalCssBytes += sheet.inlineBytes;
  const linkedHrefs = new Set<string>();
  for (const sheet of snapshot.sheets) {
    if (sheet.href && sheet.inlineBytes === 0) linkedHrefs.add(sheet.href);
  }
  for (const href of linkedHrefs) totalCssBytes += await fetchSheetBytes(page, href);

  const keptRules: RuleCapture[] = [];
  const usedKeyframes = new Set<string>();
  const usedFonts = new Set<string>();
  let criticalSelectorCount = 0;

  for (const sheet of snapshot.sheets) {
    if (!sheet.accessible) continue;
    for (const rule of sheet.rules) {
      if (rule.type !== 'style' || !rule.matches) continue;
      criticalSelectorCount += 1;
      keptRules.push(rule);
      if (rule.animationsUsed) for (const n of rule.animationsUsed) usedKeyframes.add(n);
      if (rule.fontFamilies) for (const f of rule.fontFamilies) usedFonts.add(f.toLowerCase());
    }
  }
  for (const f of snapshot.activeFontFamilies) usedFonts.add(f.toLowerCase());
  for (const n of snapshot.activeAnimationNames) usedKeyframes.add(n);

  for (const sheet of snapshot.sheets) {
    if (!sheet.accessible) continue;
    for (const rule of sheet.rules) {
      if (rule.type === 'keyframes') {
        if (rule.keyframesName && usedKeyframes.has(rule.keyframesName)) keptRules.push(rule);
      } else if (rule.type === 'fontface') {
        const fams = rule.fontFamilies ?? [];
        if (fams.some((f) => usedFonts.has(f.toLowerCase()))) keptRules.push(rule);
      }
    }
  }

  const parts: string[] = [];
  for (const rule of keptRules) parts.push(rule.type === 'style' ? wrapRule(rule) : rule.cssText);
  const minified = minifyCss(parts.join('\n'));

  const criticalCssBytes = minified.length;
  const savingsRatio = totalCssBytes > 0 ? Math.max(0, (totalCssBytes - criticalCssBytes) / totalCssBytes) : 0;

  const recommendations: string[] = [];
  if (totalCssBytes > 0 && criticalCssBytes > 0) {
    const kb = Math.max(1, Math.round(criticalCssBytes / 1024));
    recommendations.push(
      `inline ${kb} KB of critical CSS and defer rest with <link rel="preload" as="style" onload="this.rel=\\'stylesheet\\'">`,
    );
  }
  if (totalCssBytes > 0 && savingsRatio >= 0.3) {
    const savedKb = Math.max(1, Math.round((totalCssBytes - criticalCssBytes) / 1024));
    recommendations.push(
      `defer ${savedKb} KB of non-critical CSS to unblock first paint (${Math.round(savingsRatio * 100)}% reduction on initial render path)`,
    );
  }
  const blocking = snapshot.sheets.filter((s) => s.href && s.inlineBytes === 0).length;
  if (blocking > 0 && criticalCssBytes / 1024 >= MIN_BLOCKING_KB) {
    recommendations.push(
      `${blocking} external stylesheet(s) block render; inline the critical subset above and async-load the originals`,
    );
  }
  const inaccessible = snapshot.sheets.filter((s) => !s.accessible).length;
  if (inaccessible > 0) {
    recommendations.push(
      `${inaccessible} stylesheet(s) were cross-origin and could not be inspected; add CORS headers to audit them`,
    );
  }

  const passed = totalCssBytes === 0 || savingsRatio > 0;

  return {
    page: pageUrl,
    css: minified,
    stats: {
      totalCssBytes,
      criticalCssBytes,
      savingsRatio,
      sheetCount: snapshot.sheets.length,
      selectorCount: snapshot.totalSelectors,
      criticalSelectorCount,
    },
    recommendations,
    passed,
  };
}
