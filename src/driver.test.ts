import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Driver } from './driver.js';

test('Driver assigns cdpPort on launch and clears on close', async () => {
  const d = new Driver();
  await d.launch({ headless: true });
  assert.equal(typeof d.cdpPort, 'number');
  assert.ok((d.cdpPort ?? 0) > 0);
  const page = await d.newPage();
  await page.goto('about:blank');
  await d.close();
  assert.equal(d.cdpPort, undefined);
});

test('Driver.newPage throws before launch', async () => {
  const d = new Driver();
  await assert.rejects(() => d.newPage(), /not launched/);
});
