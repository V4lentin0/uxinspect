import type { Page } from 'playwright';

// Audits z-index layering problems: modals buried below overlays, conflicting stacking
// contexts, fixed headers covering dialogs, and pathological z-index values.

export type ZIndexIssueKind =
  | 'modal-below-overlay'
  | 'conflicting-stacking-context'
  | 'fixed-header-covers-modal'
  | 'z-index-overflow'
  | 'negative-z-index-hidden'
  | 'missing-z-index-on-fixed';

export interface StackingEntry {
  selector: string;
  role: string | null;
  zIndex: number;
  position: string;
  stackingContext: boolean;
  visible: boolean;
  insideDialog: boolean;
  covered: boolean;
  coveringSelector?: string;
}

export interface ZIndexIssue {
  kind: ZIndexIssueKind;
  selector: string;
  detail: string;
}

export interface ZIndexAuditResult {
  page: string;
  entries: StackingEntry[];
  issues: ZIndexIssue[];
  maxZIndex: number;
  stackingContextCount: number;
  passed: boolean;
}

interface EvaluatedEntry {
  selector: string;
  role: string | null;
  zIndex: number;
  zIndexRaw: string;
  position: string;
  stackingContext: boolean;
  visible: boolean;
  insideDialog: boolean;
  isDialogLike: boolean;
  isHeaderLike: boolean;
  topLessThan100: boolean;
  rectWidth: number;
  rectHeight: number;
  centerX: number;
  centerY: number;
  covered: boolean;
  coveringSelector: string | null;
  coveringZIndex: number;
  ancestorContext: AncestorStackingInfo | null;
}

interface AncestorStackingInfo {
  selector: string;
  zIndex: number;
  siblingMaxZIndex: number;
  siblingMaxSelector: string | null;
}

const Z_INDEX_MAX_SAFE = 2_147_483_000;

const DIALOG_SELECTOR =
  '[role=dialog], [role=alertdialog], dialog[open], [aria-modal="true"], .modal, .overlay, .popover, .toast';

export async function auditZIndex(page: Page): Promise<ZIndexAuditResult> {
  const url = page.url();

  const evaluated = await page.evaluate(
    (args: { dialogSelector: string; maxSafe: number }): EvaluatedEntry[] => {
      const shortSelector = (el: Element): string => {
        let s = el.tagName.toLowerCase();
        if (el.id) {
          s += `#${el.id}`;
          return s;
        }
        const firstClass = el.classList && el.classList[0];
        if (firstClass) s += `.${firstClass}`;
        const parent = el.parentElement;
        if (parent) {
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

      const createsStackingContext = (el: Element, style: CSSStyleDeclaration): boolean => {
        if (el === document.documentElement) return true;
        const position = style.position;
        const zIndex = style.zIndex;
        if ((position === 'absolute' || position === 'relative') && zIndex !== 'auto') {
          return true;
        }
        if (position === 'fixed' || position === 'sticky') return true;
        const opacity = parseFloat(style.opacity || '1');
        if (opacity < 1) return true;
        if (style.transform && style.transform !== 'none') return true;
        if (style.filter && style.filter !== 'none') return true;
        if (style.perspective && style.perspective !== 'none') return true;
        if (style.clipPath && style.clipPath !== 'none') return true;
        if (style.mask && style.mask !== 'none' && style.mask !== 'match-source') return true;
        if (style.isolation === 'isolate') return true;
        if (style.mixBlendMode && style.mixBlendMode !== 'normal') return true;
        const willChange = style.willChange || '';
        if (/transform|opacity|filter|perspective/i.test(willChange)) return true;
        const contain = style.contain || '';
        if (/layout|paint|strict|content/i.test(contain)) return true;
        return false;
      };

      const parseZIndex = (raw: string): number => {
        if (!raw || raw === 'auto') return 0;
        const n = parseInt(raw, 10);
        return Number.isFinite(n) ? n : 0;
      };

      const dialogMatches = new Set<Element>();
      try {
        document.querySelectorAll(args.dialogSelector).forEach((el) => {
          dialogMatches.add(el);
        });
      } catch {
        /* ignore invalid selector */
      }

      const candidates = new Set<Element>();
      dialogMatches.forEach((el) => candidates.add(el));

      const all = document.querySelectorAll('*');
      all.forEach((el) => {
        const style = getComputedStyle(el);
        const pos = style.position;
        if (pos === 'fixed' || pos === 'sticky' || pos === 'absolute') {
          candidates.add(el);
        }
      });

      const entries: EvaluatedEntry[] = [];
      const MAX_ENTRIES = 400;
      let count = 0;

      candidates.forEach((el) => {
        if (count >= MAX_ENTRIES) return;
        count++;
        const style = getComputedStyle(el);
        const rect = (el as HTMLElement).getBoundingClientRect();
        const zIndexRaw = style.zIndex;
        const zIndex = parseZIndex(zIndexRaw);
        const visible = isVisible(el);
        const stackingContext = createsStackingContext(el, style);

        let insideDialog = false;
        let node: Element | null = el.parentElement;
        while (node) {
          if (dialogMatches.has(node)) {
            insideDialog = true;
            break;
          }
          node = node.parentElement;
        }

        const role = el.getAttribute('role');
        const isDialogLike = dialogMatches.has(el);
        const tag = el.tagName.toLowerCase();
        const isHeaderLike =
          role === 'banner' ||
          tag === 'header' ||
          (style.position === 'fixed' && rect.top <= 0 && rect.top >= -4 && rect.height < 200);
        const topLessThan100 = rect.top < 100;

        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;

        let covered = false;
        let coveringSelector: string | null = null;
        let coveringZIndex = 0;
        if (
          isDialogLike &&
          visible &&
          rect.width > 0 &&
          rect.height > 0 &&
          centerX >= 0 &&
          centerY >= 0 &&
          centerX <= window.innerWidth &&
          centerY <= window.innerHeight
        ) {
          const top = document.elementFromPoint(centerX, centerY);
          if (top && top !== el && !el.contains(top) && !top.contains(el)) {
            covered = true;
            coveringSelector = shortSelector(top);
            const topStyle = getComputedStyle(top);
            coveringZIndex = parseZIndex(topStyle.zIndex);
          }
        }

        let ancestorContext: AncestorStackingInfo | null = null;
        if (isDialogLike) {
          let ancestor: Element | null = el.parentElement;
          while (ancestor && ancestor !== document.documentElement) {
            const aStyle = getComputedStyle(ancestor);
            if (createsStackingContext(ancestor, aStyle)) {
              const aZ = parseZIndex(aStyle.zIndex);
              const parent = ancestor.parentElement;
              let siblingMaxZ = Number.NEGATIVE_INFINITY;
              let siblingMaxSel: string | null = null;
              if (parent) {
                Array.from(parent.children).forEach((sib) => {
                  if (sib === ancestor) return;
                  const sStyle = getComputedStyle(sib);
                  if (createsStackingContext(sib, sStyle)) {
                    const sZ = parseZIndex(sStyle.zIndex);
                    if (sZ > siblingMaxZ) {
                      siblingMaxZ = sZ;
                      siblingMaxSel = shortSelector(sib);
                    }
                  }
                });
              }
              ancestorContext = {
                selector: shortSelector(ancestor),
                zIndex: aZ,
                siblingMaxZIndex: siblingMaxZ === Number.NEGATIVE_INFINITY ? 0 : siblingMaxZ,
                siblingMaxSelector: siblingMaxSel,
              };
              break;
            }
            ancestor = ancestor.parentElement;
          }
        }

        entries.push({
          selector: shortSelector(el),
          role,
          zIndex,
          zIndexRaw,
          position: style.position,
          stackingContext,
          visible,
          insideDialog,
          isDialogLike,
          isHeaderLike,
          topLessThan100,
          rectWidth: rect.width,
          rectHeight: rect.height,
          centerX,
          centerY,
          covered,
          coveringSelector,
          coveringZIndex,
          ancestorContext,
        });

        // Silence maxSafe unused-param complaint for strict-TS consumers.
        void args.maxSafe;
      });

      return entries;
    },
    { dialogSelector: DIALOG_SELECTOR, maxSafe: Z_INDEX_MAX_SAFE }
  );

  const issues: ZIndexIssue[] = [];
  const stackingContextCount = evaluated.filter((e) => e.stackingContext).length;
  let maxZ = 0;
  for (const e of evaluated) {
    if (e.zIndex > maxZ) maxZ = e.zIndex;
  }

  const visibleDialogs = evaluated.filter((e) => e.isDialogLike && e.visible);
  const fixedHeaders = evaluated.filter(
    (e) => e.isHeaderLike && e.position === 'fixed' && e.visible
  );

  for (const dlg of visibleDialogs) {
    if (dlg.covered && dlg.coveringSelector && dlg.coveringZIndex > dlg.zIndex) {
      issues.push({
        kind: 'modal-below-overlay',
        selector: dlg.selector,
        detail: `modal is covered by "${dlg.coveringSelector}" (z-index ${dlg.coveringZIndex} > ${dlg.zIndex})`,
      });
    }

    if (
      dlg.ancestorContext &&
      dlg.ancestorContext.siblingMaxSelector &&
      dlg.ancestorContext.zIndex < dlg.ancestorContext.siblingMaxZIndex
    ) {
      issues.push({
        kind: 'conflicting-stacking-context',
        selector: dlg.selector,
        detail: `dialog lives inside stacking context "${dlg.ancestorContext.selector}" (z-index ${dlg.ancestorContext.zIndex}) whose sibling "${dlg.ancestorContext.siblingMaxSelector}" has higher z-index ${dlg.ancestorContext.siblingMaxZIndex}`,
      });
    }

    for (const hdr of fixedHeaders) {
      if (hdr.zIndex > dlg.zIndex) {
        issues.push({
          kind: 'fixed-header-covers-modal',
          selector: dlg.selector,
          detail: `fixed header "${hdr.selector}" has z-index ${hdr.zIndex} which is higher than modal z-index ${dlg.zIndex}`,
        });
      }
    }
  }

  for (const e of evaluated) {
    if (e.zIndex > Z_INDEX_MAX_SAFE) {
      issues.push({
        kind: 'z-index-overflow',
        selector: e.selector,
        detail: `z-index ${e.zIndex} is near or above the 32-bit integer maximum`,
      });
    }
    if (e.zIndex < 0 && e.visible) {
      issues.push({
        kind: 'negative-z-index-hidden',
        selector: e.selector,
        detail: `element is visible with negative z-index ${e.zIndex}; may be rendered behind its parent`,
      });
    }
    if (e.position === 'fixed' && e.zIndexRaw === 'auto') {
      issues.push({
        kind: 'missing-z-index-on-fixed',
        selector: e.selector,
        detail: 'position: fixed element has z-index: auto; stacking order will depend on DOM order',
      });
    }
  }

  const entries: StackingEntry[] = evaluated.map((e) => {
    const entry: StackingEntry = {
      selector: e.selector,
      role: e.role,
      zIndex: e.zIndex,
      position: e.position,
      stackingContext: e.stackingContext,
      visible: e.visible,
      insideDialog: e.insideDialog,
      covered: e.covered,
    };
    if (e.coveringSelector) entry.coveringSelector = e.coveringSelector;
    return entry;
  });

  return {
    page: url,
    entries,
    issues,
    maxZIndex: maxZ,
    stackingContextCount,
    passed: issues.length === 0,
  };
}
