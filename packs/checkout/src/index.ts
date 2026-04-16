/**
 * @uxinspect/pack-checkout
 *
 * Preset uxinspect flows for hosted card-checkout patterns:
 *  - happy path (success redirect)
 *  - 3DS / step-up challenge
 *  - declined card
 *  - webhook receipt verification via a user-provided catcher URL
 *
 * Flow selectors, URLs, and customer data are injected via template
 * placeholders (e.g. `{{checkoutUrl}}`) resolved at build time from
 * `CheckoutPackConfig`. Test card numbers come from `test-cards.ts`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Flow, Step } from './types.js';
import {
  resolveTestCards,
  type TestCardsConfig,
  type TestCardSet,
} from './test-cards.js';

export type {
  Flow,
  Step,
  StepAction,
  AssertConfig,
} from './types.js';
export {
  resolveTestCards,
  getProviderDeck,
  type TestCardProvider,
  type TestCardSet,
  type TestCardsConfig,
} from './test-cards.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// This file lives at either <pkg>/src/index.ts (source) or <pkg>/dist/src/index.js
// (compiled). Flow JSONs ship at <pkg>/flows. Walk up looking for a directory
// that contains both `flows/` and `assertions/` — that's the pack root.
import { statSync } from 'node:fs';
function resolvePackRoot(start: string): string {
  let cur = start;
  for (let i = 0; i < 6; i += 1) {
    cur = join(cur, '..');
    try {
      const fStat = statSync(join(cur, 'flows'));
      const aStat = statSync(join(cur, 'assertions'));
      if (fStat.isDirectory() && aStat.isDirectory()) return cur;
    } catch {
      // try next level up
    }
  }
  return join(start, '..');
}
const PACK_ROOT = resolvePackRoot(__dirname);
const FLOWS_DIR = join(PACK_ROOT, 'flows');
const ASSERTIONS_DIR = join(PACK_ROOT, 'assertions');

/** Hosted card-checkout field selectors. Override any to match your form. */
export interface CheckoutSelectors {
  email: string;
  name: string;
  cardIframe: string;
  cardNumber: string;
  cardExpiry: string;
  cardCvc: string;
  cardPostal: string;
  submit: string;
  successRegion: string;
  errorRegion: string;
  threeDSFrame: string;
  threeDSComplete: string;
}

export const DEFAULT_SELECTORS: CheckoutSelectors = {
  email: 'input[type="email"], input[name="email"]',
  name: 'input[name="name"], input[name="cardholder-name"]',
  // Generic card-entry iframe selector. Host apps should override to match
  // whichever hosted-fields element their provider renders.
  cardIframe: 'iframe[name*="card"], iframe[title*="card" i], iframe[src*="card" i]',
  cardNumber: 'input[name="cardnumber"], input[name="number"], input[autocomplete="cc-number"]',
  cardExpiry: 'input[name="exp-date"], input[name="expiry"], input[autocomplete="cc-exp"]',
  cardCvc: 'input[name="cvc"], input[name="cvv"], input[autocomplete="cc-csc"]',
  cardPostal: 'input[name="postal"], input[name="postalCode"], input[autocomplete="postal-code"]',
  submit: 'button[type="submit"]',
  successRegion: '[data-checkout-success], .checkout-success, [role="status"]',
  errorRegion: '[data-checkout-error], .checkout-error, [role="alert"], .alert-danger',
  threeDSFrame: 'iframe[name*="3ds" i], iframe[src*="3ds" i], iframe[src*="challenge" i]',
  threeDSComplete: 'button[name="complete"], button[data-testid="complete"], input[value="Complete"]',
};

export interface CustomerFixture {
  email: string;
  name: string;
}

export const DEFAULT_CUSTOMER: CustomerFixture = {
  email: 'buyer@example.test',
  name: 'Test Buyer',
};

export interface CheckoutPackConfig {
  /** URL of the page that hosts the card entry form. */
  checkoutUrl: string;
  /** URL or URL-glob pattern expected after a successful authorisation. */
  successRedirectPattern: string;
  /** Test card provider keying. */
  testCards: TestCardsConfig;
  /** Selector overrides. Merged on top of `DEFAULT_SELECTORS`. */
  selectors?: Partial<CheckoutSelectors>;
  /** Customer fixture used to fill email/name. */
  customer?: CustomerFixture;
  /**
   * Webhook catcher URL that returns either
   *   `{ received: true, ... }` or a non-empty array when the provider
   *   webhook has been received. Used by the `webhook-fired` flow.
   */
  webhookCatcherUrl?: string;
  /** Poll timeout in ms for the webhook-fired flow (default 30000). */
  webhookTimeoutMs?: number;
  /** Which preset flows to include. Defaults to all four. */
  include?: Array<'happyPath' | 'threeDS' | 'declined' | 'webhook'>;
}

const FLOW_FILES = {
  happyPath: 'card-checkout.flow.json',
  threeDS: '3ds-challenge.flow.json',
  declined: 'declined-card.flow.json',
  webhook: 'webhook-fired.flow.json',
} as const;

type PresetKey = keyof typeof FLOW_FILES;

/** Raw flow loader — reads the JSON as-is, placeholders included. */
export function loadRawFlow(preset: PresetKey): Flow {
  const file = join(FLOWS_DIR, FLOW_FILES[preset]);
  const raw = readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw) as Flow;
  return parsed;
}

/** Raw assertion config loader. */
export function loadRawAssertion(preset: PresetKey): unknown {
  const fileMap: Record<PresetKey, string> = {
    happyPath: 'card-checkout.assert.json',
    threeDS: '3ds-challenge.assert.json',
    declined: 'declined-card.assert.json',
    webhook: 'webhook-fired.assert.json',
  };
  const file = join(ASSERTIONS_DIR, fileMap[preset]);
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Shallow placeholder substitution on any string value in a flow tree. */
function substitute(value: string, vars: Record<string, string>): string {
  return value.replace(/\{\{([\w.]+)\}\}/g, (_match, key: string) => {
    const resolved = vars[key];
    if (resolved === undefined) {
      throw new Error(`Missing checkout pack variable: ${key}`);
    }
    return resolved;
  });
}

function substituteDeep<T>(node: T, vars: Record<string, string>): T {
  if (typeof node === 'string') {
    return substitute(node, vars) as unknown as T;
  }
  if (Array.isArray(node)) {
    return node.map((child) => substituteDeep(child, vars)) as unknown as T;
  }
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = substituteDeep(v, vars);
    }
    return out as unknown as T;
  }
  return node;
}

function buildVars(config: CheckoutPackConfig, cards: TestCardSet, selectors: CheckoutSelectors, customer: CustomerFixture): Record<string, string> {
  return {
    checkoutUrl: config.checkoutUrl,
    successRedirectPattern: config.successRedirectPattern,
    'cards.success': cards.success,
    'cards.threeDS': cards.threeDS,
    'cards.declined': cards.declined,
    'cards.expiry': cards.expiry ?? '12/34',
    'cards.cvc': cards.cvc ?? '123',
    'cards.postalCode': cards.postalCode ?? '10001',
    'customer.email': customer.email,
    'customer.name': customer.name,
    'selectors.email': selectors.email,
    'selectors.name': selectors.name,
    'selectors.cardIframe': selectors.cardIframe,
    'selectors.cardNumber': selectors.cardNumber,
    'selectors.cardExpiry': selectors.cardExpiry,
    'selectors.cardCvc': selectors.cardCvc,
    'selectors.cardPostal': selectors.cardPostal,
    'selectors.submit': selectors.submit,
    'selectors.successRegion': selectors.successRegion,
    'selectors.errorRegion': selectors.errorRegion,
    'selectors.threeDSFrame': selectors.threeDSFrame,
    'selectors.threeDSComplete': selectors.threeDSComplete,
  };
}

function injectWebhookSetup(flow: Flow, config: CheckoutPackConfig): Flow {
  if (!config.webhookCatcherUrl) {
    throw new Error(
      'webhook-fired flow requires webhookCatcherUrl in checkout pack config',
    );
  }
  const setup: Step = {
    eval: `(() => { globalThis.__uxinspectWebhookUrl = ${JSON.stringify(config.webhookCatcherUrl)}; globalThis.__uxinspectWebhookTimeoutMs = ${config.webhookTimeoutMs ?? 30000}; })()`,
  };
  return {
    name: flow.name,
    steps: [setup, ...flow.steps],
  };
}

/**
 * Build the final flow set to pass into uxinspect's `inspect({ flows })` option.
 * Substitutes placeholders and handles webhook bootstrap.
 */
export function buildFlows(config: CheckoutPackConfig): Flow[] {
  const cards = resolveTestCards(config.testCards);
  const selectors: CheckoutSelectors = { ...DEFAULT_SELECTORS, ...(config.selectors ?? {}) };
  const customer: CustomerFixture = config.customer ?? DEFAULT_CUSTOMER;
  const vars = buildVars(config, cards, selectors, customer);

  const include = config.include ?? ['happyPath', 'threeDS', 'declined', 'webhook'];
  const out: Flow[] = [];
  for (const preset of include) {
    const raw = loadRawFlow(preset);
    let resolved = substituteDeep(raw, vars);
    if (preset === 'webhook') {
      resolved = injectWebhookSetup(resolved, config);
    }
    out.push(resolved);
  }
  return out;
}

/**
 * Convenience: returns `{ flows }` spread-ready into an uxinspect config.
 *
 * ```ts
 * import { checkoutPack } from '@uxinspect/pack-checkout';
 * import { inspect } from 'uxinspect';
 *
 * await inspect({
 *   url: 'https://shop.example.com',
 *   ...checkoutPack({
 *     checkoutUrl: 'https://shop.example.com/checkout',
 *     successRedirectPattern: 'https://shop.example.com/thank-you**',
 *     testCards: { provider: 'stripe' },
 *   }),
 * });
 * ```
 */
export function checkoutPack(config: CheckoutPackConfig): { flows: Flow[] } {
  return { flows: buildFlows(config) };
}

/**
 * Default flow set — uses a `stripe` test deck, placeholder-only URLs. Intended
 * for consumers who just want `import { flows } from '@uxinspect/pack-checkout'`
 * and fill in their URL later via their own config composition.
 */
export const flows: Flow[] = buildFlows({
  checkoutUrl: 'https://example.test/checkout',
  successRedirectPattern: 'https://example.test/thank-you**',
  testCards: { provider: 'stripe' },
  webhookCatcherUrl: 'https://example.test/__webhook-catcher',
});
