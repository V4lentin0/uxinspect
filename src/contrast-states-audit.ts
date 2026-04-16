import type { Page } from 'playwright';
import type { ContrastConfig, ContrastResult, ContrastState, ContrastViolation } from './types.js';

// P4 #38 — Color contrast at every interaction state.
//
// Walks every interactive element (a, button, input, select, textarea, and
// common widget roles) and measures computed foreground vs background colour
// contrast for each requested state: default, hover, focus, active, disabled.
//
// Uses real WCAG relative-luminance math (sRGB gamma + 0.2126/0.7152/0.0722
// coefficients + (L1+0.05)/(L2+0.05)). Flags:
//   - Body / primary text: < 4.5:1 (AA), < 7:1 (AAA)
//   - Large text (>=18pt / >=14pt bold): < 3:1 (AA), < 4.5:1 (AAA)
//   - Focus indicators (outline / box-shadow ring vs adjacent surface): < 3:1
//
// Background detection walks up the DOM to the first ancestor with a
// non-transparent background colour, blending semi-transparent colours along
// the way so alpha doesn't silently mask failures.

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type=hidden])',
  'select',
  'textarea',
  '[role=button]',
  '[role=link]',
  '[role=tab]',
  '[role=menuitem]',
  '[role=checkbox]',
  '[role=radio]',
].join(',');

const DEFAULT_STATES: ContrastState[] = ['default', 'hover', 'focus', 'active', 'disabled'];

export async function runContrastStatesAudit(
  page: Page,
  opts?: ContrastConfig,
): Promise<ContrastResult> {
  const targetLevel: 'AA' | 'AAA' = opts?.targetLevel ?? 'AA';
  const skipSelectors: string[] = Array.isArray(opts?.skip) ? (opts!.skip as string[]) : [];
  const requestedStates: ContrastState[] = Array.isArray(opts?.states) && opts!.states!.length
    ? (opts!.states as ContrastState[])
    : DEFAULT_STATES;
  const maxElements = opts?.maxElements ?? 200;
  const url = page.url();

  // Phase 1: collect candidates in page context.
  const candidates = await page.evaluate(
    ({ selector, skipSelectors, maxElements }: {
      selector: string;
      skipSelectors: string[];
      maxElements: number;
    }) => {
      function buildSelector(el: Element): string {
        if (el.id) return `#${CSS.escape(el.id)}`;
        const testid = el.getAttribute('data-testid');
        if (testid) return `[data-testid="${testid}"]`;
        const tag = el.tagName.toLowerCase();
        const cls = Array.from(el.classList).slice(0, 2);
        const role = el.getAttribute('role');
        let s = tag;
        if (cls.length) s += '.' + cls.map(c => CSS.escape(c)).join('.');
        if (role && !el.id && !cls.length) s += `[role="${role}"]`;
        const parent = el.parentElement;
        if (parent) {
          const sibs = Array.from(parent.children).filter(c => c.tagName === el.tagName);
          if (sibs.length > 1) {
            const idx = sibs.indexOf(el);
            if (idx >= 0) s += `:nth-of-type(${idx + 1})`;
          }
        }
        return s;
      }

      function matches(el: Element, skipList: string[]): boolean {
        for (const s of skipList) {
          try { if (el.matches(s)) return true; } catch { /* ignore bad selectors */ }
        }
        return false;
      }

      const out: Array<{
        selector: string;
        tag: string;
        text: string;
        disabled: boolean;
      }> = [];

      const nodes = Array.from(document.querySelectorAll(selector));
      let assigned = 0;
      for (const el of nodes) {
        if (assigned >= maxElements) break;
        if (matches(el, skipSelectors)) continue;
        const rect = (el as HTMLElement).getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const style = getComputedStyle(el as HTMLElement);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        if (parseFloat(style.opacity || '1') === 0) continue;
        const text = (el.textContent || '').trim().slice(0, 60);
        const disabled =
          (el as HTMLInputElement).disabled === true ||
          el.hasAttribute('disabled') ||
          el.getAttribute('aria-disabled') === 'true';
        // Tag each candidate with a stable data-attr so we can re-query from Node side.
        el.setAttribute('data-uxi-contrast', String(assigned));
        out.push({ selector: buildSelector(el), tag: el.tagName.toLowerCase(), text, disabled });
        assigned += 1;
      }
      return out;
    },
    { selector: INTERACTIVE_SELECTOR, skipSelectors, maxElements },
  );

  const violations: ContrastViolation[] = [];
  const stateCounts: Record<ContrastState, number> = {
    default: 0, hover: 0, focus: 0, active: 0, disabled: 0,
  };

  const thresholdForText = (level: 'AA' | 'AAA', large: boolean): number => {
    if (level === 'AAA') return large ? 4.5 : 7;
    return large ? 3 : 4.5;
  };
  const FOCUS_RING_THRESHOLD = 3;

  // Phase 2: for every candidate × state, simulate and measure.
  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    if (!cand) continue;
    const handleSel = `[data-uxi-contrast="${i}"]`;
    const elementHandle = await page.$(handleSel);
    if (!elementHandle) continue;

    for (const state of requestedStates) {
      // Skip states that don't apply to this element.
      if (state === 'disabled' && !cand.disabled) continue;
      if (state === 'hover' && cand.disabled) continue;
      if (state === 'focus' && cand.disabled) continue;
      if (state === 'active' && cand.disabled) continue;

      // Simulate the state. Wrap in try/catch so a single failed element
      // never aborts the audit.
      try {
        if (state === 'hover') {
          await elementHandle.hover({ force: true, timeout: 1000 }).catch(() => {});
        } else if (state === 'focus') {
          await elementHandle.evaluate((n: Element) => (n as HTMLElement).focus?.()).catch(() => {});
        } else if (state === 'active') {
          await elementHandle.dispatchEvent('mousedown').catch(() => {});
        } else {
          // default/disabled — clear any residual state.
          await page.mouse.move(0, 0).catch(() => {});
          await elementHandle.evaluate((n: Element) => (n as HTMLElement).blur?.()).catch(() => {});
        }
      } catch { /* best effort */ }

      // Read computed styles + effective background in page context.
      const measurement = await elementHandle.evaluate((el: Element) => {
        // --- colour parsing ---
        type Rgba = [number, number, number, number];
        function parseColor(input: string): Rgba | null {
          if (!input) return null;
          const s = input.trim();
          if (s === 'transparent' || s === 'none') return [0, 0, 0, 0];
          if (s.startsWith('#')) {
            const h = s.slice(1);
            const expand = (i: number, step: number): number =>
              step === 1 ? parseInt(h[i] + h[i], 16) : parseInt(h.slice(i * 2, i * 2 + 2), 16);
            if (h.length === 3 || h.length === 4) {
              const a = h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1;
              return [expand(0, 1), expand(1, 1), expand(2, 1), a];
            }
            if (h.length === 6 || h.length === 8) {
              const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
              return [
                parseInt(h.slice(0, 2), 16),
                parseInt(h.slice(2, 4), 16),
                parseInt(h.slice(4, 6), 16),
                a,
              ];
            }
            return null;
          }
          const m = s.match(/rgba?\(([^)]+)\)/i);
          if (m && m[1]) {
            const parts = m[1].split(',').map(p => p.trim());
            const r = parseFloat(parts[0] || '0');
            const g = parseFloat(parts[1] || '0');
            const b = parseFloat(parts[2] || '0');
            const a = parts.length >= 4 ? parseFloat(parts[3] || '1') : 1;
            if ([r, g, b].some(Number.isNaN)) return null;
            return [r, g, b, Number.isNaN(a) ? 1 : a];
          }
          return null;
        }

        function blend(fg: Rgba, bg: Rgba): Rgba {
          const a = fg[3];
          if (a >= 1) return [fg[0], fg[1], fg[2], 1];
          return [
            fg[0] * a + bg[0] * (1 - a),
            fg[1] * a + bg[1] * (1 - a),
            fg[2] * a + bg[2] * (1 - a),
            1,
          ];
        }

        function relLum(c: number): number {
          const v = c / 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        }
        function luminance(rgb: Rgba): number {
          return 0.2126 * relLum(rgb[0]) + 0.7152 * relLum(rgb[1]) + 0.0722 * relLum(rgb[2]);
        }
        function ratio(fg: Rgba, bg: Rgba): number {
          const l1 = luminance(fg);
          const l2 = luminance(bg);
          const hi = Math.max(l1, l2);
          const lo = Math.min(l1, l2);
          return (hi + 0.05) / (lo + 0.05);
        }

        // Walk up the DOM until we find a non-transparent background,
        // blending each translucent layer we pass through.
        function effectiveBackground(start: Element): Rgba {
          let node: Element | null = start;
          let acc: Rgba = [0, 0, 0, 0];
          while (node) {
            const cs = getComputedStyle(node);
            const parsed = parseColor(cs.backgroundColor) || [0, 0, 0, 0];
            if (parsed[3] > 0) {
              if (acc[3] === 0) acc = parsed;
              else {
                // Composite: acc is on top of parsed.
                const a = acc[3];
                acc = [
                  acc[0] * a + parsed[0] * (1 - a),
                  acc[1] * a + parsed[1] * (1 - a),
                  acc[2] * a + parsed[2] * (1 - a),
                  Math.min(1, a + parsed[3] * (1 - a)),
                ];
              }
              if (acc[3] >= 0.999) return acc;
            }
            node = node.parentElement;
          }
          // Fallback: assume white page background.
          const fallback: Rgba = [255, 255, 255, 1];
          if (acc[3] === 0) return fallback;
          const a = acc[3];
          return [
            acc[0] * a + 255 * (1 - a),
            acc[1] * a + 255 * (1 - a),
            acc[2] * a + 255 * (1 - a),
            1,
          ];
        }

        const cs = getComputedStyle(el as HTMLElement);
        const fgRaw = parseColor(cs.color) || [0, 0, 0, 1];
        const bg = effectiveBackground(el);
        const fg = blend(fgRaw, bg);
        const textRatio = ratio(fg, bg);

        // Text size classification: >= 18pt (24px) or >= 14pt (18.66px) bold.
        const fontSizePx = parseFloat(cs.fontSize || '16') || 16;
        const fontWeight = parseInt(cs.fontWeight || '400', 10) || 400;
        const isLarge =
          fontSizePx >= 24 ||
          (fontSizePx >= 18.66 && fontWeight >= 700);

        // Focus-indicator ring contrast: outline or box-shadow colour vs bg.
        let ringRatio: number | null = null;
        let ringColorStr: string | null = null;
        const outlineStyle = cs.outlineStyle;
        const outlineWidthPx = parseFloat(cs.outlineWidth || '0') || 0;
        if (outlineStyle && outlineStyle !== 'none' && outlineWidthPx > 0) {
          const oc = parseColor(cs.outlineColor);
          if (oc && oc[3] > 0) {
            const blended = blend(oc, bg);
            ringRatio = ratio(blended, bg);
            ringColorStr = cs.outlineColor;
          }
        }
        // box-shadow may carry a focus ring (e.g. Tailwind focus:ring-2).
        if (ringRatio === null && cs.boxShadow && cs.boxShadow !== 'none') {
          const m = cs.boxShadow.match(/rgba?\([^)]+\)|#[0-9a-f]{3,8}/i);
          if (m) {
            const sc = parseColor(m[0]);
            if (sc && sc[3] > 0) {
              const blended = blend(sc, bg);
              ringRatio = ratio(blended, bg);
              ringColorStr = m[0];
            }
          }
        }

        const toHex = (rgb: Rgba): string => {
          const r = Math.round(Math.max(0, Math.min(255, rgb[0])));
          const g = Math.round(Math.max(0, Math.min(255, rgb[1])));
          const b = Math.round(Math.max(0, Math.min(255, rgb[2])));
          return '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('');
        };

        return {
          fgHex: toHex(fg),
          bgHex: toHex(bg),
          textRatio,
          isLarge,
          fontSizePx,
          fontWeight,
          ringRatio,
          ringColorHex: ringColorStr,
          hasText: !!(el.textContent || '').trim(),
        };
      }).catch(() => null);

      if (!measurement) continue;
      stateCounts[state] = (stateCounts[state] || 0) + 1;

      // Text contrast violation.
      if (measurement.hasText) {
        const required = thresholdForText(targetLevel, measurement.isLarge);
        if (measurement.textRatio < required) {
          violations.push({
            selector: cand.selector,
            state,
            kind: 'text',
            level: targetLevel,
            ratio: Math.round(measurement.textRatio * 100) / 100,
            required,
            foreground: measurement.fgHex,
            background: measurement.bgHex,
            isLarge: measurement.isLarge,
            fontSizePx: Math.round(measurement.fontSizePx * 10) / 10,
            snippet: cand.text,
            message:
              `${cand.tag} text contrast ${(Math.round(measurement.textRatio * 100) / 100)}:1 ` +
              `on state "${state}" is below ${targetLevel} threshold ${required}:1` +
              (measurement.isLarge ? ' (large text)' : ''),
          });
        }
      }

      // Focus ring contrast — only meaningful in the focus state.
      if (state === 'focus' && measurement.ringRatio !== null) {
        if (measurement.ringRatio < FOCUS_RING_THRESHOLD) {
          violations.push({
            selector: cand.selector,
            state,
            kind: 'focus-ring',
            level: targetLevel,
            ratio: Math.round(measurement.ringRatio * 100) / 100,
            required: FOCUS_RING_THRESHOLD,
            foreground: measurement.ringColorHex ?? measurement.fgHex,
            background: measurement.bgHex,
            isLarge: false,
            snippet: cand.text,
            message:
              `${cand.tag} focus indicator contrast ${(Math.round(measurement.ringRatio * 100) / 100)}:1 ` +
              `is below the 3:1 threshold for non-text UI components`,
          });
        }
      }
    }

    // Release programmatic state so the next candidate sees a clean slate.
    try {
      await elementHandle.evaluate((n: Element) => (n as HTMLElement).blur?.());
      await elementHandle.dispatchEvent('mouseup').catch(() => {});
    } catch { /* ignore */ }
    await elementHandle.dispose().catch(() => {});
  }

  // Cleanup: strip the data-uxi-contrast attribute we added.
  await page.evaluate(() => {
    document.querySelectorAll('[data-uxi-contrast]').forEach(e => e.removeAttribute('data-uxi-contrast'));
  }).catch(() => {});

  const passed = violations.length === 0;

  return {
    page: url,
    scanned: candidates.length,
    states: requestedStates,
    targetLevel,
    violations,
    stateCounts,
    passed,
  };
}
