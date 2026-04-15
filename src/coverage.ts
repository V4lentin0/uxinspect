import type { Page } from 'playwright';

export const INTERACTIVE_SELECTOR =
  'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=tab], [role=menuitem], [tabindex]:not([tabindex="-1"]), [onclick]';

export interface CoverageResult {
  totalInteractive: number;
  byTag: Record<string, number>;
}

export interface InteractiveElementInfo {
  key: string;
  tag: string;
  snippet: string;
  selector: string;
}

/**
 * Count visible + enabled interactive elements on a page, grouped by tag.
 */
export async function measureClickCoverage(page: Page): Promise<CoverageResult> {
  const byTag = await page.evaluate((selector: string) => {
    const els = Array.from(document.querySelectorAll<HTMLElement>(selector));
    const counts: Record<string, number> = {};
    for (const el of els) {
      if (!isVisibleAndEnabled(el)) continue;
      const tag = el.tagName.toLowerCase();
      counts[tag] = (counts[tag] ?? 0) + 1;
    }
    return counts;

    function isVisibleAndEnabled(el: HTMLElement): boolean {
      if ((el as HTMLInputElement | HTMLButtonElement).disabled) return false;
      if (el.getAttribute('aria-disabled') === 'true') return false;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      return true;
    }
  }, INTERACTIVE_SELECTOR);

  const totalInteractive = Object.values(byTag).reduce((a, b) => a + b, 0);
  return { totalInteractive, byTag };
}

/**
 * Collect a snapshot of every visible+enabled interactive element (for computing
 * missed set after exploration). Each entry has a stable key matching the one
 * explore.ts computes when clicking.
 */
export async function listInteractiveElements(page: Page): Promise<InteractiveElementInfo[]> {
  return page.evaluate((selector: string) => {
    const els = Array.from(document.querySelectorAll<HTMLElement>(selector));
    const out: { key: string; tag: string; snippet: string; selector: string }[] = [];
    for (const el of els) {
      if (!isVisibleAndEnabled(el)) continue;
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : '';
      const cls =
        el.className && typeof el.className === 'string'
          ? `.${el.className.slice(0, 40)}`
          : '';
      const txt = (el.textContent ?? '').trim().slice(0, 40);
      const href = (el as HTMLAnchorElement).href ?? '';
      const key = `${tag}${id}${cls}|${txt}|${href}`;
      const snippet = el.outerHTML.slice(0, 200);
      const cssSelector = id
        ? `#${el.id}`
        : tag +
          (el.className && typeof el.className === 'string' && el.className.trim()
            ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
            : '');
      out.push({ key, tag, snippet, selector: cssSelector });
    }
    return out;

    function isVisibleAndEnabled(el: HTMLElement): boolean {
      if ((el as HTMLInputElement | HTMLButtonElement).disabled) return false;
      if (el.getAttribute('aria-disabled') === 'true') return false;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      return true;
    }
  }, INTERACTIVE_SELECTOR);
}
