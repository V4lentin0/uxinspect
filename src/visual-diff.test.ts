import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { ssimFromBuffers, compareSsim } from './visual-ssim.js';
import { applyMaskToPng } from './visual-mask.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Build a deterministic PNG so tests don't depend on real screenshots.
 * `mutate` lets us perturb pixels for the "slightly different" case.
 */
function buildPng(
  width: number,
  height: number,
  mutate?: (x: number, y: number) => [number, number, number] | null,
): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) << 2;
      // Base pattern: diagonal gradient so SSIM has real variance to measure.
      const base = ((x + y) * 3) & 0xff;
      const mutated = mutate ? mutate(x, y) : null;
      png.data[idx] = mutated ? mutated[0] : base;
      png.data[idx + 1] = mutated ? mutated[1] : base;
      png.data[idx + 2] = mutated ? mutated[2] : base;
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

test('ssimFromBuffers: identical images score 1.0', async () => {
  const a = buildPng(64, 64);
  const b = buildPng(64, 64);
  const result = await ssimFromBuffers(a, b, { windowSize: 8 });
  assert.equal(result.mssim, 1);
  assert.equal(result.changedRegions, 0);
});

test('ssimFromBuffers: near-identical images score above 0.98 threshold (P2 #23)', async () => {
  const baseline = buildPng(80, 80);
  // Perturb only a thin noise layer (+/- 1 on blue channel) to simulate JPEG-ish jitter.
  const current = buildPng(80, 80, (x, y) => {
    const base = ((x + y) * 3) & 0xff;
    const jitter = (x + y) % 2 === 0 ? 1 : -1;
    return [base, base, Math.max(0, Math.min(255, base + jitter))];
  });
  const result = await ssimFromBuffers(baseline, current, { windowSize: 8 });
  assert.ok(
    result.mssim > 0.98,
    `expected mssim > 0.98 for near-identical images, got ${result.mssim}`,
  );
});

test('ssimFromBuffers: very different images score well below threshold', async () => {
  const baseline = buildPng(64, 64);
  // Invert every pixel — totally different image.
  const current = buildPng(64, 64, (x, y) => {
    const base = ((x + y) * 3) & 0xff;
    return [255 - base, 255 - base, 255 - base];
  });
  const result = await ssimFromBuffers(baseline, current, { windowSize: 8 });
  assert.ok(
    result.mssim < 0.5,
    `expected mssim < 0.5 for inverted images, got ${result.mssim}`,
  );
});

test('ssimFromBuffers: dimension mismatch returns zero score', async () => {
  const a = buildPng(32, 32);
  const b = buildPng(48, 48);
  const result = await ssimFromBuffers(a, b);
  assert.equal(result.mssim, 0);
  assert.equal(result.ssim, 0);
});

test('applyMaskToPng: ignore-region rect is replaced with fill colour on both images', () => {
  // Baseline has a gradient; current has a red square where baseline has gradient.
  const baseline = buildPng(40, 40);
  const current = buildPng(40, 40, (x, y) => {
    if (x >= 10 && x < 30 && y >= 10 && y < 30) return [255, 0, 0];
    return null;
  });
  // Without masking, SSIM should drop because of the red square.
  // With masking of the exact same rect on both, they should be identical
  // in the comparison window => SSIM == 1.
  const rect = [{ x: 10, y: 10, width: 20, height: 20 }];
  const maskedBaseline = applyMaskToPng(baseline, rect);
  const maskedCurrent = applyMaskToPng(current, rect);
  const pngA = PNG.sync.read(maskedBaseline);
  const pngB = PNG.sync.read(maskedCurrent);
  // The masked regions should match byte-for-byte on both images.
  for (let y = 10; y < 30; y += 1) {
    for (let x = 10; x < 30; x += 1) {
      const idx = (y * 40 + x) << 2;
      assert.equal(pngA.data[idx], pngB.data[idx]);
      assert.equal(pngA.data[idx + 1], pngB.data[idx + 1]);
      assert.equal(pngA.data[idx + 2], pngB.data[idx + 2]);
    }
  }
});

test('compareSsim: reports pass when mssim >= threshold', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-ssim-'));
  const baselinePath = path.join(dir, 'baseline.png');
  const currentPath = path.join(dir, 'current.png');
  const diffPath = path.join(dir, 'diff.png');
  await fs.writeFile(baselinePath, buildPng(48, 48));
  await fs.writeFile(
    currentPath,
    buildPng(48, 48, (x, y) => {
      const base = ((x + y) * 3) & 0xff;
      const jitter = (x + y) % 2 === 0 ? 1 : -1;
      return [base, base, Math.max(0, Math.min(255, base + jitter))];
    }),
  );
  const result = await compareSsim({
    baselinePath,
    currentPath,
    diffPath,
    threshold: 0.95,
    windowSize: 8,
  });
  assert.equal(result.passed, true, `expected passed, got mssim=${result.mssim}`);
  assert.ok(result.mssim >= 0.95);
  await fs.rm(dir, { recursive: true, force: true });
});
