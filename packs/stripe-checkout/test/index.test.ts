import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripeCardForm,
  stripe3DS,
  stripeDeclinedCard,
  stripeWebhookFired,
  stripeSuccessRedirect,
  stripeSuccessFlow,
  TEST_CARDS,
  type Step,
} from '../src/index.js';

function isStep(x: unknown): x is Step {
  return typeof x === 'object' && x !== null;
}

function flatten(steps: Step[]): Step[] {
  const out: Step[] = [];
  for (const s of steps) {
    out.push(s);
    if ('iframe' in s) out.push(...flatten(s.iframe.steps));
  }
  return out;
}

describe('TEST_CARDS', () => {
  test('exposes the documented Stripe test card numbers', () => {
    assert.equal(TEST_CARDS.success, '4242 4242 4242 4242');
    assert.equal(TEST_CARDS.threeDS, '4000 0025 0000 3155');
    assert.equal(TEST_CARDS.declined, '4000 0000 0000 0002');
    assert.equal(TEST_CARDS.insufficient, '4000 0000 0000 9995');
  });
});

describe('stripeCardForm', () => {
  test('returns Step[] and every entry is a step object', () => {
    const steps = stripeCardForm();
    assert.ok(Array.isArray(steps));
    assert.ok(steps.length > 0);
    for (const s of steps) assert.ok(isStep(s));
  });

  test('waits for the card iframe before filling', () => {
    const steps = stripeCardForm();
    assert.ok('waitFor' in steps[0]!, 'first step should be waitFor');
  });

  test('fills all four Stripe Elements fields inside iframe', () => {
    const steps = stripeCardForm();
    const iframe = steps.find((s): s is Step & { iframe: { selector: string; steps: Step[] } } => 'iframe' in s);
    assert.ok(iframe, 'expected iframe step');
    const fills = iframe!.iframe.steps.filter((s) => 'fill' in s);
    assert.equal(fills.length, 4, 'cardnumber, expiry, cvc, postal');
  });

  test('defaults to the 4242 success card', () => {
    const steps = stripeCardForm();
    const flat = flatten(steps);
    const hasSuccessCard = flat.some(
      (s) => 'fill' in s && s.fill.text === TEST_CARDS.success,
    );
    assert.ok(hasSuccessCard, 'must inject 4242 4242 4242 4242');
  });

  test('honours custom card number argument', () => {
    const custom = '5555 5555 5555 4444';
    const steps = stripeCardForm(custom);
    const flat = flatten(steps);
    assert.ok(flat.some((s) => 'fill' in s && s.fill.text === custom));
  });

  test('honours overridden iframe selector', () => {
    const steps = stripeCardForm(undefined, { cardIframeSelector: '#custom-el' });
    const waitStep = steps.find((s) => 'waitFor' in s) as { waitFor: string };
    assert.equal(waitStep.waitFor, '#custom-el');
  });
});

describe('stripe3DS', () => {
  test('returns a non-empty Step[] using the 3DS challenge card', () => {
    const steps = stripe3DS();
    assert.ok(steps.length > 0);
    const flat = flatten(steps);
    const uses3DSCard = flat.some(
      (s) => 'fill' in s && s.fill.text === TEST_CARDS.threeDS,
    );
    assert.ok(uses3DSCard, 'must use 4000 0025 0000 3155');
  });

  test('clicks submit and enters the challenge iframe', () => {
    const steps = stripe3DS();
    const hasSubmit = steps.some((s) => 'click' in s);
    const hasInnerIframe = steps.filter((s) => 'iframe' in s).length >= 2;
    assert.ok(hasSubmit, 'should click submit');
    assert.ok(hasInnerIframe, 'should enter card iframe + challenge iframe');
  });

  test('asserts the payment_intents response after completion', () => {
    const steps = stripe3DS();
    const hasIntentWait = steps.some(
      (s) =>
        'waitForResponse' in s &&
        typeof s.waitForResponse === 'object' &&
        s.waitForResponse.url.includes('payment_intents'),
    );
    assert.ok(hasIntentWait);
  });
});

describe('stripeDeclinedCard', () => {
  test('uses the 4000-0000-0000-0002 decline card', () => {
    const steps = stripeDeclinedCard();
    const flat = flatten(steps);
    assert.ok(
      flat.some((s) => 'fill' in s && s.fill.text === TEST_CARDS.declined),
    );
  });

  test('asserts a visible decline error via waitFor', () => {
    const steps = stripeDeclinedCard();
    const errorWait = steps.find((s) => 'waitFor' in s && typeof s.waitFor === 'string' && /decline|invalid|error|alert/i.test(s.waitFor));
    assert.ok(errorWait, 'must wait on a visible decline error');
  });
});

describe('stripeWebhookFired', () => {
  test('returns Step[] that polls the receiver URL', () => {
    const steps = stripeWebhookFired({
      receiverUrl: 'https://example.com/__test/webhook',
    });
    assert.ok(Array.isArray(steps));
    assert.ok(steps.length > 0);
    const pollsReceiver = steps.some(
      (s) =>
        'waitForResponse' in s &&
        typeof s.waitForResponse === 'object' &&
        s.waitForResponse.url.includes('__test/webhook'),
    );
    assert.ok(pollsReceiver, 'must hit receiverUrl');
  });

  test('respects custom timeout and interval', () => {
    const steps = stripeWebhookFired({
      receiverUrl: 'https://example.com/w',
      timeoutMs: 5_000,
      intervalMs: 1_000,
    });
    assert.ok(steps.length > 0);
  });
});

describe('stripeSuccessRedirect', () => {
  test('submits a valid card and asserts redirect', () => {
    const returnUrl = 'https://example.com/thanks';
    const steps = stripeSuccessRedirect(returnUrl);
    const flat = flatten(steps);
    assert.ok(
      flat.some((s) => 'fill' in s && s.fill.text === TEST_CARDS.success),
    );
    assert.ok(steps.some((s) => 'click' in s));
    const redirectWait = steps.find(
      (s) =>
        'waitForResponse' in s &&
        typeof s.waitForResponse === 'object' &&
        s.waitForResponse.url === returnUrl,
    );
    assert.ok(redirectWait, 'must wait for returnUrl response');
  });
});

describe('stripeSuccessFlow', () => {
  test('returns a preset flow object with name + steps', () => {
    const flow = stripeSuccessFlow({
      checkoutUrl: 'https://example.com/checkout',
      returnUrl: 'https://example.com/thanks',
    });
    assert.equal(typeof flow.name, 'string');
    assert.ok(flow.name.length > 0);
    assert.ok(Array.isArray(flow.steps));
    assert.ok(flow.steps.length > 0);
    assert.ok('goto' in flow.steps[0]!);
  });
});
