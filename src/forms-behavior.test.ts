import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { auditFormBehavior } from './forms-audit.js';

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

async function setup(html: string): Promise<Page> {
  const page = await context.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  return page;
}

describe('auditFormBehavior', () => {
  test('form with native + aria validation behaviour passes the cycle', async () => {
    const page = await setup(`
      <html><body>
        <form id="signup" novalidate>
          <label for="email">Email</label>
          <input id="email" name="email" type="email" required />
          <div id="email-error" role="alert" class="error" style="display:none"></div>
          <button type="submit" id="go">Sign up</button>
        </form>
        <script>
          const form = document.getElementById('signup');
          const input = document.getElementById('email');
          const err = document.getElementById('email-error');
          form.addEventListener('submit', (ev) => {
            ev.preventDefault();
            const v = input.value.trim();
            const okEmail = /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(v);
            if (!v) {
              input.setAttribute('aria-invalid', 'true');
              err.textContent = 'Email is required';
              err.style.display = 'block';
            } else if (!okEmail) {
              input.setAttribute('aria-invalid', 'true');
              err.textContent = 'Invalid email';
              err.style.display = 'block';
            } else {
              input.setAttribute('aria-invalid', 'false');
              err.textContent = '';
              err.style.display = 'none';
            }
          });
        </script>
      </body></html>
    `);
    try {
      const result = await auditFormBehavior(page);
      assert.equal(result.forms.length, 1, 'one form discovered');
      const f = result.forms[0]!;
      assert.equal(f.emptyShowsError, true, 'empty submit surfaces an error');
      assert.equal(f.invalidShowsError, true, 'invalid submit surfaces an error');
      assert.equal(f.validClearsError, true, 'valid submit clears the error');
      assert.deepEqual(f.missingBehavior, []);
      assert.equal(result.passed, true);
      assert.ok(!f.error);
    } finally {
      await page.close();
    }
  });

  test('form with broken validation (no error on empty submit) fails', async () => {
    const page = await setup(`
      <html><body>
        <form id="broken" novalidate>
          <label for="name">Name</label>
          <input id="name" name="name" type="text" />
          <button type="submit">Save</button>
        </form>
        <script>
          // Intentionally swallows the submit without surfacing any validation.
          document.getElementById('broken').addEventListener('submit', (ev) => {
            ev.preventDefault();
          });
        </script>
      </body></html>
    `);
    try {
      const result = await auditFormBehavior(page);
      assert.equal(result.forms.length, 1);
      const f = result.forms[0]!;
      assert.equal(f.emptyShowsError, false, 'no error surfaced on empty submit');
      assert.ok(f.missingBehavior.includes('no-error-on-empty-submit'));
      assert.equal(result.passed, false, 'overall result is failing');
    } finally {
      await page.close();
    }
  });

  test('formSelector scope only probes matching forms', async () => {
    const page = await setup(`
      <html><body>
        <form id="a">
          <input name="x" required />
          <button type="submit">A</button>
        </form>
        <form id="b" class="target">
          <input name="y" required />
          <button type="submit">B</button>
        </form>
      </body></html>
    `);
    try {
      const result = await auditFormBehavior(page, 'form.target');
      assert.equal(result.forms.length, 1, 'only the scoped form is audited');
      assert.ok(result.forms[0]!.selector.includes('#b'));
    } finally {
      await page.close();
    }
  });

  test('page with no forms returns empty, passing result', async () => {
    const page = await setup('<html><body><h1>nothing here</h1></body></html>');
    try {
      const result = await auditFormBehavior(page);
      assert.equal(result.forms.length, 0);
      assert.equal(result.passed, true);
    } finally {
      await page.close();
    }
  });
});
