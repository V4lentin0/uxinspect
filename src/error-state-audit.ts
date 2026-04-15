import type { Page } from 'playwright';

export interface ErrorStateOptions {
  selectors?: string[];
  allowExisting?: boolean;
}

export interface ErrorStateFinding {
  selector: string;
  snippet: string;
  text: string;
}

export interface ErrorStateResult {
  checked: number;
  newErrors: ErrorStateFinding[];
  passed: boolean;
}

export const DEFAULT_ERROR_STATE_SELECTORS: readonly string[] = [
  '[role="alert"]',
  '.error',
  '.alert-danger',
  '.alert-error',
  '.toast-error',
  '[data-error]',
  '[aria-invalid="true"]',
];

interface Snapshot {
  selector: string;
  keys: string[];
}

async function collectSnapshot(page: Page, selectors: string[]): Promise<Snapshot[]> {
  return page
    .evaluate((sels: string[]) => {
      const out: { selector: string; keys: string[] }[] = [];
      const makeKey = (el: Element, idx: number): string => {
        const html = (el as HTMLElement).outerHTML || '';
        const text = (el.textContent || '').trim().slice(0, 120);
        const id = (el as HTMLElement).id || '';
        return `${idx}|${id}|${text}|${html.slice(0, 160)}`;
      };
      for (const sel of sels) {
        let nodes: Element[] = [];
        try {
          nodes = Array.from(document.querySelectorAll(sel));
        } catch {
          nodes = [];
        }
        const keys = nodes
          .filter((n) => {
            const el = n as HTMLElement;
            if (!el || !el.isConnected) return false;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
            return true;
          })
          .map((n, i) => makeKey(n, i));
        out.push({ selector: sel, keys });
      }
      return out;
    }, selectors)
    .catch(() => selectors.map((s) => ({ selector: s, keys: [] })));
}

async function collectFindings(
  page: Page,
  selectors: string[],
  newKeys: Map<string, Set<string>>,
): Promise<ErrorStateFinding[]> {
  const payload = selectors.map((s) => ({ selector: s, keys: Array.from(newKeys.get(s) ?? []) }));
  return page
    .evaluate((items: { selector: string; keys: string[] }[]) => {
      const out: { selector: string; snippet: string; text: string }[] = [];
      const makeKey = (el: Element, idx: number): string => {
        const html = (el as HTMLElement).outerHTML || '';
        const text = (el.textContent || '').trim().slice(0, 120);
        const id = (el as HTMLElement).id || '';
        return `${idx}|${id}|${text}|${html.slice(0, 160)}`;
      };
      for (const { selector, keys } of items) {
        if (!keys.length) continue;
        let nodes: Element[] = [];
        try {
          nodes = Array.from(document.querySelectorAll(selector));
        } catch {
          nodes = [];
        }
        nodes.forEach((n, i) => {
          const el = n as HTMLElement;
          if (!el || !el.isConnected) return;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;
          const key = makeKey(el, i);
          if (!keys.includes(key)) return;
          const html = el.outerHTML || '';
          const text = (el.textContent || '').trim();
          out.push({
            selector,
            snippet: html.slice(0, 200),
            text: text.slice(0, 200),
          });
        });
      }
      return out;
    }, payload)
    .catch(() => []);
}

/**
 * Audit error-state appearance: call the `before` snapshot, run the interaction,
 * call settle, then diff. If new error-state elements appeared that weren't there
 * before, they're flagged as new errors triggered by the interaction.
 *
 * Usage pattern:
 *   const audit = await auditErrorStateAppearance(page, opts);
 *   // this single call takes a pre-snapshot, but callers that want to test a
 *   // specific interaction should use the before/after helpers below.
 *
 * This default entrypoint returns a baseline snapshot against an already-settled
 * page — it reports any visible error-state elements as `newErrors` only when
 * `allowExisting` is false. When called pre-click it simply establishes the
 * baseline.
 */
export async function auditErrorStateAppearance(
  page: Page,
  opts: ErrorStateOptions = {},
): Promise<ErrorStateResult> {
  const selectors = (opts.selectors?.length ? opts.selectors : [...DEFAULT_ERROR_STATE_SELECTORS]).slice();
  const allowExisting = opts.allowExisting ?? true;

  const snapshot = await collectSnapshot(page, selectors);
  const checked = selectors.length;

  if (allowExisting) {
    return { checked, newErrors: [], passed: true };
  }

  const newKeys = new Map<string, Set<string>>();
  for (const s of snapshot) newKeys.set(s.selector, new Set(s.keys));
  const findings = await collectFindings(page, selectors, newKeys);
  return { checked, newErrors: findings, passed: findings.length === 0 };
}

/**
 * Snapshot error-state element counts/keys BEFORE an interaction.
 * Call `diffErrorStateAppearance(page, snapshot)` after the interaction+settle
 * to obtain any NEW error-state elements that appeared.
 */
export async function snapshotErrorState(
  page: Page,
  opts: ErrorStateOptions = {},
): Promise<{ selectors: string[]; snapshot: Snapshot[] }> {
  const selectors = (opts.selectors?.length ? opts.selectors : [...DEFAULT_ERROR_STATE_SELECTORS]).slice();
  const snapshot = await collectSnapshot(page, selectors);
  return { selectors, snapshot };
}

/**
 * Compare a post-click snapshot against the pre-click snapshot and return any
 * newly appeared error-state elements.
 */
export async function diffErrorStateAppearance(
  page: Page,
  before: { selectors: string[]; snapshot: Snapshot[] },
): Promise<ErrorStateResult> {
  const { selectors, snapshot } = before;
  const after = await collectSnapshot(page, selectors);
  const newKeys = new Map<string, Set<string>>();
  for (const sel of selectors) {
    const prev = new Set(snapshot.find((s) => s.selector === sel)?.keys ?? []);
    const now = after.find((s) => s.selector === sel)?.keys ?? [];
    const added = new Set<string>();
    for (const k of now) if (!prev.has(k)) added.add(k);
    newKeys.set(sel, added);
  }
  const findings = await collectFindings(page, selectors, newKeys);
  return {
    checked: selectors.length,
    newErrors: findings,
    passed: findings.length === 0,
  };
}
