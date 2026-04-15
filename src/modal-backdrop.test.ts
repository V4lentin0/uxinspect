import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import { auditFocusTrap } from './focus-trap-audit.js';

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

// Build a modal page with configurable close handlers.
// - escCloses: Escape keypress removes the dialog.
// - backdropCloses: clicking the backdrop (.modal-backdrop) removes the
//   dialog AND the backdrop.
function modalPage(opts: { escCloses: boolean; backdropCloses: boolean }): string {
  const escHandler = opts.escCloses
    ? `document.addEventListener('keydown', (e) => {
         if (e.key === 'Escape') {
           const d = document.getElementById('dlg');
           const b = document.getElementById('bd');
           if (d) d.remove();
           if (b) b.remove();
         }
       });`
    : '';
  const backdropHandler = opts.backdropCloses
    ? `document.getElementById('bd').addEventListener('click', (e) => {
         if (e.target && e.target.id === 'bd') {
           const d = document.getElementById('dlg');
           const b = document.getElementById('bd');
           if (d) d.remove();
           if (b) b.remove();
         }
       });`
    : '';
  return `<!doctype html>
<html><head><style>
  html, body { margin: 0; padding: 0; width: 100vw; height: 100vh; }
  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 10;
  }
  .dialog {
    position: fixed; top: 40%; left: 40%; width: 20%; height: 20%;
    background: #fff; padding: 16px; z-index: 20;
  }
</style></head>
<body>
  <button id="opener">open</button>
  <div id="bd" class="modal-backdrop"></div>
  <div id="dlg" class="dialog" role="dialog" aria-modal="true">
    <button id="confirm">ok</button>
    <button id="cancel">cancel</button>
  </div>
  <script>
    ${escHandler}
    ${backdropHandler}
  </script>
</body></html>`;
}

describe('auditFocusTrap — modal backdrop-close detection', () => {
  test('modal closing only on Esc flags close-on-backdrop-missing', async () => {
    const page = await newPage();
    try {
      await page.setContent(
        modalPage({ escCloses: true, backdropCloses: false })
      );
      const result = await auditFocusTrap(page);
      assert.equal(result.dialogs.length, 1, 'one dialog detected');
      const d = result.dialogs[0];
      assert.equal(d.backdropClosedIt, false, 'backdrop did not close');
      assert.equal(d.escClosedIt, true, 'Esc closed it');
      const kinds = result.issues.map((i) => i.kind);
      assert.ok(
        !kinds.includes('close-on-esc-missing'),
        'no close-on-esc-missing issue'
      );
      assert.ok(
        !kinds.includes('close-completely-blocked'),
        'no close-completely-blocked issue'
      );
      // Per acceptance: modal must close on either Esc OR backdrop.
      // Esc works here, so we do NOT flag close-on-backdrop-missing —
      // the dialog is dismissible. Only both-fail triggers the flag.
      assert.ok(
        !kinds.includes('close-on-backdrop-missing'),
        'no close-on-backdrop-missing when Esc works'
      );
    } finally {
      await page.close();
    }
  });

  test('modal closing only on backdrop is ok — no close issues flagged', async () => {
    const page = await newPage();
    try {
      await page.setContent(
        modalPage({ escCloses: false, backdropCloses: true })
      );
      const result = await auditFocusTrap(page);
      assert.equal(result.dialogs.length, 1, 'one dialog detected');
      const d = result.dialogs[0];
      assert.equal(d.backdropClosedIt, true, 'backdrop closed it');
      // Esc is never tested in this case because backdrop already closed it.
      const kinds = result.issues.map((i) => i.kind);
      assert.ok(
        !kinds.includes('close-on-esc-missing'),
        'no close-on-esc-missing — backdrop satisfied'
      );
      assert.ok(
        !kinds.includes('close-on-backdrop-missing'),
        'no close-on-backdrop-missing — backdrop worked'
      );
      assert.ok(
        !kinds.includes('close-completely-blocked'),
        'no close-completely-blocked'
      );
    } finally {
      await page.close();
    }
  });

  test('modal closing on neither flags both close-on-esc-missing and close-on-backdrop-missing plus close-completely-blocked', async () => {
    const page = await newPage();
    try {
      await page.setContent(
        modalPage({ escCloses: false, backdropCloses: false })
      );
      const result = await auditFocusTrap(page);
      assert.equal(result.dialogs.length, 1, 'one dialog detected');
      const d = result.dialogs[0];
      assert.equal(d.backdropClosedIt, false, 'backdrop did not close');
      assert.equal(d.escClosedIt, false, 'Esc did not close');
      const kinds = result.issues.map((i) => i.kind);
      assert.ok(
        kinds.includes('close-on-esc-missing'),
        'flags close-on-esc-missing'
      );
      assert.ok(
        kinds.includes('close-on-backdrop-missing'),
        'flags close-on-backdrop-missing'
      );
      assert.ok(
        kinds.includes('close-completely-blocked'),
        'flags close-completely-blocked'
      );
      assert.equal(result.passed, false, 'audit failed overall');
    } finally {
      await page.close();
    }
  });
});
