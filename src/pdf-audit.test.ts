import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import { auditPrintMedia } from './pdf-audit.js';

let browser: Browser | undefined;
let context: BrowserContext | undefined;
let tmpDir: string;

before(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-audit-'));
});

after(async () => {
  await context?.close();
  await browser?.close();
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

async function newPage(): Promise<Page> {
  if (!context) throw new Error('browser context not ready');
  return context.newPage();
}

describe('auditPrintMedia', () => {
  test('returns PdfAuditResult shape with pdfPath when PDF generation succeeds', async () => {
    const page = await newPage();
    try {
      await page.setContent('<html><head><title>tiny</title></head><body><p>hello</p></body></html>');
      const res = await auditPrintMedia(page, { outDir: tmpDir, url: 'https://example.com/tiny' });
      assert.equal(typeof res.page, 'string');
      assert.equal(res.format, 'A4');
      assert.equal(res.landscape, false);
      assert.ok(res.pageHeightPx > 0, 'pageHeightPx should be positive');
      assert.ok(res.pageWidthPx > 0, 'pageWidthPx should be positive');
      assert.ok(Array.isArray(res.issues));
      assert.equal(typeof res.passed, 'boolean');
      assert.ok(res.pdfPath, 'pdfPath should be set when PDF writes successfully');
      const stat = await fs.stat(res.pdfPath!);
      assert.ok(stat.size > 0, 'PDF file should be non-empty');
    } finally {
      await page.close();
    }
  });

  test('flags table rows that split across a page boundary', async () => {
    const page = await newPage();
    try {
      // Build a tall page with very tall rows — first row starts near page break
      // A4 @ 96dpi = 1123px per page. Put first row at top:1050 with height:200 so it crosses boundary.
      const html = `
        <html><head><style>
          body { margin: 0; padding: 0; }
          .spacer { height: 1050px; }
          table { width: 100%; border-collapse: collapse; }
          td { padding: 8px; border: 1px solid #ccc; vertical-align: top; height: 200px; }
        </style></head>
        <body>
          <div class="spacer"></div>
          <table><tbody>
            <tr><td>row-1-cell-a</td><td>row-1-cell-b</td></tr>
            <tr><td>row-2-cell-a</td><td>row-2-cell-b</td></tr>
          </tbody></table>
        </body></html>`;
      await page.setContent(html);
      const res = await auditPrintMedia(page, { outDir: tmpDir, url: 'https://example.com/breaking-table' });
      const splitRowIssues = res.issues.filter((i) => i.type === 'page-break-mid-row');
      assert.ok(splitRowIssues.length >= 1, `expected at least one page-break-mid-row issue, got issues: ${JSON.stringify(res.issues)}`);
      assert.equal(splitRowIssues[0]!.severity, 'warn');
    } finally {
      await page.close();
    }
  });

  test('page with proper print CSS (break-inside: avoid, small content) passes without split issues', async () => {
    const page = await newPage();
    try {
      const html = `
        <html><head><style>
          @media print { nav { display: none } }
          body { margin: 0; padding: 0; font-family: sans-serif; }
          table { width: 100%; border-collapse: collapse; break-inside: avoid; page-break-inside: avoid; }
          td { padding: 4px; border: 1px solid #ccc; }
        </style></head>
        <body>
          <header>Invoice #123</header>
          <table><tbody>
            <tr><td>line 1</td><td>$10</td></tr>
            <tr><td>line 2</td><td>$20</td></tr>
          </tbody></table>
          <footer>Total: $30</footer>
        </body></html>`;
      await page.setContent(html);
      const res = await auditPrintMedia(page, { outDir: tmpDir, url: 'https://example.com/invoice' });
      assert.equal(res.passed, true);
      const splits = res.issues.filter(
        (i) => i.type === 'page-break-mid-row' || i.type === 'page-break-mid-image' || i.type === 'page-break-mid-heading',
      );
      assert.equal(splits.length, 0, `expected no split issues, got: ${JSON.stringify(splits)}`);
      const pdfStat = await fs.stat(res.pdfPath!);
      assert.ok(pdfStat.size > 0);
    } finally {
      await page.close();
    }
  });

  test('flags visible navigation that should hide on print', async () => {
    const page = await newPage();
    try {
      // nav has no @media print { display: none } rule — it stays visible
      const html = `
        <html><head><style>
          body { margin: 0; padding: 0; }
          nav { background: #eee; padding: 10px; }
        </style></head>
        <body>
          <nav><a href="/">home</a> <a href="/about">about</a></nav>
          <main><h1>Content</h1><p>Body text</p></main>
        </body></html>`;
      await page.setContent(html);
      const res = await auditPrintMedia(page, { outDir: tmpDir, url: 'https://example.com/with-nav' });
      const hidden = res.issues.filter((i) => i.type === 'hidden-on-print-visible');
      assert.ok(hidden.length >= 1, `expected hidden-on-print-visible issue, got: ${JSON.stringify(res.issues)}`);
    } finally {
      await page.close();
    }
  });

  test('flags missing showOnPrint selector as error (print-critical-missing)', async () => {
    const page = await newPage();
    try {
      await page.setContent('<html><body><p>no receipt header here</p></body></html>');
      const res = await auditPrintMedia(page, {
        outDir: tmpDir,
        url: 'https://example.com/missing',
        selectors: { showOnPrint: ['#receipt-total'] },
      });
      const crit = res.issues.filter((i) => i.type === 'print-critical-missing');
      assert.ok(crit.length >= 1);
      assert.equal(crit[0]!.severity, 'error');
      assert.equal(res.passed, false);
    } finally {
      await page.close();
    }
  });

  test('respects Letter format and landscape orientation', async () => {
    const page = await newPage();
    try {
      await page.setContent('<html><body><p>letter landscape</p></body></html>');
      const res = await auditPrintMedia(page, {
        outDir: tmpDir,
        url: 'https://example.com/letter',
        format: 'Letter',
        landscape: true,
      });
      assert.equal(res.format, 'Letter');
      assert.equal(res.landscape, true);
      // landscape swaps dimensions — width becomes the larger number
      assert.ok(res.pageWidthPx > res.pageHeightPx, 'landscape width should exceed height');
    } finally {
      await page.close();
    }
  });
});
