/**
 * P6 #49 — Jitter / human-misclick simulation audit.
 *
 * Real users do not click the exact pixel-center of a target. Fingers on
 * trackpads wobble, mice drift. Some handlers rely on `e.target === button`
 * equality checks (or `currentTarget` mis-use) and silently break when the
 * click lands on a child `<span>` / `<svg>` inside the button. This audit
 * catches that whole class of regression.
 *
 * For every `button`, `[role="button"]`, `a[href]`, and submit/button input,
 * we:
 *   1. Take a baseline center-click and record whether the page reacted
 *      (DOM mutation count + body-html hash).
 *   2. Fire N jittered clicks at random ±jitterPx offsets (clamped to the
 *      bounding box so the event is still on the element) and record the
 *      same two signals per click.
 *   3. Emit an issue when:
 *        - center reacted but a jittered click did not → 'silent-click'
 *        - jitter clicks react inconsistently (< minConsistencyRatio) →
 *          'inconsistent-response'
 *        - the DOM-state after a jittered click differs from center
 *          (different handler path) → 'off-target-trigger'
 *
 * We never reload between probes by default — we trust that a re-click on a
 * well-built control is idempotent. `reloadBetween` is available for pages
 * with destructive handlers (single-fire buttons etc.).
 */
import type { Page } from 'playwright';

export type JitterIssueKind =
  | 'silent-click'
  | 'inconsistent-response'
  | 'off-target-trigger';

export interface JitterIssue {
  readonly kind: JitterIssueKind;
  readonly selector: string;
  readonly detail: string;
}

export interface JitterResult {
  readonly issues: readonly JitterIssue[];
  readonly buttonsProbed: number;
  readonly passed: boolean;
}

export interface JitterAuditOptions {
  /** Cap how many clickable targets we probe. Default 30. */
  readonly maxButtons?: number;
  /** Max pixel offset from center for each jittered click. Default 8. */
  readonly jitterPx?: number;
  /** How many jittered clicks per target. Default 5. */
  readonly jitterClicks?: number;
  /** Ms to wait after each click before sampling DOM. Default 100. */
  readonly settleMs?: number;
  /**
   * Minimum ratio of jittered clicks that must trigger a response. Below
   * this we emit 'inconsistent-response'. Default 0.6.
   */
  readonly minConsistencyRatio?: number;
  /** Reload between probes to neutralize destructive handlers. Default false. */
  readonly reloadBetween?: boolean;
}

interface DiscoveredTarget {
  readonly selector: string;
  readonly box: { x: number; y: number; width: number; height: number };
}

/**
 * FNV-1a 32-bit hash — fast and good enough to detect "DOM shape changed".
 * We only need equality, not cryptographic strength.
 */
function hashString(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

async function installMutationCounter(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    if (w.__uxinspectMutObs) return;
    w.__uxinspectMut = 0;
    const obs = new MutationObserver((records) => {
      const cur = (w.__uxinspectMut as number) ?? 0;
      w.__uxinspectMut = cur + records.length;
    });
    obs.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    w.__uxinspectMutObs = obs;
  });
}

async function resetCounter(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as Record<string, number>).__uxinspectMut = 0;
  });
}

async function readCounter(page: Page): Promise<number> {
  return await page.evaluate(
    () => (window as unknown as Record<string, number>).__uxinspectMut ?? 0,
  );
}

async function discover(page: Page, maxButtons: number): Promise<DiscoveredTarget[]> {
  return await page.evaluate((cap: number) => {
    const sel =
      'button, [role="button"], a[href], input[type="submit"], input[type="button"]';
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(sel));
    const out: DiscoveredTarget[] = [];
    const matches = (s?: string | null): boolean => typeof s === 'string' && s.length > 0;
    for (const el of nodes) {
      if (out.length >= cap) break;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const id = el.id;
      const tid = el.getAttribute('data-testid');
      const htmlName = (el as unknown as { name?: string }).name;
      let selector: string;
      if (matches(id)) selector = `#${CSS.escape(id)}`;
      else if (matches(tid)) selector = `[data-testid="${tid}"]`;
      else if (matches(htmlName)) selector = `${el.tagName.toLowerCase()}[name="${htmlName}"]`;
      else {
        const tag = el.tagName.toLowerCase();
        const all = Array.from(document.querySelectorAll(tag));
        const idx = all.indexOf(el);
        selector = `${tag}:nth-of-type(${idx + 1})`;
      }
      out.push({
        selector,
        box: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      });
    }
    return out;
    // NOTE: we intentionally redeclare the interface inside page.evaluate
    //       because the runtime scope has no TS types.
  }, maxButtons) as unknown as DiscoveredTarget[];
}

interface ClickProbe {
  readonly mutations: number;
  readonly bodyHash: string;
}

async function probeClickAt(
  page: Page,
  x: number,
  y: number,
  settleMs: number,
): Promise<ClickProbe> {
  await resetCounter(page);
  try {
    await page.mouse.click(x, y);
  } catch {
    // swallow — we still sample state below so callers can see zero reaction
  }
  await page.waitForTimeout(settleMs);
  const mutations = await readCounter(page);
  const bodyHtml = await page.evaluate(() => document.body.innerHTML);
  return { mutations, bodyHash: hashString(bodyHtml) };
}

function randOffset(maxPx: number): number {
  if (maxPx <= 0) return 0;
  return (Math.random() * 2 - 1) * maxPx;
}

function clampToBox(
  cx: number,
  cy: number,
  ox: number,
  oy: number,
  box: { x: number; y: number; width: number; height: number },
): { x: number; y: number } {
  // Keep the click at least 1px inside each edge so we stay on the element.
  const minX = box.x + 1;
  const maxX = box.x + box.width - 1;
  const minY = box.y + 1;
  const maxY = box.y + box.height - 1;
  return {
    x: Math.min(maxX, Math.max(minX, cx + ox)),
    y: Math.min(maxY, Math.max(minY, cy + oy)),
  };
}

export async function runJitterAudit(
  page: Page,
  opts: JitterAuditOptions = {},
): Promise<JitterResult> {
  const maxButtons = opts.maxButtons ?? 30;
  const jitterPx = opts.jitterPx ?? 8;
  const jitterClicks = opts.jitterClicks ?? 5;
  const settleMs = opts.settleMs ?? 100;
  const minConsistencyRatio = opts.minConsistencyRatio ?? 0.6;
  const reloadBetween = opts.reloadBetween ?? false;

  await installMutationCounter(page);

  const targets = await discover(page, maxButtons);
  const issues: JitterIssue[] = [];

  for (const target of targets) {
    if (reloadBetween) {
      await page.reload();
      await installMutationCounter(page);
    }

    const cx = target.box.x + target.box.width / 2;
    const cy = target.box.y + target.box.height / 2;

    // Baseline: a dead-center click.
    const baseline = await probeClickAt(page, cx, cy, settleMs);
    const baselineReacted = baseline.mutations > 0;

    // Jittered clicks.
    const probes: ClickProbe[] = [];
    for (let i = 0; i < jitterClicks; i++) {
      const ox = randOffset(jitterPx);
      const oy = randOffset(jitterPx);
      const { x, y } = clampToBox(cx, cy, ox, oy, target.box);
      probes.push(await probeClickAt(page, x, y, settleMs));
    }

    const reactedCount = probes.filter((p) => p.mutations > 0).length;
    const reactedRatio = jitterClicks > 0 ? reactedCount / jitterClicks : 1;

    // 'silent-click': baseline reacted but a jittered click did not.
    if (baselineReacted && reactedCount < jitterClicks) {
      issues.push({
        kind: 'silent-click',
        selector: target.selector,
        detail: `center-click produced ${baseline.mutations} mutation(s) but ${jitterClicks - reactedCount}/${jitterClicks} jittered click(s) produced none`,
      });
    }

    // 'inconsistent-response': mixed hit/miss ratio below threshold.
    // Only meaningful when the baseline itself reacted; silent buttons are
    // their own separate concern.
    if (
      baselineReacted &&
      jitterClicks > 0 &&
      reactedRatio > 0 &&
      reactedRatio < minConsistencyRatio
    ) {
      issues.push({
        kind: 'inconsistent-response',
        selector: target.selector,
        detail: `${reactedCount}/${jitterClicks} jittered clicks reacted (ratio ${reactedRatio.toFixed(2)} < ${minConsistencyRatio})`,
      });
    }

    // 'off-target-trigger': a jittered click fired a substantially
    // different number of mutations than center — likely a different code
    // path. We deliberately do NOT compare body-hashes directly because
    // idempotent counters (click-n++) produce a fresh hash every call
    // without implying a new handler. A 2x+ delta in mutation volume is a
    // much stronger signal that a different listener ran.
    if (baselineReacted) {
      const threshold = Math.max(2, baseline.mutations * 2);
      const suspicious = probes.find(
        (p) =>
          p.mutations > 0 &&
          (p.mutations >= threshold || p.mutations * 2 <= baseline.mutations),
      );
      if (suspicious) {
        issues.push({
          kind: 'off-target-trigger',
          selector: target.selector,
          detail: `jittered click produced ${suspicious.mutations} mutation(s) vs center baseline ${baseline.mutations}`,
        });
      }
    }
  }

  return {
    issues,
    buttonsProbed: targets.length,
    passed: issues.length === 0,
  };
}
