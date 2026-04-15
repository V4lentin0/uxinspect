import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import { auditDisabledButtons } from './disabled-buttons-audit.js';

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

describe('auditDisabledButtons', () => {
  test('custom role=button with [disabled] attr still responds and is flagged', async () => {
    const page = await newPage();
    try {
      // Real bug: dev applied `disabled` to a non-native-button <div role="button">.
      // `disabled` has no native semantics on a div, so the click handler fires.
      await page.setContent(`
        <html><body>
          <div id="bad" role="button" disabled tabindex="0">bad</div>
          <script>
            document.getElementById('bad').addEventListener('click', () => {
              for (let i = 0; i < 6; i++) {
                document.body.appendChild(document.createElement('div'));
              }
            });
          </script>
        </body></html>
      `);
      const result = await auditDisabledButtons(page);
      assert.equal(result.checked, 1);
      assert.equal(result.passed, false);
      assert.ok(result.responded.length >= 1, 'expected a finding for disabled button');
      const finding = result.responded[0]!;
      assert.ok(['dom', 'console', 'network', 'url'].includes(finding.what));
      assert.ok(finding.selector.includes('bad'));
    } finally {
      await page.close();
    }
  });

  test('truly inert disabled button with pointer-events:none and no handler is NOT flagged', async () => {
    const page = await newPage();
    try {
      await page.setContent(`
        <html>
          <head><style>button[disabled]{pointer-events:none;}</style></head>
          <body>
            <button id="ok" disabled>ok</button>
          </body>
        </html>
      `);
      const result = await auditDisabledButtons(page);
      assert.equal(result.checked, 1);
      assert.equal(result.passed, true);
      assert.equal(result.responded.length, 0);
    } finally {
      await page.close();
    }
  });

  test('aria-disabled=true element that emits console.error on click is flagged', async () => {
    const page = await newPage();
    try {
      await page.setContent(`
        <html><body>
          <div id="aria" role="button" aria-disabled="true" tabindex="0">aria</div>
          <script>
            document.getElementById('aria').addEventListener('click', () => {
              console.error('should-not-fire');
            });
          </script>
        </body></html>
      `);
      const result = await auditDisabledButtons(page);
      assert.equal(result.checked, 1);
      assert.equal(result.passed, false);
      assert.ok(result.responded.length >= 1);
      const finding = result.responded[0]!;
      assert.equal(finding.what, 'console');
      assert.ok(finding.evidence.includes('should-not-fire'));
    } finally {
      await page.close();
    }
  });

  test('maxButtons guard skips when too many disabled elements', async () => {
    const page = await newPage();
    try {
      const many = Array.from({ length: 6 }, (_, i) => `<button disabled id="b${i}">x</button>`).join('');
      await page.setContent(`<html><body>${many}</body></html>`);
      const result = await auditDisabledButtons(page, { maxButtons: 3 });
      assert.equal(result.checked, 0);
      assert.equal(result.passed, true);
      assert.ok(result.skipped);
      assert.equal(result.skipped!.reason, 'too-many-buttons');
      assert.equal(result.skipped!.max, 3);
      assert.ok(result.skipped!.total > 3);
    } finally {
      await page.close();
    }
  });

  test('ignores non-interactive disabled elements (e.g. <fieldset disabled>)', async () => {
    const page = await newPage();
    try {
      await page.setContent(`
        <html><body>
          <fieldset disabled><legend>inert</legend><span>x</span></fieldset>
        </body></html>
      `);
      const result = await auditDisabledButtons(page);
      // fieldset is not in our interactive allowlist, so nothing gets checked
      assert.equal(result.checked, 0);
      assert.equal(result.passed, true);
    } finally {
      await page.close();
    }
  });
});
