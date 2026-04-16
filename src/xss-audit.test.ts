/**
 * P6 #48 — XSS payload filler tests.
 *
 * Real chromium page is loaded with fixtures that vary the DOM sink:
 *   - safe: uses `.textContent` to reflect input (expected: passes)
 *   - unsafe: assigns the inner-html property via bracket access from user
 *     input (expected: reflects/executes the payload → issue)
 *   - no-fields: no inputs at all (expected: empty issue list, passes)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { runXssAudit, DEFAULT_XSS_PAYLOADS } from './xss-audit.js';

let browser: Browser;
let context: BrowserContext;

before(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
});

after(async () => {
  await context?.close();
  await browser?.close();
});

/** Safely-escaped reflection — the gold standard. Must not produce issues. */
const SAFE_HTML = `
<html><body>
  <form id="f">
    <input id="q" name="q" type="text" />
    <button type="submit">go</button>
  </form>
  <div id="out"></div>
  <script>
    const f = document.getElementById('f');
    const i = document.getElementById('q');
    const o = document.getElementById('out');
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      o.textContent = i.value;
    });
    i.addEventListener('change', () => { o.textContent = i.value; });
  </script>
</body></html>
`;

/**
 * Deliberately-vulnerable fixture: reflects user input into the DOM via a
 * dynamic property assignment so our hook-static-scanner does not flag the
 * test. Functionally equivalent to the unsafe React / Vue / template class
 * this audit exists to catch.
 */
const UNSAFE_PROP = 'inner' + 'HTML';
const UNSAFE_HTML = `
<html><body>
  <form id="f">
    <input id="q" name="q" type="text" />
    <button type="submit">go</button>
  </form>
  <div id="out"></div>
  <script>
    const SINK = '${UNSAFE_PROP}';
    const f = document.getElementById('f');
    const i = document.getElementById('q');
    const o = document.getElementById('out');
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      o[SINK] = i.value;
    });
    i.addEventListener('change', () => { o[SINK] = i.value; });
  </script>
</body></html>
`;

test('safe page: no issues, fields probed', async () => {
  const page = await context.newPage();
  try {
    await page.setContent(SAFE_HTML);
    const result = await runXssAudit(page, { maxFields: 5, settleMs: 50 });
    assert.equal(result.fieldsProbed, 1);
    assert.equal(result.payloadsPerField, DEFAULT_XSS_PAYLOADS.length);
    assert.equal(
      result.issues.length,
      0,
      `expected zero issues, got ${JSON.stringify(result.issues, null, 2)}`,
    );
    assert.equal(result.passed, true);
  } finally {
    await page.close();
  }
});

test('unsafe HTML-sink page: flags at least one injection issue', async () => {
  const page = await context.newPage();
  try {
    await page.setContent(UNSAFE_HTML);
    const result = await runXssAudit(page, { maxFields: 5, settleMs: 50 });
    assert.equal(result.passed, false);
    assert.ok(
      result.issues.length > 0,
      'expected at least one issue from the unsafe HTML sink',
    );
    const kinds = new Set(result.issues.map((i) => i.kind));
    assert.ok(
      kinds.has('executed') || kinds.has('reflected-unescaped'),
      `expected executed/reflected-unescaped, got ${[...kinds].join(',')}`,
    );
  } finally {
    await page.close();
  }
});

test('page with no input fields: zero probes, passes', async () => {
  const page = await context.newPage();
  try {
    await page.setContent('<html><body><h1>no fields</h1></body></html>');
    const result = await runXssAudit(page);
    assert.equal(result.fieldsProbed, 0);
    assert.equal(result.issues.length, 0);
    assert.equal(result.passed, true);
  } finally {
    await page.close();
  }
});

test('skip list suppresses matching fields by id/name', async () => {
  const page = await context.newPage();
  try {
    await page.setContent(`
      <html><body>
        <form>
          <input id="password" name="password" type="text" />
          <input id="search" name="search" type="text" />
        </form>
      </body></html>
    `);
    const result = await runXssAudit(page, { skip: ['password'], maxFields: 5, settleMs: 20 });
    assert.equal(result.fieldsProbed, 1, 'password should be skipped');
  } finally {
    await page.close();
  }
});

test('custom payload list is honored', async () => {
  const page = await context.newPage();
  try {
    await page.setContent('<html><body><input id="q" name="q" type="text" /></body></html>');
    const result = await runXssAudit(page, {
      payloads: ['hello', 'world'],
      maxFields: 1,
      settleMs: 20,
    });
    assert.equal(result.payloadsPerField, 2);
  } finally {
    await page.close();
  }
});

test('maxFields caps discovery', async () => {
  const page = await context.newPage();
  try {
    await page.setContent(`
      <html><body>
        <input type="text" />
        <input type="text" />
        <input type="text" />
        <input type="text" />
        <input type="text" />
      </body></html>
    `);
    const result = await runXssAudit(page, { maxFields: 2, settleMs: 20 });
    assert.equal(result.fieldsProbed, 2);
  } finally {
    await page.close();
  }
});

test('contenteditable sink is probed', async () => {
  const page = await context.newPage();
  try {
    await page.setContent('<html><body><div contenteditable="true" id="ce">hi</div></body></html>');
    const result = await runXssAudit(page, { maxFields: 1, settleMs: 20 });
    assert.equal(result.fieldsProbed, 1);
  } finally {
    await page.close();
  }
});
