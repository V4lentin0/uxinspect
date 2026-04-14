import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { checkRetireJs } from './retire.js';
import { auditTouchTargets } from './touchtargets.js';
import { auditKeyboard } from './keyboard.js';
import { auditPassiveSecurity } from './passive-security.js';

let browser: Browser;
let context: BrowserContext;

before(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
});

after(async () => {
  await context?.close();
  await browser?.close();
});

async function freshPage(html: string): Promise<Page> {
  const page = await context.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  return page;
}

describe('checkRetireJs', () => {
  test('clean page with no scripts passes', async () => {
    const page = await freshPage('<html><body><h1>Clean</h1><p>Nothing to see.</p></body></html>');
    const result = await checkRetireJs(page);
    assert.equal(result.passed, true);
    assert.equal(result.findings.length, 0);
    assert.equal(result.librariesScanned, 0);
    await page.close();
  });

  test('detects old jQuery referenced via script src', async () => {
    const page = await freshPage(
      '<html><body><script src="https://cdn.example.com/jquery-1.6.0.min.js"></script><div>hi</div></body></html>',
    );
    const result = await checkRetireJs(page);
    assert.equal(result.passed, false);
    assert.ok(result.findings.length >= 1);
    const jq = result.findings.find(f => f.library === 'jquery');
    assert.ok(jq, 'expected a jquery finding');
    assert.match(jq!.version, /^1\.6\.0/);
    assert.ok(jq!.vulnerabilities.length >= 1);
    assert.equal(jq!.vulnerabilities[0].severity, 'medium');
    await page.close();
  });
});

describe('auditTouchTargets', () => {
  test('clean page with large buttons passes', async () => {
    const page = await freshPage(`
      <html><body>
        <button style="width:80px;height:80px;margin:20px;display:block">Save</button>
        <button style="width:80px;height:80px;margin:20px;display:block">Cancel</button>
      </body></html>
    `);
    const result = await auditTouchTargets(page);
    assert.equal(result.passed, true);
    assert.equal(result.tooSmall.length, 0);
    assert.equal(result.overlapping.length, 0);
    assert.ok(result.scanned >= 2);
    await page.close();
  });

  test('detects a button that is too small', async () => {
    const page = await freshPage(`
      <html><body>
        <button id="tiny" style="width:20px;height:20px">x</button>
      </body></html>
    `);
    const result = await auditTouchTargets(page);
    assert.equal(result.passed, false);
    assert.ok(result.tooSmall.length >= 1);
    const tiny = result.tooSmall.find(f => f.selector === '#tiny');
    assert.ok(tiny, 'expected #tiny in tooSmall');
    assert.ok(tiny!.width < 44);
    assert.ok(tiny!.height < 44);
    await page.close();
  });

  test('honors custom minSize option', async () => {
    const page = await freshPage(`
      <html><body>
        <button id="med" style="width:30px;height:30px">m</button>
      </body></html>
    `);
    const relaxed = await auditTouchTargets(page, { minSize: 20 });
    assert.equal(relaxed.passed, true);
    const strict = await auditTouchTargets(page, { minSize: 40 });
    assert.equal(strict.passed, false);
    await page.close();
  });
});

describe('auditKeyboard', () => {
  test('page with focusable elements returns focusable count and tab order', async () => {
    const page = await freshPage(`
      <html>
        <head><style>
          button:focus, a:focus, input:focus { outline: 2px solid blue; }
        </style></head>
        <body>
          <a id="skip" href="#main">Skip to content</a>
          <button id="b1">Button 1</button>
          <button id="b2">Button 2</button>
          <input id="i1" type="text" />
          <a id="main" href="#">Main</a>
        </body>
      </html>
    `);
    const result = await auditKeyboard(page, { maxTabs: 20 });
    assert.equal(typeof result.page, 'string');
    assert.ok(result.focusableCount >= 4);
    assert.ok(result.tabsTaken >= 1);
    assert.ok(Array.isArray(result.tabOrder));
    // No focus-trap error expected on a small page that cycles
    assert.equal(result.issues.some(i => i.type === 'focus-trap'), false);
    await page.close();
  });

  test('detects missing focus style on a button', async () => {
    const page = await freshPage(`
      <html>
        <head><style>
          button { outline: none !important; box-shadow: none !important; }
          button:focus { outline: none !important; box-shadow: none !important; }
        </style></head>
        <body>
          <button id="noring" style="outline:none;box-shadow:none">x</button>
        </body>
      </html>
    `);
    const result = await auditKeyboard(page, { maxTabs: 10, requireFocusRing: true });
    const hasNoFocus = result.issues.some(i => i.type === 'no-focus-style');
    assert.equal(hasNoFocus, true, 'expected no-focus-style issue');
    await page.close();
  });

  test('skip-link-missing is reported when first focusable is not a skip link', async () => {
    const page = await freshPage(`
      <html><body>
        <button id="first">Sign up</button>
        <button id="second">Log in</button>
      </body></html>
    `);
    const result = await auditKeyboard(page, { maxTabs: 5 });
    const hasSkipMissing = result.issues.some(i => i.type === 'skip-link-missing');
    assert.equal(hasSkipMissing, true, 'expected skip-link-missing issue');
    await page.close();
  });
});

describe('auditPassiveSecurity', () => {
  test('clean page with no external links or cookies passes', async () => {
    const page = await freshPage('<html><body><h1>Hi</h1><p>No external stuff.</p></body></html>');
    const result = await auditPassiveSecurity(page);
    // No error-level issues on a plain about:blank-style page
    assert.equal(result.issues.some(i => i.level === 'error'), false);
    assert.equal(result.passed, true);
    assert.equal(result.scannedScripts, 0);
    assert.equal(result.scannedLinks, 0);
    await page.close();
  });

  test('detects target="_blank" without rel="noopener"', async () => {
    const page = await freshPage(`
      <html><body>
        <a href="https://external.example.com/landing" target="_blank">open external</a>
      </body></html>
    `);
    const result = await auditPassiveSecurity(page);
    const blankIssue = result.issues.find(i => i.type === 'target-blank-no-noopener');
    assert.ok(blankIssue, 'expected target-blank-no-noopener issue');
    assert.equal(blankIssue!.level, 'warn');
    await page.close();
  });

  test('does not flag target="_blank" with rel="noopener"', async () => {
    const page = await freshPage(`
      <html><body>
        <a href="https://external.example.com/landing" target="_blank" rel="noopener">safe external</a>
      </body></html>
    `);
    const result = await auditPassiveSecurity(page);
    const blankIssue = result.issues.find(i => i.type === 'target-blank-no-noopener');
    assert.equal(blankIssue, undefined, 'did not expect target-blank-no-noopener issue');
    await page.close();
  });
});
