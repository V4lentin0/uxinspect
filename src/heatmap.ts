import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';

export interface HeatmapResult {
  url: string;
  svgPath: string;
  totalInteractive: number;
  clicked: number;
  percent: number;
}

export interface InteractiveBox {
  x: number;
  y: number;
  width: number;
  height: number;
  key: string;
  clicked: boolean;
}

/**
 * Build a stable identity key for an interactive element. Mirrors the key
 * format produced in explore.ts so sets of "clicked" keys can be matched.
 */
export async function computeElementKey(loc: import('playwright').Locator): Promise<string> {
  return loc
    .evaluate((el) => {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : '';
      const cls =
        el.className && typeof el.className === 'string' ? `.${el.className.slice(0, 40)}` : '';
      const txt = (el.textContent ?? '').trim().slice(0, 40);
      const href = (el as HTMLAnchorElement).href ?? '';
      return `${tag}${id}${cls}|${txt}|${href}`;
    })
    .catch(() => '');
}

function slugify(url: string): string {
  try {
    const u = new URL(url);
    const s = `${u.host}${u.pathname}`.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
    return (s || 'page').slice(0, 120).toLowerCase();
  } catch {
    return url.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 120).toLowerCase() || 'page';
  }
}

function escapeXml(s: string): string {
  return (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function collectInteractiveBoxes(
  page: Page,
  clickedSelectors: Set<string>,
): Promise<InteractiveBox[]> {
  const locators = await page
    .locator('button:visible, a:visible, [role="button"]:visible')
    .all()
    .catch(() => [] as import('playwright').Locator[]);

  const boxes: InteractiveBox[] = [];
  for (const loc of locators) {
    const key = await computeElementKey(loc);
    if (!key) continue;
    const box = await loc.boundingBox().catch(() => null);
    if (!box || box.width <= 0 || box.height <= 0) continue;
    boxes.push({
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      key,
      clicked: clickedSelectors.has(key),
    });
  }
  return boxes;
}

/**
 * Render an SVG heatmap overlaying clicked (green) vs untested (red)
 * interactive elements on top of a screenshot of the page.
 *
 * Saves to `.uxinspect/heatmaps/<page-slug>.svg` by default.
 */
export async function generateExploreHeatmap(
  page: Page,
  clickedSelectors: Set<string>,
  screenshotPath: string,
  opts: { outDir?: string } = {},
): Promise<HeatmapResult> {
  const outDir = opts.outDir ?? path.join(process.cwd(), '.uxinspect', 'heatmaps');
  await fs.mkdir(outDir, { recursive: true });

  const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
  const boxes = await collectInteractiveBoxes(page, clickedSelectors);

  // Screenshot -> data URL background. Fall back to transparent bg on failure.
  let bgImg = '';
  try {
    let pngBuf: Buffer;
    const stat = await fs.stat(screenshotPath).catch(() => null);
    if (stat?.isFile()) {
      pngBuf = await fs.readFile(screenshotPath);
    } else {
      pngBuf = await page.screenshot({ fullPage: false, type: 'png' });
      await fs.mkdir(path.dirname(screenshotPath), { recursive: true }).catch(() => {});
      await fs.writeFile(screenshotPath, pngBuf).catch(() => {});
    }
    const dataUrl = `data:image/png;base64,${pngBuf.toString('base64')}`;
    bgImg = `<image href="${dataUrl}" x="0" y="0" width="${viewport.width}" height="${viewport.height}" preserveAspectRatio="xMidYMid slice" />`;
  } catch {
    // no screenshot available — continue with blank bg
  }

  const clickedCount = boxes.filter((b) => b.clicked).length;
  const total = boxes.length;
  const percent = total === 0 ? 0 : Math.round((clickedCount / total) * 1000) / 10;

  const rects = boxes
    .map((b) => {
      const fill = b.clicked ? '#10B981' : '#EF4444';
      const stroke = b.clicked ? '#059669' : '#B91C1C';
      return `<rect x="${b.x.toFixed(1)}" y="${b.y.toFixed(1)}" width="${b.width.toFixed(1)}" height="${b.height.toFixed(1)}" fill="${fill}" fill-opacity="0.35" stroke="${stroke}" stroke-width="1.5"><title>${escapeXml(b.key)}</title></rect>`;
    })
    .join('');

  const legend = `
    <g font-family="Inter, system-ui, sans-serif" font-size="12">
      <rect x="12" y="12" width="200" height="58" rx="6" ry="6" fill="#FFFFFF" fill-opacity="0.92" stroke="#E5E7EB" />
      <rect x="22" y="22" width="12" height="12" fill="#10B981" fill-opacity="0.6" stroke="#059669" />
      <text x="40" y="32" fill="#1D1D1F">Clicked ${clickedCount}/${total} (${percent}%)</text>
      <rect x="22" y="46" width="12" height="12" fill="#EF4444" fill-opacity="0.6" stroke="#B91C1C" />
      <text x="40" y="56" fill="#1D1D1F">Untested ${total - clickedCount}</text>
    </g>`;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewport.width} ${viewport.height}" width="${viewport.width}" height="${viewport.height}">
  ${bgImg}
  ${rects}
  ${legend}
</svg>
`;

  const slug = slugify(page.url());
  const svgPath = path.join(outDir, `${slug}.svg`);
  await fs.writeFile(svgPath, svg, 'utf8');

  return { url: page.url(), svgPath, totalInteractive: total, clicked: clickedCount, percent };
}
