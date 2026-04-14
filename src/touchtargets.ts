import type { Page } from 'playwright';

export interface TouchTargetOptions {
  minSize?: number;
  onlyViewport?: boolean;
  ignoreHidden?: boolean;
}

export interface TouchTargetFinding {
  selector: string;
  html: string;
  width: number;
  height: number;
  overlapsWith?: string;
}

export interface TouchTargetResult {
  page: string;
  scanned: number;
  tooSmall: TouchTargetFinding[];
  overlapping: TouchTargetFinding[];
  passed: boolean;
}

export async function auditTouchTargets(page: Page, opts?: TouchTargetOptions): Promise<TouchTargetResult> {
  const minSize = opts?.minSize ?? 44;
  const onlyViewport = opts?.onlyViewport ?? false;
  const ignoreHidden = opts?.ignoreHidden ?? true;

  const url = page.url();

  const { scanned, tooSmall, overlapping } = await page.evaluate(
    ({ minSize, onlyViewport, ignoreHidden }: { minSize: number; onlyViewport: boolean; ignoreHidden: boolean }) => {
      const SELECTOR = [
        'a[href]', 'button',
        'input:not([type=hidden])', 'select', 'textarea',
        '[role=button]', '[role=link]', '[role=menuitem]',
        '[role=tab]', '[role=checkbox]', '[role=radio]',
        '[onclick]', '[tabindex]:not([tabindex="-1"])',
      ].join(',');

      function buildSelector(el: Element): string {
        const id = el.id;
        if (id) return `#${CSS.escape(id)}`;
        const testid = el.getAttribute('data-testid');
        if (testid) return `[data-testid="${testid}"]`;
        const tag = el.tagName.toLowerCase();
        const classes = Array.from(el.classList).slice(0, 3);
        return classes.length ? `${tag}.${classes.map(c => CSS.escape(c)).join('.')}` : tag;
      }

      function rectsOverlap(a: DOMRect, b: DOMRect): boolean {
        return !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
      }

      const nodes = Array.from(document.querySelectorAll(SELECTOR));

      interface Item {
        selector: string;
        html: string;
        rect: DOMRect;
      }

      const items: Item[] = [];

      for (const el of nodes) {
        const rect = el.getBoundingClientRect();
        if (ignoreHidden && rect.width === 0 && rect.height === 0) continue;
        if (onlyViewport && (rect.bottom < 0 || rect.top > window.innerHeight)) continue;
        items.push({
          selector: buildSelector(el),
          html: el.outerHTML.slice(0, 120),
          rect,
        });
      }

      const tooSmall: Array<{ selector: string; html: string; width: number; height: number }> = [];
      const overlapping: Array<{ selector: string; html: string; width: number; height: number; overlapsWith: string }> = [];

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const { rect } = item;

        if (rect.width < minSize || rect.height < minSize) {
          tooSmall.push({
            selector: item.selector,
            html: item.html,
            width: rect.width,
            height: rect.height,
          });

          for (let j = 0; j < items.length; j++) {
            if (i === j) continue;
            if (rectsOverlap(rect, items[j].rect)) {
              overlapping.push({
                selector: item.selector,
                html: item.html,
                width: rect.width,
                height: rect.height,
                overlapsWith: items[j].selector,
              });
              break;
            }
          }
        }
      }

      return { scanned: items.length, tooSmall, overlapping };
    },
    { minSize, onlyViewport, ignoreHidden }
  );

  return {
    page: url,
    scanned,
    tooSmall,
    overlapping,
    passed: tooSmall.length === 0 && overlapping.length === 0,
  };
}
