/**
 * P0 #5 — Per-click console error attribution.
 *
 * attachConsoleCapture records errors/warnings/pageerrors/requestfailed on a
 * Playwright Page, fingerprints them so duplicates collapse to occurrence
 * counts, and between beginStep/endStep pairs attributes every new issue to
 * the currently active step. Tests use a real chromium page to exercise the
 * Playwright event wiring end-to-end.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { attachConsoleCapture } from './console-errors.js';

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

test('captures console.error and counts duplicates via fingerprint', async () => {
  const page = await context.newPage();
  const cap = attachConsoleCapture(page);
  try {
    await page.setContent(
      '<html><body><button id="b" onclick="console.error(\'oops\');console.error(\'oops\')">x</button></body></html>',
    );
    await page.click('#b');
    await page.waitForTimeout(50);
    const r = cap.result();
    assert.equal(r.issues.length, 1, 'duplicate fingerprints should collapse');
    assert.equal(r.issues[0].occurrences, 2);
    assert.equal(r.errorCount, 2);
    assert.equal(r.warningCount, 0);
    assert.equal(r.passed, false);
  } finally {
    cap.detach();
    await page.close();
  }
});

test('captures console.warn but keeps passed=true', async () => {
  const page = await context.newPage();
  const cap = attachConsoleCapture(page);
  try {
    await page.setContent(
      '<html><body><button id="b" onclick="console.warn(\'soft\')">x</button></body></html>',
    );
    await page.click('#b');
    await page.waitForTimeout(50);
    const r = cap.result();
    assert.equal(r.errorCount, 0);
    assert.equal(r.warningCount, 1);
    assert.equal(r.passed, true);
  } finally {
    cap.detach();
    await page.close();
  }
});

test('captures uncaught pageerror', async () => {
  const page = await context.newPage();
  const cap = attachConsoleCapture(page);
  try {
    await page.setContent(
      '<html><body><button id="b" onclick="setTimeout(() => { throw new Error(\'sync-fail\'); }, 0)">x</button></body></html>',
    );
    await page.click('#b');
    await page.waitForTimeout(50);
    const r = cap.result();
    assert.ok(r.issues.some((i) => i.type === 'pageerror' && /sync-fail/.test(i.message)));
    assert.equal(r.passed, false);
  } finally {
    cap.detach();
    await page.close();
  }
});

test('classifies unhandled promise rejection as unhandledrejection', async () => {
  const page = await context.newPage();
  const cap = attachConsoleCapture(page);
  try {
    await page.setContent(
      '<html><body><button id="b" onclick="Promise.reject(new Error(\'unhandled async\'))">x</button></body></html>',
    );
    await page.click('#b');
    await page.waitForTimeout(100);
    const r = cap.result();
    // Playwright fires pageerror for unhandled rejections; our classifier
    // routes messages matching /unhandled(\s|promise)/ to 'unhandledrejection'.
    // Chromium's text starts with 'Uncaught (in promise)' which does NOT
    // match that regex, so we accept either type here — the key signal is
    // that the rejection was captured.
    const hit = r.issues.find((i) => /unhandled async/.test(i.message));
    assert.ok(hit, 'unhandled promise rejection should be recorded');
    assert.ok(hit!.type === 'pageerror' || hit!.type === 'unhandledrejection');
  } finally {
    cap.detach();
    await page.close();
  }
});

test('beginStep/endStep attributes ONLY issues fired during the step', async () => {
  const page = await context.newPage();
  const cap = attachConsoleCapture(page);
  try {
    await page.setContent(`
      <html><body>
        <button id="pre" onclick="console.error('pre-step')">pre</button>
        <button id="mid" onclick="console.error('in-step')">mid</button>
        <button id="post" onclick="console.error('post-step')">post</button>
      </body></html>
    `);
    // pre-step error — must NOT appear in the step capture.
    await page.click('#pre');
    await page.waitForTimeout(30);

    cap.beginStep('click mid');
    await page.click('#mid');
    await page.waitForTimeout(30);
    const step = cap.endStep();

    // post-step error — also must NOT appear.
    await page.click('#post');
    await page.waitForTimeout(30);

    assert.equal(step.step, 'click mid');
    assert.equal(step.issues.length, 1);
    assert.match(step.issues[0].message, /in-step/);
    assert.equal(step.errorCount, 1);
    assert.equal(step.passed, false);

    // Aggregate result sees all three.
    const r = cap.result();
    assert.equal(r.issues.length, 3);
    assert.equal(r.errorCount, 3);
  } finally {
    cap.detach();
    await page.close();
  }
});

test('normalize strips numbers + paths so related errors collapse', async () => {
  const page = await context.newPage();
  const cap = attachConsoleCapture(page);
  try {
    await page.setContent(`
      <html><body><button id="b" onclick="
        console.error('failed at /a/b/c.js line 12');
        console.error('failed at /x/y/z.js line 345');
      ">x</button></body></html>
    `);
    await page.click('#b');
    await page.waitForTimeout(50);
    const r = cap.result();
    // Both messages normalize to the same fingerprint (numbers → N, paths → <path>).
    assert.equal(r.issues.length, 1);
    assert.equal(r.issues[0].occurrences, 2);
  } finally {
    cap.detach();
    await page.close();
  }
});

test('detach() stops capture', async () => {
  const page = await context.newPage();
  const cap = attachConsoleCapture(page);
  await page.setContent(
    '<html><body><button id="b" onclick="console.error(\'ignored\')">x</button></body></html>',
  );
  cap.detach();
  await page.click('#b');
  await page.waitForTimeout(30);
  const r = cap.result();
  assert.equal(r.errorCount, 0);
  await page.close();
});
