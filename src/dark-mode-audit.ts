import type { Page, BrowserContext } from 'playwright';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface DarkModeIssue {
  type:
    | 'no-color-scheme-meta'
    | 'no-media-query-support'
    | 'visually-identical'
    | 'contrast-regression'
    | 'hardcoded-color'
    | 'missing-theme-color-dark';
  severity: 'warn' | 'error';
  selector?: string;
  detail: string;
}

export interface DarkModeResult {
  page: string;
  supportsColorScheme: boolean;
  hasColorSchemeMeta: boolean;
  hasThemeColorLight: boolean;
  hasThemeColorDark: boolean;
  lightScreenshot?: string;
  darkScreenshot?: string;
  pixelDiffRatio: number;
  contrastRegressions: Array<{ selector: string; lightRatio: number; darkRatio: number }>;
  issues: DarkModeIssue[];
  passed: boolean;
}

export interface DarkModeAuditOptions {
  screenshotDir?: string;
  sampleSelectors?: string[];
}

// BrowserContext is part of the typed surface so callers can hand a context-derived page.
export type DarkModeContext = BrowserContext;

type Rgba = [number, number, number, number];
type Rgb = [number, number, number];

const DEFAULT_SELECTORS = ['body', 'main', 'h1', 'p', 'a', 'button'];
const PIXEL_DIFF_THRESHOLD = 0.02;
const WCAG_AA_NORMAL = 4.5;
const HARDCODED_LIMIT = 20;

function parseColor(input: string): Rgba | null {
  const s = input.trim().toLowerCase();
  if (!s || s === 'transparent' || s === 'currentcolor') return null;
  const rgb = s.match(/^rgba?\s*\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.%]+))?\s*\)$/);
  if (rgb) {
    const a = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? Number(rgb[4].slice(0, -1)) / 100 : Number(rgb[4]);
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), a];
  }
  const hex = s.match(/^#([0-9a-f]{3,8})$/);
  if (!hex) return null;
  const h = hex[1];
  const expand = (i: number, n: number): number => parseInt(h.slice(i, i + n).padEnd(2, h.slice(i, i + n)), 16);
  if (h.length === 3 || h.length === 4) {
    const a = h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1;
    return [expand(0, 1), expand(1, 1), expand(2, 1), a];
  }
  if (h.length === 6 || h.length === 8) {
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), a];
  }
  return null;
}

function relLum(c: number): number {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function luminance(rgb: Rgb): number {
  return 0.2126 * relLum(rgb[0]) + 0.7152 * relLum(rgb[1]) + 0.0722 * relLum(rgb[2]);
}

function contrastRatio(fgStr: string, bgStr: string): number | null {
  const fg = parseColor(fgStr);
  const bg = parseColor(bgStr);
  if (!fg || !bg) return null;
  const a = fg[3];
  const blended: Rgb = a < 1
    ? [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a)]
    : [fg[0], fg[1], fg[2]];
  const l1 = luminance(blended);
  const l2 = luminance([bg[0], bg[1], bg[2]]);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

function diffRatio(a: Buffer, b: Buffer): number {
  if (a.length === 0 || b.length === 0) return 0;
  const len = Math.min(a.length, b.length);
  let sampled = 0;
  let diff = 0;
  for (let i = 0; i < len; i += 8) {
    sampled += 1;
    if (a[i] !== b[i]) diff += 1;
  }
  return sampled === 0 ? 0 : diff / sampled;
}

async function scanMeta(page: Page) {
  return await page.evaluate(() => {
    const cs = document.querySelector('meta[name="color-scheme"]');
    const themes = Array.from(document.querySelectorAll('meta[name="theme-color"]'));
    let hasLight = false;
    let hasDark = false;
    for (const m of themes) {
      const media = (m.getAttribute('media') ?? '').toLowerCase();
      if (media.includes('prefers-color-scheme: dark')) hasDark = true;
      else hasLight = true;
    }
    return { hasColorSchemeMeta: cs !== null, hasThemeColorLight: hasLight, hasThemeColorDark: hasDark };
  });
}

async function scanStylesheets(page: Page) {
  return await page.evaluate((limit: number) => {
    let supportsColorScheme = false;
    const hardcoded: Array<{ selector: string; detail: string }> = [];
    const commonRx = /(^|[\s,>+~])(html|body|main|a|p|h[1-6])(\s*[,{:.#\[]|$)/i;
    const literalRx = /#[0-9a-f]{3,8}\b|\brgba?\s*\(/i;
    const varRx = /\bvar\s*\(\s*--/i;

    function inspect(rule: CSSStyleRule): void {
      if (hardcoded.length >= limit) return;
      const sel = rule.selectorText || '';
      if (!commonRx.test(sel)) return;
      const style = rule.style;
      const candidates = [
        style.getPropertyValue('color').trim(),
        style.getPropertyValue('background-color').trim(),
        style.getPropertyValue('background').trim(),
      ].filter(v => v.length > 0);
      for (const value of candidates) {
        if (varRx.test(value)) continue;
        if (literalRx.test(value)) {
          hardcoded.push({ selector: sel, detail: `literal color in rule: ${value.slice(0, 80)}` });
          break;
        }
      }
    }

    function walk(rules: CSSRuleList | undefined): void {
      if (!rules) return;
      for (let i = 0; i < rules.length; i += 1) {
        const rule = rules[i];
        if (rule instanceof CSSMediaRule) {
          const text = (rule.conditionText || rule.media.mediaText || '').toLowerCase();
          if (text.includes('prefers-color-scheme: dark')) supportsColorScheme = true;
          walk(rule.cssRules);
          continue;
        }
        if (rule instanceof CSSStyleRule) { inspect(rule); continue; }
        const nested = rule as unknown as { cssRules?: CSSRuleList };
        if (nested.cssRules) walk(nested.cssRules);
      }
    }

    for (const sheet of Array.from(document.styleSheets)) {
      try { walk(sheet.cssRules); } catch { /* cross-origin */ }
    }
    return { supportsColorScheme, hardcodedRules: hardcoded };
  }, HARDCODED_LIMIT);
}

async function readSelectorColors(page: Page, selectors: string[]) {
  return await page.evaluate((sels: string[]) => {
    function effectiveBg(el: Element): string {
      let cur: Element | null = el;
      while (cur) {
        const bg = window.getComputedStyle(cur).backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
        cur = cur.parentElement;
      }
      return window.getComputedStyle(document.documentElement).backgroundColor || 'rgb(255, 255, 255)';
    }
    return sels.map(sel => {
      try {
        const el = document.querySelector(sel);
        if (!el) return { selector: sel, found: false, fg: '', bg: '' };
        const cs = window.getComputedStyle(el);
        return { selector: sel, found: true, fg: cs.color, bg: effectiveBg(el) };
      } catch {
        return { selector: sel, found: false, fg: '', bg: '' };
      }
    });
  }, selectors);
}

export async function auditDarkMode(
  page: Page,
  opts?: DarkModeAuditOptions,
): Promise<DarkModeResult> {
  const url = page.url();
  const sampleSelectors = opts?.sampleSelectors ?? DEFAULT_SELECTORS;
  const issues: DarkModeIssue[] = [];

  const meta = await scanMeta(page);
  const styles = await scanStylesheets(page);

  await page.emulateMedia({ colorScheme: 'light' });
  const lightBytes = await page.screenshot({ type: 'png', fullPage: false });
  const lightColors = await readSelectorColors(page, sampleSelectors);

  await page.emulateMedia({ colorScheme: 'dark' });
  const darkBytes = await page.screenshot({ type: 'png', fullPage: false });
  const darkColors = await readSelectorColors(page, sampleSelectors);

  let lightScreenshot: string | undefined;
  let darkScreenshot: string | undefined;
  if (opts?.screenshotDir) {
    await fs.mkdir(opts.screenshotDir, { recursive: true });
    lightScreenshot = path.join(opts.screenshotDir, 'dark-mode-light.png');
    darkScreenshot = path.join(opts.screenshotDir, 'dark-mode-dark.png');
    await fs.writeFile(lightScreenshot, lightBytes);
    await fs.writeFile(darkScreenshot, darkBytes);
  }

  const pixelDiffRatio = diffRatio(lightBytes, darkBytes);
  await page.emulateMedia({ colorScheme: null });

  if (!meta.hasColorSchemeMeta) {
    issues.push({ type: 'no-color-scheme-meta', severity: 'warn', detail: 'Missing <meta name="color-scheme">; browsers cannot pre-style scrollbars or form controls.' });
  }
  if (!styles.supportsColorScheme) {
    issues.push({ type: 'no-media-query-support', severity: 'error', detail: 'No @media (prefers-color-scheme: dark) rules found in any same-origin stylesheet.' });
  }
  if (meta.hasThemeColorLight && !meta.hasThemeColorDark) {
    issues.push({ type: 'missing-theme-color-dark', severity: 'warn', detail: 'theme-color defined for light only; add a media="(prefers-color-scheme: dark)" variant.' });
  }
  if (styles.supportsColorScheme && pixelDiffRatio < PIXEL_DIFF_THRESHOLD) {
    issues.push({ type: 'visually-identical', severity: 'warn', detail: `Light vs dark differ by only ${(pixelDiffRatio * 100).toFixed(2)}%; dark mode rules may not actually apply.` });
  }
  for (const rule of styles.hardcodedRules) {
    issues.push({ type: 'hardcoded-color', severity: 'warn', selector: rule.selector, detail: rule.detail });
  }

  const contrastRegressions: DarkModeResult['contrastRegressions'] = [];
  for (let i = 0; i < sampleSelectors.length; i += 1) {
    const sel = sampleSelectors[i];
    const light = lightColors[i];
    const dark = darkColors[i];
    if (!light?.found || !dark?.found) continue;
    const lightRatio = contrastRatio(light.fg, light.bg);
    const darkRatio = contrastRatio(dark.fg, dark.bg);
    if (lightRatio === null || darkRatio === null) continue;
    if (darkRatio < lightRatio && darkRatio < WCAG_AA_NORMAL) {
      const lr = Number(lightRatio.toFixed(2));
      const dr = Number(darkRatio.toFixed(2));
      contrastRegressions.push({ selector: sel, lightRatio: lr, darkRatio: dr });
      issues.push({ type: 'contrast-regression', severity: 'error', selector: sel, detail: `Contrast drops from ${lr} (light) to ${dr} (dark); below WCAG AA 4.5:1.` });
    }
  }

  return {
    page: url,
    supportsColorScheme: styles.supportsColorScheme,
    hasColorSchemeMeta: meta.hasColorSchemeMeta,
    hasThemeColorLight: meta.hasThemeColorLight,
    hasThemeColorDark: meta.hasThemeColorDark,
    lightScreenshot,
    darkScreenshot,
    pixelDiffRatio: Number(pixelDiffRatio.toFixed(4)),
    contrastRegressions,
    issues,
    passed: issues.every(i => i.severity !== 'error'),
  };
}
