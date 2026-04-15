import type { Page } from 'playwright';

export interface StabilizeOptions {
  freezeAnimations?: boolean;
  waitForFonts?: boolean;
  scrollLazyLoad?: boolean;
  stitchFullPage?: boolean;
  scrollStep?: number;
  scrollDelayMs?: number;
}

const FREEZE_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  animation-iteration-count: 1 !important;
  animation-play-state: paused !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  scroll-behavior: auto !important;
  caret-color: transparent !important;
}
video, audio { visibility: hidden !important; }
`;

export async function stabilizePageForCapture(
  page: Page,
  opts: StabilizeOptions = {},
): Promise<void> {
  const {
    freezeAnimations = true,
    waitForFonts = true,
    scrollLazyLoad = true,
    stitchFullPage = false,
    scrollStep = 200,
    scrollDelayMs = 100,
  } = opts;

  if (freezeAnimations) {
    await page
      .addStyleTag({ content: FREEZE_CSS })
      .catch(() => {});
    await page
      .evaluate(() => {
        try {
          const anims =
            typeof (document as Document & { getAnimations?: () => Animation[] }).getAnimations ===
            'function'
              ? (document as Document & { getAnimations: () => Animation[] }).getAnimations()
              : [];
          for (const a of anims) {
            try {
              a.pause();
              if (a.effect && 'updateTiming' in a.effect) {
                (a.effect as KeyframeEffect).updateTiming({ duration: 0 });
              }
            } catch {
              /* ignore */
            }
          }
          const imgs = document.querySelectorAll('img');
          imgs.forEach((img) => {
            const el = img as HTMLImageElement;
            const src = el.currentSrc || el.src;
            if (!src) return;
            if (/\.gif(\?|$)/i.test(src) || /\.webp(\?|$)/i.test(src) || /\.apng(\?|$)/i.test(src)) {
              try {
                const canvas = document.createElement('canvas');
                canvas.width = el.naturalWidth || el.width || 1;
                canvas.height = el.naturalHeight || el.height || 1;
                const ctx = canvas.getContext('2d');
                if (ctx && el.complete && el.naturalWidth > 0) {
                  ctx.drawImage(el, 0, 0);
                  try {
                    el.src = canvas.toDataURL('image/png');
                  } catch {
                    /* ignore tainted canvas */
                  }
                }
              } catch {
                /* ignore */
              }
            }
          });
        } catch {
          /* ignore */
        }
      })
      .catch(() => {});
  }

  if (waitForFonts) {
    await page
      .evaluate(async () => {
        try {
          if (
            'fonts' in document &&
            (document as Document & { fonts: { ready: Promise<unknown> } }).fonts
          ) {
            await (document as Document & { fonts: { ready: Promise<unknown> } }).fonts.ready;
          }
        } catch {
          /* ignore */
        }
      })
      .catch(() => {});
  }

  if (scrollLazyLoad) {
    await page
      .evaluate(
        async ({ step, delay }) => {
          const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
          const maxHeight = Math.max(
            document.body.scrollHeight,
            document.documentElement.scrollHeight,
          );
          let y = 0;
          while (y < maxHeight) {
            window.scrollTo(0, y);
            await sleep(delay);
            y += step;
          }
          window.scrollTo(0, maxHeight);
          await sleep(delay);
          window.scrollTo(0, 0);
          await sleep(delay);
          const imgs = Array.from(document.querySelectorAll('img'));
          await Promise.all(
            imgs.map((img) => {
              const el = img as HTMLImageElement;
              if (el.complete) return Promise.resolve();
              return new Promise<void>((resolve) => {
                const done = () => resolve();
                el.addEventListener('load', done, { once: true });
                el.addEventListener('error', done, { once: true });
                setTimeout(done, 2000);
              });
            }),
          );
        },
        { step: scrollStep, delay: scrollDelayMs },
      )
      .catch(() => {});
  }

  if (stitchFullPage) {
    // Force consistent layout: set viewport scroll to 0 and expand body for
    // fullPage capture. Actual stitching happens in captureStitchedScreenshot.
    await page
      .evaluate(() => {
        window.scrollTo(0, 0);
      })
      .catch(() => {});
  }
}

export interface StitchOptions {
  path?: string;
  chunkHeight?: number;
}

/**
 * Scroll-and-stitch capture for pages where Playwright's fullPage capture
 * misses sticky/fixed layouts. Captures the viewport in sequential chunks
 * and composes a single PNG.
 */
export async function captureStitchedScreenshot(
  page: Page,
  opts: StitchOptions = {},
): Promise<Buffer> {
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  const chunk = opts.chunkHeight ?? viewport.height;

  const total = await page.evaluate(() => {
    return Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight,
      document.body.offsetHeight,
      document.documentElement.offsetHeight,
    );
  });

  const { PNG } = await import('pngjs');
  const full = new PNG({ width: viewport.width, height: total });

  let y = 0;
  while (y < total) {
    await page.evaluate((scrollY) => window.scrollTo(0, scrollY), y);
    await page.waitForTimeout(50);
    const remaining = total - y;
    const h = Math.min(chunk, remaining);
    const buf = await page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width: viewport.width, height: h },
    });
    const part = PNG.sync.read(buf);
    // Copy part rows into composed image starting at row y
    for (let row = 0; row < part.height; row++) {
      const srcStart = row * part.width * 4;
      const dstStart = (y + row) * full.width * 4;
      const rowBytes = Math.min(part.width, full.width) * 4;
      part.data.copy(full.data, dstStart, srcStart, srcStart + rowBytes);
    }
    y += chunk;
  }

  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  const out = PNG.sync.write(full);
  if (opts.path) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(opts.path, out);
  }
  return out;
}
