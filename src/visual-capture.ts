import { PNG } from 'pngjs';
import type { Page } from 'playwright';

/**
 * P2 #24 — Stable visual capture helpers.
 *
 * Small, composable building blocks for screenshot-taking code paths (visual
 * diff, flow screenshot steps, storybook capture, etc.). All helpers are
 * additive: they assume nothing about the page state and return quickly on
 * pages that don't need them.
 */

export interface CaptureOptions {
  /** Inject a stylesheet that zeroes CSS animations and transitions. Default: true. */
  freezeAnimations?: boolean;
  /** Await `document.fonts.ready` before screenshot. Default: true. */
  waitFonts?: boolean;
  /** Scroll the page end-to-end in small increments to trigger lazy-loaded
   *  images/iframes before capture. Default: false (opt-in — slower). */
  autoScrollLazy?: boolean;
  /** Manually scroll-and-stitch the full page. Used when the browser's native
   *  `fullPage` option can't reach the whole document (sticky headers, virtual
   *  scrollers, huge pages). Default: false (opt-in — slower). */
  stitch?: boolean;
}

/**
 * Resolved options with defaults applied.
 */
export interface ResolvedCaptureOptions {
  freezeAnimations: boolean;
  waitFonts: boolean;
  autoScrollLazy: boolean;
  stitch: boolean;
}

const FREEZE_STYLE_ID = 'uxinspect-freeze-animations';
const FREEZE_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  caret-color: transparent !important;
  scroll-behavior: auto !important;
}
`;

/**
 * Merge user-supplied options with defaults.
 *   - freezeAnimations, waitFonts: ON by default (cheap, stabilize visuals)
 *   - autoScrollLazy, stitch:       OFF by default (expensive, opt-in)
 */
export function resolveCaptureOptions(
  opts?: CaptureOptions | undefined | null,
): ResolvedCaptureOptions {
  return {
    freezeAnimations: opts?.freezeAnimations ?? true,
    waitFonts: opts?.waitFonts ?? true,
    autoScrollLazy: opts?.autoScrollLazy ?? false,
    stitch: opts?.stitch ?? false,
  };
}

/**
 * Inject a stylesheet that kills CSS animations and transitions. Idempotent —
 * safe to call multiple times per page.
 */
export async function freezeAnimations(page: Page): Promise<void> {
  try {
    await page.evaluate(
      ({ id, css }) => {
        if (document.getElementById(id)) return;
        const style = document.createElement('style');
        style.id = id;
        style.setAttribute('data-uxinspect', 'freeze');
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
      },
      { id: FREEZE_STYLE_ID, css: FREEZE_CSS },
    );
  } catch {
    // Page may have navigated or closed; ignore. Best-effort stabilization.
  }
}

/**
 * Wait for web fonts to finish loading so that text isn't captured mid-FOUT
 * (flash of unstyled text). Bails out quickly if the font loading API is
 * unavailable or rejects.
 */
export async function waitFonts(page: Page, timeoutMs = 3000): Promise<void> {
  try {
    await page.evaluate(async (timeout: number) => {
      const fonts = (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts;
      if (!fonts || !fonts.ready) return;
      await Promise.race([
        fonts.ready,
        new Promise((resolve) => setTimeout(resolve, timeout)),
      ]);
    }, timeoutMs);
  } catch {
    // Page may have navigated or API missing. Don't block capture.
  }
}

/**
 * Auto-scroll top-to-bottom in small increments to trigger IntersectionObserver-
 * backed lazy loading (images, iframes, virtual lists). Ends at scroll-top.
 */
export async function autoScrollLazyLoad(
  page: Page,
  opts: { stepPx?: number; pauseMs?: number; maxScrolls?: number } = {},
): Promise<void> {
  const stepPx = opts.stepPx ?? 200;
  const pauseMs = opts.pauseMs ?? 100;
  const maxScrolls = opts.maxScrolls ?? 500;
  try {
    await page.evaluate(
      async ({ stepPx, pauseMs, maxScrolls }) => {
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        let lastHeight = -1;
        let guard = 0;
        while (guard++ < maxScrolls) {
          const doc = document.scrollingElement || document.documentElement;
          const current = doc.scrollTop;
          const maxScroll = doc.scrollHeight - window.innerHeight;
          if (maxScroll <= 0) break;
          const next = Math.min(current + stepPx, maxScroll);
          window.scrollTo(0, next);
          await sleep(pauseMs);
          if (next >= maxScroll) {
            // Give the last batch of lazy content a moment to load, then verify
            // the document hasn't grown (infinite scroll would keep expanding).
            await sleep(pauseMs);
            if (doc.scrollHeight === lastHeight) break;
            lastHeight = doc.scrollHeight;
          }
        }
        window.scrollTo(0, 0);
        await sleep(pauseMs);
      },
      { stepPx, pauseMs, maxScrolls },
    );
  } catch {
    // Page navigated or was closed; ignore. Best-effort prefetch.
  }
}

/**
 * Scroll-and-stitch a full-page PNG by capturing viewport-sized slices and
 * pasting them together. Used for pages where the browser's native `fullPage`
 * screenshot fails (e.g. pages with `position: fixed` headers that smear,
 * or very tall pages that exceed Chromium's single-capture limit).
 *
 * Returns a PNG Buffer.
 */
export async function stitchFullPage(
  page: Page,
  opts: { overlapPx?: number; maxHeightPx?: number; pauseMs?: number } = {},
): Promise<Buffer> {
  const overlapPx = Math.max(0, opts.overlapPx ?? 0);
  const maxHeightPx = opts.maxHeightPx ?? 32000;
  const pauseMs = opts.pauseMs ?? 50;

  const { vw, vh, docH, dpr } = await page.evaluate(() => {
    const doc = document.scrollingElement || document.documentElement;
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      docH: Math.max(
        doc.scrollHeight,
        document.body ? document.body.scrollHeight : 0,
        doc.clientHeight,
      ),
      dpr: window.devicePixelRatio || 1,
    };
  });

  const totalHeight = Math.min(docH, maxHeightPx);
  // If the document fits in a single viewport, just take one shot — no
  // stitching needed.
  if (totalHeight <= vh) {
    await page.evaluate(() => window.scrollTo(0, 0));
    return await page.screenshot({ fullPage: false });
  }

  // Save and zero scroll so the first slice is pixel-accurate, then restore.
  const originalScrollY = await page.evaluate(() => window.scrollY);

  const slices: { buffer: Buffer; y: number }[] = [];
  let y = 0;
  const step = Math.max(1, vh - overlapPx);
  let guard = 0;
  while (y < totalHeight && guard++ < 1000) {
    await page.evaluate((sy) => window.scrollTo(0, sy), y);
    await page.waitForTimeout(pauseMs);
    const buf = await page.screenshot({ fullPage: false });
    slices.push({ buffer: buf, y });
    if (y + vh >= totalHeight) break;
    y += step;
  }

  await page.evaluate((sy) => window.scrollTo(0, sy), originalScrollY);

  // Decode all slices, all share the same width & device pixel ratio.
  const decoded = slices.map((s) => ({ png: PNG.sync.read(s.buffer), y: s.y }));
  const width = decoded[0].png.width;
  const heightCss = totalHeight;
  const heightPx = Math.round(heightCss * dpr);
  const out = new PNG({ width, height: heightPx });

  // Clear to white so overlap/gaps stay white rather than undefined.
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 255;
    out.data[i + 1] = 255;
    out.data[i + 2] = 255;
    out.data[i + 3] = 255;
  }

  for (const { png, y: cssY } of decoded) {
    const dstY = Math.round(cssY * dpr);
    const rows = Math.min(png.height, heightPx - dstY);
    if (rows <= 0) continue;
    // Copy rows into the output. If the slice is wider (shouldn't happen),
    // clamp to output width.
    const cols = Math.min(png.width, width);
    for (let row = 0; row < rows; row++) {
      const srcStart = row * png.width * 4;
      const dstStart = (dstY + row) * width * 4;
      png.data.copy(
        out.data,
        dstStart,
        srcStart,
        srcStart + cols * 4,
      );
    }
  }

  return PNG.sync.write(out);
}

/**
 * High-level screenshot wrapper. Applies the pre-capture stabilizations
 * (freeze animations, wait fonts, optional auto-scroll) and either calls
 * Playwright's native screenshot or our stitcher depending on `stitch`.
 */
export async function stableScreenshot(
  page: Page,
  opts: CaptureOptions & {
    fullPage?: boolean;
    path?: string;
    type?: 'png' | 'jpeg';
  } = {},
): Promise<Buffer> {
  const resolved = resolveCaptureOptions(opts);
  await prepareCapture(page, resolved);
  let buffer: Buffer;
  if (resolved.stitch) {
    buffer = await stitchFullPage(page);
  } else {
    buffer = await page.screenshot({
      fullPage: opts.fullPage ?? false,
      type: opts.type,
    });
  }
  if (opts.path) {
    const { promises: fs } = await import('node:fs');
    const path = await import('node:path');
    await fs.mkdir(path.dirname(opts.path), { recursive: true });
    await fs.writeFile(opts.path, buffer);
  }
  return buffer;
}

/**
 * Run the pre-capture stabilization steps as configured. Exported so callers
 * can reuse it when they still want to issue the screenshot call themselves
 * (e.g. to pass Playwright-specific options like `mask`).
 */
export async function prepareCapture(
  page: Page,
  opts: CaptureOptions | ResolvedCaptureOptions,
): Promise<ResolvedCaptureOptions> {
  const resolved =
    'freezeAnimations' in opts &&
    'waitFonts' in opts &&
    'autoScrollLazy' in opts &&
    'stitch' in opts
      ? (opts as ResolvedCaptureOptions)
      : resolveCaptureOptions(opts as CaptureOptions);
  if (resolved.freezeAnimations) await freezeAnimations(page);
  if (resolved.waitFonts) await waitFonts(page);
  if (resolved.autoScrollLazy) await autoScrollLazyLoad(page);
  return resolved;
}
