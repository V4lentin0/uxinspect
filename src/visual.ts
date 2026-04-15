import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import type { Page } from 'playwright';
import type { VisualResult } from './types.js';
import type { BaselineStore } from './store.js';
import {
  prepareCapture,
  stitchFullPage,
  resolveCaptureOptions,
  type CaptureOptions,
} from './visual-capture.js';

export interface VisualOptions {
  baselineDir: string;
  outputDir: string;
  threshold?: number;
  failRatio?: number;
  store?: BaselineStore;
  /** P2 #24 — freeze animations / wait fonts / auto-scroll / stitch. */
  captureOptions?: CaptureOptions;
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

  await fs.mkdir(path.dirname(currentPath), { recursive: true });
  await fs.mkdir(path.dirname(diffPath), { recursive: true });
  await fs.mkdir(opts.baselineDir, { recursive: true });

  const resolved = resolveCaptureOptions(opts.captureOptions);
  await prepareCapture(page, resolved);
  let currentBytes: Buffer;
  if (resolved.stitch) {
    currentBytes = await stitchFullPage(page);
    await fs.writeFile(currentPath, currentBytes);
  } else {
    await page.screenshot({ path: currentPath, fullPage: true });
    currentBytes = await fs.readFile(currentPath);
  }
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
    };
  }

  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(baseline.data, current.data, diff.data, width, height, {
    threshold: opts.threshold ?? 0.1,
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
