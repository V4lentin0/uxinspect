import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { ssimFromBuffers } from './visual-ssim.js';

// Render many anti-aliased lines (simulates rendered text) so AA drift is widespread.
function drawBase(width: number, height: number): PNG {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) << 2;
      png.data[idx] = 245;
      png.data[idx + 1] = 245;
      png.data[idx + 2] = 245;
      png.data[idx + 3] = 255;
    }
  }
  // Many diagonal AA'd lines — every edge pixel gets AA'd gray.
  for (let j = 0; j < height; j += 6) {
    for (let i = 0; i < width; i += 1) {
      const yExact = j + i * 0.3;
      const y0 = Math.floor(yExact);
      const frac = yExact - y0;
      for (const [yy, blend] of [[y0, 1 - frac], [y0 + 1, frac]] as [number, number][]) {
        if (yy < 0 || yy >= height) continue;
        const idx = (yy * width + i) << 2;
        const v = Math.round(245 - 220 * blend);
        png.data[idx] = v;
        png.data[idx + 1] = v;
        png.data[idx + 2] = v;
      }
    }
  }
  return png;
}

// Only perturb pixels on edges (where there's luminance change) — mimics AA re-render drift.
function addAaNoise(src: PNG): PNG {
  const { width, height, data } = src;
  const out = new PNG({ width, height });
  out.data = Buffer.from(data);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) << 2;
      const up = ((y - 1) * width + x) << 2;
      const dn = ((y + 1) * width + x) << 2;
      // If this pixel is near an edge (neighbours differ), nudge it toward neighbour
      const diff = Math.abs(data[up] - data[dn]);
      if (diff > 30) {
        // Small 20% drift toward neighbour (sub-pixel feel)
        out.data[idx] = Math.round(data[idx] * 0.8 + data[up] * 0.2);
        out.data[idx + 1] = Math.round(data[idx + 1] * 0.8 + data[up + 1] * 0.2);
        out.data[idx + 2] = Math.round(data[idx + 2] * 0.8 + data[up + 2] * 0.2);
      }
    }
  }
  return out;
}

describe('visual diff algorithms', () => {
  test('SSIM is more lenient than pixelmatch on sub-pixel shift / anti-alias noise', async () => {
    const w = 120;
    const h = 120;
    const baseline = drawBase(w, h);
    const current = addAaNoise(baseline);

    // pixelmatch with a strict threshold flags every edge pixel that shifted.
    const diff = new PNG({ width: w, height: h });
    const pxDiff = pixelmatch(baseline.data, current.data, diff.data, w, h, { threshold: 0.01 });
    const pxRatio = pxDiff / (w * h);
    // default visual.ts failRatio is 0.001 — an AA shift at tight threshold blows past it
    const pixelmatchPasses = pxRatio < 0.001;

    // SSIM should score high (near 1) on a sub-pixel shifted image
    const { mssim } = await ssimFromBuffers(
      PNG.sync.write(baseline),
      PNG.sync.write(current),
    );
    const ssimPasses = mssim >= 0.95;

    // pixelmatch (strict) flags the diff
    assert.ok(pxDiff > 0, `pixelmatch should flag AA diffs, got ${pxDiff}`);
    // With the default failRatio, pixelmatch fails while SSIM at 0.95 passes
    assert.equal(
      pixelmatchPasses,
      false,
      `pixelmatch at strict threshold should fail AA shift, pxRatio=${pxRatio}`,
    );
    assert.equal(
      ssimPasses,
      true,
      `SSIM at 0.95 threshold should pass AA shift, mssim=${mssim}`,
    );
  });

  test('pixelmatch aaTolerance + ignoreRegions wiring compiles + runs end-to-end', async () => {
    const { checkVisual } = await import('./visual.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-visual-'));
    const baselineDir = path.join(dir, 'baselines');
    const outputDir = path.join(dir, 'out');
    await fs.mkdir(baselineDir, { recursive: true });
    await fs.mkdir(path.join(outputDir, 'current'), { recursive: true });

    // Fake page stub — only page.url() + page.screenshot() are used
    const pngBuf = PNG.sync.write(drawBase(60, 60));
    let screenshotCalls = 0;
    const fakePage: any = {
      url: () => 'about:blank',
      screenshot: async (opts: { path: string }) => {
        screenshotCalls += 1;
        await fs.writeFile(opts.path, pngBuf);
        return pngBuf;
      },
    };

    // First call creates a baseline (no comparison yet).
    const first = await checkVisual(fakePage, 'home', 'desktop', {
      baselineDir,
      outputDir,
      algorithm: 'pixelmatch',
      aaTolerance: 10,
      ignoreRegions: [{ x: 10, y: 10, w: 20, h: 20 }],
    });
    assert.equal(first.passed, true);
    assert.equal(first.algorithm, 'pixelmatch');
    assert.ok(screenshotCalls === 1);

    // Second call compares against baseline — identical pixels → zero diff.
    const second = await checkVisual(fakePage, 'home', 'desktop', {
      baselineDir,
      outputDir,
      algorithm: 'pixelmatch',
      aaTolerance: 10,
      ignoreRegions: [{ x: 10, y: 10, w: 20, h: 20 }],
    });
    assert.equal(second.passed, true);
    assert.equal(second.diffPixels, 0);
    assert.equal(second.algorithm, 'pixelmatch');

    // SSIM branch: create a baseline + compare
    const ssimRun = await checkVisual(fakePage, 'home2', 'desktop', {
      baselineDir,
      outputDir,
      algorithm: 'ssim',
      ssimThreshold: 0.9,
    });
    assert.equal(ssimRun.algorithm, 'ssim');

    const ssimRun2 = await checkVisual(fakePage, 'home2', 'desktop', {
      baselineDir,
      outputDir,
      algorithm: 'ssim',
      ssimThreshold: 0.9,
    });
    assert.equal(ssimRun2.algorithm, 'ssim');
    assert.ok((ssimRun2.ssim ?? 0) >= 0.9);
    assert.equal(ssimRun2.passed, true);

    await fs.rm(dir, { recursive: true });
  });
});
