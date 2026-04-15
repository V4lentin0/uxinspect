import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIHelper, selectorToCacheEntry } from './ai.js';
import type { LlmHealContext } from './ai.js';
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

test('selectorToCacheEntry maps heal-strategy prefixes to cache shape', () => {
  assert.deepEqual(selectorToCacheEntry('testid=submit', 'click'), {
    strategy: 'testid',
    value: 'submit',
    verb: 'click',
  });
  assert.deepEqual(selectorToCacheEntry('css=#ok', 'click'), {
    strategy: 'css',
    value: '#ok',
    verb: 'click',
  });
  assert.deepEqual(selectorToCacheEntry('role=button|Save', 'click'), {
    strategy: 'role',
    value: 'button|Save',
    verb: 'click',
  });
  assert.deepEqual(selectorToCacheEntry('text=Save', 'click'), {
    strategy: 'text',
    value: 'Save',
    verb: 'click',
  });
  // Unqualified selectors fall back to raw CSS.
  assert.deepEqual(selectorToCacheEntry('.primary', 'click'), {
    strategy: 'css',
    value: '.primary',
    verb: 'click',
  });
  assert.equal(selectorToCacheEntry('', 'click'), null);
});

test('AIHelper.selfHeal recovers when original locator is missing (data-testid neighborhood)', async () => {
  const driver = new Driver();
  await driver.launch({ headless: true });
  const page = await driver.newPage();
  // Original CSS `.submit-btn` never existed; the real button has a data-testid.
  await page.setContent(`
    <html><body>
      <form>
        <div class="wrapper">
          <button data-testid="submit-form">Submit order</button>
        </div>
      </form>
    </body></html>
  `);
  const ai = new AIHelper();
  await ai.init(page);
  const healed = await ai.selfHeal('click Submit order', 'css=.submit-btn');
  assert.ok(healed, 'self-heal should return a non-null result');
  assert.ok(
    ['testid-neighborhood', 'role-name', 'text', 'xpath-similarity', 'reresolve'].includes(
      healed!.strategy,
    ),
  );
  // Heal events are recorded.
  const events = ai.getHealEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0]!.failedSelector, 'css=.submit-btn');
  assert.equal(events[0]!.instruction, 'click Submit order');
  await driver.close();
});

test('AIHelper.act auto-heals a cached-but-stale selector and updates cache heals counter', async () => {
  const driver = new Driver();
  await driver.launch({ headless: true });
  const page = await driver.newPage();
  await page.setContent(`
    <html><body>
      <button id="save">Save profile</button>
    </body></html>
  `);
  const ai = new AIHelper();
  await ai.init(page);
  // Prime the cache with a stale CSS selector.
  (ai as any).cache['click Save profile'] = {
    strategy: 'css',
    value: '#nonexistent-old',
    verb: 'click',
  };
  const ok = await ai.act('click Save profile');
  assert.equal(ok, true, 'act should succeed via self-heal');
  const events = ai.getHealEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0]!.failedSelector, 'css=#nonexistent-old');
  // Cache is updated and heals counter incremented.
  const cached = (ai as any).cache['click Save profile'];
  assert.ok(cached, 'cache entry should exist after heal');
  assert.equal(cached.heals, 1);
  assert.ok(cached.lastHealAt > 0);
  await driver.close();
});

test('AIHelper.act returns false for an expected-failure locator (self-heal does not invent matches)', async () => {
  const driver = new Driver();
  await driver.launch({ headless: true });
  const page = await driver.newPage();
  await page.setContent('<html><body><p>Nothing clickable here.</p></body></html>');
  const ai = new AIHelper();
  await ai.init(page);
  const ok = await ai.act('click Launch rocket');
  assert.equal(ok, false);
  // No heal event should be recorded for a genuinely-missing target.
  assert.equal(ai.getHealEvents().length, 0);
  await driver.close();
});

test('AIHelper self-heal is single-shot per step (no infinite loops)', async () => {
  const driver = new Driver();
  await driver.launch({ headless: true });
  const page = await driver.newPage();
  await page.setContent('<html><body><p>no matches</p></body></html>');
  const ai = new AIHelper();
  await ai.init(page);
  const start = Date.now();
  const ok = await ai.act('click Definitely missing label');
  const elapsed = Date.now() - start;
  assert.equal(ok, false);
  // A missing target must not run self-heal more than once; should be fast.
  assert.ok(elapsed < 15_000, `self-heal took too long: ${elapsed}ms`);
  await driver.close();
});

test('AIHelper self-heal can be disabled via options (no heal events on act)', async () => {
  const driver = new Driver();
  await driver.launch({ headless: true });
  const page = await driver.newPage();
  await page.setContent(`
    <html><body>
      <button data-testid="submit-form">Submit order</button>
    </body></html>
  `);
  const ai = new AIHelper({ selfHeal: false });
  await ai.init(page);
  // Prime a stale cache entry — act should NOT record a heal event.
  (ai as any).cache['click Submit order'] = {
    strategy: 'css',
    value: '#ghost',
    verb: 'click',
  };
  const ok = await ai.act('click Submit order');
  // With self-heal disabled, stale cache miss → fresh heuristic finds the
  // testid button, but since selfHeal is off the heal event is not logged.
  assert.equal(ok, true, 'fresh heuristic should still find the button');
  assert.equal(
    ai.getHealEvents().length,
    0,
    'no heal events should be recorded when selfHeal disabled',
  );
  await driver.close();
});

test('AIHelper llmHealHook is consulted as last-resort strategy', async () => {
  const driver = new Driver();
  await driver.launch({ headless: true });
  const page = await driver.newPage();
  // Nothing matches "Launch rocket" semantically, but there's a node with an
  // obscure selector. The LLM hook returns it.
  await page.setContent('<html><body><section class="hidden-hook"></section></body></html>');
  let calls = 0;
  const llmHealHook = async (ctx: LlmHealContext) => {
    calls += 1;
    assert.equal(ctx.failedSelector, 'css=.nope');
    // Return an obscure selector only visible via the LLM.
    return 'section.hidden-hook';
  };
  const ai = new AIHelper({ llmHealHook });
  await ai.init(page);
  const healed = await ai.selfHeal('click Launch rocket', 'css=.nope');
  assert.equal(calls, 1, 'LLM hook should have been invoked');
  assert.ok(healed);
  assert.equal(healed!.strategy, 'llm');
  assert.equal(healed!.selector, 'css=section.hidden-hook');
  await driver.close();
});
