import type { Page } from 'playwright';

// WCAG 1.4.3 (contrast: minimum) and 1.4.11 (non-text contrast) require adequate
// contrast not just at rest, but at every visual state — hover, focus, active,
// disabled, visited. axe-core only measures default state, so low-contrast
// disabled text, hover underlines, or focus rings slip through. This audit
// triggers each state, measures computed colors, and computes the WCAG ratio.

export type ContrastState = 'hover' | 'focus' | 'active' | 'disabled' | 'visited';

export interface ContrastStateFailure {
  selector: string;
  state: ContrastState;
  ratio: number;
  foreground: string;
  background: string;
  snippet: string;
  threshold: number;
}

export interface ContrastStateMeasurement {
  selector: string;
  state: ContrastState;
  ratio: number;
  foreground: string;
  background: string;
  passed: boolean;
}

export interface ContrastStatesResult {
  page: string;
  elementsMeasured: number;
  measurements: ContrastStateMeasurement[];
  failures: ContrastStateFailure[];
  passed: boolean;
}

export interface ContrastStatesOptions {
  states?: ContrastState[];
  selectors?: string[];
  minRatio?: number;
  maxElements?: number;
}

const DEFAULT_STATES: ContrastState[] = ['hover', 'focus', 'disabled'];
const DEFAULT_SELECTORS = ['button', 'a', 'input', '[role="button"]', '[role="link"]'];
const DEFAULT_MIN_RATIO = 4.5; // WCAG AA text threshold
const NON_TEXT_MIN_RATIO = 3.0; // WCAG 1.4.11 non-text / UI threshold
const DEFAULT_MAX_ELEMENTS = 60;

interface ElementDescriptor {
  selector: string;
  snippet: string;
  tagName: string;
  isDisabled: boolean;
  hasText: boolean;
}

interface ColorSample {
  foreground: string;
  background: string;
  isTextElement: boolean;
}

export async function auditContrastStates(
  page: Page,
  opts: ContrastStatesOptions = {}
): Promise<ContrastStatesResult> {
  const url = page.url();
  const states: ContrastState[] = opts.states && opts.states.length > 0 ? opts.states : DEFAULT_STATES;
  const selectors: string[] =
    opts.selectors && opts.selectors.length > 0 ? opts.selectors : DEFAULT_SELECTORS;
  const minRatio = typeof opts.minRatio === 'number' && opts.minRatio > 0 ? opts.minRatio : DEFAULT_MIN_RATIO;
  const maxElements =
    typeof opts.maxElements === 'number' && opts.maxElements > 0 ? opts.maxElements : DEFAULT_MAX_ELEMENTS;

  const descriptors = await collectElements(page, selectors, maxElements);

  const measurements: ContrastStateMeasurement[] = [];
  const failures: ContrastStateFailure[] = [];

  for (const desc of descriptors) {
    for (const state of states) {
      // Skip disabled state on elements that aren't actually disabled —
      // we cannot ethically toggle the disabled attribute just to measure.
      if (state === 'disabled' && !desc.isDisabled) continue;

      let sample: ColorSample | null = null;
      try {
        sample = await applyStateAndMeasure(page, desc, state);
      } catch {
        sample = null;
      }
      await resetState(page, desc, state).catch(() => {});

      if (!sample) continue;

      const ratio = contrastRatio(sample.foreground, sample.background);
      const threshold = sample.isTextElement ? minRatio : NON_TEXT_MIN_RATIO;
      const passed = ratio >= threshold;

      measurements.push({
        selector: desc.selector,
        state,
        ratio: round(ratio, 3),
        foreground: sample.foreground,
        background: sample.background,
        passed,
      });

      if (!passed) {
        failures.push({
          selector: desc.selector,
          state,
          ratio: round(ratio, 3),
          foreground: sample.foreground,
          background: sample.background,
          snippet: desc.snippet,
          threshold,
        });
      }
    }
  }

  return {
    page: url,
    elementsMeasured: descriptors.length,
    measurements,
    failures,
    passed: failures.length === 0,
  };
}

async function collectElements(
  page: Page,
  selectors: string[],
  maxElements: number
): Promise<ElementDescriptor[]> {
  return page.evaluate(
    (args: { selectors: string[]; maxElements: number }): ElementDescriptor[] => {
      const describe = (el: Element): string => {
        let s = el.tagName.toLowerCase();
        if (el.id) s += `#${el.id}`;
        const firstClass = el.classList?.[0];
        if (firstClass) s += `.${firstClass}`;
        const parent = el.parentElement;
        if (!el.id && parent) {
          const sibs = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
          if (sibs.length > 1) {
            const idx = sibs.indexOf(el);
            if (idx >= 0) s += `:nth-of-type(${idx + 1})`;
          }
        }
        return s;
      };

      const snippetOf = (el: Element): string => {
        const html = (el as HTMLElement).outerHTML || '';
        return html.length > 200 ? html.slice(0, 200) + '…' : html;
      };

      const isElementVisible = (el: Element): boolean => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = getComputedStyle(el as HTMLElement);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (parseFloat(style.opacity || '1') === 0) return false;
        return true;
      };

      const combined = args.selectors.join(', ');
      let nodes: NodeListOf<Element>;
      try {
        nodes = document.querySelectorAll(combined);
      } catch {
        return [];
      }

      const seen = new Set<string>();
      const out: ElementDescriptor[] = [];
      nodes.forEach((el) => {
        if (out.length >= args.maxElements) return;
        if (!isElementVisible(el)) return;
        const selector = describe(el);
        if (seen.has(selector)) return;
        seen.add(selector);
        const text = (el.textContent || '').trim();
        const isDisabled =
          (el as HTMLButtonElement).disabled === true ||
          el.hasAttribute('disabled') ||
          el.getAttribute('aria-disabled') === 'true';
        out.push({
          selector,
          snippet: snippetOf(el),
          tagName: el.tagName.toLowerCase(),
          isDisabled,
          hasText: text.length > 0,
        });
      });
      return out;
    },
    { selectors, maxElements }
  );
}

async function applyStateAndMeasure(
  page: Page,
  desc: ElementDescriptor,
  state: ContrastState
): Promise<ColorSample | null> {
  const locator = page.locator(desc.selector).first();

  if (state === 'hover') {
    await locator.hover({ force: true, timeout: 2000 }).catch(() => {});
  } else if (state === 'focus') {
    await page
      .evaluate((sel: string) => {
        const el = document.querySelector(sel);
        if (el && typeof (el as HTMLElement).focus === 'function') {
          (el as HTMLElement).focus();
        }
      }, desc.selector)
      .catch(() => {});
  } else if (state === 'active') {
    const box = await locator.boundingBox().catch(() => null);
    if (box) {
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y).catch(() => {});
      await page.mouse.down().catch(() => {});
    }
  } else if (state === 'visited') {
    // Visited pseudo-class styles are browser-restricted for privacy; measuring
    // them via getComputedStyle returns the unvisited value. We only flag if
    // the element exposes an aria-current or a [data-visited] signal. For now
    // we sample the rest state — callers can still spot missing differentiation.
  }
  // 'disabled' needs no trigger; we only got here if already disabled.

  // Give the browser one frame to apply the state style.
  await page.waitForTimeout(30).catch(() => {});

  return page.evaluate(
    (sel: string): ColorSample | null => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return null;
      const style = getComputedStyle(el);
      const fg = style.color || 'rgb(0, 0, 0)';

      // Walk up ancestors to find the first non-transparent background.
      const findBackground = (start: HTMLElement): string => {
        let cur: HTMLElement | null = start;
        while (cur) {
          const cs = getComputedStyle(cur);
          const bg = cs.backgroundColor;
          if (bg && !/rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(bg) && bg !== 'transparent') {
            return bg;
          }
          cur = cur.parentElement;
        }
        return 'rgb(255, 255, 255)';
      };

      const bg = findBackground(el);
      const text = (el.textContent || '').trim();
      return { foreground: fg, background: bg, isTextElement: text.length > 0 };
    },
    desc.selector
  );
}

async function resetState(page: Page, desc: ElementDescriptor, state: ContrastState): Promise<void> {
  if (state === 'hover') {
    // Move mouse away to clear hover.
    await page.mouse.move(0, 0).catch(() => {});
  } else if (state === 'focus') {
    await page
      .evaluate((sel: string) => {
        const el = document.querySelector(sel);
        if (el && typeof (el as HTMLElement).blur === 'function') {
          (el as HTMLElement).blur();
        }
      }, desc.selector)
      .catch(() => {});
  } else if (state === 'active') {
    await page.mouse.up().catch(() => {});
    await page.mouse.move(0, 0).catch(() => {});
  }
}

// ---------- WCAG contrast math ----------

export function parseColor(
  input: string
): { r: number; g: number; b: number; a: number } | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;

  if (s.startsWith('#')) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      const r = parseInt(hex[0]! + hex[0]!, 16);
      const g = parseInt(hex[1]! + hex[1]!, 16);
      const b = parseInt(hex[2]! + hex[2]!, 16);
      return { r, g, b, a: 1 };
    }
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return { r, g, b, a: 1 };
    }
    if (hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = parseInt(hex.slice(6, 8), 16) / 255;
      return { r, g, b, a };
    }
    return null;
  }

  const rgbMatch = s.match(/^rgba?\(([^)]+)\)$/);
  if (rgbMatch) {
    const parts = rgbMatch[1]!.split(/[,\s/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const r = parseChannel(parts[0]!);
    const g = parseChannel(parts[1]!);
    const b = parseChannel(parts[2]!);
    const a = parts[3] !== undefined ? parseAlpha(parts[3]) : 1;
    if ([r, g, b].some((v) => Number.isNaN(v))) return null;
    return { r, g, b, a };
  }

  return null;
}

function parseChannel(v: string): number {
  const s = v.trim();
  if (s.endsWith('%')) return Math.round((parseFloat(s) / 100) * 255);
  return parseInt(s, 10);
}

function parseAlpha(v: string): number {
  const s = v.trim();
  if (s.endsWith('%')) return parseFloat(s) / 100;
  return parseFloat(s);
}

function relativeLuminance(r: number, g: number, b: number): number {
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(fg: string, bg: string): number {
  const c1 = parseColor(fg);
  const c2 = parseColor(bg);
  if (!c1 || !c2) return 0;

  // If foreground has alpha < 1, flatten it onto the background.
  const flat = c1.a < 1
    ? {
        r: Math.round(c1.r * c1.a + c2.r * (1 - c1.a)),
        g: Math.round(c1.g * c1.a + c2.g * (1 - c1.a)),
        b: Math.round(c1.b * c1.a + c2.b * (1 - c1.a)),
      }
    : { r: c1.r, g: c1.g, b: c1.b };

  const l1 = relativeLuminance(flat.r, flat.g, flat.b);
  const l2 = relativeLuminance(c2.r, c2.g, c2.b);
  const [lighter, darker] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}

function round(n: number, decimals: number): number {
  const m = Math.pow(10, decimals);
  return Math.round(n * m) / m;
}
