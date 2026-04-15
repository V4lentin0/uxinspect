import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium, type Browser } from 'playwright';
import {
  generateExploreHeatmap,
  collectInteractiveBoxes,
  computeElementKey,
  type HeatmapResult,
} from './heatmap.js';

async function withPage<T>(fn: (browser: Browser, page: import('playwright').Page) => Promise<T>): Promise<T> {
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
    const page = await ctx.newPage();
    return await fn(browser, page);
  } finally {
    await browser.close();
  }
}

function buildButtonsHtml(n: number): string {
  const buttons: string[] = [];
  for (let i = 0; i < n; i++) {
    buttons.push(
      `<button id="btn-${i}" style="display:block;margin:8px;width:120px;height:32px;">Button ${i}</button>`,
    );
  }
  return `<!doctype html><html><body style="margin:0;padding:16px;font-family:sans-serif;">${buttons.join('')}</body></html>`;
}

test('generateExploreHeatmap renders 10 rects (5 green, 5 red) and writes SVG', async () => {
  await withPage(async (_browser, page) => {
    await page.setContent(buildButtonsHtml(10));

    // Gather the canonical element keys so the "clicked" set matches what
    // collectInteractiveBoxes / computeElementKey produce at heatmap time.
    const locators = await page.locator('button:visible').all();
    assert.equal(locators.length, 10);

    const allKeys: string[] = [];
    for (const loc of locators) {
      allKeys.push(await computeElementKey(loc));
    }
    const clickedSelectors = new Set<string>(allKeys.slice(0, 5));

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-heatmap-'));
    const shotPath = path.join(tmp, 'page.png');

    const result: HeatmapResult = await generateExploreHeatmap(
      page,
      clickedSelectors,
      shotPath,
      { outDir: tmp },
    );

    assert.equal(result.totalInteractive, 10);
    assert.equal(result.clicked, 5);
    assert.equal(result.percent, 50);
    assert.ok(result.svgPath.endsWith('.svg'));

    const stat = await fs.stat(result.svgPath);
    assert.ok(stat.isFile());

    const svg = await fs.readFile(result.svgPath, 'utf8');
    // 10 element rects + 3 legend rects (bg panel + green sample + red sample).
    const rectMatches = svg.match(/<rect\b/g) ?? [];
    assert.equal(rectMatches.length, 13);

    // Only element rects carry a <title> (their selector key); 10 of those.
    const titleMatches = svg.match(/<title>/g) ?? [];
    assert.equal(titleMatches.length, 10);

    // 5 clicked (green) + 5 untested (red) element rects, plus 1 swatch each
    // in the legend = 6 fills per colour.
    const greenMatches = svg.match(/fill="#10B981"/g) ?? [];
    const redMatches = svg.match(/fill="#EF4444"/g) ?? [];
    assert.equal(greenMatches.length, 6);
    assert.equal(redMatches.length, 6);

    // Element rects carry stroke-width="1.5"; legend rects don't.
    const elementStrokeMatches = svg.match(/stroke-width="1\.5"/g) ?? [];
    assert.equal(elementStrokeMatches.length, 10);

    assert.match(svg, /<svg\b/);
    assert.match(svg, /<image\b/); // screenshot embedded as background

    await fs.rm(tmp, { recursive: true });
  });
});

test('collectInteractiveBoxes returns one box per visible button with clicked flag', async () => {
  await withPage(async (_browser, page) => {
    await page.setContent(buildButtonsHtml(3));
    const locators = await page.locator('button:visible').all();
    const keys: string[] = [];
    for (const loc of locators) keys.push(await computeElementKey(loc));
    const clicked = new Set<string>([keys[0]!]);
    const boxes = await collectInteractiveBoxes(page, clicked);
    assert.equal(boxes.length, 3);
    assert.equal(boxes.filter((b) => b.clicked).length, 1);
    for (const b of boxes) {
      assert.ok(b.width > 0);
      assert.ok(b.height > 0);
    }
  });
});

test('generateExploreHeatmap handles zero interactive elements', async () => {
  await withPage(async (_browser, page) => {
    await page.setContent('<!doctype html><html><body><p>no buttons here</p></body></html>');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-heatmap-empty-'));
    const shotPath = path.join(tmp, 'page.png');
    const result = await generateExploreHeatmap(page, new Set(), shotPath, { outDir: tmp });
    assert.equal(result.totalInteractive, 0);
    assert.equal(result.clicked, 0);
    assert.equal(result.percent, 0);
    const svg = await fs.readFile(result.svgPath, 'utf8');
    // Only the 3 legend rects (bg panel + 2 swatches) should remain.
    const rectMatches = svg.match(/<rect\b/g) ?? [];
    assert.equal(rectMatches.length, 3);
    await fs.rm(tmp, { recursive: true });
  });
});
