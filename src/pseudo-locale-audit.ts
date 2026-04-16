/**
 * P6 #51 — Pseudo-locale long-string audit.
 *
 * Forces the page into a pseudo-locale at runtime: every ASCII letter is
 * replaced with an accented Latin equivalent and the string is stretched to
 * ~1.5× its original length.  The audit then inspects the live DOM for the
 * classes of breakage that real translations expose:
 *
 *   truncated-text       — leaf element whose scrollWidth exceeds its clientWidth
 *   clipped-button       — <button> / [role=button] that overflows its own box
 *   overflowing-container — container whose scrollHeight exceeds its clientHeight
 *   hidden-by-overflow   — child bounding rect sits outside the parent clip area
 *
 * Implementation strategy
 * -----------------------
 * 1. Walk text nodes with TreeWalker inside page.evaluate.
 * 2. For each eligible text node: save the original value to a Map keyed by
 *    a per-node numeric id stored in a data-uxi-plid attribute on the *parent*
 *    element.  Replace nodeValue with the pseudo-locale string.
 * 3. Force a reflow by reading document.body.offsetHeight.
 * 4. Scan elements for overflow signals (see issue kinds above).
 * 5. Restore every text node from the saved Map using the same ids.
 * 6. Remove all data-uxi-plid attributes so the audit is fully non-destructive.
 *
 * The restoration approach (save-to-Map + numeric ids) is simpler and safer
 * than cloning the whole DOM: the Map is a plain JS object that travels
 * across the page.evaluate serialisation boundary as JSON.
 */
import type { Page } from 'playwright';

// ─── Public types ────────────────────────────────────────────────────────────

export type PseudoIssueKind =
  | 'truncated-text'
  | 'clipped-button'
  | 'overflowing-container'
  | 'hidden-by-overflow';

export interface PseudoIssue {
  readonly kind: PseudoIssueKind;
  readonly selector: string;
  readonly original: string;
  readonly pseudo: string;
  readonly detail: string;
}

export interface PseudoAuditOptions {
  /** How much longer to make each string.  Default 1.5 (50 % longer). Range [1, 3]. */
  readonly stretchFactor?: number;
  /** Opening and closing wrap characters.  Default ['[', ']']. */
  readonly wrapChar?: [string, string];
  /** Maximum number of text nodes to transform.  Default 500. */
  readonly maxElements?: number;
  /** Selectors whose subtrees are skipped entirely.  Default includes script/style/code/pre. */
  readonly skipSelectors?: readonly string[];
  /** Minimum original text length to bother transforming.  Default 2. */
  readonly minTextLen?: number;
}

export interface PseudoAuditResult {
  readonly nodesTransformed: number;
  readonly issues: readonly PseudoIssue[];
  readonly passed: boolean;
  readonly checkedAt: string;
}

// ─── Character map ───────────────────────────────────────────────────────────

/**
 * ASCII letter → accented Latin equivalent.
 *
 * Lower-case: a–z mapped to common diacritics that are visually distinct but
 * still legible at a glance.  Upper-case mirrors the lower-case choices.
 * Only the 52 ASCII letters are listed; every other character is left as-is.
 */
export const PSEUDO_CHAR_MAP: Readonly<Record<string, string>> = {
  a: 'á', b: 'ƀ', c: 'ç', d: 'ď', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ħ',
  i: 'í', j: 'ĵ', k: 'ķ', l: 'ĺ', m: 'ɱ', n: 'ñ', o: 'ó', p: 'þ',
  q: 'q', r: 'ŕ', s: 'ŝ', t: 'ť', u: 'ú', v: 'v', w: 'ŵ', x: 'x',
  y: 'ý', z: 'ž',
  A: 'Á', B: 'Ɓ', C: 'Ç', D: 'Ď', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ħ',
  I: 'Í', J: 'Ĵ', K: 'Ķ', L: 'Ĺ', M: 'Ɱ', N: 'Ñ', O: 'Ó', P: 'Þ',
  Q: 'Q', R: 'Ŕ', S: 'Ŝ', T: 'Ť', U: 'Ú', V: 'V', W: 'Ŵ', X: 'X',
  Y: 'Ý', Z: 'Ž',
} as const;

// ─── Pure transformation ──────────────────────────────────────────────────────

/**
 * Convert an ASCII string to its pseudo-locale equivalent.
 *
 * Steps:
 *   1. Replace every ASCII letter via PSEUDO_CHAR_MAP (other chars pass through).
 *   2. Pad with tilde characters until `transformed.length ≈ s.length * stretchFactor`.
 *   3. Wrap with `wrap[0]` and `wrap[1]`.
 *
 * Pure — no DOM access.  Safe to call from unit tests.
 */
export function toPseudoLocale(
  s: string,
  opts?: { stretchFactor?: number; wrap?: [string, string] },
): string {
  const factor = Math.min(3, Math.max(1, opts?.stretchFactor ?? 1.5));
  const open = opts?.wrap?.[0] ?? '[';
  const close = opts?.wrap?.[1] ?? ']';

  // 1. Substitute letters.
  let transformed = '';
  for (const ch of s) {
    transformed += (PSEUDO_CHAR_MAP as Record<string, string>)[ch] ?? ch;
  }

  // 2. Pad to target length (excluding the two wrap chars themselves).
  const target = Math.round(s.length * factor);
  const padLen = Math.max(0, target - transformed.length);
  if (padLen > 0) {
    transformed += '~'.repeat(padLen);
  }

  // 3. Wrap.
  return `${open}${transformed}${close}`;
}

// ─── Default skip selectors ───────────────────────────────────────────────────

const DEFAULT_SKIP_SELECTORS: readonly string[] = [
  'script',
  'style',
  'code',
  'pre',
  'textarea',
  'noscript',
  'template',
  '[data-uxi-skip-pseudo]',
];

// ─── Browser-side helpers ─────────────────────────────────────────────────────

/** Serialisable shape passed into page.evaluate. */
interface EvalOptions {
  charMap: Record<string, string>;
  stretchFactor: number;
  open: string;
  close: string;
  maxElements: number;
  skipSelectors: readonly string[];
  minTextLen: number;
}

/** Serialisable shape returned from the transform + scan evaluate call. */
interface EvalResult {
  nodesTransformed: number;
  issues: Array<{
    kind: PseudoIssueKind;
    selector: string;
    original: string;
    pseudo: string;
    detail: string;
  }>;
  /** nodeIdAttr value → original text, for restoration. */
  originals: Record<string, string>;
  /** nodeIdAttr value → pseudo text, to allow restoration matching. */
  pseudos: Record<string, string>;
}

// ─── Main audit function ──────────────────────────────────────────────────────

export async function runPseudoLocaleAudit(
  page: Page,
  opts?: PseudoAuditOptions,
): Promise<PseudoAuditResult> {
  const stretchFactor = Math.min(3, Math.max(1, opts?.stretchFactor ?? 1.5));
  const wrapChar = opts?.wrapChar ?? (['[', ']'] as [string, string]);
  const maxElements = opts?.maxElements ?? 500;
  const skipSelectors: readonly string[] = opts?.skipSelectors ?? DEFAULT_SKIP_SELECTORS;
  const minTextLen = opts?.minTextLen ?? 2;

  const evalOpts: EvalOptions = {
    charMap: PSEUDO_CHAR_MAP as Record<string, string>,
    stretchFactor,
    open: wrapChar[0],
    close: wrapChar[1],
    maxElements,
    skipSelectors: skipSelectors as string[],
    minTextLen,
  };

  // ── Phase 1: transform text nodes + scan for overflow issues ──────────────
  const evalResult = await page.evaluate((cfg: EvalOptions): EvalResult => {
    const ATTR = 'data-uxi-plid';

    // ── Inline pseudo-locale transform (mirrors toPseudoLocale exactly) ──────
    function toPseudo(s: string): string {
      let out = '';
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        out += cfg.charMap[ch as string] ?? ch;
      }
      const target = Math.round(s.length * cfg.stretchFactor);
      const padLen = Math.max(0, target - out.length);
      if (padLen > 0) {
        out += '~'.repeat(padLen);
      }
      return `${cfg.open}${out}${cfg.close}`;
    }

    // ── Build CSS matcher for skip selectors ─────────────────────────────────
    function buildSkipRe(selectors: readonly string[]): (el: Element) => boolean {
      return (el: Element): boolean => {
        for (const sel of selectors) {
          try {
            if (el.matches(sel)) return true;
          } catch {
            // ignore invalid selectors
          }
        }
        return false;
      };
    }
    const isSkipped = buildSkipRe(cfg.skipSelectors);

    function isInsideSkipped(el: Element | null): boolean {
      let cur = el;
      while (cur) {
        if (isSkipped(cur)) return true;
        cur = cur.parentElement;
      }
      return false;
    }

    // ── Walk text nodes, transform, save originals ──────────────────────────
    const originals: Record<string, string> = {};
    const pseudos: Record<string, string> = {};
    let counter = 0;
    let transformed = 0;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && transformed < cfg.maxElements) {
      const tn = node as Text;
      const raw = tn.nodeValue ?? '';
      const trimmed = raw.trim();

      // Skip empty, too-short, or inside skipped ancestors.
      if (trimmed.length < cfg.minTextLen || isInsideSkipped(tn.parentElement)) {
        node = walker.nextNode();
        continue;
      }

      // Assign a stable numeric id to the parent element for later restoration.
      const parent = tn.parentElement as HTMLElement | null;
      if (!parent) {
        node = walker.nextNode();
        continue;
      }

      const id = String(counter++);
      parent.setAttribute(ATTR, id);

      const pseudo = toPseudo(raw);
      originals[id] = raw;
      pseudos[id] = pseudo;

      tn.nodeValue = pseudo;
      transformed++;

      node = walker.nextNode();
    }

    // ── Force reflow ─────────────────────────────────────────────────────────
    void document.body.offsetHeight;

    // ── Helper: stable selector for an element ───────────────────────────────
    function buildSelector(el: Element): string {
      const tag = el.tagName.toLowerCase();
      const id = (el as HTMLElement).id ? `#${CSS.escape((el as HTMLElement).id)}` : '';
      const first = el.classList[0] ? `.${CSS.escape(el.classList[0])}` : '';
      const attr = el.getAttribute(ATTR) ? `[${ATTR}="${el.getAttribute(ATTR)}"]` : '';
      return id ? `${tag}${id}` : `${tag}${first}${attr}`;
    }

    // ── Scan for overflow issues ──────────────────────────────────────────────
    const issues: EvalResult['issues'] = [];
    const seen = new Set<Element>();

    // Iterate all elements that we transformed (they carry the ATTR).
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>(`[${ATTR}]`),
    );

    for (const el of candidates) {
      if (seen.has(el)) continue;
      seen.add(el);

      const cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;

      const id = el.getAttribute(ATTR) ?? '';
      const original = originals[id] ?? '';
      const pseudo = pseudos[id] ?? '';

      const sw = el.scrollWidth;
      const cw = el.clientWidth;
      const sh = el.scrollHeight;
      const ch = el.clientHeight;
      const overflowX = cs.overflowX ?? cs.overflow;
      const overflowY = cs.overflowY ?? cs.overflow;

      const tag = el.tagName.toLowerCase();
      const isButton =
        tag === 'button' ||
        el.getAttribute('role') === 'button';

      // clipped-button: button text overflows the button box.
      if (isButton && sw > cw) {
        issues.push({
          kind: 'clipped-button',
          selector: buildSelector(el),
          original,
          pseudo,
          detail: `button scrollWidth ${sw} > clientWidth ${cw}`,
        });
        continue;
      }

      // truncated-text: inline/block element clips its own text horizontally.
      if (
        sw > cw + 1 &&
        overflowX !== 'visible' &&
        overflowX !== 'auto' &&
        overflowX !== 'scroll'
      ) {
        issues.push({
          kind: 'truncated-text',
          selector: buildSelector(el),
          original,
          pseudo,
          detail: `scrollWidth ${sw} > clientWidth ${cw} (overflow-x: ${overflowX})`,
        });
        continue;
      }

      // overflowing-container: vertical clip.
      if (
        sh > ch + 2 &&
        overflowY !== 'visible' &&
        overflowY !== 'auto' &&
        overflowY !== 'scroll'
      ) {
        issues.push({
          kind: 'overflowing-container',
          selector: buildSelector(el),
          original,
          pseudo,
          detail: `scrollHeight ${sh} > clientHeight ${ch} (overflow-y: ${overflowY})`,
        });
        continue;
      }

      // hidden-by-overflow: child rect outside parent clip rect.
      const parentEl = el.parentElement;
      if (parentEl) {
        const parentRect = parentEl.getBoundingClientRect();
        const childRect = el.getBoundingClientRect();
        const parentCs = window.getComputedStyle(parentEl);
        const parentOvX = parentCs.overflowX ?? parentCs.overflow;
        const parentOvY = parentCs.overflowY ?? parentCs.overflow;
        const parentClips =
          parentOvX === 'hidden' ||
          parentOvY === 'hidden' ||
          parentOvX === 'clip' ||
          parentOvY === 'clip';

        if (parentClips) {
          const outside =
            childRect.right > parentRect.right + 2 ||
            childRect.bottom > parentRect.bottom + 2 ||
            childRect.left < parentRect.left - 2 ||
            childRect.top < parentRect.top - 2;

          if (outside) {
            issues.push({
              kind: 'hidden-by-overflow',
              selector: buildSelector(el),
              original,
              pseudo,
              detail: `child rect [${childRect.left.toFixed(0)},${childRect.top.toFixed(0)},${childRect.right.toFixed(0)},${childRect.bottom.toFixed(0)}] outside parent clip [${parentRect.left.toFixed(0)},${parentRect.top.toFixed(0)},${parentRect.right.toFixed(0)},${parentRect.bottom.toFixed(0)}]`,
            });
          }
        }
      }
    }

    return { nodesTransformed: transformed, issues, originals, pseudos };
  }, evalOpts);

  // ── Phase 2: restore original text nodes + remove plid attrs ─────────────
  await page.evaluate(
    (args: { attr: string; originals: Record<string, string> }) => {
      const { attr, originals } = args;
      const els = Array.from(document.querySelectorAll<HTMLElement>(`[${attr}]`));
      for (const el of els) {
        const id = el.getAttribute(attr);
        if (!id) continue;
        const orig = originals[id];
        if (orig === undefined) continue;
        // Walk the element's direct text-node children and restore the first
        // one whose current value is the pseudo-locale string (or any non-empty
        // text node if only one exists).
        const childNodes = Array.from(el.childNodes);
        for (const child of childNodes) {
          if (child.nodeType === Node.TEXT_NODE && (child.nodeValue ?? '').trim().length > 0) {
            child.nodeValue = orig;
            break;
          }
        }
        el.removeAttribute(attr);
      }
    },
    { attr: 'data-uxi-plid', originals: evalResult.originals },
  );

  return {
    nodesTransformed: evalResult.nodesTransformed,
    issues: evalResult.issues,
    passed: evalResult.issues.length === 0,
    checkedAt: new Date().toISOString(),
  };
}
