import type { Page } from 'playwright';

// Post-hoc limitation: keyboard event simulation via page.keyboard cannot guarantee identical
// behavior to a real user when the page installs non-standard focus handlers. This audit tests
// for the common WCAG 2.4.3 failure modes: dialogs that do not retain focus when open.

export type FocusTrapIssueKind =
  | 'focus-escapes-dialog'
  | 'dialog-not-focusable'
  | 'first-focus-missing'
  | 'close-on-esc-missing'
  | 'close-on-backdrop-missing'
  | 'close-completely-blocked'
  | 'tab-exits-dialog';

export interface FocusTrapIssue {
  kind: FocusTrapIssueKind;
  dialogSelector: string;
  detail: string;
}

export interface FocusTrapDialogReport {
  selector: string;
  role: string;
  visible: boolean;
  focusableCount: number;
  firstFocused: string | null;
  tabTrapped: boolean;
  shiftTabTrapped: boolean;
  escClosedIt: boolean;
  backdropClosedIt: boolean;
}

export interface FocusTrapResult {
  page: string;
  dialogs: FocusTrapDialogReport[];
  issues: FocusTrapIssue[];
  passed: boolean;
}

export interface FocusTrapOptions {
  dialogSelectors?: string[];
  maxTabs?: number;
}

interface DialogDescriptor {
  selector: string;
  role: string;
  visible: boolean;
}

interface FocusProbe {
  insideDialog: boolean;
  activeDescriptor: string;
  focusableCount: number;
  dialogStillVisible: boolean;
  dialogFocusable: boolean;
}

const DEFAULT_DIALOG_SELECTOR =
  '[role=dialog]:not([aria-hidden="true"]), [role=alertdialog]:not([aria-hidden="true"]), dialog[open]';

const FOCUSABLE_SELECTOR =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

export async function auditFocusTrap(
  page: Page,
  opts: FocusTrapOptions = {}
): Promise<FocusTrapResult> {
  const url = page.url();
  const maxTabs = opts.maxTabs && opts.maxTabs > 0 ? opts.maxTabs : 30;
  const selectorList = opts.dialogSelectors && opts.dialogSelectors.length > 0
    ? opts.dialogSelectors
    : [DEFAULT_DIALOG_SELECTOR];

  const dialogs: DialogDescriptor[] = await page.evaluate(
    (selectors: string[]): DialogDescriptor[] => {
      const seen = new Set<Element>();
      const found: DialogDescriptor[] = [];

      const shortSelector = (el: Element): string => {
        let s = el.tagName.toLowerCase();
        if (el.id) s += `#${el.id}`;
        const firstClass = el.classList?.[0];
        if (firstClass) s += `.${firstClass}`;
        const parent = el.parentElement;
        if (!el.id && parent) {
          const sibs = Array.from(parent.children).filter(
            (c) => c.tagName === el.tagName
          );
          if (sibs.length > 1) {
            const idx = sibs.indexOf(el);
            if (idx >= 0) s += `:nth-of-type(${idx + 1})`;
          }
        }
        return s;
      };

      const isVisible = (el: Element): boolean => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = getComputedStyle(el as HTMLElement);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (parseFloat(style.opacity || '1') === 0) return false;
        return true;
      };

      for (const sel of selectors) {
        let nodes: NodeListOf<Element>;
        try {
          nodes = document.querySelectorAll(sel);
        } catch {
          continue;
        }
        nodes.forEach((el) => {
          if (seen.has(el)) return;
          seen.add(el);
          const role =
            el.getAttribute('role') ||
            (el.tagName.toLowerCase() === 'dialog' ? 'dialog' : 'dialog');
          found.push({
            selector: shortSelector(el),
            role,
            visible: isVisible(el),
          });
        });
      }

      return found;
    },
    selectorList
  );

  const dialogReports: FocusTrapDialogReport[] = [];
  const issues: FocusTrapIssue[] = [];

  for (const descriptor of dialogs) {
    if (!descriptor.visible) {
      dialogReports.push({
        selector: descriptor.selector,
        role: descriptor.role,
        visible: false,
        focusableCount: 0,
        firstFocused: null,
        tabTrapped: false,
        shiftTabTrapped: false,
        escClosedIt: false,
        backdropClosedIt: false,
      });
      continue;
    }

    const probe = await page.evaluate(
      (args: { selector: string; focusableSelector: string }): FocusProbe => {
        const root = document.querySelector(args.selector);
        if (!root) {
          return {
            insideDialog: false,
            activeDescriptor: '',
            focusableCount: 0,
            dialogStillVisible: false,
            dialogFocusable: false,
          };
        }

        const describe = (el: Element | null): string => {
          if (!el) return '';
          let s = el.tagName.toLowerCase();
          if (el.id) s += `#${el.id}`;
          const firstClass = el.classList?.[0];
          if (firstClass) s += `.${firstClass}`;
          return s;
        };

        const pre = document.activeElement;
        const activeDescriptor = describe(pre);
        const insideBefore = pre ? root.contains(pre) : false;

        const focusables = Array.from(
          root.querySelectorAll(args.focusableSelector)
        ).filter((el) => {
          const rect = (el as HTMLElement).getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          const style = getComputedStyle(el as HTMLElement);
          return style.display !== 'none' && style.visibility !== 'hidden';
        });

        const initialTabindex = root.getAttribute('tabindex');
        if (initialTabindex === null) {
          root.setAttribute('tabindex', '-1');
        }
        (root as HTMLElement).focus();
        const afterFocus = document.activeElement;
        const dialogFocusable =
          afterFocus === root ||
          (afterFocus !== null && root.contains(afterFocus));
        if (initialTabindex === null) {
          root.removeAttribute('tabindex');
        }

        return {
          insideDialog: insideBefore,
          activeDescriptor,
          focusableCount: focusables.length,
          dialogStillVisible: true,
          dialogFocusable,
        };
      },
      { selector: descriptor.selector, focusableSelector: FOCUSABLE_SELECTOR }
    );

    if (!probe.insideDialog) {
      issues.push({
        kind: 'first-focus-missing',
        dialogSelector: descriptor.selector,
        detail: probe.activeDescriptor
          ? `focus was on "${probe.activeDescriptor}" instead of inside the dialog when it opened`
          : 'no element was programmatically focused when the dialog opened',
      });
    }

    if (!probe.dialogFocusable) {
      issues.push({
        kind: 'dialog-not-focusable',
        dialogSelector: descriptor.selector,
        detail: 'dialog could not receive focus via .focus()',
      });
    }

    const firstFocused = await focusFirst(page, descriptor.selector);

    let tabTrapped = false;
    let tabExit = false;
    for (let i = 0; i < maxTabs; i++) {
      await page.keyboard.press('Tab');
      const state = await readFocusState(page, descriptor.selector);
      if (!state.dialogStillInDom) {
        break;
      }
      if (!state.inside) {
        tabExit = true;
        break;
      }
      if (i > 0 && state.sameAsFirst) {
        tabTrapped = true;
        break;
      }
    }

    if (tabExit) {
      issues.push({
        kind: 'tab-exits-dialog',
        dialogSelector: descriptor.selector,
        detail: 'Tab key moved focus outside the dialog',
      });
    } else if (!tabTrapped && probe.focusableCount > 0) {
      issues.push({
        kind: 'focus-escapes-dialog',
        dialogSelector: descriptor.selector,
        detail: `Tab cycled ${maxTabs} times without returning to first focusable element`,
      });
    }

    await focusFirst(page, descriptor.selector);
    let shiftTrapped = false;
    let shiftExit = false;
    for (let i = 0; i < maxTabs; i++) {
      await page.keyboard.press('Shift+Tab');
      const state = await readFocusState(page, descriptor.selector);
      if (!state.dialogStillInDom) break;
      if (!state.inside) {
        shiftExit = true;
        break;
      }
      if (i > 0 && state.sameAsFirst) {
        shiftTrapped = true;
        break;
      }
    }

    if (shiftExit) {
      issues.push({
        kind: 'tab-exits-dialog',
        dialogSelector: descriptor.selector,
        detail: 'Shift+Tab moved focus outside the dialog',
      });
    }

    // Backdrop-close probe: try common backdrop selectors first, then fall back
    // to clicking a point outside the dialog's bounding box. We attempt the
    // backdrop BEFORE Esc so that, if backdrop closes the dialog, we don't
    // need to reopen it to test Esc. Modal MUST close on either Esc OR
    // backdrop (we flag only when BOTH fail).
    const backdropAttempt = await tryBackdropClose(page, descriptor.selector);
    const backdropClosedIt = backdropAttempt.closed;

    let escClosedIt = false;
    if (!backdropClosedIt) {
      await page.keyboard.press('Escape');
      const afterEsc = await isStillVisible(page, descriptor.selector);
      escClosedIt = !afterEsc;
    }

    if (!backdropClosedIt && !escClosedIt) {
      issues.push({
        kind: 'close-on-esc-missing',
        dialogSelector: descriptor.selector,
        detail: 'dialog did not close when Escape was pressed',
      });
      issues.push({
        kind: 'close-on-backdrop-missing',
        dialogSelector: descriptor.selector,
        detail: backdropAttempt.detail
          ? `dialog did not close on backdrop/outside click (${backdropAttempt.detail})`
          : 'dialog did not close on backdrop/outside click',
      });
      issues.push({
        kind: 'close-completely-blocked',
        dialogSelector: descriptor.selector,
        detail: 'dialog cannot be dismissed by either Escape or a backdrop click',
      });
    }

    dialogReports.push({
      selector: descriptor.selector,
      role: descriptor.role,
      visible: true,
      focusableCount: probe.focusableCount,
      firstFocused,
      tabTrapped: tabTrapped && !tabExit,
      shiftTabTrapped: shiftTrapped && !shiftExit,
      escClosedIt,
      backdropClosedIt,
    });
  }

  return {
    page: url,
    dialogs: dialogReports,
    issues,
    passed: issues.length === 0,
  };
}

async function focusFirst(page: Page, selector: string): Promise<string | null> {
  return page.evaluate(
    (args: { selector: string; focusableSelector: string }): string | null => {
      const root = document.querySelector(args.selector);
      if (!root) return null;
      const focusables = Array.from(
        root.querySelectorAll(args.focusableSelector)
      ).filter((el) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      const first = focusables[0] as HTMLElement | undefined;
      if (!first) {
        (root as HTMLElement).focus();
        return null;
      }
      first.focus();
      let s = first.tagName.toLowerCase();
      if (first.id) s += `#${first.id}`;
      const firstClass = first.classList?.[0];
      if (firstClass) s += `.${firstClass}`;
      return s;
    },
    { selector, focusableSelector: FOCUSABLE_SELECTOR }
  );
}

interface FocusState {
  inside: boolean;
  sameAsFirst: boolean;
  dialogStillInDom: boolean;
}

async function readFocusState(
  page: Page,
  selector: string
): Promise<FocusState> {
  return page.evaluate(
    (args: { selector: string; focusableSelector: string }): FocusState => {
      const root = document.querySelector(args.selector);
      if (!root) {
        return { inside: false, sameAsFirst: false, dialogStillInDom: false };
      }
      const active = document.activeElement;
      const inside = active ? root.contains(active) : false;
      const focusables = Array.from(
        root.querySelectorAll(args.focusableSelector)
      ).filter((el) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      const first = focusables[0];
      const sameAsFirst = !!(first && active && first === active);
      return { inside, sameAsFirst, dialogStillInDom: true };
    },
    { selector, focusableSelector: FOCUSABLE_SELECTOR }
  );
}

async function isStillVisible(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel: string): boolean => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const rect = (el as HTMLElement).getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el as HTMLElement);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    return true;
  }, selector);
}

interface BackdropAttempt {
  closed: boolean;
  detail: string;
}

const BACKDROP_SELECTORS = [
  '.modal-backdrop',
  '.overlay',
  '.modal-overlay',
  '[data-backdrop]',
  '[data-overlay]',
  '[data-modal-backdrop]',
];

async function tryBackdropClose(
  page: Page,
  dialogSelector: string
): Promise<BackdropAttempt> {
  // 1) Try known backdrop selectors first — these are the semantic way sites
  // implement click-outside-to-close.
  const backdropInfo = await page.evaluate(
    (args: { dialogSelector: string; backdropSelectors: string[] }): {
      found: boolean;
      x: number;
      y: number;
      selector: string;
    } => {
      const dialog = document.querySelector(args.dialogSelector);
      const dialogRect = dialog
        ? (dialog as HTMLElement).getBoundingClientRect()
        : null;
      const overlaps = (r: DOMRect): boolean => {
        if (!dialogRect) return false;
        return !(
          r.right <= dialogRect.left ||
          r.left >= dialogRect.right ||
          r.bottom <= dialogRect.top ||
          r.top >= dialogRect.bottom
        );
      };
      for (const sel of args.backdropSelectors) {
        let nodes: NodeListOf<Element>;
        try {
          nodes = document.querySelectorAll(sel);
        } catch {
          continue;
        }
        for (const el of Array.from(nodes)) {
          const rect = (el as HTMLElement).getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          const style = getComputedStyle(el as HTMLElement);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          // Pick a point on the backdrop that is NOT inside the dialog.
          const candidates: Array<[number, number]> = [
            [rect.left + 2, rect.top + 2],
            [rect.right - 2, rect.top + 2],
            [rect.left + 2, rect.bottom - 2],
            [rect.right - 2, rect.bottom - 2],
            [rect.left + rect.width / 2, rect.top + 2],
          ];
          for (const [x, y] of candidates) {
            if (!dialogRect) {
              return { found: true, x, y, selector: sel };
            }
            // Skip points inside the dialog's bbox.
            if (
              x >= dialogRect.left &&
              x <= dialogRect.right &&
              y >= dialogRect.top &&
              y <= dialogRect.bottom
            ) {
              continue;
            }
            return { found: true, x, y, selector: sel };
          }
          // Fallback: if backdrop fully overlaps dialog, click a corner anyway.
          if (overlaps(rect)) {
            return {
              found: true,
              x: rect.left + 2,
              y: rect.top + 2,
              selector: sel,
            };
          }
        }
      }
      return { found: false, x: 0, y: 0, selector: '' };
    },
    { dialogSelector, backdropSelectors: BACKDROP_SELECTORS }
  );

  if (backdropInfo.found) {
    try {
      await page.mouse.click(backdropInfo.x, backdropInfo.y);
    } catch {
      // ignore click errors; we'll still check visibility
    }
    const stillVisible = await isStillVisible(page, dialogSelector);
    if (!stillVisible) {
      return { closed: true, detail: `matched ${backdropInfo.selector}` };
    }
  }

  // 2) Fallback: click a point outside the dialog's bounding box. We try the
  // top-left corner (10,10) first, then hunt for a viewport corner that is
  // not covered by the dialog.
  const outsidePoint = await page.evaluate((sel: string): {
    x: number;
    y: number;
  } | null => {
    const el = document.querySelector(sel);
    if (!el) return { x: 10, y: 10 };
    const r = (el as HTMLElement).getBoundingClientRect();
    const vw = Math.max(
      document.documentElement.clientWidth || 0,
      window.innerWidth || 0
    );
    const vh = Math.max(
      document.documentElement.clientHeight || 0,
      window.innerHeight || 0
    );
    const candidates: Array<[number, number]> = [
      [10, 10],
      [vw - 10, 10],
      [10, vh - 10],
      [vw - 10, vh - 10],
    ];
    for (const [x, y] of candidates) {
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) continue;
      return { x, y };
    }
    return { x: 5, y: 5 };
  }, dialogSelector);

  if (outsidePoint) {
    try {
      await page.mouse.click(outsidePoint.x, outsidePoint.y);
    } catch {
      // ignore
    }
    const stillVisible = await isStillVisible(page, dialogSelector);
    if (!stillVisible) {
      return {
        closed: true,
        detail: `outside click at (${outsidePoint.x},${outsidePoint.y})`,
      };
    }
  }

  return {
    closed: false,
    detail: backdropInfo.found
      ? `backdrop ${backdropInfo.selector} did not dismiss dialog`
      : 'no backdrop element found and outside click did not dismiss dialog',
  };
}
