import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import type { Page } from 'playwright';
import type { VisualResult } from './types.js';

export interface VisualOptions {
  baselineDir: string;
  outputDir: string;
  threshold?: number;
  failRatio?: number;
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

  await page.screenshot({ path: currentPath, fullPage: true });

  const baselineExists = await fileExists(baselinePath);
  if (!baselineExists) {
    await fs.copyFile(currentPath, baselinePath);
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

  const baseline = PNG.sync.read(await fs.readFile(baselinePath));
  const current = PNG.sync.read(await fs.readFile(currentPath));
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
