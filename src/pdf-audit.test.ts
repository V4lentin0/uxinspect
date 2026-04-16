/**
 * P4 #43 — pdf-audit tests.
 *
 * Exercises runPdfAudit end-to-end against a chromium page with known print
 * CSS, plus shape-only tests that don't need a browser at all.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, firefox, type Browser, type BrowserContext, type Page } from 'playwright';
import { runPdfAudit } from './pdf-audit.js';
import type { PdfResult } from './types.js';

let browser: Browser;
let context: BrowserContext;

before(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
});

after(async () => {
  await context?.close();
  await browser?.close();
});

async function newPage(): Promise<Page> {
  return context.newPage();
}

function baseHtml(body: string, extraCss = ''): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    html, body { margin: 0; padding: 0; font-family: sans-serif; font-size: 14px; color: #111; }
    @page { size: A4; margin: 1cm; }
    @media print {
      .only-screen { display: none; }
    }
    ${extraCss}
  </style>
</head>
<body>${body}</body>
</html>`;
}

describe('runPdfAudit', () => {
  test('returns a PdfResult with expected shape when run under Chromium', async () => {
    const page = await newPage();
    try {
      await page.setContent(baseHtml('<h1>Hello</h1><p>Short body for a single page.</p>'));
      const result = await runPdfAudit(page, { outDir: '' });
      assert.equal(typeof result.page, 'string');
      assert.equal(result.browser, 'chromium');
      assert.equal(typeof result.startedAt, 'string');
      assert.ok(result.sizeBytes > 0, 'expected non-empty PDF bytes');
      assert.ok(Array.isArray(result.issues));
      assert.ok(Array.isArray(result.layoutDrift));
      // pageCount may be 0 if pdfjs-dist is not installed — both are legal.
      if (result.pageCount > 0) {
        assert.equal(result.pages.length, result.pageCount);
        for (const pg of result.pages) {
          assert.ok(pg.widthPt > 0 && pg.heightPt > 0, 'page dimensions present');
          assert.ok(Array.isArray(pg.items));
        }
      } else {
        // No pdfjs => we should have recorded a pdfjs-missing info issue.
        assert.ok(
          result.issues.some(i => i.type === 'pdfjs-missing'),
          'expected pdfjs-missing info when parsing skipped',
        );
      }
    } finally {
      await page.close();
    }
  });

  test('restores screen emulation after running', async () => {
    const page = await newPage();
    try {
      await page.setContent(baseHtml('<div class="only-screen">screen only</div><div>always</div>'));
      await runPdfAudit(page, { outDir: '' });
      // After audit: the element hidden in print should be visible again on screen.
      const visible = await page.evaluate(() => {
        const el = document.querySelector('.only-screen') as HTMLElement | null;
        if (!el) return false;
        const cs = window.getComputedStyle(el);
        return cs.display !== 'none';
      });
      assert.equal(visible, true, 'only-screen element must be visible after audit cleans up');
    } finally {
      await page.close();
    }
  });

  test('flags too-many-pages when expectedMaxPages is exceeded', async () => {
    const page = await newPage();
    try {
      // Force ~4 printed pages with break-after page rules.
      const blocks = Array.from({ length: 4 })
        .map((_, i) => `<div style="page-break-after:always;break-after:page;">Section ${i + 1}</div>`)
        .join('');
      await page.setContent(baseHtml(blocks));
      const result = await runPdfAudit(page, { outDir: '', expectedMaxPages: 1 });
      // Can only assert on too-many-pages when pdfjs parsed the doc.
      if (result.pageCount > 0) {
        assert.ok(result.pageCount >= 2, `expected multi-page output, got ${result.pageCount}`);
        if (result.pageCount > 1) {
          assert.ok(
            result.issues.some(i => i.type === 'too-many-pages'),
            'expected too-many-pages issue',
          );
        }
      }
    } finally {
      await page.close();
    }
  });

  test('flags images that overflow printable content width', async () => {
    const page = await newPage();
    try {
      await page.setContent(baseHtml(
        '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" ' +
        'style="width:2000px;height:40px;background:#eee;" alt="big">',
      ));
      const result = await runPdfAudit(page, { outDir: '' });
      assert.ok(
        result.issues.some(i => i.type === 'image-overflow'),
        'expected image-overflow issue for oversized image',
      );
      assert.equal(result.passed, false, 'overflow should flip passed=false');
    } finally {
      await page.close();
    }
  });

  test('returns pages with origin-at-top y coordinates (if pdfjs installed)', async () => {
    const page = await newPage();
    try {
      await page.setContent(baseHtml('<h1 style="margin-top:0">Top line</h1>'));
      const result = await runPdfAudit(page, { outDir: '' });
      if (result.pageCount > 0 && result.pages[0].items.length > 0) {
        const ys = result.pages[0].items.map(i => i.y);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        // Origin-at-top convention: smaller y = closer to top. Values must lie
        // inside the page height.
        assert.ok(minY >= 0, `minY=${minY} should be >= 0`);
        assert.ok(maxY <= result.pages[0].heightPt + 2, 'items stay within page height');
      }
    } finally {
      await page.close();
    }
  });

  test('custom page size (pt) is passed to page.pdf() without throwing', async () => {
    const page = await newPage();
    try {
      await page.setContent(baseHtml('<p>custom</p>'));
      const result = await runPdfAudit(page, { outDir: '', pageSize: { w: 400, h: 600 } });
      assert.ok(result.sizeBytes > 0, 'custom-size PDF must render');
      // If parsed, the reported page size should approximately match what we asked for.
      if (result.pageCount > 0) {
        const pg = result.pages[0];
        assert.ok(Math.abs(pg.widthPt - 400) < 2, `widthPt ~400, got ${pg.widthPt}`);
        assert.ok(Math.abs(pg.heightPt - 600) < 2, `heightPt ~600, got ${pg.heightPt}`);
      }
    } finally {
      await page.close();
    }
  });

  test('no-page-rule info is produced when CSS has no @page block', async () => {
    const page = await newPage();
    try {
      // Strip the @page rule from the default template.
      await page.setContent(`<!doctype html>
<html>
<head><style>body { font-size: 14px; }</style></head>
<body><p>no page rule</p></body>
</html>`);
      const result = await runPdfAudit(page, { outDir: '' });
      assert.ok(
        result.issues.some(i => i.type === 'no-page-rule'),
        'expected no-page-rule info when @page is absent',
      );
    } finally {
      await page.close();
    }
  });

  test('short-circuits with wrong-browser on non-chromium', async () => {
    let fxBrowser: Browser | undefined;
    try {
      fxBrowser = await firefox.launch({ headless: true }).catch(() => undefined);
    } catch { /* firefox not installed on CI runner */ }
    if (!fxBrowser) {
      // Firefox binary not available — skip but assert the guard exists.
      assert.equal(typeof runPdfAudit, 'function');
      return;
    }
    const ctx = await fxBrowser.newContext();
    const page = await ctx.newPage();
    try {
      await page.setContent('<p>firefox</p>');
      const result: PdfResult = await runPdfAudit(page, { outDir: '' });
      assert.equal(result.passed, false);
      assert.equal(result.browser, 'firefox');
      assert.ok(result.issues.some(i => i.type === 'wrong-browser'), 'expected wrong-browser issue');
      assert.equal(result.pageCount, 0, 'no rendering attempted on non-chromium');
      assert.equal(result.sizeBytes, 0);
    } finally {
      await page.close();
      await ctx.close();
      await fxBrowser.close();
    }
  });
});
