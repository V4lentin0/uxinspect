import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import {
  autoScrollLazyLoad,
  freezeAnimations,
  prepareCapture,
  resolveCaptureOptions,
  stableScreenshot,
  stitchFullPage,
  waitFonts,
} from './visual-capture.js';

let browser: Browser | undefined;
let context: BrowserContext | undefined;

before(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 400, height: 300 } });
});

after(async () => {
  await context?.close();
  await browser?.close();
});

async function newPage(): Promise<Page> {
  if (!context) throw new Error('browser context not ready');
  return context.newPage();
}

// A deliberately tall page (5x the viewport height) painted with 5 distinct
// solid-color stripes so the stitcher output can be checked for each band.
function tallStripedPage(opts: {
  viewportHeight: number;
  stripes: string[]; // css colors
}): string {
  const stripeHeight = opts.viewportHeight;
  const stripes = opts.stripes
    .map(
      (c, i) =>
        `<div data-stripe="${i}" style="height:${stripeHeight}px;background:${c};"></div>`,
    )
    .join('');
  return `<!doctype html>
<html>
<head>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #ffffff; }
</style>
</head>
<body>${stripes}</body>
</html>`;
}

describe('visual-capture defaults', () => {
  test('resolveCaptureOptions applies documented defaults', () => {
    const r = resolveCaptureOptions();
    assert.equal(r.freezeAnimations, true);
    assert.equal(r.waitFonts, true);
    assert.equal(r.autoScrollLazy, false);
    assert.equal(r.stitch, false);
  });

  test('resolveCaptureOptions respects explicit overrides', () => {
    const r = resolveCaptureOptions({
      freezeAnimations: false,
      waitFonts: false,
      autoScrollLazy: true,
      stitch: true,
    });
    assert.equal(r.freezeAnimations, false);
    assert.equal(r.waitFonts, false);
    assert.equal(r.autoScrollLazy, true);
    assert.equal(r.stitch, true);
  });
});

describe('visual-capture — freezeAnimations', () => {
  test('injects the zero-duration stylesheet exactly once', async () => {
    const page = await newPage();
    try {
      await page.setContent(`<!doctype html><html><body><div id="x"></div></body></html>`);
      await freezeAnimations(page);
      await freezeAnimations(page); // idempotent
      const count = await page.evaluate(() =>
        document.querySelectorAll('style[data-uxinspect="freeze"]').length,
      );
      assert.equal(count, 1, 'exactly one freeze stylesheet');
      // The stylesheet must override animation & transition durations.
      const durations = await page.evaluate(() => {
        const el = document.getElementById('x')!;
        el.style.transition = 'opacity 5s linear';
        const c = getComputedStyle(el);
        return { animation: c.animationDuration, transition: c.transitionDuration };
      });
      assert.equal(durations.animation, '0s', 'animation-duration zeroed');
      assert.equal(durations.transition, '0s', 'transition-duration zeroed');
    } finally {
      await page.close();
    }
  });
});

describe('visual-capture — waitFonts', () => {
  test('resolves when document.fonts.ready resolves', async () => {
    const page = await newPage();
    try {
      await page.setContent(
        `<!doctype html><html><body>Hello fonts</body></html>`,
      );
      // Should resolve well under the 3s timeout.
      const t0 = Date.now();
      await waitFonts(page, 3000);
      const dt = Date.now() - t0;
      assert.ok(dt < 3000, `waitFonts returned in ${dt}ms (<3000)`);
    } finally {
      await page.close();
    }
  });
});

describe('visual-capture — autoScrollLazyLoad', () => {
  test('scrolls to the bottom and returns to top, triggering lazy images', async () => {
    const page = await newPage();
    try {
      await page.setContent(`<!doctype html>
<html><body style="margin:0">
  <div style="height:3000px;background:linear-gradient(#fff,#000)"></div>
  <img id="lazy"
       loading="lazy"
       src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEX///+nxBvIAAAAC0lEQVQI12NgAAIAAAUAAeImBZsAAAAASUVORK5CYII="
       width="50" height="50" />
</body></html>`);
      await autoScrollLazyLoad(page, { stepPx: 400, pauseMs: 10 });
      const finalY = await page.evaluate(() => window.scrollY);
      assert.equal(finalY, 0, 'scrolled back to top after lazy-load pass');
      const imgLoaded = await page.evaluate(() => {
        const img = document.getElementById('lazy') as HTMLImageElement;
        return img && img.complete && img.naturalWidth > 0;
      });
      assert.ok(imgLoaded, 'lazy image has loaded after full-page scroll');
    } finally {
      await page.close();
    }
  });
});

describe('visual-capture — stitchFullPage', () => {
  test('stitches a tall page into a single PNG covering the whole document', async () => {
    const page = await newPage();
    try {
      await page.setViewportSize({ width: 400, height: 300 });
      // 5 viewport-height stripes = 1500px tall document in a 300px viewport.
      const stripes = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff'];
      await page.setContent(tallStripedPage({ viewportHeight: 300, stripes }));

      const buf = await stitchFullPage(page, { pauseMs: 20 });
      const png = PNG.sync.read(buf);

      // Playwright takes shots at device-pixel resolution. Widths must match
      // the visible viewport (at whatever DPR) and height must span the whole
      // document (≈ 1500 css px * DPR).
      const dpr = await page.evaluate(() => window.devicePixelRatio || 1);
      const expectedHeight = Math.round(1500 * dpr);
      assert.equal(png.width, 400 * dpr, `width matches viewport (DPR ${dpr})`);
      assert.equal(
        png.height,
        expectedHeight,
        `height spans all stripes (1500 css px * DPR ${dpr} = ${expectedHeight})`,
      );

      // Sample the center pixel of each stripe and confirm the colour matches.
      // Stripe N occupies [N*300 .. (N+1)*300) in css pixels.
      const expected = [
        { r: 255, g: 0, b: 0 }, // red
        { r: 0, g: 255, b: 0 }, // green
        { r: 0, g: 0, b: 255 }, // blue
        { r: 255, g: 255, b: 0 }, // yellow
        { r: 255, g: 0, b: 255 }, // magenta
      ];
      for (let i = 0; i < expected.length; i++) {
        const cssCenterY = i * 300 + 150;
        const y = Math.round(cssCenterY * dpr);
        const x = Math.round((400 * dpr) / 2);
        const idx = (png.width * y + x) << 2;
        const r = png.data[idx];
        const g = png.data[idx + 1];
        const b = png.data[idx + 2];
        const want = expected[i];
        assert.ok(
          Math.abs(r - want.r) <= 4 &&
            Math.abs(g - want.g) <= 4 &&
            Math.abs(b - want.b) <= 4,
          `stripe ${i}: got rgb(${r},${g},${b}), want rgb(${want.r},${want.g},${want.b})`,
        );
      }
    } finally {
      await page.close();
    }
  });

  test('stitchFullPage short-circuits to a single capture when page fits in one viewport', async () => {
    const page = await newPage();
    try {
      await page.setViewportSize({ width: 400, height: 300 });
      await page.setContent(`<!doctype html>
<html><body style="margin:0">
  <div style="height:100px;background:#abcdef"></div>
</body></html>`);
      const buf = await stitchFullPage(page);
      const png = PNG.sync.read(buf);
      const dpr = await page.evaluate(() => window.devicePixelRatio || 1);
      // A single capture returns a viewport-sized PNG (height = 300 css px).
      assert.equal(png.width, 400 * dpr);
      assert.equal(png.height, 300 * dpr);
    } finally {
      await page.close();
    }
  });
});

describe('visual-capture — stableScreenshot', () => {
  test('stableScreenshot returns a non-empty PNG and applies defaults', async () => {
    const page = await newPage();
    try {
      await page.setViewportSize({ width: 400, height: 300 });
      await page.setContent(
        `<!doctype html><html><body style="background:#123456;margin:0">hi</body></html>`,
      );
      const buf = await stableScreenshot(page);
      assert.ok(buf.length > 0, 'non-empty buffer');
      const png = PNG.sync.read(buf);
      assert.ok(png.width > 0 && png.height > 0, 'decodable PNG');
      // Freeze stylesheet should have been injected by default.
      const freezeStyles = await page.evaluate(() =>
        document.querySelectorAll('style[data-uxinspect="freeze"]').length,
      );
      assert.equal(freezeStyles, 1, 'freeze stylesheet present by default');
    } finally {
      await page.close();
    }
  });

  test('prepareCapture with all flags off skips injection and scrolling', async () => {
    const page = await newPage();
    try {
      await page.setContent(
        `<!doctype html><html><body><div style="height:2000px"></div></body></html>`,
      );
      await page.evaluate(() => window.scrollTo(0, 500));
      await prepareCapture(page, {
        freezeAnimations: false,
        waitFonts: false,
        autoScrollLazy: false,
        stitch: false,
      });
      // No freeze style injected.
      const styles = await page.evaluate(() =>
        document.querySelectorAll('style[data-uxinspect="freeze"]').length,
      );
      assert.equal(styles, 0, 'no freeze style when disabled');
      // Scroll not reset.
      const y = await page.evaluate(() => window.scrollY);
      assert.equal(y, 500, 'scroll position untouched when autoScrollLazy off');
    } finally {
      await page.close();
    }
  });
});
