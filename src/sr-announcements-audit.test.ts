/**
 * P6 #50 — Virtual screen-reader announcements audit tests.
 *
 * Each test loads an inline HTML fixture into a real Chromium page and verifies
 * the computed announcements + issues produced by runSrAnnouncementsAudit.
 *
 * Run via: node --test dist/sr-announcements-audit.test.js
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { runSrAnnouncementsAudit } from './sr-announcements-audit.js';

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

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Button with clear visible text → correct announcement, zero issues
// ─────────────────────────────────────────────────────────────────────────────
test('button with visible text: correct announcement, no issues', async () => {
  const page = await freshPage(`
    <html><body>
      <button id="submit-btn">Submit form</button>
    </body></html>
  `);
  try {
    const result = await runSrAnnouncementsAudit(page, {
      includeLandmarks: false,
      includeLiveRegions: false,
    });

    assert.ok(result.targetsProbed >= 1, 'should probe at least the button');

    const ann = result.announcements.find((a) => a.selector === '#submit-btn');
    assert.ok(ann, 'should have an announcement for #submit-btn');
    assert.equal(ann!.role, 'button');
    assert.equal(ann!.name, 'Submit form');
    assert.ok(
      ann!.announcement.includes('Submit form'),
      `announcement "${ann!.announcement}" should contain the visible text`,
    );
    assert.ok(
      ann!.announcement.includes('button'),
      `announcement "${ann!.announcement}" should include role`,
    );

    const btnIssues = result.issues.filter((i) => i.selector === '#submit-btn');
    assert.equal(btnIssues.length, 0, `expected no issues for labeled button, got: ${JSON.stringify(btnIssues)}`);
    assert.equal(result.passed, true);
    assert.ok(result.checkedAt, 'checkedAt should be set');
  } finally {
    await page.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: Icon-only button (no accessible name) → flags missing-accessible-name
// ─────────────────────────────────────────────────────────────────────────────
test('icon-only button with no accessible name: flags missing-accessible-name', async () => {
  const page = await freshPage(`
    <html><body>
      <button id="icon-btn">
        <svg aria-hidden="true" width="16" height="16"><path d="M0 0"/></svg>
      </button>
    </body></html>
  `);
  try {
    const result = await runSrAnnouncementsAudit(page, {
      includeLandmarks: false,
      includeLiveRegions: false,
    });

    const issue = result.issues.find(
      (i) => i.kind === 'missing-accessible-name' && i.selector === '#icon-btn',
    );
    assert.ok(
      issue,
      `expected missing-accessible-name for icon-only button, issues: ${JSON.stringify(result.issues)}`,
    );
    assert.equal(result.passed, false);
  } finally {
    await page.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: role="checkbox" without aria-checked → flags role-without-state
// ─────────────────────────────────────────────────────────────────────────────
test('role=checkbox without aria-checked: flags role-without-state', async () => {
  const page = await freshPage(`
    <html><body>
      <div id="custom-check" role="checkbox" tabindex="0">Accept terms</div>
    </body></html>
  `);
  try {
    const result = await runSrAnnouncementsAudit(page, {
      includeLandmarks: false,
      includeLiveRegions: false,
    });

    const issue = result.issues.find(
      (i) => i.kind === 'role-without-state' && i.selector === '#custom-check',
    );
    assert.ok(
      issue,
      `expected role-without-state for custom checkbox, issues: ${JSON.stringify(result.issues)}`,
    );
    assert.ok(
      issue!.detail.includes('aria-checked'),
      `detail should mention aria-checked, got: "${issue!.detail}"`,
    );
    assert.equal(result.passed, false);
  } finally {
    await page.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: Empty aria-live region at load time → flags empty-live-region
// ─────────────────────────────────────────────────────────────────────────────
test('empty aria-live region at load: flags empty-live-region', async () => {
  const page = await freshPage(`
    <html><body>
      <div id="status-msg" aria-live="polite"></div>
      <button>Do action</button>
    </body></html>
  `);
  try {
    const result = await runSrAnnouncementsAudit(page, {
      includeLandmarks: false,
      includeLiveRegions: true,
    });

    const issue = result.issues.find(
      (i) => i.kind === 'empty-live-region' && i.selector === '#status-msg',
    );
    assert.ok(
      issue,
      `expected empty-live-region for #status-msg, issues: ${JSON.stringify(result.issues)}`,
    );
    assert.equal(result.passed, false);
  } finally {
    await page.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: Two <nav> elements with no labels → flags landmark-unlabeled for both
// ─────────────────────────────────────────────────────────────────────────────
test('two unlabeled nav landmarks: flags landmark-unlabeled for each', async () => {
  const page = await freshPage(`
    <html><body>
      <nav id="nav1"><a href="/home">Home</a></nav>
      <nav id="nav2"><a href="/about">About</a></nav>
      <main><p>Content</p></main>
    </body></html>
  `);
  try {
    const result = await runSrAnnouncementsAudit(page, {
      includeLandmarks: true,
      includeLiveRegions: false,
    });

    const landmarkIssues = result.issues.filter((i) => i.kind === 'landmark-unlabeled');
    assert.ok(
      landmarkIssues.length >= 2,
      `expected at least 2 landmark-unlabeled issues, got ${landmarkIssues.length}: ${JSON.stringify(landmarkIssues)}`,
    );
    const selectors = landmarkIssues.map((i) => i.selector);
    assert.ok(selectors.some((s) => s.includes('nav1')), 'should flag #nav1');
    assert.ok(selectors.some((s) => s.includes('nav2')), 'should flag #nav2');
    assert.equal(result.passed, false);
  } finally {
    await page.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: maxTargets cap is honored
// ─────────────────────────────────────────────────────────────────────────────
test('maxTargets cap is honored', async () => {
  const page = await freshPage(`
    <html><body>
      <button>A</button>
      <button>B</button>
      <button>C</button>
      <button>D</button>
      <button>E</button>
      <button>F</button>
      <button>G</button>
      <button>H</button>
      <button>I</button>
      <button>J</button>
    </body></html>
  `);
  try {
    const result = await runSrAnnouncementsAudit(page, {
      maxTargets: 4,
      includeLandmarks: false,
      includeLiveRegions: false,
    });

    assert.equal(result.targetsProbed, 4, `expected 4 targets (capped), got ${result.targetsProbed}`);
  } finally {
    await page.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7: aria-labelledby resolution
// ─────────────────────────────────────────────────────────────────────────────
test('aria-labelledby resolves to referenced element text', async () => {
  const page = await freshPage(`
    <html><body>
      <span id="dialog-title">Confirm deletion</span>
      <button id="confirm-btn" aria-labelledby="dialog-title">OK</button>
    </body></html>
  `);
  try {
    const result = await runSrAnnouncementsAudit(page, {
      includeLandmarks: false,
      includeLiveRegions: false,
    });

    const ann = result.announcements.find((a) => a.selector === '#confirm-btn');
    assert.ok(ann, 'should find announcement for #confirm-btn');
    assert.equal(
      ann!.name,
      'Confirm deletion',
      `name should be resolved from aria-labelledby, got "${ann!.name}"`,
    );
    assert.ok(
      ann!.announcement.includes('Confirm deletion'),
      `announcement "${ann!.announcement}" should contain resolved label`,
    );

    const nameIssues = result.issues.filter(
      (i) => i.kind === 'missing-accessible-name' && i.selector === '#confirm-btn',
    );
    assert.equal(nameIssues.length, 0, 'should not flag missing name when aria-labelledby resolves');
  } finally {
    await page.close();
  }
});
