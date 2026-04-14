import { PNG } from 'pngjs';
import type { Page } from 'playwright';

export type MaskRegion =
  | { selector: string }
  | { x: number; y: number; width: number; height: number };

export interface MaskedScreenshotOptions {
  fullPage?: boolean;
  regions: MaskRegion[];
  color?: string;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

function isSelectorRegion(r: MaskRegion): r is { selector: string } {
  return typeof (r as { selector?: unknown }).selector === 'string';
}

function clipRectToZero(r: Rect): Rect {
  const x = Math.max(0, Math.floor(r.x));
  const y = Math.max(0, Math.floor(r.y));
  const width = Math.max(0, Math.ceil(r.width));
  const height = Math.max(0, Math.ceil(r.height));
  return { x, y, width, height };
}

function parseColor(input: string | undefined): RGB {
  if (!input) return { r: 0, g: 0, b: 0 };
  const trimmed = input.trim();
  const hex = trimmed.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
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
  const rgb = trimmed.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgb) {
    return {
      r: Math.min(255, parseInt(rgb[1], 10)),
      g: Math.min(255, parseInt(rgb[2], 10)),
      b: Math.min(255, parseInt(rgb[3], 10)),
    };
  }
  return { r: 0, g: 0, b: 0 };
}

export async function resolveMaskRegions(
  page: Page,
  regions: MaskRegion[],
): Promise<Rect[]> {
  const result: Rect[] = [];
  for (const region of regions) {
    if (isSelectorRegion(region)) {
      const rects = await page.evaluate((selector) => {
        const nodes = Array.from(document.querySelectorAll(selector));
        return nodes.map((node) => {
          const r = (node as Element).getBoundingClientRect();
          return {
            x: Math.floor(r.x + window.scrollX),
            y: Math.floor(r.y + window.scrollY),
            width: Math.ceil(r.width),
            height: Math.ceil(r.height),
          };
        });
      }, region.selector);
      for (const r of rects) result.push(clipRectToZero(r));
    } else {
      result.push(clipRectToZero(region));
    }
  }
  return result;
}

export function applyMaskToPng(
  pngBuffer: Buffer,
  rects: Rect[],
  color?: RGB,
): Buffer {
  const png = PNG.sync.read(pngBuffer);
  const { width, height, data } = png;
  const fill = color ?? { r: 0, g: 0, b: 0 };
  for (const raw of rects) {
    const rect = clipRectToZero(raw);
    const x0 = Math.min(rect.x, width);
    const y0 = Math.min(rect.y, height);
    const x1 = Math.min(rect.x + rect.width, width);
    const y1 = Math.min(rect.y + rect.height, height);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const idx = (width * y + x) << 2;
        data[idx] = fill.r;
        data[idx + 1] = fill.g;
        data[idx + 2] = fill.b;
        data[idx + 3] = 255;
      }
    }
  }
  return PNG.sync.write(png);
}

export async function takeMaskedScreenshot(
  page: Page,
  opts: MaskedScreenshotOptions,
): Promise<Buffer> {
  const raw = await page.screenshot({ fullPage: opts.fullPage ?? false });
  const rects = await resolveMaskRegions(page, opts.regions);
  const color = parseColor(opts.color);
  return applyMaskToPng(raw, rects, color);
}

export async function screenshotWithPlaywrightMask(
  page: Page,
  opts: { fullPage?: boolean; maskSelectors: string[] },
): Promise<Buffer> {
  const locators = opts.maskSelectors.map((sel) => page.locator(sel));
  return await page.screenshot({
    fullPage: opts.fullPage ?? false,
    mask: locators,
  });
}
