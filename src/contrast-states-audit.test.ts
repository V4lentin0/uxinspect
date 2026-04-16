import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { runContrastStatesAudit } from './contrast-states-audit.js';

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

describe('runContrastStatesAudit — WCAG math', () => {
  test('perfect black-on-white button passes AA and AAA on every state', async () => {
    const page = await freshPage(`
      <html><body style="background:#ffffff;margin:40px;font-family:sans-serif">
        <button id="b" style="
          background:#ffffff;
          color:#000000;
          padding:12px 20px;
          border:1px solid #000;
          font-size:16px;
          outline-offset:2px;
        ">Save changes</button>
      </body></html>
    `);
    try {
      const aa = await runContrastStatesAudit(page, { targetLevel: 'AA' });
      assert.equal(aa.scanned, 1);
      assert.equal(aa.passed, true);
      assert.equal(aa.violations.length, 0);
      assert.equal(aa.targetLevel, 'AA');

      const aaa = await runContrastStatesAudit(page, { targetLevel: 'AAA' });
      assert.equal(aaa.passed, true);
      assert.equal(aaa.violations.length, 0);
    } finally {
      await page.close();
    }
  });

  test('low-contrast grey-on-white text fails AA and reports ratio + colours', async () => {
    // #AAAAAA on #FFFFFF = ~2.32:1, well below 4.5.
    const page = await freshPage(`
      <html><body style="background:#ffffff;margin:40px">
        <button id="b" style="background:#ffffff;color:#aaaaaa;padding:8px 16px;font-size:14px">
          Submit
        </button>
      </body></html>
    `);
    try {
      const res = await runContrastStatesAudit(page, { targetLevel: 'AA', states: ['default'] });
      assert.equal(res.passed, false);
      assert.ok(res.violations.length >= 1, 'expected a text contrast violation');
      const v = res.violations.find(x => x.kind === 'text' && x.state === 'default');
      assert.ok(v, 'expected default-state text violation');
      assert.equal(v!.level, 'AA');
      assert.equal(v!.required, 4.5);
      assert.ok(v!.ratio < 4.5, `ratio ${v!.ratio} should be < 4.5`);
      assert.ok(v!.ratio > 2 && v!.ratio < 3, `ratio ${v!.ratio} should be ~2.32 for #aaa on #fff`);
      assert.equal(v!.isLarge, false);
      assert.equal(v!.background.toLowerCase(), '#ffffff');
      assert.equal(v!.foreground.toLowerCase(), '#aaaaaa');
    } finally {
      await page.close();
    }
  });

  test('large text (24px) uses the 3:1 AA threshold, not 4.5', async () => {
    // #888888 on #FFFFFF = ~3.54:1. Fails AA for normal text, passes AA for large.
    const page = await freshPage(`
      <html><body style="background:#fff;margin:40px">
        <button id="small" style="background:#fff;color:#888;font-size:14px;padding:4px">small</button>
        <button id="big" style="background:#fff;color:#888;font-size:24px;padding:4px">big</button>
      </body></html>
    `);
    try {
      const res = await runContrastStatesAudit(page, { targetLevel: 'AA', states: ['default'] });
      const small = res.violations.find(v => v.selector.includes('small'));
      const big = res.violations.find(v => v.selector.includes('big'));
      assert.ok(small, 'small text should violate AA at ~3.54:1');
      assert.equal(small!.isLarge, false);
      assert.equal(small!.required, 4.5);
      // 24px passes the 3:1 large threshold, so it should not violate.
      assert.equal(big, undefined, 'large 24px text at ~3.54:1 passes AA');
    } finally {
      await page.close();
    }
  });

  test('skip selectors exclude elements from the scan', async () => {
    const page = await freshPage(`
      <html><body style="background:#fff">
        <button id="bad1" class="skipme" style="background:#fff;color:#ccc">a</button>
        <button id="bad2" style="background:#fff;color:#ccc">b</button>
      </body></html>
    `);
    try {
      const res = await runContrastStatesAudit(page, {
        targetLevel: 'AA',
        skip: ['.skipme'],
        states: ['default'],
      });
      assert.equal(res.scanned, 1);
      // Only #bad2 should be flagged, #bad1 is skipped.
      assert.ok(res.violations.every(v => !v.selector.includes('bad1')));
    } finally {
      await page.close();
    }
  });

  test('disabled state is only reported for elements that are actually disabled', async () => {
    const page = await freshPage(`
      <html><body style="background:#fff">
        <button id="enabled" style="background:#fff;color:#000">ok</button>
        <button id="dis" disabled style="background:#fff;color:#ddd">nope</button>
      </body></html>
    `);
    try {
      const res = await runContrastStatesAudit(page, {
        targetLevel: 'AA',
        states: ['default', 'disabled'],
      });
      // stateCounts.disabled counts only the truly disabled element.
      assert.equal(res.stateCounts.disabled, 1);
      assert.equal(res.stateCounts.default, 2);
      // The disabled button (#ddd on #fff ~= 1.5:1) fails.
      const disViolations = res.violations.filter(v => v.state === 'disabled');
      assert.ok(disViolations.length >= 1, 'disabled element with low contrast should fail');
    } finally {
      await page.close();
    }
  });

  test('focus ring below 3:1 vs surface is flagged as focus-ring kind', async () => {
    // Pale-blue outline (#cfe8ff ~= 1.3:1 on white) should trip the 3:1 focus rule.
    const page = await freshPage(`
      <html>
        <head><style>
          #r:focus { outline: 3px solid #cfe8ff; outline-offset: 0; }
        </style></head>
        <body style="background:#ffffff;margin:40px">
          <button id="r" style="background:#ffffff;color:#000000">focus me</button>
        </body>
      </html>
    `);
    try {
      const res = await runContrastStatesAudit(page, { targetLevel: 'AA', states: ['focus'] });
      const ring = res.violations.find(v => v.kind === 'focus-ring' && v.state === 'focus');
      assert.ok(ring, 'expected focus-ring violation for pale outline');
      assert.equal(ring!.required, 3);
      assert.ok(ring!.ratio < 3, `ring ratio ${ring!.ratio} should be below 3:1`);
    } finally {
      await page.close();
    }
  });

  test('transparent background walks up to ancestor and still measures contrast', async () => {
    // Inner button has transparent bg; ancestor provides the real surface.
    const page = await freshPage(`
      <html><body style="background:#222222;margin:0">
        <div style="background:#222222;padding:20px">
          <button id="b" style="background:transparent;color:#333333;padding:8px">low</button>
        </div>
      </body></html>
    `);
    try {
      const res = await runContrastStatesAudit(page, { targetLevel: 'AA', states: ['default'] });
      const v = res.violations.find(x => x.kind === 'text' && x.state === 'default');
      assert.ok(v, 'expected a text contrast violation when background is inherited from ancestor');
      // #333 on #222 is extremely low contrast (~1.2:1).
      assert.ok(v!.ratio < 2, `ratio ${v!.ratio} should reflect ancestor bg, not page default`);
      assert.equal(v!.background.toLowerCase(), '#222222');
    } finally {
      await page.close();
    }
  });

  test('walker covers inputs, textareas, selects, and role=* widgets', async () => {
    const page = await freshPage(`
      <html><body style="background:#fff;margin:20px">
        <a href="#x" style="color:#000">link</a>
        <input type="text" value="x" style="color:#000;background:#fff" />
        <textarea style="color:#000;background:#fff">x</textarea>
        <select style="color:#000;background:#fff"><option>a</option></select>
        <div role="button" style="color:#000;background:#fff">r-btn</div>
        <div role="tab" style="color:#000;background:#fff">r-tab</div>
      </body></html>
    `);
    try {
      const res = await runContrastStatesAudit(page, { targetLevel: 'AA', states: ['default'] });
      assert.equal(res.scanned, 6);
      assert.equal(res.passed, true);
      assert.deepEqual(res.states, ['default']);
    } finally {
      await page.close();
    }
  });
});
