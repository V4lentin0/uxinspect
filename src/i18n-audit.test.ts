import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, BrowserContext, Page, Route } from 'playwright';
import { chromium } from 'playwright';
import {
  runI18nAudit,
  DEFAULT_I18N_LOCALES,
  DEFAULT_I18N_OVERFLOW_SELECTORS,
  type I18nResult,
} from './i18n-audit.js';

let browser: Browser | undefined;
let context: BrowserContext | undefined;

before(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 640, height: 480 } });
});

after(async () => {
  await context?.close();
  await browser?.close();
});

async function newPage(): Promise<Page> {
  if (!context) throw new Error('browser context not ready');
  return context.newPage();
}

/**
 * Intercept network for a synthetic app that serves per-locale HTML from
 * the `?lang=` query so runI18nAudit's real navigation flow is exercised.
 */
async function installFixture(
  page: Page,
  fixtures: Record<string, string>,
  defaultHtml: string,
): Promise<void> {
  await page.route('https://uxi.test/**', (route: Route) => {
    const u = new URL(route.request().url());
    const lang = u.searchParams.get('lang') ?? '';
    const body = fixtures[lang] ?? defaultHtml;
    return route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body,
    });
  });
}

describe('runI18nAudit', () => {
  test('clean LTR/RTL app with fully translated strings passes', async () => {
    const page = await newPage();
    try {
      const html = (lang: string, dir: string, title: string) => `
        <!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8"></head>
        <body><h1>${title}</h1>
          <nav><a href="#">${title}</a></nav>
          <button>OK</button>
        </body></html>`;
      await installFixture(
        page,
        {
          en: html('en', 'ltr', 'Welcome friend'),
          ar: html('ar', 'rtl', 'اهلا صديقي'),
          de: html('de', 'ltr', 'Hallo Freund'),
          ja: html('ja', 'ltr', 'こんにちは'),
          zh: html('zh', 'ltr', '你好朋友'),
        },
        html('en', 'ltr', 'Welcome friend'),
      );
      await page.goto('https://uxi.test/');
      const result: I18nResult = await runI18nAudit(page);
      assert.equal(result.passed, true, JSON.stringify(result.issues, null, 2));
      assert.deepEqual(
        result.locales,
        DEFAULT_I18N_LOCALES,
        'should probe the documented default locales',
      );
      assert.equal(result.summaries.length, DEFAULT_I18N_LOCALES.length);
      const ar = result.summaries.find((s) => s.locale === 'ar');
      assert.ok(ar, 'expected an ar summary');
      assert.equal(ar.direction, 'rtl');
      assert.equal(ar.expectedRtl, true);
      assert.equal(ar.visited, true);
    } finally {
      await page.close();
    }
  });

  test('RTL locale missing html[dir="rtl"] is flagged with severity=error', async () => {
    const page = await newPage();
    try {
      await installFixture(
        page,
        {
          ar: `<!doctype html><html lang="ar"><head><meta charset="utf-8"></head>
               <body><h1>اهلا</h1></body></html>`,
        },
        `<!doctype html><html lang="en"><body><h1>ok</h1></body></html>`,
      );
      await page.goto('https://uxi.test/');
      const result = await runI18nAudit(page, { locales: ['ar'] });
      assert.equal(result.passed, false);
      const rtl = result.issues.find((i) => i.kind === 'rtl-dir-missing' || i.kind === 'rtl-dir-wrong');
      assert.ok(rtl, `expected an rtl-dir issue, got ${JSON.stringify(result.issues)}`);
      assert.equal(rtl.severity, 'error');
      assert.equal(rtl.locale, 'ar');
    } finally {
      await page.close();
    }
  });

  test('un-translated keys (ALL_CAPS, dotted, mustache) surface as issues', async () => {
    const page = await newPage();
    try {
      await installFixture(
        page,
        {
          en: `<!doctype html><html lang="en" dir="ltr"><body>
                 <h1>WELCOME_TITLE</h1>
                 <p>profile.name is {{user.name}}</p>
                 <button>SAVE_BUTTON_LABEL</button>
               </body></html>`,
        },
        `<!doctype html><html lang="en"><body></body></html>`,
      );
      await page.goto('https://uxi.test/');
      const result = await runI18nAudit(page, { locales: ['en'] });
      const keyKinds = result.issues.filter((i) => i.kind === 'missing-translation-key');
      const phKinds = result.issues.filter((i) => i.kind === 'unrendered-placeholder');
      assert.ok(
        keyKinds.some((i) => i.snippet === 'WELCOME_TITLE'),
        `expected WELCOME_TITLE key, got ${JSON.stringify(keyKinds)}`,
      );
      assert.ok(
        keyKinds.some((i) => i.snippet === 'profile.name'),
        `expected profile.name key, got ${JSON.stringify(keyKinds)}`,
      );
      assert.ok(
        phKinds.some((i) => (i.snippet ?? '').includes('{{user.name}}')),
        `expected {{user.name}} placeholder, got ${JSON.stringify(phKinds)}`,
      );
      // Unrendered placeholder is severity=error, so the audit must fail.
      assert.equal(result.passed, false);
    } finally {
      await page.close();
    }
  });

  test('text overflow on a constrained button is flagged per locale', async () => {
    const page = await newPage();
    try {
      const longDe = 'Benutzerkontoverwaltungseinstellungen speichern';
      await installFixture(
        page,
        {
          en: `<!doctype html><html lang="en" dir="ltr"><body>
                 <button style="width:60px;white-space:nowrap;overflow:hidden;">Save</button>
               </body></html>`,
          de: `<!doctype html><html lang="de" dir="ltr"><body>
                 <button style="width:60px;white-space:nowrap;overflow:hidden;">${longDe}</button>
               </body></html>`,
        },
        `<!doctype html><html lang="en"><body></body></html>`,
      );
      await page.goto('https://uxi.test/');
      const result = await runI18nAudit(page, { locales: ['en', 'de'] });
      const enOverflow = result.issues.find((i) => i.kind === 'text-overflow' && i.locale === 'en');
      const deOverflow = result.issues.find((i) => i.kind === 'text-overflow' && i.locale === 'de');
      assert.equal(enOverflow, undefined, 'en button should fit');
      assert.ok(deOverflow, 'de button should overflow');
      assert.ok(deOverflow.target?.startsWith('button'), 'target should point to the button');
      const deSummary = result.summaries.find((s) => s.locale === 'de');
      assert.ok(deSummary && deSummary.overflowsDetected > 0);
    } finally {
      await page.close();
    }
  });

  test('navigation failure is recorded as an issue without crashing', async () => {
    const page = await newPage();
    try {
      // Default page loads; en locale fulfils; ja is aborted.
      await page.route('https://uxi.test/**', (route: Route) => {
        const u = new URL(route.request().url());
        const lang = u.searchParams.get('lang');
        if (lang === 'ja') return route.abort('failed');
        return route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<!doctype html><html lang="en"><body>ok</body></html>',
        });
      });
      await page.goto('https://uxi.test/');
      const result = await runI18nAudit(page, {
        locales: ['en', 'ja'],
        navigationTimeoutMs: 2000,
      });
      const navFail = result.issues.find((i) => i.kind === 'navigation-failed' && i.locale === 'ja');
      assert.ok(navFail, 'expected a navigation-failed issue for ja');
      const ja = result.summaries.find((s) => s.locale === 'ja');
      assert.ok(ja && ja.visited === false);
      // passed must be false because navigation-failed is severity=error
      assert.equal(result.passed, false);
    } finally {
      await page.close();
    }
  });

  test('custom i18nKeyPattern and locales override defaults', async () => {
    const page = await newPage();
    try {
      await installFixture(
        page,
        {
          fr: `<!doctype html><html lang="fr" dir="ltr"><body>
                 <p>keyname:something</p>
                 <p>not a key</p>
               </body></html>`,
        },
        `<!doctype html><html lang="en"><body>x</body></html>`,
      );
      await page.goto('https://uxi.test/');
      const result = await runI18nAudit(page, {
        locales: ['fr'],
        i18nKeyPattern: /\bkeyname:[a-z]+\b/,
      });
      const custom = result.issues.find((i) => i.kind === 'missing-translation-key');
      assert.ok(custom, `expected custom key match, got ${JSON.stringify(result.issues)}`);
      assert.equal(custom.snippet, 'keyname:something');
      assert.equal(result.summaries.length, 1);
      assert.equal(result.summaries[0].locale, 'fr');
    } finally {
      await page.close();
    }
  });

  test('DEFAULT_I18N_OVERFLOW_SELECTORS is non-empty and contains primitives', () => {
    assert.ok(DEFAULT_I18N_OVERFLOW_SELECTORS.length > 0);
    assert.ok(DEFAULT_I18N_OVERFLOW_SELECTORS.includes('button'));
    assert.ok(DEFAULT_I18N_OVERFLOW_SELECTORS.includes('label'));
  });
});
