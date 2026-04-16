/**
 * P5 #49 — PDF export via Playwright print-to-PDF.
 * Chromium-only (page.pdf() not available in Firefox/WebKit).
 */

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PdfExportOptions {
  /** Paper format. Default 'A4'. */
  format?: 'A4' | 'Letter' | 'Legal' | 'Tabloid';
  /** Landscape mode. Default false. */
  landscape?: boolean;
  /** Margins in CSS units. Default '16mm' all sides. */
  margin?: { top?: string; right?: string; bottom?: string; left?: string };
  /** Print background colors/images. Default true. */
  printBackground?: boolean;
}

/**
 * Load an HTML file in headless Chromium and export as PDF.
 * @returns Absolute path to the generated PDF.
 */
export async function exportToPdf(
  htmlPath: string,
  outPath?: string,
  opts: PdfExportOptions = {},
): Promise<string> {
  const absHtml = path.resolve(htmlPath);
  const absPdf = outPath
    ? path.resolve(outPath)
    : absHtml.replace(/\.html?$/i, '.pdf');

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`file://${absHtml}`, { waitUntil: 'networkidle' });
    await page.pdf({
      path: absPdf,
      format: opts.format ?? 'A4',
      landscape: opts.landscape ?? false,
      printBackground: opts.printBackground ?? true,
      margin: {
        top: opts.margin?.top ?? '16mm',
        right: opts.margin?.right ?? '16mm',
        bottom: opts.margin?.bottom ?? '16mm',
        left: opts.margin?.left ?? '16mm',
      },
    });
    return absPdf;
  } finally {
    await browser.close();
  }
}
