import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import type { Page } from 'playwright';
import type { VisualResult } from './types.js';
import type { BaselineStore } from './store.js';
import { ssimFromBuffers } from './visual-ssim.js';

export type VisualAlgorithm = 'pixelmatch' | 'ssim';

export interface IgnoreRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface VisualOptions {
  baselineDir: string;
  outputDir: string;
  threshold?: number;
  failRatio?: number;
  store?: BaselineStore;
  algorithm?: VisualAlgorithm;
  ssimThreshold?: number;
  aaTolerance?: number;
  ignoreRegions?: IgnoreRegion[];
}

function fillRegionsBlack(png: PNG, regions: IgnoreRegion[]): void {
  const { width, height, data } = png;
  for (const raw of regions) {
    const x0 = Math.max(0, Math.floor(raw.x));
    const y0 = Math.max(0, Math.floor(raw.y));
    const x1 = Math.min(width, Math.floor(raw.x + raw.w));
    const y1 = Math.min(height, Math.floor(raw.y + raw.h));
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const idx = (y * width + x) << 2;
        data[idx] = 0;
        data[idx + 1] = 0;
        data[idx + 2] = 0;
        data[idx + 3] = 255;
      }
    }
  }
}

function clampAaTolerance(raw: number | undefined): number {
  if (raw === undefined || Number.isNaN(raw)) return 0.1;
  const t = Math.max(0, Math.min(100, raw));
  return t / 100;
}

export async function checkVisual(
  page: Page,
  name: string,
  viewport: string,
  opts: VisualOptions,
): Promise<VisualResult> {
  const baselinePath = path.join(opts.baselineDir, `${name}-${viewport}.png`);
  const currentPath = path.join(opts.outputDir, 'current', `${name}-${viewport}.png`);
  const diffPath = path.join(opts.outputDir, 'diff', `${name}-${viewport}.png`);
  const algorithm: VisualAlgorithm = opts.algorithm ?? 'pixelmatch';
  const regions = opts.ignoreRegions ?? [];

  await fs.mkdir(path.dirname(currentPath), { recursive: true });
  await fs.mkdir(path.dirname(diffPath), { recursive: true });
  await fs.mkdir(opts.baselineDir, { recursive: true });

  await page.screenshot({ path: currentPath, fullPage: true });
  const currentBytes = await fs.readFile(currentPath);
  const storeKey = `${name}-${viewport}.png`;

  let baselineBytes: Buffer | null = null;
  if (opts.store) {
    baselineBytes = await opts.store.read(storeKey).catch(() => null);
  }
  if (!baselineBytes && (await fileExists(baselinePath))) {
    baselineBytes = await fs.readFile(baselinePath);
  }
  if (!baselineBytes) {
    await fs.writeFile(baselinePath, currentBytes);
    if (opts.store) await opts.store.write(storeKey, currentBytes).catch(() => {});
    return {
      page: page.url(),
      viewport,
      baseline: baselinePath,
      current: currentPath,
      diffPixels: 0,
      diffRatio: 0,
      passed: true,
      algorithm,
      ssim: algorithm === 'ssim' ? 1 : undefined,
    };
  }
  await fs.writeFile(baselinePath, baselineBytes);

  const baseline = PNG.sync.read(baselineBytes);
  const current = PNG.sync.read(currentBytes);
  const { width, height } = baseline;

  if (current.width !== width || current.height !== height) {
    return {
      page: page.url(),
      viewport,
      baseline: baselinePath,
      current: currentPath,
      diffPixels: width * height,
      diffRatio: 1,
      passed: false,
      algorithm,
      ssim: algorithm === 'ssim' ? 0 : undefined,
    };
  }

  if (regions.length) {
    fillRegionsBlack(baseline, regions);
    fillRegionsBlack(current, regions);
  }

  if (algorithm === 'ssim') {
    const baselineBuf = PNG.sync.write(baseline);
    const currentBuf = PNG.sync.write(current);
    const ssimThreshold = opts.ssimThreshold ?? 0.95;
    const { mssim } = await ssimFromBuffers(baselineBuf, currentBuf);
    const total = width * height;
    const similarityLoss = Math.max(0, 1 - mssim);
    const diffPixels = Math.round(similarityLoss * total);
    const diff = new PNG({ width, height });
    // Overlay diff: visualize changed regions by highlighting where baseline and current differ in grayscale
    for (let i = 0; i < baseline.data.length; i += 4) {
      const dr = Math.abs(baseline.data[i] - current.data[i]);
      const dg = Math.abs(baseline.data[i + 1] - current.data[i + 1]);
      const db = Math.abs(baseline.data[i + 2] - current.data[i + 2]);
      const d = Math.min(255, dr + dg + db);
      diff.data[i] = d;
      diff.data[i + 1] = 0;
      diff.data[i + 2] = 0;
      diff.data[i + 3] = d > 0 ? 200 : 255;
    }
    await fs.writeFile(diffPath, PNG.sync.write(diff));

    return {
      page: page.url(),
      viewport,
      baseline: baselinePath,
      current: currentPath,
      diff: diffPath,
      diffPixels,
      diffRatio: similarityLoss,
      passed: mssim >= ssimThreshold,
      algorithm,
      ssim: mssim,
    };
  }

  const diff = new PNG({ width, height });
  const aaThreshold = opts.aaTolerance !== undefined
    ? clampAaTolerance(opts.aaTolerance)
    : (opts.threshold ?? 0.1);
  const diffPixels = pixelmatch(baseline.data, current.data, diff.data, width, height, {
    threshold: aaThreshold,
    includeAA: false,
  });
  await fs.writeFile(diffPath, PNG.sync.write(diff));

  const total = width * height;
  const ratio = diffPixels / total;
  const failRatio = opts.failRatio ?? 0.001;

  return {
    page: page.url(),
    viewport,
    baseline: baselinePath,
    current: currentPath,
    diff: diffPath,
    diffPixels,
    diffRatio: ratio,
    passed: ratio < failRatio,
    algorithm,
  };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
