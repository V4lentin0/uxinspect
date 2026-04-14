import type { Page } from 'playwright';

export interface KeyboardAuditOptions {
  maxTabs?: number;
  requireFocusRing?: boolean;
}

export interface KeyboardIssue {
  level: 'error' | 'warn';
  type:
    | 'focus-trap'
    | 'invisible-focus'
    | 'no-focus-style'
    | 'skip-link-missing'
    | 'reachable-but-invisible'
    | 'tab-order-mismatch';
  selector?: string;
  message: string;
}

export interface KeyboardAuditResult {
  page: string;
  focusableCount: number;
  tabsTaken: number;
  tabOrder: string[];
  issues: KeyboardIssue[];
  passed: boolean;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function toSelector(e: Element): string {
  if (e.id) return '#' + e.id;
  const cls = (e.className as string) ?? '';
  const suffix = cls ? '.' + cls.split(' ').filter(Boolean).slice(0, 2).join('.') : '';
  return e.tagName.toLowerCase() + suffix;
}

export async function auditKeyboard(
  page: Page,
  opts?: KeyboardAuditOptions,
): Promise<KeyboardAuditResult> {
  const maxTabs = opts?.maxTabs ?? 80;
  const requireFocusRing = opts?.requireFocusRing ?? true;

  const url = page.url();
  const issues: KeyboardIssue[] = [];

  const focusableCount = await page.$$eval(FOCUSABLE, els => els.length);

  await page.click('body', { force: true }).catch(() => {});

  const tabOrder: string[] = [];
  let tabsTaken = 0;
  let looped = false;

  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press('Tab');
    tabsTaken++;

    const info = await page.evaluate(() => {
      const e = document.activeElement as HTMLElement | null;
      if (!e || e === document.body) return null;

      const id = e.id ? '#' + e.id : null;
      const cls = (e.className as string) ?? '';
      const suffix = cls ? '.' + cls.split(' ').filter(Boolean).slice(0, 2).join('.') : '';
      const sel = id ?? e.tagName.toLowerCase() + suffix;

      const r = e.getBoundingClientRect();
      const focused = window.getComputedStyle(e);
      const fo = focused.outlineStyle;
      const fw = focused.outlineWidth;
      const fb = focused.boxShadow;

      e.blur();
      const blurred = window.getComputedStyle(e);
      const sameStyle = fo === blurred.outlineStyle && fw === blurred.outlineWidth && fb === blurred.boxShadow;
      e.focus();

      const tag = e.tagName.toLowerCase();
      const text = e.textContent ?? '';

      return {
        sel,
        rect: { top: r.top, left: r.left, width: r.width, height: r.height, vpw: window.innerWidth, vph: window.innerHeight },
        sameStyle,
        isSkipCandidate: (tag === 'a' || tag === 'button') && /skip|jump|content|main/i.test(text),
      };
    });

    if (!info) continue;

    const { sel, rect, sameStyle, isSkipCandidate } = info;

    if (tabOrder.length > 0 && sel === tabOrder[0]) {
      looped = true;
      break;
    }

    tabOrder.push(sel);

    // reachable-but-invisible
    const outside = rect.top > rect.vph || rect.left > rect.vpw || rect.top + rect.height < 0 || rect.left + rect.width < 0;
    if (outside || rect.width < 1 || rect.height < 1) {
      issues.push({
        level: 'warn',
        type: 'reachable-but-invisible',
        selector: sel,
        message: `Focusable element is not visible in viewport: ${sel}`,
      });
    }

    // no-focus-style
    if (requireFocusRing && sameStyle) {
      issues.push({
        level: 'warn',
        type: 'no-focus-style',
        selector: sel,
        message: `No visible focus style detected on: ${sel}`,
      });
    }

    // skip-link check on first focused element
    if (i === 0 && !isSkipCandidate) {
      issues.push({
        level: 'warn',
        type: 'skip-link-missing',
        message: 'First focusable element is not a skip-navigation link',
      });
    }
  }

  // focus-trap: never looped
  if (!looped && tabsTaken >= Math.min(focusableCount + 10, maxTabs)) {
    issues.push({
      level: 'error',
      type: 'focus-trap',
      message: `Focus did not cycle back after ${tabsTaken} tabs (${focusableCount} focusable elements found)`,
    });
  }

  // tab-order-mismatch vs visual order
  const visualOrder = await page.$$eval(FOCUSABLE, (els) =>
    (els as HTMLElement[])
      .map(e => {
        const r = e.getBoundingClientRect();
        const id = e.id ? '#' + e.id : null;
        const cls = (e.className as string) ?? '';
        const suffix = cls ? '.' + cls.split(' ').filter(Boolean).slice(0, 2).join('.') : '';
        return { score: r.top * 10000 + r.left, sel: id ?? e.tagName.toLowerCase() + suffix };
      })
      .sort((a, b) => a.score - b.score)
      .map(x => x.sel),
  );

  let mismatches = 0;
  const checkLen = Math.min(tabOrder.length, visualOrder.length);
  for (let i = 0; i < checkLen; i++) {
    if (tabOrder[i] !== visualOrder[i]) mismatches++;
  }
  if (mismatches > 3) {
    issues.push({
      level: 'warn',
      type: 'tab-order-mismatch',
      message: `Tab order differs from visual order in ${mismatches} positions`,
    });
  }

  const passed = !issues.some(i => i.level === 'error');

  return { page: url, focusableCount, tabsTaken, tabOrder, issues, passed };
}
