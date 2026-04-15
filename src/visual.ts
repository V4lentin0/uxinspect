import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import type { Page } from 'playwright';
import type { VisualDiffConfig, VisualIgnoreRegion, VisualResult } from './types.js';
import type { BaselineStore } from './store.js';
import { ssimFromBuffers } from './visual-ssim.js';
import { applyMaskToPng, resolveMaskRegions, type MaskRegion, type Rect } from './visual-mask.js';
import {
  prepareCapture,
  stitchFullPage,
  resolveCaptureOptions,
  type CaptureOptions,
} from './visual-capture.js';

export interface VisualOptions {
  baselineDir: string;
  outputDir: string;
  /** Pixelmatch colour-distance threshold (0..1). Legacy field, superseded by `diff.threshold`. */
  threshold?: number;
  /** Ratio above which pixelmatch fails. Legacy field, superseded by `diff.failRatio`. */
  failRatio?: number;
  store?: BaselineStore;
  /** Visual diff configuration (P2 #23). Backwards compatible when omitted. */
  diff?: VisualDiffConfig;
  /** P2 #24 — freeze animations / wait fonts / auto-scroll / stitch. */
  captureOptions?: CaptureOptions;
}

function normaliseRegion(r: VisualIgnoreRegion): MaskRegion {
  if ('selector' in r) return { selector: r.selector };
  if ('width' in r && 'height' in r) {
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }
  return { x: r.x, y: r.y, width: r.w, height: r.h };
}

async function resolveIgnoreRects(
  page: Page,
  regions: VisualIgnoreRegion[] | undefined,
): Promise<Rect[]> {
  if (!regions || regions.length === 0) return [];
  return resolveMaskRegions(page, regions.map(normaliseRegion));
}

function parseColor(input: string | undefined): { r: number; g: number; b: number } | undefined {
  if (!input) return undefined;
  const hex = input.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const v = hex[1];
    if (v.length === 3) {
      return {
        r: parseInt(v[0] + v[0], 16),
        g: parseInt(v[1] + v[1], 16),
        b: parseInt(v[2] + v[2], 16),
      };
    }
    return {
      r: parseInt(v.slice(0, 2), 16),
      g: parseInt(v.slice(2, 4), 16),
      b: parseInt(v.slice(4, 6), 16),
    };
  }
  const rgb = input.trim().match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgb) {
    return {
      r: Math.min(255, parseInt(rgb[1], 10)),
      g: Math.min(255, parseInt(rgb[2], 10)),
      b: Math.min(255, parseInt(rgb[3], 10)),
    };
  }
  return undefined;
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

  const diffCfg: VisualDiffConfig = opts.diff ?? {};
  const algorithm = diffCfg.algorithm ?? 'pixelmatch';

  // P2 #24 — stabilise capture (freeze animations / wait fonts / auto-scroll / stitch)
  // before we snapshot so the diff is deterministic.
  const resolved = resolveCaptureOptions(opts.captureOptions);
  await prepareCapture(page, resolved);
  let rawCurrent: Buffer;
  if (resolved.stitch) {
    rawCurrent = await stitchFullPage(page);
  } else {
    rawCurrent = await page.screenshot({ fullPage: true });
  }

  // P2 #23 — apply ignore-region masks before writing current + before diffing.
  const ignoreRects = await resolveIgnoreRects(page, diffCfg.ignoreRegions);
  const maskColor = parseColor(diffCfg.maskColor);
  const currentBytes = ignoreRects.length > 0
    ? applyMaskToPng(rawCurrent, ignoreRects, maskColor)
    : rawCurrent;
  await fs.writeFile(currentPath, currentBytes);
  const storeKey = `${name}-${viewport}.png`;

  let baselineBytes: Buffer | null = null;
  if (opts.store) {
    baselineBytes = await opts.store.read(storeKey).catch(() => null);
  }
  if (!baselineBytes && (await fileExists(baselinePath))) {
    baselineBytes = await fs.readFile(baselinePath);
  }
  if (!baselineBytes) {
    // First run: persist the masked current as the new baseline.
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
      algorithm: algorithm === 'ssim' ? 'ssim' : undefined,
    };
  }

  // Mask the baseline with the same regions so the diff is apples-to-apples.
  const maskedBaselineBytes = ignoreRects.length > 0
    ? applyMaskToPng(baselineBytes, ignoreRects, maskColor)
    : baselineBytes;
  await fs.writeFile(baselinePath, baselineBytes);

  const baseline = PNG.sync.read(maskedBaselineBytes);
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
      algorithm: algorithm === 'ssim' ? 'ssim' : undefined,
    };
  }

  if (algorithm === 'ssim') {
    const windowSize = Math.max(
      2,
      Math.round(diffCfg.antialiasTolerance ?? 11),
    );
    const ssim = await ssimFromBuffers(maskedBaselineBytes, currentBytes, { windowSize });
    const threshold = diffCfg.ssimThreshold ?? 0.98;
    const passed = ssim.mssim >= threshold;
    return {
      page: page.url(),
      viewport,
      baseline: baselinePath,
      current: currentPath,
      diffPixels: ssim.changedRegions,
      diffRatio: Math.max(0, 1 - ssim.mssim),
      passed,
      algorithm: 'ssim',
      ssim: ssim.mssim,
      changedRegions: ssim.changedRegions,
    };
  }

  // Pixelmatch path (default). `antialiasTolerance` (if provided) overrides the legacy threshold.
  const diff = new PNG({ width, height });
  const pxThreshold = diffCfg.antialiasTolerance ?? diffCfg.threshold ?? opts.threshold ?? 0.1;
  const diffPixels = pixelmatch(baseline.data, current.data, diff.data, width, height, {
    threshold: pxThreshold,
  });
  await fs.writeFile(diffPath, PNG.sync.write(diff));

  const total = width * height;
  const ratio = total > 0 ? diffPixels / total : 0;
  const failRatio = diffCfg.failRatio ?? opts.failRatio ?? 0.001;

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
