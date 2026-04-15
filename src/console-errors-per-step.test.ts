import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Driver } from './driver.js';
import { attachConsoleCapture } from './console-errors.js';

test('markStepStart/end attributes console errors to specific step', async () => {
  const driver = new Driver();
  await driver.launch({ headless: true });
  try {
    const page = await driver.newPage();
    const handle = attachConsoleCapture(page);

    await page.goto('data:text/html,<!doctype html><html><body><button id="a">A</button><button id="b">B</button></body></html>');

    // Step 1: click A — trigger one console.error
    const cap1 = handle.markStepStart('click "#a"');
    await page.evaluate(() => console.error('error-during-step-1'));
    // Small wait so timeline records before end
    await new Promise((r) => setTimeout(r, 50));
    const r1 = cap1.end();

    // Step 2: click B — no errors
    const cap2 = handle.markStepStart('click "#b"');
    await new Promise((r) => setTimeout(r, 50));
    const r2 = cap2.end();

    // Step 3: multiple errors during one step
    const cap3 = handle.markStepStart('click "#a" again');
    await page.evaluate(() => {
      console.error('err-a');
      console.error('err-b');
      console.error('err-c');
    });
    await new Promise((r) => setTimeout(r, 50));
    const r3 = cap3.end();

    // Assertions
    assert.equal(r1.step, 'click "#a"');
    assert.ok(r1.errors.length >= 1, `expected at least 1 error in step 1, got ${r1.errors.length}`);
    assert.ok(
      r1.errors.some((e) => e.message.includes('error-during-step-1')),
      'step 1 should contain its own error',
    );

    assert.equal(r2.step, 'click "#b"');
    assert.equal(r2.errors.length, 0, 'step 2 should have no errors');

    assert.equal(r3.step, 'click "#a" again');
    assert.ok(r3.errors.length >= 3, `step 3 should capture all 3 errors, got ${r3.errors.length}`);
    const messages = r3.errors.map((e) => e.message).join('|');
    assert.match(messages, /err-a/);
    assert.match(messages, /err-b/);
    assert.match(messages, /err-c/);

    // Session-level result() still contains all errors (backward compatible)
    const sessionResult = handle.result();
    assert.ok(sessionResult.errorCount >= 4, `session should track all errors, got ${sessionResult.errorCount}`);

    handle.detach();
  } finally {
    await driver.close();
  }
});

test('markStepStart does not attribute errors outside its window', async () => {
  const driver = new Driver();
  await driver.launch({ headless: true });
  try {
    const page = await driver.newPage();
    const handle = attachConsoleCapture(page);

    await page.goto('data:text/html,<!doctype html><html><body></body></html>');

    // Error BEFORE any step
    await page.evaluate(() => console.error('pre-step-error'));
    await new Promise((r) => setTimeout(r, 50));

    const cap = handle.markStepStart('click "target"');
    await page.evaluate(() => console.error('during-step-error'));
    await new Promise((r) => setTimeout(r, 50));
    const result = cap.end();

    // Error AFTER step
    await page.evaluate(() => console.error('post-step-error'));
    await new Promise((r) => setTimeout(r, 50));

    const messages = result.errors.map((e) => e.message);
    assert.ok(messages.some((m) => m.includes('during-step-error')), 'should capture during-step error');
    assert.ok(!messages.some((m) => m.includes('pre-step-error')), 'should NOT capture pre-step error');
    assert.ok(!messages.some((m) => m.includes('post-step-error')), 'should NOT capture post-step error');

    handle.detach();
  } finally {
    await driver.close();
  }
});
