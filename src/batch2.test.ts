import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { auditForms } from './forms-audit.js';
import { checkStructuredData } from './structured-data.js';
import { auditImages } from './image-audit.js';
import { checkOpenGraph } from './open-graph.js';

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

async function newPage(): Promise<Page> {
  return context.newPage();
}

describe('auditForms', () => {
  test('happy path: clean form with labels + autocomplete passes', async () => {
    const page = await newPage();
    try {
      await page.setContent(`
        <html><body>
          <form id="signin" action="/login" method="post">
            <label for="email">Email *</label>
            <input id="email" name="email" type="email" autocomplete="email" inputmode="email" required />
            <label for="pw">Password *</label>
            <input id="pw" name="password" type="password" autocomplete="current-password" required />
            <button type="submit">Sign in</button>
          </form>
        </body></html>
      `);
      const result = await auditForms(page);
      assert.equal(result.forms.length, 1);
      const form = result.forms[0];
      assert.equal(form.fields, 2);
      assert.equal(form.hasSubmitButton, true);
      assert.equal(form.method, 'POST');
      assert.equal(form.issues.length, 0);
      assert.equal(result.totalIssues, 0);
      assert.equal(result.passed, true);
      assert.equal(typeof result.page, 'string');
    } finally {
      await page.close();
    }
  });

  test('detects issues: unlabeled input and password without autocomplete', async () => {
    const page = await newPage();
    try {
      await page.setContent(`
        <html><body>
          <form id="bad">
            <input id="name" name="name" type="text" />
            <input id="pw" name="pw" type="password" />
            <button type="submit">Go</button>
          </form>
        </body></html>
      `);
      const result = await auditForms(page);
      assert.equal(result.forms.length, 1);
      const form = result.forms[0];
      const types = form.issues.map((i) => i.type);
      assert.ok(types.includes('missing-label'), 'expected missing-label issue');
      assert.ok(types.includes('missing-autocomplete'), 'expected missing-autocomplete issue');
      assert.ok(result.totalIssues >= 2);
      // missing-label is level 'error' so passed should be false
      assert.equal(result.passed, false);
    } finally {
      await page.close();
    }
  });
});

describe('checkStructuredData', () => {
  test('happy path: valid JSON-LD Organization', async () => {
    const page = await newPage();
    try {
      await page.setContent(`
        <html><head>
          <script type="application/ld+json">
            {"@context":"https://schema.org","@type":"Organization","name":"x","url":"https://example.com"}
          </script>
        </head><body><h1>Hi</h1></body></html>
      `);
      const result = await checkStructuredData(page);
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].format, 'json-ld');
      assert.equal(result.items[0].type, 'Organization');
      assert.equal(result.issues.length, 0);
      assert.equal(result.passed, true);
      assert.deepEqual(result.hreflangTags, []);
    } finally {
      await page.close();
    }
  });

  test('detects issues: broken JSON-LD emits invalid-json error', async () => {
    const page = await newPage();
    try {
      await page.setContent(`
        <html><head>
          <script type="application/ld+json">{ not valid json }</script>
        </head><body></body></html>
      `);
      const result = await checkStructuredData(page);
      const types = result.issues.map((i) => i.type);
      assert.ok(types.includes('invalid-json'), 'expected invalid-json issue');
      assert.equal(result.passed, false);
    } finally {
      await page.close();
    }
  });
});

describe('auditImages', () => {
  // 1x1 transparent PNG so the image actually "loads" (not broken)
  const TINY_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

  test('happy path: img with alt + dimensions has no missing-alt/broken', async () => {
    const page = await newPage();
    try {
      await page.setContent(`
        <html><body>
          <img id="a" src="${TINY_PNG}" alt="logo" width="100" height="100" />
        </body></html>
      `);
      // wait until image decodes
      await page
        .locator('#a')
        .evaluate((el: HTMLImageElement) => (el.complete ? null : new Promise((r) => (el.onload = () => r(null)))));
      const result = await auditImages(page);
      assert.equal(result.images.length, 1);
      const img = result.images[0];
      assert.equal(img.hasAlt, true);
      assert.equal(img.alt, 'logo');
      assert.equal(img.width, 100);
      assert.equal(img.height, 100);
      const types = result.issues.map((i) => i.type);
      assert.ok(!types.includes('missing-alt'));
      assert.ok(!types.includes('broken-image'));
      assert.ok(!types.includes('missing-dimensions'));
      assert.equal(result.passed, true);
      assert.equal(result.stats.total, 1);
      assert.equal(result.stats.withAlt, 1);
    } finally {
      await page.close();
    }
  });

  test('detects issues: img missing alt and missing dimensions', async () => {
    const page = await newPage();
    try {
      await page.setContent(`
        <html><body>
          <img id="b" src="/a.png" />
        </body></html>
      `);
      // give network attempt time to settle
      await page.waitForLoadState('domcontentloaded');
      const result = await auditImages(page);
      assert.equal(result.images.length, 1);
      const img = result.images[0];
      assert.equal(img.hasAlt, false);
      assert.equal(img.width, undefined);
      assert.equal(img.height, undefined);
      const types = result.issues.map((i) => i.type);
      assert.ok(types.includes('missing-alt'), 'expected missing-alt issue');
      assert.ok(types.includes('missing-dimensions'), 'expected missing-dimensions issue');
      // missing-alt flips passed to false
      assert.equal(result.passed, false);
    } finally {
      await page.close();
    }
  });
});

describe('checkOpenGraph', () => {
  test('happy path: page with all og + twitter tags has no core issues', async () => {
    const page = await newPage();
    try {
      await page.setContent(`
        <html><head>
          <meta property="og:title" content="Clean Title" />
          <meta property="og:description" content="A short description of the page." />
          <meta property="og:image" content="https://example.invalid/ignored-but-present.jpg" />
          <meta property="og:image:width" content="1200" />
          <meta property="og:image:height" content="630" />
          <meta property="og:url" content="https://example.com/" />
          <meta property="og:type" content="website" />
          <meta name="twitter:card" content="summary_large_image" />
        </head><body></body></html>
      `);
      const result = await checkOpenGraph(page);
      assert.equal(result.openGraph.title, 'Clean Title');
      assert.equal(result.openGraph.description, 'A short description of the page.');
      assert.equal(result.openGraph.image, 'https://example.invalid/ignored-but-present.jpg');
      assert.equal(result.openGraph.imageWidth, 1200);
      assert.equal(result.openGraph.imageHeight, 630);
      assert.equal(result.twitter.card, 'summary_large_image');
      const types = result.issues.map((i) => i.type);
      assert.ok(!types.includes('missing-og-title'));
      assert.ok(!types.includes('missing-og-description'));
      assert.ok(!types.includes('missing-og-image'));
      assert.ok(!types.includes('missing-twitter-card'));
      // 1200x630 => ratio ~1.90 which is within tolerance of 1.91
      assert.ok(!types.includes('og-image-too-small'));
      assert.ok(!types.includes('og-image-wrong-ratio'));
    } finally {
      await page.close();
    }
  });

  test('detects issues: no og:image raises missing-og-image', async () => {
    const page = await newPage();
    try {
      await page.setContent(`
        <html><head>
          <meta property="og:title" content="Has Title" />
          <meta property="og:description" content="Has description." />
          <meta name="twitter:card" content="summary" />
        </head><body></body></html>
      `);
      const result = await checkOpenGraph(page);
      assert.equal(result.openGraph.image, undefined);
      const types = result.issues.map((i) => i.type);
      assert.ok(types.includes('missing-og-image'), 'expected missing-og-image issue');
      assert.equal(result.passed, false);
      assert.equal(result.imageReachable, false);
    } finally {
      await page.close();
    }
  });
});
