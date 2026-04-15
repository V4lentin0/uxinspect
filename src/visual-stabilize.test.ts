import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Driver } from './driver.js';
import { stabilizePageForCapture, captureStitchedScreenshot } from './visual-stabilize.js';

test('stabilizePageForCapture freezes CSS animations and transitions', async () => {
  const driver = new Driver();
  await driver.launch({ headless: true });
  const page = await driver.newPage();
  await page.setContent(`
    <html><head><style>
      @keyframes slide { from { transform: translateX(0); } to { transform: translateX(500px); } }
      .box { width: 100px; height: 100px; background: red;
             animation: slide 2s linear infinite;
             transition: opacity 3s ease; }
    </style></head><body>
      <div class="box" id="b"></div>
    </body></html>
  `);
  // Let at least one frame render so animation is active
  await page.waitForTimeout(50);
  await stabilizePageForCapture(page, {
    freezeAnimations: true,
    waitForFonts: false,
    scrollLazyLoad: false,
  });
  const result = await page.evaluate(() => {
    const el = document.getElementById('b')!;
    const cs = getComputedStyle(el);
    const anims = (document as Document & { getAnimations?: () => Animation[] })
      .getAnimations?.() ?? [];
    return {
      animationDuration: cs.animationDuration,
      transitionDuration: cs.transitionDuration,
      playState: cs.animationPlayState,
      anyRunning: anims.some((a) => a.playState === 'running'),
    };
  });
  assert.equal(result.animationDuration, '0s');
  assert.equal(result.transitionDuration, '0s');
  assert.equal(result.playState, 'paused');
  assert.equal(result.anyRunning, false);
  await driver.close();
});

test('stabilizePageForCapture resolves document.fonts.ready', async () => {
  const driver = new Driver();
  await driver.launch({ headless: true });
  const page = await driver.newPage();
  await page.setContent(`
    <html><body><p style="font-family: 'Inter', sans-serif;">Hello</p></body></html>
  `);
  const before = await page.evaluate(() => document.fonts.status);
  await stabilizePageForCapture(page, {
    freezeAnimations: false,
    waitForFonts: true,
    scrollLazyLoad: false,
  });
  const after = await page.evaluate(() => document.fonts.status);
  assert.ok(before === 'loaded' || before === 'loading');
  assert.equal(after, 'loaded');
  await driver.close();
});

test('stabilizePageForCapture scrolls lazy-loaded images into view', async () => {
  const driver = new Driver();
  await driver.launch({ headless: true });
  const page = await driver.newPage();
  // Build a tall page with a lazy-loaded image far below the fold using a
  // 1x1 data URI so no network is required.
  const tinyPng =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  await page.setContent(`
    <html><body style="margin:0">
      <div style="height: 4000px; background: #eee"></div>
      <img id="lazy"
           data-src="${tinyPng}"
           style="width: 50px; height: 50px"
           loading="lazy" />
      <script>
        const io = new IntersectionObserver((entries) => {
          for (const e of entries) {
            if (e.isIntersecting) {
              const img = e.target;
              img.src = img.dataset.src;
              io.unobserve(img);
            }
          }
        });
        io.observe(document.getElementById('lazy'));
      </script>
    </body></html>
  `);
  // Before stabilize: image has no src set yet because it's below viewport
  const initial = await page.evaluate(() => {
    const img = document.getElementById('lazy') as HTMLImageElement;
    return { src: img.src, complete: img.complete && img.naturalWidth > 0 };
  });
  assert.equal(initial.src, '');

  await stabilizePageForCapture(page, {
    freezeAnimations: false,
    waitForFonts: false,
    scrollLazyLoad: true,
    scrollStep: 400,
    scrollDelayMs: 30,
  });

  const final = await page.evaluate(() => {
    const img = document.getElementById('lazy') as HTMLImageElement;
    return { hasSrc: !!img.src, complete: img.complete && img.naturalWidth > 0 };
  });
  assert.equal(final.hasSrc, true);
  assert.equal(final.complete, true);
  await driver.close();
});

test('captureStitchedScreenshot produces PNG covering full document height', async () => {
  const driver = new Driver();
  await driver.launch({ headless: true });
  const page = await driver.newPage();
  await page.setViewportSize({ width: 400, height: 300 });
  await page.setContent(`
    <html><body style="margin:0">
      <div style="height: 900px; background: linear-gradient(#f00, #00f)"></div>
    </body></html>
  `);
  const buf = await captureStitchedScreenshot(page);
  const { PNG } = await import('pngjs');
  const png = PNG.sync.read(buf);
  assert.equal(png.width, 400);
  assert.ok(png.height >= 900, `expected height >=900, got ${png.height}`);
  await driver.close();
});

test('stabilizePageForCapture with all options does not throw on minimal page', async () => {
  const driver = new Driver();
  await driver.launch({ headless: true });
  const page = await driver.newPage();
  await page.setContent('<html><body><p>hi</p></body></html>');
  await stabilizePageForCapture(page);
  await driver.close();
});
