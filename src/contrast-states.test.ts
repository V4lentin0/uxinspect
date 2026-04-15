import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import { auditContrastStates, contrastRatio, parseColor } from './contrast-states-audit.js';

let browser: Browser | undefined;
let context: BrowserContext | undefined;

before(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
});

after(async () => {
  await context?.close();
  await browser?.close();
});

async function newPage(): Promise<Page> {
  if (!context) throw new Error('browser context not ready');
  return context.newPage();
}

describe('contrast math', () => {
  test('parseColor handles hex, rgb, rgba, hex8', () => {
    assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
    assert.deepEqual(parseColor('#000000'), { r: 0, g: 0, b: 0, a: 1 });
    assert.deepEqual(parseColor('rgb(255, 0, 0)'), { r: 255, g: 0, b: 0, a: 1 });
    const rgba = parseColor('rgba(0, 0, 0, 0.5)');
    assert.ok(rgba);
    assert.equal(rgba!.r, 0);
    assert.equal(rgba!.a, 0.5);
    assert.equal(parseColor('not-a-color'), null);
  });

  test('contrastRatio: black on white = 21, white on white = 1', () => {
    const bw = contrastRatio('rgb(0, 0, 0)', 'rgb(255, 255, 255)');
    assert.ok(bw > 20.9 && bw < 21.1, `expected ~21, got ${bw}`);
    const ww = contrastRatio('rgb(255, 255, 255)', 'rgb(255, 255, 255)');
    assert.ok(Math.abs(ww - 1) < 0.0001, `expected 1, got ${ww}`);
  });

  test('contrastRatio: light gray on white is low', () => {
    const ratio = contrastRatio('rgb(200, 200, 200)', 'rgb(255, 255, 255)');
    assert.ok(ratio < 2.5, `light gray on white should fail AA, got ${ratio}`);
  });
});

describe('auditContrastStates', () => {
  test('flags disabled button with light gray text on white (low contrast)', async () => {
    const page = await newPage();
    try {
      await page.setContent(`
        <html>
          <head><style>
            body { background: #ffffff; margin: 0; padding: 20px; font-family: sans-serif; }
            button { padding: 10px 20px; background: #ffffff; }
            button[disabled] { color: rgb(220, 220, 220); background: #ffffff; }
          </style></head>
          <body>
            <button id="bad" disabled>Disabled Low Contrast</button>
          </body>
        </html>
      `);
      const result = await auditContrastStates(page, { states: ['disabled'] });
      assert.equal(typeof result.page, 'string');
      assert.ok(result.elementsMeasured >= 1, `expected >=1 element, got ${result.elementsMeasured}`);
      const badFailure = result.failures.find(
        (f) => f.state === 'disabled' && f.selector.includes('bad'),
      );
      assert.ok(badFailure, `expected disabled-state failure for #bad, got failures: ${JSON.stringify(result.failures)}`);
      assert.ok(badFailure!.ratio < 4.5);
      assert.equal(result.passed, false);
    } finally {
      await page.close();
    }
  });

  test('passes button with proper contrast in all states', async () => {
    const page = await newPage();
    try {
      await page.setContent(`
        <html>
          <head><style>
            body { background: #ffffff; margin: 0; padding: 20px; font-family: sans-serif; }
            button {
              padding: 10px 20px;
              background: #ffffff;
              color: rgb(0, 0, 0);
              border: 1px solid #333;
            }
            button:hover { color: rgb(0, 0, 0); background: #f0f0f0; }
            button:focus { color: rgb(0, 0, 0); background: #ffffff; outline: 2px solid #000; }
          </style></head>
          <body>
            <button id="good">High Contrast Button</button>
          </body>
        </html>
      `);
      const result = await auditContrastStates(page, { states: ['hover', 'focus'] });
      const goodFailures = result.failures.filter((f) => f.selector.includes('good'));
      assert.equal(
        goodFailures.length,
        0,
        `expected no failures for high-contrast button, got: ${JSON.stringify(goodFailures)}`,
      );
      // At least hover and focus measurements should be present.
      const goodMeasurements = result.measurements.filter((m) => m.selector.includes('good'));
      assert.ok(goodMeasurements.length >= 2);
      assert.ok(goodMeasurements.every((m) => m.passed));
    } finally {
      await page.close();
    }
  });

  test('returns shape { failures, passed, measurements, elementsMeasured }', async () => {
    const page = await newPage();
    try {
      await page.setContent('<html><body><button>ok</button></body></html>');
      const result = await auditContrastStates(page);
      assert.ok('failures' in result);
      assert.ok('passed' in result);
      assert.ok('measurements' in result);
      assert.ok('elementsMeasured' in result);
      assert.ok(Array.isArray(result.failures));
      assert.ok(Array.isArray(result.measurements));
      assert.equal(typeof result.passed, 'boolean');
    } finally {
      await page.close();
    }
  });
});
