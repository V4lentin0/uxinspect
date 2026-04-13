import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIHelper } from './ai.js';

test('AIHelper.init returns null without apiKey', async () => {
  const ai = new AIHelper({});
  const page = await ai.init();
  assert.equal(page, null);
  assert.equal(ai.isAvailable(), false);
});

test('AIHelper methods return safe defaults when not initialized', async () => {
  const ai = new AIHelper({});
  assert.equal(await ai.act('click button'), false);
  assert.equal(await ai.extract('title'), null);
  assert.deepEqual(await ai.observe('buttons'), []);
  assert.equal(ai.page, null);
});

test('AIHelper.close is safe when uninitialized', async () => {
  const ai = new AIHelper({});
  await ai.close();
});
