import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import { auditI18n } from './i18n-audit.js';

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

describe('auditI18n - missing keys', () => {
  test('page with raw t.welcome literal is flagged as dot-path', async () => {
    const page = await newPage();
    try {
      await page.setContent(
        '<html><body><h1>t.welcome</h1><p>Hello world</p></body></html>',
      );
      const result = await auditI18n(page, {
        checks: { missingKeys: true, rtlLayout: false, overflow: false },
      });
      assert.ok(result.missingKeys.length >= 1, 'expected at least one missing-key hit');
      const hit = result.missingKeys.find((h) => h.text.includes('t.welcome'));
      assert.ok(hit, 't.welcome should be flagged');
      assert.equal(hit?.kind, 'dot-path');
      assert.equal(result.passed, false);
    } finally {
      await page.close();
    }
  });

  test('page with [unknown] bracket placeholder is flagged', async () => {
    const page = await newPage();
    try {
      await page.setContent('<html><body><span>[unknown]</span></body></html>');
      const result = await auditI18n(page, {
        checks: { missingKeys: true, rtlLayout: false, overflow: false },
      });
      const hit = result.missingKeys.find((h) => h.kind === 'bracket-unknown');
      assert.ok(hit, '[unknown] should be flagged');
    } finally {
      await page.close();
    }
  });

  test('page with {i18n.greeting} placeholder is flagged', async () => {
    const page = await newPage();
    try {
      await page.setContent(
        '<html><body><p>{i18n.greeting}</p></body></html>',
      );
      const result = await auditI18n(page, {
        checks: { missingKeys: true, rtlLayout: false, overflow: false },
      });
      const hit = result.missingKeys.find((h) => h.kind === 'placeholder-syntax');
      assert.ok(hit, '{i18n.greeting} should be flagged');
    } finally {
      await page.close();
    }
  });

  test('page with {{ tr.Y }} handlebars is flagged', async () => {
    const page = await newPage();
    try {
      await page.setContent(
        '<html><body><p>{{ tr.save }}</p></body></html>',
      );
      const result = await auditI18n(page, {
        checks: { missingKeys: true, rtlLayout: false, overflow: false },
      });
      const hit = result.missingKeys.find((h) => h.kind === 'handlebars');
      assert.ok(hit, '{{ tr.save }} should be flagged');
    } finally {
      await page.close();
    }
  });

  test('page with USER.WELCOME.TITLE screaming-snake is flagged', async () => {
    const page = await newPage();
    try {
      await page.setContent(
        '<html><body><h2>USER.WELCOME.TITLE</h2></body></html>',
      );
      const result = await auditI18n(page, {
        checks: { missingKeys: true, rtlLayout: false, overflow: false },
      });
      const hit = result.missingKeys.find((h) => h.kind === 'all-screaming-snake');
      assert.ok(hit, 'USER.WELCOME.TITLE should be flagged');
    } finally {
      await page.close();
    }
  });

  test('clean page with only natural-language copy has no missing keys', async () => {
    const page = await newPage();
    try {
      await page.setContent(
        '<html><body><h1>Welcome</h1><p>This is real copy, not a placeholder.</p><button>Save</button></body></html>',
      );
      const result = await auditI18n(page, {
        checks: { missingKeys: true, rtlLayout: false, overflow: false },
      });
      assert.equal(result.missingKeys.length, 0);
    } finally {
      await page.close();
    }
  });
});

describe('auditI18n - overflow', () => {
  test('button with fixed 50px width and long german text overflows', async () => {
    const page = await newPage();
    try {
      await page.setContent(
        `<html><body>
           <button style="width:50px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:inline-block;">Wartung beendet</button>
         </body></html>`,
      );
      // Skip the network-round-trip branch by disabling other checks; overflow will
      // measure on the current page when url is about:blank.
      const result = await auditI18n(page, {
        locales: ['de-DE'],
        checks: { missingKeys: false, rtlLayout: false, overflow: true },
      });
      assert.ok(
        result.overflowing.length >= 1,
        `expected at least one overflow hit, got ${result.overflowing.length}`,
      );
      const hit = result.overflowing[0];
      assert.equal(hit.locale, 'de-DE');
      assert.equal(hit.tag, 'button');
      assert.ok(hit.scrollWidth > hit.clientWidth);
      assert.ok(hit.text.includes('Wartung'));
      assert.equal(result.passed, false);
    } finally {
      await page.close();
    }
  });

  test('button wide enough for its text reports no overflow', async () => {
    const page = await newPage();
    try {
      await page.setContent(
        `<html><body>
           <button style="width:500px;">OK</button>
         </body></html>`,
      );
      const result = await auditI18n(page, {
        locales: ['de-DE'],
        checks: { missingKeys: false, rtlLayout: false, overflow: true },
      });
      assert.equal(result.overflowing.length, 0);
    } finally {
      await page.close();
    }
  });
});

describe('auditI18n - result shape', () => {
  test('disabling all checks returns an empty passing result', async () => {
    const page = await newPage();
    try {
      await page.setContent('<html><body>hi</body></html>');
      const result = await auditI18n(page, {
        checks: { missingKeys: false, rtlLayout: false, overflow: false },
      });
      assert.deepEqual(result.missingKeys, []);
      assert.deepEqual(result.rtlIssues, []);
      assert.deepEqual(result.overflowing, []);
      assert.deepEqual(result.localesChecked, []);
      assert.equal(result.passed, true);
      assert.equal(typeof result.page, 'string');
    } finally {
      await page.close();
    }
  });
});
