import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

export interface SsimResult {
  page: string;
  viewport: string;
  baseline: string;
  current: string;
  diff?: string;
  ssim: number;
  mssim: number;
  changedRegions: number;
  passed: boolean;
}

interface RawImage {
  width: number;
  height: number;
  data: Buffer;
}

interface WindowStats {
  ssim: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

const K1 = 0.01;
const K2 = 0.03;
const L = 255;
const C1 = (K1 * L) * (K1 * L);
const C2 = (K2 * L) * (K2 * L);
const REGION_THRESHOLD = 0.9;

function toGrayscale(img: RawImage): Float64Array {
  const { width, height, data } = img;
  const out = new Float64Array(width * height);
  for (let i = 0, p = 0; p < width * height; p += 1, i += 4) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    out[p] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return out;
}

function computeWindow(
  a: Float64Array, b: Float64Array, width: number,
  x0: number, y0: number, w: number, h: number,
): number {
  const n = w * h;
  let sumA = 0, sumB = 0;
  for (let y = 0; y < h; y += 1) {
    const row = (y0 + y) * width + x0;
    for (let x = 0; x < w; x += 1) { sumA += a[row + x] ?? 0; sumB += b[row + x] ?? 0; }
  }
  const mA = sumA / n;
  const mB = sumB / n;
  let varA = 0, varB = 0, cov = 0;
  for (let y = 0; y < h; y += 1) {
    const row = (y0 + y) * width + x0;
    for (let x = 0; x < w; x += 1) {
      const va = (a[row + x] ?? 0) - mA;
      const vb = (b[row + x] ?? 0) - mB;
      varA += va * va; varB += vb * vb; cov += va * vb;
    }
  }
  varA /= n; varB /= n; cov /= n;
  const num = (2 * mA * mB + C1) * (2 * cov + C2);
  const den = (mA * mA + mB * mB + C1) * (varA + varB + C2);
  return den === 0 ? 1 : num / den;
}

function ssimWindows(
  a: Float64Array, b: Float64Array, width: number, height: number, windowSize: number,
): WindowStats[] {
  const stats: WindowStats[] = [];
  for (let y = 0; y + windowSize <= height; y += windowSize) {
    for (let x = 0; x + windowSize <= width; x += windowSize) {
      stats.push({ ssim: computeWindow(a, b, width, x, y, windowSize, windowSize), x, y, w: windowSize, h: windowSize });
    }
  }
  return stats;
}

function summarize(stats: WindowStats[]): { mssim: number; changedRegions: number } {
  if (stats.length === 0) return { mssim: 1, changedRegions: 0 };
  let total = 0, changed = 0;
  for (const s of stats) { total += s.ssim; if (s.ssim < REGION_THRESHOLD) changed += 1; }
  return { mssim: total / stats.length, changedRegions: changed };
}

function writeOverlay(
  current: RawImage,
  stats: WindowStats[],
  outPath: string,
): void {
  const { width, height, data } = current;
  const overlay = new PNG({ width, height });
  overlay.data = Buffer.from(data);
  for (const s of stats) {
    if (s.ssim >= REGION_THRESHOLD) continue;
    for (let y = s.y; y < s.y + s.h && y < height; y += 1) {
      for (let x = s.x; x < s.x + s.w && x < width; x += 1) {
        const idx = (y * width + x) * 4;
        const alpha = 120 / 255;
        overlay.data[idx] = Math.round((overlay.data[idx] ?? 0) * (1 - alpha) + 255 * alpha);
        overlay.data[idx + 1] = Math.round((overlay.data[idx + 1] ?? 0) * (1 - alpha));
        overlay.data[idx + 2] = Math.round((overlay.data[idx + 2] ?? 0) * (1 - alpha));
        overlay.data[idx + 3] = 255;
      }
    }
  }
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, PNG.sync.write(overlay));
}

export async function compareSsim(opts: {
  baselinePath: string;
  currentPath: string;
  diffPath?: string;
  threshold?: number;
  windowSize?: number;
}): Promise<SsimResult> {
  const threshold = opts.threshold ?? 0.95;
  const windowSize = opts.windowSize ?? 11;
  const base: SsimResult = {
    page: '',
    viewport: '',
    baseline: opts.baselinePath,
    current: opts.currentPath,
    diff: opts.diffPath,
    ssim: 0,
    mssim: 0,
    changedRegions: 0,
    passed: false,
  };
  try {
    const baselineImg = PNG.sync.read(readFileSync(opts.baselinePath));
    const currentImg = PNG.sync.read(readFileSync(opts.currentPath));
    if (baselineImg.width !== currentImg.width || baselineImg.height !== currentImg.height) {
      return {
        ...base,
        page: `dimension mismatch ${baselineImg.width}x${baselineImg.height} vs ${currentImg.width}x${currentImg.height}`,
      };
    }
    const grayA = toGrayscale(baselineImg);
    const grayB = toGrayscale(currentImg);
    const stats = ssimWindows(grayA, grayB, baselineImg.width, baselineImg.height, windowSize);
    const { mssim, changedRegions } = summarize(stats);
    if (opts.diffPath) {
      writeOverlay(currentImg, stats, opts.diffPath);
    }
    return {
      ...base,
      ssim: mssim,
      mssim,
      changedRegions,
      passed: mssim >= threshold,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unreadable image';
    return { ...base, page: `error: ${msg}` };
  }
}

export async function ssimFromBuffers(
  a: Buffer,
  b: Buffer,
  opts?: { windowSize?: number },
): Promise<{ ssim: number; mssim: number; changedRegions: number }> {
  const windowSize = opts?.windowSize ?? 11;
  try {
    const imgA = PNG.sync.read(a);
    const imgB = PNG.sync.read(b);
    if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
      return { ssim: 0, mssim: 0, changedRegions: 0 };
    }
    const grayA = toGrayscale(imgA);
    const grayB = toGrayscale(imgB);
    const stats = ssimWindows(grayA, grayB, imgA.width, imgA.height, windowSize);
    const { mssim, changedRegions } = summarize(stats);
    return { ssim: mssim, mssim, changedRegions };
  } catch {
    return { ssim: 0, mssim: 0, changedRegions: 0 };
  }
}
