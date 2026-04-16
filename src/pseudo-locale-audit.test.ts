/**
 * P6 #51 — Pseudo-locale audit tests.
 *
 * Real Chromium is used for all browser-side tests.
 * One purely-unit test (toPseudoLocale) runs without a browser.
 *
 * Run with:  node --test dist/pseudo-locale-audit.test.js
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import {
  toPseudoLocale,
  runPseudoLocaleAudit,
  PSEUDO_CHAR_MAP,
} from './pseudo-locale-audit.js';

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

// ─── Test 1: pure unit — toPseudoLocale ──────────────────────────────────────

test('toPseudoLocale: transforms letters, stretches length, wraps', () => {
  const original = 'Hello';
  const result = toPseudoLocale(original);

  // Wrapped in default brackets.
  assert.ok(result.startsWith('['), `expected '[' prefix, got: ${result}`);
  assert.ok(result.endsWith(']'), `expected ']' suffix, got: ${result}`);

  // Contains accented chars (not unchanged ASCII letters in the core text).
  // The mapped chars for H, e, l, l, o are Ħ, é, ĺ, ĺ, ó respectively.
  const inner = result.slice(1, -1); // strip brackets
  assert.ok(inner.includes('Ħ') || inner.includes('é'), `expected accented chars in: ${inner}`);

  // Total length (including brackets) should be ≥ original.length * 1.5.
  const minLen = Math.round(original.length * 1.5) + 2; // +2 for brackets
  assert.ok(
    result.length >= minLen,
    `expected length ≥ ${minLen}, got ${result.length}: ${result}`,
  );

  // Digits pass through unchanged.
  const withDigit = toPseudoLocale('ab12');
  assert.ok(withDigit.includes('12'), `digits should pass through: ${withDigit}`);

  // Custom wrap chars.
  const custom = toPseudoLocale('Hi', { wrap: ['{', '}'] });
  assert.ok(custom.startsWith('{') && custom.endsWith('}'), `custom wrap failed: ${custom}`);

  // Custom stretch factor.
  const stretched = toPseudoLocale('ab', { stretchFactor: 2 });
  // "ab" → "áƀ" + padding to 4 chars + brackets → length ≥ 6
  assert.ok(stretched.length >= 6, `expected ≥ 6 chars, got ${stretched.length}: ${stretched}`);
});

// ─── Test 2: PSEUDO_CHAR_MAP coverage ────────────────────────────────────────

test('PSEUDO_CHAR_MAP: all 52 ASCII letters have a mapping', () => {
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const upper = lower.toUpperCase();
  const allLetters = lower + upper;

  assert.equal(
    Object.keys(PSEUDO_CHAR_MAP).length,
    52,
    `expected exactly 52 keys, got ${Object.keys(PSEUDO_CHAR_MAP).length}`,
  );

  for (const ch of allLetters) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(PSEUDO_CHAR_MAP, ch),
      `PSEUDO_CHAR_MAP missing key: '${ch}'`,
    );
    const val = (PSEUDO_CHAR_MAP as Record<string, string>)[ch];
    assert.ok(
      typeof val === 'string' && val.length > 0,
      `PSEUDO_CHAR_MAP['${ch}'] is empty or undefined`,
    );
  }
});

// ─── Test 3: flexible button — zero issues ────────────────────────────────────

test('flexible button with ample width: zero issues', async () => {
  const page = await context.newPage();
  try {
    await page.setContent(`
      <html><body>
        <div style="width:600px;padding:20px;">
          <button style="width:400px;padding:8px 16px;overflow:visible;">Submit</button>
        </div>
      </body></html>
    `);
    const result = await runPseudoLocaleAudit(page);
    const btnIssues = result.issues.filter(
      (i) => i.kind === 'clipped-button' || i.kind === 'truncated-text',
    );
    assert.equal(
      btnIssues.length,
      0,
      `expected no button/truncation issues on wide button, got: ${JSON.stringify(btnIssues, null, 2)}`,
    );
  } finally {
    await page.close();
  }
});

// ─── Test 4: narrow button — flags clipped-button or truncated-text ───────────

test('narrow button with overflow:hidden: flags clipped-button or truncated-text', async () => {
  const page = await context.newPage();
  try {
    await page.setContent(`
      <html><body>
        <button id="narrow" style="width:60px;overflow:hidden;white-space:nowrap;">Submit</button>
      </body></html>
    `);
    const result = await runPseudoLocaleAudit(page, { stretchFactor: 2.5 });
    const btnIssues = result.issues.filter(
      (i) => i.kind === 'clipped-button' || i.kind === 'truncated-text',
    );
    assert.ok(
      btnIssues.length > 0,
      `expected at least one clipped-button/truncated-text issue, got: ${JSON.stringify(result.issues, null, 2)}`,
    );
  } finally {
    await page.close();
  }
});

// ─── Test 5: overflowing container ───────────────────────────────────────────

test('height-clamped container with overflow:hidden: flags overflowing-container or truncated-text', async () => {
  const page = await context.newPage();
  try {
    // The container is narrow and height-clamped with overflow:hidden on both axes.
    // After pseudo-localization the stretched text will overflow either
    // horizontally (truncated-text) or vertically (overflowing-container)
    // depending on whether the browser wraps the text first.
    // Either signal confirms the audit correctly detected the breakage.
    await page.setContent(`
      <html><body>
        <div id="box" style="height:20px;overflow:hidden;width:200px;word-wrap:break-word;overflow-y:hidden;overflow-x:hidden;">
          Short text that will grow a lot after pseudo-localization
        </div>
      </body></html>
    `);
    const result = await runPseudoLocaleAudit(page, { stretchFactor: 3 });
    const containerIssues = result.issues.filter(
      (i) => i.kind === 'overflowing-container' || i.kind === 'truncated-text',
    );
    assert.ok(
      containerIssues.length > 0,
      `expected at least one overflow issue, got: ${JSON.stringify(result.issues, null, 2)}`,
    );
  } finally {
    await page.close();
  }
});

// ─── Test 6: maxElements cap ──────────────────────────────────────────────────

test('maxElements option caps the number of transformed nodes', async () => {
  const page = await context.newPage();
  try {
    // Build 20 paragraphs so there are more text nodes than the cap.
    const items = Array.from({ length: 20 }, (_, i) => `<p>Paragraph number ${i + 1}</p>`).join('\n');
    await page.setContent(`<html><body>${items}</body></html>`);

    const result = await runPseudoLocaleAudit(page, { maxElements: 5 });
    assert.ok(
      result.nodesTransformed <= 5,
      `expected ≤ 5 nodes transformed, got ${result.nodesTransformed}`,
    );
  } finally {
    await page.close();
  }
});

// ─── Test 7: restoration — body text returns to original after audit ──────────

test('audit is non-destructive: original text restored after scan', async () => {
  const page = await context.newPage();
  try {
    await page.setContent(`
      <html><body>
        <p id="greeting">Hello world</p>
        <button>Click me</button>
      </body></html>
    `);

    await runPseudoLocaleAudit(page);

    // After the audit the original text must be back.
    const greetingText = await page.evaluate(
      () => document.getElementById('greeting')?.textContent ?? '',
    );
    assert.equal(
      greetingText.trim(),
      'Hello world',
      `expected restored text "Hello world", got: "${greetingText}"`,
    );

    const btnText = await page.evaluate(
      () => (document.querySelector('button') as HTMLButtonElement | null)?.textContent ?? '',
    );
    assert.equal(
      btnText.trim(),
      'Click me',
      `expected restored button text "Click me", got: "${btnText}"`,
    );

    // No data-uxi-plid attributes should linger.
    const leftover = await page.evaluate(
      () => document.querySelectorAll('[data-uxi-plid]').length,
    );
    assert.equal(leftover, 0, `expected 0 leftover data-uxi-plid attrs, found ${leftover}`);
  } finally {
    await page.close();
  }
});

// ─── Test 8: skipSelectors honored ───────────────────────────────────────────

test('text inside <code> is not transformed when code is in skipSelectors', async () => {
  const page = await context.newPage();
  try {
    await page.setContent(`
      <html><body>
        <p id="normal">Normal paragraph</p>
        <code id="code-block">function hello() { return "hi"; }</code>
      </body></html>
    `);

    // Run with the default skipSelectors (which includes 'code').
    await runPseudoLocaleAudit(page);

    // The code element's text must be unchanged.
    const codeText = await page.evaluate(
      () => (document.getElementById('code-block') as HTMLElement | null)?.textContent ?? '',
    );
    assert.equal(
      codeText,
      'function hello() { return "hi"; }',
      `code text should be unchanged, got: "${codeText}"`,
    );

    // The normal paragraph must also be restored (non-destructive check).
    const normalText = await page.evaluate(
      () => (document.getElementById('normal') as HTMLElement | null)?.textContent ?? '',
    );
    assert.equal(
      normalText.trim(),
      'Normal paragraph',
      `normal paragraph should be restored, got: "${normalText}"`,
    );
  } finally {
    await page.close();
  }
});
