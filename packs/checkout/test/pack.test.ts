import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildFlows,
  checkoutPack,
  flows as defaultFlows,
  loadRawFlow,
  loadRawAssertion,
  resolveTestCards,
  getProviderDeck,
  DEFAULT_SELECTORS,
  type Flow,
  type Step,
  type StepAction,
} from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// When compiled, tests live in dist/test/, flows ship from <pack>/flows/
const FLOWS_DIR = join(__dirname, '..', '..', 'flows');

// ─── Flow schema guard ─────────────────────────────────────────────
// Mirrors uxinspect's StepAction union. Each step must have exactly one
// known action key plus optional `assert`/`captureOptions`.
const STEP_ACTION_KEYS = new Set<string>([
  'goto',
  'click',
  'type',
  'fill',
  'waitFor',
  'screenshot',
  'ai',
  'drag',
  'upload',
  'dialog',
  'scroll',
  'select',
  'key',
  'eval',
  'waitForResponse',
  'waitForRequest',
  'hover',
  'check',
  'uncheck',
  'focus',
  'blur',
  'reload',
  'back',
  'forward',
  'newTab',
  'switchTab',
  'closeTab',
  'iframe',
  'sleep',
  'waitForDownload',
  'waitForPopup',
  'cookie',
  'clearCookies',
]);

const STEP_EXTRA_KEYS = new Set<string>(['assert', 'captureOptions']);
const ASSERT_KEYS = new Set<string>(['console', 'network', 'dom', 'visual']);

function validateStep(step: unknown, path: string): void {
  assert.equal(typeof step, 'object', `${path}: step must be an object`);
  assert.ok(step, `${path}: step is null`);
  const keys = Object.keys(step as Record<string, unknown>);
  const actionKeys = keys.filter((k) => STEP_ACTION_KEYS.has(k));
  assert.equal(
    actionKeys.length,
    1,
    `${path}: expected exactly 1 action key, got [${actionKeys.join(', ')}]`,
  );
  for (const k of keys) {
    assert.ok(
      STEP_ACTION_KEYS.has(k) || STEP_EXTRA_KEYS.has(k),
      `${path}: unknown key "${k}"`,
    );
  }
  const stepObj = step as Record<string, unknown>;
  if (stepObj.assert) {
    assert.equal(typeof stepObj.assert, 'object', `${path}.assert: not object`);
    for (const k of Object.keys(stepObj.assert as Record<string, unknown>)) {
      assert.ok(ASSERT_KEYS.has(k), `${path}.assert: unknown key "${k}"`);
    }
  }
  // Recurse into nested iframe steps.
  if (stepObj.iframe) {
    const iframe = stepObj.iframe as { selector: string; steps: unknown[] };
    assert.equal(typeof iframe.selector, 'string', `${path}.iframe.selector`);
    assert.ok(Array.isArray(iframe.steps), `${path}.iframe.steps array`);
    iframe.steps.forEach((s, i) => validateStep(s, `${path}.iframe.steps[${i}]`));
  }
}

function validateFlow(flow: unknown, path: string): asserts flow is Flow {
  assert.equal(typeof flow, 'object', `${path}: flow not object`);
  assert.ok(flow, `${path}: flow null`);
  const f = flow as Record<string, unknown>;
  assert.equal(typeof f.name, 'string', `${path}.name: must be string`);
  assert.ok((f.name as string).length > 0, `${path}.name: empty`);
  assert.ok(Array.isArray(f.steps), `${path}.steps: must be array`);
  assert.ok((f.steps as unknown[]).length > 0, `${path}.steps: empty`);
  (f.steps as unknown[]).forEach((s, i) => validateStep(s, `${path}.steps[${i}]`));
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('flow JSONs parse + match Flow schema', () => {
  test('all shipped flow JSONs parse as JSON', () => {
    const files = readdirSync(FLOWS_DIR).filter((f) => f.endsWith('.flow.json'));
    assert.ok(files.length >= 4, `expected >=4 flow files, got ${files.length}`);
    for (const file of files) {
      const raw = readFileSync(join(FLOWS_DIR, file), 'utf8');
      assert.doesNotThrow(() => JSON.parse(raw), `${file}: invalid JSON`);
    }
  });

  test('each preset key loads a valid Flow skeleton', () => {
    for (const preset of ['happyPath', 'threeDS', 'declined', 'webhook'] as const) {
      const flow = loadRawFlow(preset);
      validateFlow(flow, preset);
    }
  });

  test('raw flows contain placeholders until substituted', () => {
    const raw = loadRawFlow('happyPath');
    const serialised = JSON.stringify(raw);
    assert.match(serialised, /\{\{checkoutUrl\}\}/);
    assert.match(serialised, /\{\{cards\.success\}\}/);
  });
});

describe('buildFlows substitutes placeholders and yields valid Flows', () => {
  const config = {
    checkoutUrl: 'https://shop.test/checkout',
    successRedirectPattern: 'https://shop.test/thank-you**',
    testCards: { provider: 'stripe' as const },
    webhookCatcherUrl: 'https://webhook.test/catch',
  };

  test('returns 4 flows by default and each is schema-valid', () => {
    const result = buildFlows(config);
    assert.equal(result.length, 4);
    result.forEach((f, i) => validateFlow(f, `buildFlows[${i}]`));
  });

  test('substitutes checkoutUrl + success card into happy-path flow', () => {
    const result = buildFlows({ ...config, include: ['happyPath'] });
    assert.equal(result.length, 1);
    const serialised = JSON.stringify(result[0]);
    assert.match(serialised, /https:\/\/shop\.test\/checkout/);
    assert.match(serialised, /4242424242424242/);
    assert.doesNotMatch(serialised, /\{\{checkoutUrl\}\}/);
  });

  test('substitutes 3DS card into 3ds flow', () => {
    const [flow] = buildFlows({ ...config, include: ['threeDS'] });
    const serialised = JSON.stringify(flow);
    assert.match(serialised, /4000000000003220/);
    assert.doesNotMatch(serialised, /4242424242424242/);
  });

  test('substitutes declined card into declined flow', () => {
    const [flow] = buildFlows({ ...config, include: ['declined'] });
    const serialised = JSON.stringify(flow);
    assert.match(serialised, /4000000000000002/);
  });

  test('webhook flow injects setup step with user-provided catcher URL', () => {
    const [flow] = buildFlows({ ...config, include: ['webhook'] });
    const firstStep = flow.steps[0] as StepAction;
    assert.ok('eval' in firstStep, 'first step should be eval setup');
    if ('eval' in firstStep) {
      assert.match(firstStep.eval, /webhook\.test\/catch/);
      assert.match(firstStep.eval, /__uxinspectWebhookUrl/);
    }
  });

  test('webhook flow throws without webhookCatcherUrl', () => {
    assert.throws(
      () => buildFlows({ ...config, webhookCatcherUrl: undefined, include: ['webhook'] }),
      /webhookCatcherUrl/,
    );
  });

  test('custom selectors override defaults', () => {
    const [flow] = buildFlows({
      ...config,
      selectors: { submit: '#pay-button' },
      include: ['happyPath'],
    });
    const serialised = JSON.stringify(flow);
    assert.match(serialised, /#pay-button/);
  });
});

describe('checkoutPack convenience wrapper', () => {
  test('returns { flows } spreadable into inspect config', () => {
    const result = checkoutPack({
      checkoutUrl: 'https://shop.test/checkout',
      successRedirectPattern: 'https://shop.test/thank-you**',
      testCards: { provider: 'stripe' },
      webhookCatcherUrl: 'https://webhook.test/catch',
    });
    assert.ok(Array.isArray(result.flows));
    assert.equal(result.flows.length, 4);
    result.flows.forEach((f, i) => validateFlow(f, `checkoutPack.flows[${i}]`));
  });

  test('default `flows` export has 4 schema-valid flows', () => {
    assert.equal(defaultFlows.length, 4);
    defaultFlows.forEach((f, i) => validateFlow(f, `defaultFlows[${i}]`));
  });
});

describe('test-cards abstraction', () => {
  test('resolveTestCards returns stripe deck by default', () => {
    const deck = resolveTestCards({ provider: 'stripe' });
    assert.equal(deck.success, '4242424242424242');
    assert.equal(deck.threeDS, '4000000000003220');
    assert.equal(deck.declined, '4000000000000002');
  });

  test('resolveTestCards supports braintree and adyen', () => {
    const bt = resolveTestCards({ provider: 'braintree' });
    assert.equal(bt.success, '4111111111111111');
    const ad = resolveTestCards({ provider: 'adyen' });
    assert.ok(ad.success.length >= 16);
  });

  test('cards overrides merge on top of provider deck', () => {
    const deck = resolveTestCards({
      provider: 'stripe',
      cards: { success: '4000000000000077', cvc: '999' },
    });
    assert.equal(deck.success, '4000000000000077');
    assert.equal(deck.cvc, '999');
    // Unspecified fields preserved from base.
    assert.equal(deck.threeDS, '4000000000003220');
  });

  test('custom provider requires user cards and falls back otherwise', () => {
    const deck = resolveTestCards({
      provider: 'custom',
      cards: { success: '1234567890123456' },
    });
    assert.equal(deck.success, '1234567890123456');
  });

  test('getProviderDeck returns raw deck without overrides', () => {
    const deck = getProviderDeck('stripe');
    assert.equal(deck.success, '4242424242424242');
  });
});

describe('assertion configs', () => {
  test('each preset has an assertion JSON that loads and references the right flow', () => {
    const expected: Record<string, string> = {
      happyPath: 'card-checkout-happy-path',
      threeDS: 'card-checkout-3ds-challenge',
      declined: 'card-checkout-declined',
      webhook: 'card-checkout-webhook-fired',
    };
    for (const preset of ['happyPath', 'threeDS', 'declined', 'webhook'] as const) {
      const assertion = loadRawAssertion(preset) as {
        flow: string;
        assert: Record<string, string>;
      };
      assert.equal(assertion.flow, expected[preset]);
      assert.ok(assertion.assert, `${preset}: missing assert block`);
    }
  });
});

describe('user-facing strings avoid third-party brand names', () => {
  test('flow JSONs contain no vendor names', () => {
    const vendors = ['stripe', 'braintree', 'adyen', 'checkout.com', 'paypal'];
    const files = readdirSync(FLOWS_DIR).filter((f) => f.endsWith('.flow.json'));
    for (const file of files) {
      const raw = readFileSync(join(FLOWS_DIR, file), 'utf8').toLowerCase();
      for (const v of vendors) {
        assert.doesNotMatch(
          raw,
          new RegExp(`\\b${v}\\b`),
          `${file}: contains vendor name "${v}"`,
        );
      }
    }
  });

  test('default selectors avoid vendor-name substrings in attributes', () => {
    const selectorsJson = JSON.stringify(DEFAULT_SELECTORS).toLowerCase();
    const vendors = ['stripe', 'braintree', 'adyen'];
    for (const v of vendors) {
      assert.doesNotMatch(selectorsJson, new RegExp(v));
    }
  });
});
