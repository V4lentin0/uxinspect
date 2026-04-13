import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIHelper } from './ai.js';
import { Driver } from './driver.js';

test('AIHelper returns null page when no page attached', async () => {
  const ai = new AIHelper();
  const page = await ai.init();
  assert.equal(page, null);
  assert.equal(ai.isAvailable(), false);
});

test('AIHelper methods return safe defaults when not initialized', async () => {
  const ai = new AIHelper();
  assert.equal(await ai.act('click button'), false);
  assert.equal(await ai.extract('title'), null);
  assert.deepEqual(await ai.observe('buttons'), []);
});

test('AIHelper.act clicks link by text on real page (keyless)', async () => {
  const driver = new Driver();
  await driver.launch({ headless: true });
  const page = await driver.newPage();
  await page.setContent(`
    <html><body>
      <button id="x">Sign up now</button>
      <a href="#logged">Log in</a>
      <input type="email" aria-label="Email address" />
    </body></html>
  `);
  const ai = new AIHelper();
  await ai.init(page);
  assert.equal(await ai.act('click sign up button'), true);
  assert.equal(await ai.act('click the Log in link'), true);
  assert.equal(await ai.act('fill "me@x.com" in Email address'), true);
  const val = await page.locator('input[type=email]').inputValue();
  assert.equal(val, 'me@x.com');
  await driver.close();
});

test('AIHelper.extract reads text by target', async () => {
  const driver = new Driver();
  await driver.launch({ headless: true });
  const page = await driver.newPage();
  await page.setContent('<h1>Welcome back</h1><p>Hello</p>');
  const ai = new AIHelper();
  await ai.init(page);
  const txt = await ai.extract('extract Welcome back');
  assert.equal(txt, 'Welcome back');
  await driver.close();
});

test('AIHelper.observe lists matches', async () => {
  const driver = new Driver();
  await driver.launch({ headless: true });
  const page = await driver.newPage();
  await page.setContent('<button>Save</button><button>Save and close</button>');
  const ai = new AIHelper();
  await ai.init(page);
  const obs = await ai.observe('observe Save');
  assert.ok(obs.length >= 1);
  assert.ok(obs.some((t) => /save/i.test(t)));
  await driver.close();
});
