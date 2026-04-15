import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { measureClickCoverage, listInteractiveElements } from './coverage.js';
import { explore } from './explore.js';

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

describe('measureClickCoverage', () => {
  test('counts visible + enabled interactive elements', async () => {
    const page = await freshPage(`
      <html><body>
        <button>One</button>
        <button>Two</button>
        <button disabled>Disabled</button>
        <button style="display:none">Hidden</button>
        <a href="/x">Link</a>
        <input type="text" />
        <input type="hidden" name="h" />
        <select><option>a</option></select>
        <textarea></textarea>
        <div role="button" tabindex="0">RoleButton</div>
      </body></html>
    `);
    const result = await measureClickCoverage(page);
    // buttons: 2 (disabled + display:none excluded)
    // a: 1, input (text): 1, select: 1, textarea: 1, div (role=button): 1
    assert.equal(result.totalInteractive, 7);
    assert.equal(result.byTag.button, 2);
    assert.equal(result.byTag.a, 1);
    assert.equal(result.byTag.input, 1);
    assert.equal(result.byTag.select, 1);
    assert.equal(result.byTag.textarea, 1);
    assert.equal(result.byTag.div, 1);
    await page.close();
  });

  test('empty page returns zero', async () => {
    const page = await freshPage('<html><body><p>hi</p></body></html>');
    const result = await measureClickCoverage(page);
    assert.equal(result.totalInteractive, 0);
    assert.deepEqual(result.byTag, {});
    await page.close();
  });

  test('listInteractiveElements returns keys matching explore click-keys', async () => {
    const page = await freshPage(`
      <html><body>
        <button id="a">A</button>
        <button id="b">B</button>
      </body></html>
    `);
    const list = await listInteractiveElements(page);
    assert.equal(list.length, 2);
    assert.ok(list[0]!.key.includes('button'));
    assert.ok(list[0]!.snippet.includes('<button'));
    await page.close();
  });
});

describe('explore coverage integration', () => {
  test('page with 10 buttons, click 5 -> 50%', async () => {
    const buttons = Array.from({ length: 10 }, (_, i) => `<button id="b${i}">Btn${i}</button>`).join('');
    const page = await freshPage(`<html><body>${buttons}</body></html>`);
    const result = await explore(page, { maxClicks: 5, submitForms: false });
    assert.ok(result.coverage, 'coverage present');
    assert.equal(result.coverage!.total, 10);
    assert.equal(result.coverage!.clicked, 5);
    assert.equal(result.coverage!.percent, 50);
    assert.equal(result.coverage!.byTag.button, 10);
    assert.equal(result.coverage!.missed.length, 5);
    await page.close();
  });

  test('byTag breakdown: mixed elements', async () => {
    const page = await freshPage(`
      <html><body>
        <button id="b1">B1</button>
        <button id="b2">B2</button>
        <a href="#x" id="a1">L1</a>
        <a href="#y" id="a2">L2</a>
        <input type="text" id="i1" />
      </body></html>
    `);
    const result = await explore(page, { maxClicks: 1, submitForms: false });
    assert.ok(result.coverage);
    assert.equal(result.coverage!.total, 5);
    assert.equal(result.coverage!.byTag.button, 2);
    assert.equal(result.coverage!.byTag.a, 2);
    assert.equal(result.coverage!.byTag.input, 1);
    await page.close();
  });

  test('all clicked -> 100%', async () => {
    const page = await freshPage(`
      <html><body>
        <button id="b1">B1</button>
        <button id="b2">B2</button>
      </body></html>
    `);
    const result = await explore(page, { maxClicks: 10, submitForms: false });
    assert.ok(result.coverage);
    assert.equal(result.coverage!.total, 2);
    assert.equal(result.coverage!.clicked, 2);
    assert.equal(result.coverage!.percent, 100);
    assert.equal(result.coverage!.missed.length, 0);
    await page.close();
  });

  test('zero interactive -> 0% with total 0', async () => {
    const page = await freshPage('<html><body><p>text only</p></body></html>');
    const result = await explore(page, { maxClicks: 5, submitForms: false });
    assert.ok(result.coverage);
    assert.equal(result.coverage!.total, 0);
    assert.equal(result.coverage!.clicked, 0);
    assert.equal(result.coverage!.percent, 0);
    await page.close();
  });
});
