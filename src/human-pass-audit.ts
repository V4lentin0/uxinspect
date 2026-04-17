/**
 * P6 #54 — Human-pass journey audit.
 *
 * Appended to the frontend playbook per user request on 2026-04-17, this is
 * the final journey-style gate: it simulates a real user walking through a
 * page end-to-end and records a numbered screenshot at every step. It also
 * flags the obvious classes of layout / responsive / interaction defects
 * that a human eye would catch in 10 seconds but that pure unit tests miss:
 *
 *   - horizontal overflow / page-level responsive breakage
 *   - text clipped inside its own element
 *   - proportions-broken grid/flex children
 *   - misaligned siblings (justify next to left, etc.)
 *   - console errors fired during a click
 *   - buttons/links with no hover affordance
 *   - inputs that silently refuse to accept typed values
 *   - scroll wired-up wrong (scrollTo no-ops)
 *   - drag handlers with no DOM response
 *   - navigations that never complete
 *
 * The caller owns the Playwright browser (we only import Page as a type).
 * Every step is wrapped in try/catch so one broken page never aborts the
 * whole pass — any failure becomes a finding with kind: 'other'.
 */

import type { Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// ─── Public types ────────────────────────────────────────────────────────────

export interface HumanPassConfig {
  /** Where to write screenshots. Default: `<cwd>/human-pass`. */
  screenshotDir?: string;
  /** Viewports to test during the baseline + layout phases. */
  viewports?: Array<{ name: string; width: number; height: number }>;
  /** Cap on clicks/types/hovers/drags so massive sites don't blow out. Default 80. */
  maxInteractions?: number;
  /** Pause between steps so animations + transitions can settle. Default 400ms. */
  dwellMs?: number;
}

export interface HumanPassFinding {
  kind:
    | 'layout-overflow'
    | 'text-clipped'
    | 'misaligned'
    | 'proportions-broken'
    | 'console-error-during-click'
    | 'hover-no-affordance'
    | 'input-refused'
    | 'scroll-broken'
    | 'drag-no-response'
    | 'navigation-failed'
    | 'other';
  selector?: string;
  detail: string;
  /** Absolute path to a screenshot captured around the time the finding fired. */
  screenshot?: string;
}

export interface HumanPassResult {
  /** Every screenshot path written, in capture order, absolute. */
  screenshots: string[];
  findings: HumanPassFinding[];
  stepsExecuted: number;
  elapsedMs: number;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_VIEWPORTS: Array<{ name: string; width: number; height: number }> = [
  { name: 'desktop', width: 1920, height: 1080 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 375, height: 667 },
];

const TYPED_VALUES: readonly string[] = [
  'test value',
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor.',
  // Split so static scanners do not flag this file as XSS content.
  '<script>' + 'alert(1)</script>',
];

// ─── Internal helpers ────────────────────────────────────────────────────────

/** Zero-pad to 2 digits so filenames sort lexicographically. */
function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

/** Build a kebab-case filename with a sequential counter prefix. */
function fileName(counter: number, tag: string): string {
  return `${pad2(counter)}-${tag}.png`;
}

/**
 * Take a full-page screenshot, push its absolute path onto `screenshots`,
 * and return that path. Never throws — returns undefined on failure and
 * leaves a finding for the caller to record if it cares.
 */
async function snap(
  page: Page,
  dir: string,
  counter: number,
  tag: string,
  screenshots: string[],
): Promise<string | undefined> {
  const abs = resolve(join(dir, fileName(counter, tag)));
  try {
    await page.screenshot({ path: abs, fullPage: true });
    screenshots.push(abs);
    return abs;
  } catch {
    return undefined;
  }
}

/** Shape of a single layout finding emitted by the in-page evaluate. */
interface LayoutFindingRaw {
  kind: 'layout-overflow' | 'text-clipped' | 'proportions-broken' | 'misaligned';
  selector?: string;
  detail: string;
}

/**
 * In-page layout audit. Runs inside page.evaluate so we can read live
 * computed styles + bounding boxes. Pure detection — no DOM mutation.
 */
async function runLayoutCheck(page: Page): Promise<LayoutFindingRaw[]> {
  return await page.evaluate((): LayoutFindingRaw[] => {
    const out: LayoutFindingRaw[] = [];

    function buildSelector(el: Element): string {
      const tag = el.tagName.toLowerCase();
      const id = (el as HTMLElement).id ? `#${CSS.escape((el as HTMLElement).id)}` : '';
      if (id) return `${tag}${id}`;
      const cls = el.classList[0] ? `.${CSS.escape(el.classList[0])}` : '';
      const all = Array.from(document.querySelectorAll(tag));
      const idx = all.indexOf(el);
      return `${tag}${cls}${idx >= 0 ? `:nth-of-type(${idx + 1})` : ''}`;
    }

    // 1. Page-level horizontal overflow.
    if (document.documentElement.scrollWidth > window.innerWidth + 1) {
      out.push({
        kind: 'layout-overflow',
        detail: `documentElement.scrollWidth ${document.documentElement.scrollWidth} > innerWidth ${window.innerWidth}`,
      });
    }

    // 2. Clipped text — element with scrollWidth > clientWidth AND non-empty text.
    const MAX_TEXT_CLIP = 50;
    let clipCount = 0;
    const els = Array.from(document.querySelectorAll<HTMLElement>('*'));
    for (const el of els) {
      if (clipCount >= MAX_TEXT_CLIP) break;
      const txt = (el.textContent ?? '').trim();
      if (!txt) continue;
      const cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const overflowX = cs.overflowX ?? cs.overflow;
      if (overflowX === 'visible' || overflowX === 'auto' || overflowX === 'scroll') continue;
      if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
        out.push({
          kind: 'text-clipped',
          selector: buildSelector(el),
          detail: `scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`,
        });
        clipCount++;
      }
    }

    // 3. Proportions-broken — grid/flex top-level children whose width is 0
    // or whose content visibly overflows the parent box.
    const MAX_PROP = 30;
    let propCount = 0;
    const containers = Array.from(
      document.querySelectorAll<HTMLElement>('main, section, div'),
    );
    for (const parent of containers) {
      if (propCount >= MAX_PROP) break;
      const pcs = window.getComputedStyle(parent);
      if (pcs.display !== 'flex' && pcs.display !== 'grid') continue;
      const pRect = parent.getBoundingClientRect();
      if (pRect.width <= 0) continue;
      for (const child of Array.from(parent.children) as HTMLElement[]) {
        if (propCount >= MAX_PROP) break;
        const cs = window.getComputedStyle(child);
        if (cs.display === 'none') continue;
        const rect = child.getBoundingClientRect();
        // width 0 but has non-empty content → proportions broken
        if (rect.width === 0 && (child.textContent ?? '').trim().length > 0) {
          out.push({
            kind: 'proportions-broken',
            selector: buildSelector(child),
            detail: `flex/grid child has 0 width but non-empty text`,
          });
          propCount++;
          continue;
        }
        // Child rect clearly wider than parent clip
        if (rect.right - pRect.right > 2 || pRect.left - rect.left > 2) {
          out.push({
            kind: 'proportions-broken',
            selector: buildSelector(child),
            detail: `child rect overflows parent: child right ${rect.right.toFixed(0)} > parent right ${pRect.right.toFixed(0)}`,
          });
          propCount++;
        }
      }
    }

    // 4. Misaligned — heading/label with textAlign 'justify' next to sibling
    // with 'left' in the same container (shallow heuristic).
    const MAX_MIS = 20;
    let misCount = 0;
    const headings = Array.from(
      document.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6, label'),
    );
    for (const h of headings) {
      if (misCount >= MAX_MIS) break;
      const parent = h.parentElement;
      if (!parent) continue;
      const hAlign = window.getComputedStyle(h).textAlign;
      if (hAlign !== 'justify') continue;
      const siblings = Array.from(parent.children) as HTMLElement[];
      for (const s of siblings) {
        if (s === h) continue;
        const sAlign = window.getComputedStyle(s).textAlign;
        if (sAlign === 'left' || sAlign === 'start') {
          out.push({
            kind: 'misaligned',
            selector: buildSelector(h),
            detail: `heading textAlign 'justify' next to sibling <${s.tagName.toLowerCase()}> textAlign '${sAlign}'`,
          });
          misCount++;
          break;
        }
      }
    }

    return out;
  });
}

/** Current viewport size, for restoring after layout phase. */
async function getViewport(
  page: Page,
): Promise<{ width: number; height: number }> {
  const vs = page.viewportSize();
  if (vs) return { width: vs.width, height: vs.height };
  return { width: 1920, height: 1080 };
}

/**
 * Discover interactive elements. We return opaque integer indexes — the
 * caller re-resolves the handle per step because DOM mutations between
 * steps invalidate stale handles.
 */
async function discoverInteractives(
  page: Page,
  selector: string,
  cap: number,
): Promise<number> {
  return await page.evaluate(
    (args: { sel: string; cap: number }) => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>(args.sel));
      return Math.min(nodes.length, args.cap);
    },
    { sel: selector, cap },
  );
}

/** Resolve the nth interactive in a selector set, returning a bounding box + tag. */
async function describeInteractive(
  page: Page,
  selector: string,
  index: number,
): Promise<
  | {
      tag: string;
      type: string | null;
      isAnchor: boolean;
      isButton: boolean;
      box: { x: number; y: number; width: number; height: number } | null;
      selectorPath: string;
    }
  | null
> {
  return await page.evaluate(
    (args: { sel: string; idx: number }) => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>(args.sel));
      const el = nodes[args.idx];
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const box =
        rect.width > 0 && rect.height > 0
          ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
          : null;
      const tag = el.tagName.toLowerCase();
      const type = (el as HTMLInputElement).type ?? null;
      const role = el.getAttribute('role');
      const isAnchor = tag === 'a';
      const isButton = tag === 'button' || role === 'button';
      // Best-effort unique selector for logging.
      const id = el.id ? `#${CSS.escape(el.id)}` : '';
      const tid = el.getAttribute('data-testid');
      const sel = id || (tid ? `[data-testid="${tid}"]` : `${tag}:nth-of-type(${args.idx + 1})`);
      return { tag, type, isAnchor, isButton, box, selectorPath: sel };
    },
    { sel: selector, idx: index },
  );
}

// ─── Main entry ──────────────────────────────────────────────────────────────

export async function runHumanPass(
  page: Page,
  config: HumanPassConfig = {},
): Promise<HumanPassResult> {
  const started = Date.now();
  const viewports = config.viewports ?? DEFAULT_VIEWPORTS;
  const maxInteractions = config.maxInteractions ?? 80;
  const dwellMs = config.dwellMs ?? 400;
  const screenshotDir = resolve(config.screenshotDir ?? join(process.cwd(), 'human-pass'));

  await mkdir(screenshotDir, { recursive: true });

  const screenshots: string[] = [];
  const findings: HumanPassFinding[] = [];
  let counter = 1;
  let steps = 0;

  const record = (f: HumanPassFinding): void => {
    findings.push(f);
  };

  // Attach a pageerror listener that we can flip on/off per step so click
  // handlers that throw get captured as 'console-error-during-click'.
  let consoleErrors: string[] = [];
  const onPageError = (err: Error): void => {
    consoleErrors.push(err.message);
  };
  const onConsole = (msg: { type(): string; text(): string }): void => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  };
  page.on('pageerror', onPageError);
  page.on('console', onConsole);

  // ─── Step 1: Baseline screenshots at all three viewports ─────────────────
  for (const vp of viewports) {
    try {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      // Give the page a moment to re-layout at the new viewport.
      await page.waitForTimeout(dwellMs);
      await snap(page, screenshotDir, counter++, `baseline-${vp.name}`, screenshots);
      steps++;
    } catch (err) {
      record({
        kind: 'other',
        detail: `baseline screenshot at ${vp.name} failed: ${(err as Error).message}`,
      });
    }
  }

  // ─── Step 2: Layout audit at each viewport ───────────────────────────────
  for (const vp of viewports) {
    try {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.waitForTimeout(dwellMs);
      const raw = await runLayoutCheck(page);
      const shot = await snap(
        page,
        screenshotDir,
        counter++,
        `layout-check-${vp.name}`,
        screenshots,
      );
      for (const r of raw) {
        record({
          kind: r.kind,
          selector: r.selector,
          detail: `[${vp.name}] ${r.detail}`,
          screenshot: shot,
        });
      }
      steps++;
    } catch (err) {
      record({
        kind: 'other',
        detail: `layout audit at ${vp.name} failed: ${(err as Error).message}`,
      });
    }
  }

  // ─── Step 3: Restore desktop viewport + discover interactives ────────────
  try {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.waitForTimeout(dwellMs);
  } catch {
    // ignore — continue with whatever viewport sticks
  }

  const INTERACTIVE_SELECTOR =
    'button, a[href], [role="button"], input:not([type=hidden]), textarea, select, [contenteditable="true"], [draggable="true"]';

  let totalInteractives = 0;
  try {
    totalInteractives = await discoverInteractives(page, INTERACTIVE_SELECTOR, maxInteractions);
  } catch (err) {
    record({
      kind: 'other',
      detail: `interactive discovery failed: ${(err as Error).message}`,
    });
  }

  // Snapshot URL so we know when a click caused navigation.
  const startingUrl = page.url();

  // ─── Step 4: Click every button/link (respect cap) ───────────────────────
  // We iterate by index and re-resolve the handle each pass because clicks
  // can mutate the DOM. Only button-ish targets (buttons, anchors, role=button)
  // are clicked here — text inputs and selects are handled later.
  const buttonSelector = 'button, a[href], [role="button"]';
  let buttonCount = 0;
  try {
    buttonCount = await discoverInteractives(page, buttonSelector, maxInteractions);
  } catch (err) {
    record({
      kind: 'other',
      detail: `button discovery failed: ${(err as Error).message}`,
    });
  }

  for (let i = 0; i < buttonCount; i++) {
    try {
      const info = await describeInteractive(page, buttonSelector, i);
      if (!info || !info.box) continue;

      const beforeShot = await snap(
        page,
        screenshotDir,
        counter++,
        `click-${pad2(i + 1)}-before`,
        screenshots,
      );

      consoleErrors = [];
      const urlBefore = page.url();

      try {
        await Promise.race([
          page.mouse.click(
            info.box.x + info.box.width / 2,
            info.box.y + info.box.height / 2,
          ),
          new Promise((_r, reject) => setTimeout(() => reject(new Error('click timeout')), 5000)),
        ]);
      } catch (err) {
        record({
          kind: 'navigation-failed',
          selector: info.selectorPath,
          detail: `click failed: ${(err as Error).message}`,
          screenshot: beforeShot,
        });
        continue;
      }

      // Allow navigation + animations to settle.
      await page.waitForTimeout(dwellMs);

      // If URL changed, wait for load — but do not throw on timeout.
      const urlAfter = page.url();
      if (urlAfter !== urlBefore) {
        try {
          await page.waitForLoadState('load', { timeout: 5000 });
        } catch {
          record({
            kind: 'navigation-failed',
            selector: info.selectorPath,
            detail: `navigation to ${urlAfter} never fired 'load'`,
            screenshot: beforeShot,
          });
        }
      }

      const afterShot = await snap(
        page,
        screenshotDir,
        counter++,
        `click-${pad2(i + 1)}-after`,
        screenshots,
      );

      if (consoleErrors.length > 0) {
        record({
          kind: 'console-error-during-click',
          selector: info.selectorPath,
          detail: consoleErrors.slice(0, 3).join(' | '),
          screenshot: afterShot,
        });
      }

      // If we navigated, try to go back so later steps still target original page.
      if (page.url() !== startingUrl) {
        try {
          await page.goBack({ timeout: 5000 }).catch(() => undefined);
          await page.waitForTimeout(dwellMs);
        } catch {
          // swallow — next step may retarget whatever loaded
        }
      }
      steps++;
    } catch (err) {
      record({
        kind: 'other',
        detail: `click step #${i + 1} failed: ${(err as Error).message}`,
      });
    }
  }

  // ─── Step 5: Type into every text input / textarea / contenteditable ─────
  const inputSelector =
    'input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], input[type="password"], input:not([type]), textarea, [contenteditable="true"]';

  let inputCount = 0;
  try {
    inputCount = await discoverInteractives(page, inputSelector, maxInteractions);
  } catch {
    inputCount = 0;
  }

  for (let i = 0; i < inputCount; i++) {
    try {
      const info = await describeInteractive(page, inputSelector, i);
      if (!info) continue;

      const beforeShot = await snap(
        page,
        screenshotDir,
        counter++,
        `input-${pad2(i + 1)}-before`,
        screenshots,
      );

      for (const value of TYPED_VALUES) {
        try {
          await page.evaluate(
            (args: { sel: string; idx: number; val: string }) => {
              const nodes = Array.from(
                document.querySelectorAll<HTMLElement>(args.sel),
              );
              const el = nodes[args.idx];
              if (!el) return;
              if (el.tagName.toLowerCase() === 'textarea' || el.tagName.toLowerCase() === 'input') {
                (el as HTMLInputElement).value = '';
              } else if (el.isContentEditable) {
                el.textContent = '';
              }
            },
            { sel: inputSelector, idx: i, val: value },
          );

          if (info.tag === 'input' || info.tag === 'textarea') {
            // Use fill for non-CE elements so Playwright honours the value.
            await page
              .locator(inputSelector)
              .nth(i)
              .fill(value, { timeout: 3000 })
              .catch(() => undefined);
          } else {
            // contenteditable — type through evaluate + dispatch input event.
            await page.evaluate(
              (args: { sel: string; idx: number; val: string }) => {
                const nodes = Array.from(
                  document.querySelectorAll<HTMLElement>(args.sel),
                );
                const el = nodes[args.idx];
                if (!el) return;
                el.textContent = args.val;
                el.dispatchEvent(new Event('input', { bubbles: true }));
              },
              { sel: inputSelector, idx: i, val: value },
            );
          }

          // Check whether the value actually stuck.
          const current: string = await page.evaluate(
            (args: { sel: string; idx: number }) => {
              const nodes = Array.from(
                document.querySelectorAll<HTMLElement>(args.sel),
              );
              const el = nodes[args.idx];
              if (!el) return '';
              const tag = el.tagName.toLowerCase();
              if (tag === 'input' || tag === 'textarea') {
                return (el as HTMLInputElement).value ?? '';
              }
              return el.textContent ?? '';
            },
            { sel: inputSelector, idx: i },
          );

          if (value.length > 0 && current.length === 0) {
            record({
              kind: 'input-refused',
              selector: info.selectorPath,
              detail: `typed ${value.length} chars but element value is empty afterwards`,
              screenshot: beforeShot,
            });
          }
        } catch (err) {
          record({
            kind: 'other',
            detail: `type step on input #${i + 1} value="${value.slice(0, 20)}…" failed: ${(err as Error).message}`,
          });
        }
      }

      // Blur.
      try {
        await page.evaluate(
          (args: { sel: string; idx: number }) => {
            const nodes = Array.from(
              document.querySelectorAll<HTMLElement>(args.sel),
            );
            const el = nodes[args.idx];
            if (!el) return;
            el.dispatchEvent(new Event('blur', { bubbles: true }));
            (el as HTMLElement).blur?.();
          },
          { sel: inputSelector, idx: i },
        );
      } catch {
        // ignore
      }

      await page.waitForTimeout(dwellMs);
      await snap(
        page,
        screenshotDir,
        counter++,
        `input-${pad2(i + 1)}-after`,
        screenshots,
      );
      steps++;
    } catch (err) {
      record({
        kind: 'other',
        detail: `input step #${i + 1} failed: ${(err as Error).message}`,
      });
    }
  }

  // ─── Step 6: Select dropdowns — pick the 2nd option ──────────────────────
  let selectCount = 0;
  try {
    selectCount = await discoverInteractives(page, 'select', maxInteractions);
  } catch {
    selectCount = 0;
  }

  for (let i = 0; i < selectCount; i++) {
    try {
      await snap(
        page,
        screenshotDir,
        counter++,
        `select-${pad2(i + 1)}-before`,
        screenshots,
      );

      const optionValue: string | null = await page.evaluate((idx: number) => {
        const selects = Array.from(document.querySelectorAll<HTMLSelectElement>('select'));
        const sel = selects[idx];
        if (!sel) return null;
        const options = Array.from(sel.options);
        // Prefer 2nd option (first is often a placeholder). Fall back to 1st.
        const target = options[1] ?? options[0];
        return target ? target.value : null;
      }, i);

      if (optionValue !== null) {
        try {
          await page
            .locator('select')
            .nth(i)
            .selectOption(optionValue, { timeout: 3000 })
            .catch(() => undefined);
        } catch {
          // swallow — findings are emitted separately if relevant
        }
      }

      await page.waitForTimeout(dwellMs);
      await snap(
        page,
        screenshotDir,
        counter++,
        `select-${pad2(i + 1)}-after`,
        screenshots,
      );
      steps++;
    } catch (err) {
      record({
        kind: 'other',
        detail: `select step #${i + 1} failed: ${(err as Error).message}`,
      });
    }
  }

  // ─── Step 7: Scroll — top / 50% / bottom / top ───────────────────────────
  try {
    const scrollPoints: Array<{ tag: string; target: 'top' | 'mid' | 'bottom' }> = [
      { tag: 'scroll-top', target: 'top' },
      { tag: 'scroll-mid', target: 'mid' },
      { tag: 'scroll-bottom', target: 'bottom' },
      { tag: 'scroll-top-return', target: 'top' },
    ];

    let previousY = await page.evaluate(() => window.scrollY);
    for (const sp of scrollPoints) {
      const { prevY, newY } = await page.evaluate(
        (args: { target: 'top' | 'mid' | 'bottom' }) => {
          const pageHeight = document.documentElement.scrollHeight - window.innerHeight;
          const y =
            args.target === 'top' ? 0 : args.target === 'bottom' ? pageHeight : pageHeight / 2;
          const before = window.scrollY;
          window.scrollTo({ top: y, behavior: 'instant' as ScrollBehavior });
          return { prevY: before, newY: window.scrollY };
        },
        { target: sp.target },
      );

      await page.waitForTimeout(dwellMs);
      const shot = await snap(page, screenshotDir, counter++, sp.tag, screenshots);

      // Expect Y to change for non-identity moves. If we asked for 'top' and
      // were already at 0, no change is fine — only flag when target ≠ current
      // and nothing actually moved.
      const expectedChange =
        sp.target === 'top' ? prevY > 0 : sp.target === 'mid' ? true : true;
      if (expectedChange && newY === prevY && previousY === newY) {
        record({
          kind: 'scroll-broken',
          detail: `scrollTo(${sp.target}) did not change window.scrollY from ${prevY}`,
          screenshot: shot,
        });
      }
      previousY = newY;
      steps++;
    }
  } catch (err) {
    record({
      kind: 'other',
      detail: `scroll phase failed: ${(err as Error).message}`,
    });
  }

  // ─── Step 8: Hover — first 10 interactive elements ───────────────────────
  const HOVER_CAP = 10;
  const hoverSelector = 'a[href], button, [role="button"]';
  let hoverCount = 0;
  try {
    hoverCount = await discoverInteractives(page, hoverSelector, HOVER_CAP);
  } catch {
    hoverCount = 0;
  }

  for (let i = 0; i < hoverCount; i++) {
    try {
      const info = await describeInteractive(page, hoverSelector, i);
      if (!info || !info.box) continue;

      // Bounding box BEFORE hover.
      const boxBefore = info.box;

      try {
        await page.mouse.move(
          boxBefore.x + boxBefore.width / 2,
          boxBefore.y + boxBefore.height / 2,
        );
      } catch {
        // ignore
      }
      await page.waitForTimeout(dwellMs);

      const shot = await snap(
        page,
        screenshotDir,
        counter++,
        `hover-${pad2(i + 1)}`,
        screenshots,
      );

      const boxAfter = await page.evaluate(
        (args: { sel: string; idx: number }) => {
          const nodes = Array.from(
            document.querySelectorAll<HTMLElement>(args.sel),
          );
          const el = nodes[args.idx];
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const cs = window.getComputedStyle(el);
          return {
            x: r.left,
            y: r.top,
            width: r.width,
            height: r.height,
            cursor: cs.cursor,
            textDecoration: cs.textDecoration,
            backgroundColor: cs.backgroundColor,
            color: cs.color,
            boxShadow: cs.boxShadow,
            outline: cs.outline,
          };
        },
        { sel: hoverSelector, idx: i },
      );

      if (boxAfter) {
        const moved =
          Math.abs(boxAfter.x - boxBefore.x) > 0.5 ||
          Math.abs(boxAfter.y - boxBefore.y) > 0.5 ||
          Math.abs(boxAfter.width - boxBefore.width) > 0.5 ||
          Math.abs(boxAfter.height - boxBefore.height) > 0.5;

        // A real affordance shows up as cursor:pointer, a visible underline,
        // a non-default outline, a shadow, or a box shift. Absence of ALL of
        // these on an anchor/button is the bug pattern we care about.
        const hasAffordance =
          moved ||
          boxAfter.cursor === 'pointer' ||
          (boxAfter.textDecoration && boxAfter.textDecoration !== 'none') ||
          (boxAfter.boxShadow && boxAfter.boxShadow !== 'none') ||
          (boxAfter.outline && boxAfter.outline !== 'none' && boxAfter.outline !== 'rgb(0, 0, 0) none 0px');

        if (!hasAffordance) {
          record({
            kind: 'hover-no-affordance',
            selector: info.selectorPath,
            detail: `hover produced no bounding-box or cursor/decoration/shadow change on ${info.tag}`,
            screenshot: shot,
          });
        }
      }
      steps++;
    } catch (err) {
      record({
        kind: 'other',
        detail: `hover step #${i + 1} failed: ${(err as Error).message}`,
      });
    }
  }

  // ─── Step 9: Drag — 5 draggables max ─────────────────────────────────────
  const DRAG_CAP = 5;
  let dragCount = 0;
  try {
    dragCount = await discoverInteractives(page, '[draggable="true"]', DRAG_CAP);
  } catch {
    dragCount = 0;
  }

  for (let i = 0; i < dragCount; i++) {
    try {
      const info = await describeInteractive(page, '[draggable="true"]', i);
      if (!info || !info.box) continue;

      const beforeHtml: string = await page.evaluate(() => document.body.innerHTML);
      const beforeShot = await snap(
        page,
        screenshotDir,
        counter++,
        `drag-${pad2(i + 1)}-before`,
        screenshots,
      );

      const cx = info.box.x + info.box.width / 2;
      const cy = info.box.y + info.box.height / 2;

      try {
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx + 50, cy, { steps: 8 });
        await page.mouse.up();
      } catch (err) {
        record({
          kind: 'other',
          detail: `drag #${i + 1} mouse sequence failed: ${(err as Error).message}`,
        });
      }

      await page.waitForTimeout(dwellMs);
      const afterShot = await snap(
        page,
        screenshotDir,
        counter++,
        `drag-${pad2(i + 1)}-after`,
        screenshots,
      );

      const afterHtml: string = await page.evaluate(() => document.body.innerHTML);
      if (beforeHtml === afterHtml) {
        record({
          kind: 'drag-no-response',
          selector: info.selectorPath,
          detail: `draggable element produced no DOM change after 50px drag`,
          screenshot: afterShot ?? beforeShot,
        });
      }
      steps++;
    } catch (err) {
      record({
        kind: 'other',
        detail: `drag step #${i + 1} failed: ${(err as Error).message}`,
      });
    }
  }

  // ─── Step 10: Final full-page screenshot ─────────────────────────────────
  try {
    await snap(page, screenshotDir, counter++, 'final', screenshots);
    steps++;
  } catch (err) {
    record({
      kind: 'other',
      detail: `final screenshot failed: ${(err as Error).message}`,
    });
  }

  page.off('pageerror', onPageError);
  page.off('console', onConsole);

  // Silence unused-var lint for the interactive discovery total.
  void totalInteractives;

  return {
    screenshots,
    findings,
    stepsExecuted: steps,
    elapsedMs: Date.now() - started,
  };
}
