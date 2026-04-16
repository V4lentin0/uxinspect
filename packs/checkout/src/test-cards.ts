/**
 * Test card abstraction for hosted payment card checkout flows.
 *
 * Pack targets generic hosted-card checkout patterns. Provider names are used
 * as internal config keys only (for selecting the right test deck). User-facing
 * strings avoid vendor names.
 *
 * All default numbers are publicly-documented test-only card numbers from the
 * provider sandboxes. They are inert in production environments.
 */

/** Internal config keys for resolving the right test deck. */
export type TestCardProvider = 'stripe' | 'braintree' | 'adyen' | 'custom';

export interface TestCardSet {
  /** Card that authorises successfully on the provider sandbox. */
  success: string;
  /** Card that triggers a 3DS / step-up challenge on the provider sandbox. */
  threeDS: string;
  /** Card that is declined by the provider sandbox. */
  declined: string;
  /** Any valid future expiry (MM/YY). */
  expiry?: string;
  /** Any 3-digit CVC (4-digit for 15-digit cards) — sandboxes accept any. */
  cvc?: string;
  /** Any valid postal / ZIP — sandboxes accept any. */
  postalCode?: string;
}

export interface TestCardsConfig {
  provider: TestCardProvider;
  /** Override any subset of the resolved deck. */
  cards?: Partial<TestCardSet>;
}

/**
 * Publicly-documented test decks. Kept minimal: success / 3DS / declined only.
 * Users who need additional cards override via `cards` in their uxinspect config.
 */
const PROVIDER_DECKS: Record<Exclude<TestCardProvider, 'custom'>, TestCardSet> = {
  // Stripe test deck — https://docs.stripe.com/testing
  stripe: {
    success: '4242424242424242',
    threeDS: '4000000000003220',
    declined: '4000000000000002',
    expiry: '12/34',
    cvc: '123',
    postalCode: '10001',
  },
  // Braintree sandbox — https://developer.paypal.com/braintree/docs/reference/general/testing
  braintree: {
    success: '4111111111111111',
    threeDS: '4000000000001091',
    declined: '4000111111111115',
    expiry: '12/34',
    cvc: '123',
    postalCode: '10001',
  },
  // Adyen test deck — https://docs.adyen.com/development-resources/testing/test-card-numbers
  adyen: {
    success: '4111111145551142',
    threeDS: '4212345678901237',
    declined: '4000300011112220',
    expiry: '03/30',
    cvc: '737',
    postalCode: '10001',
  },
};

const CUSTOM_FALLBACK: TestCardSet = {
  success: '4242424242424242',
  threeDS: '4000000000003220',
  declined: '4000000000000002',
  expiry: '12/34',
  cvc: '123',
  postalCode: '10001',
};

/**
 * Resolve a full test card deck from user config. When `provider` is `custom`,
 * the caller must supply the cards via `cards`. Any provided field in `cards`
 * overrides the resolved default.
 */
export function resolveTestCards(config: TestCardsConfig): TestCardSet {
  const base =
    config.provider === 'custom' ? CUSTOM_FALLBACK : PROVIDER_DECKS[config.provider];
  if (!base) {
    throw new Error(`Unknown test card provider: ${String(config.provider)}`);
  }
  return {
    ...base,
    ...(config.cards ?? {}),
  };
}

/** Returns the raw deck for a provider without applying overrides. Useful for docs/tests. */
export function getProviderDeck(provider: TestCardProvider): TestCardSet {
  if (provider === 'custom') return { ...CUSTOM_FALLBACK };
  const deck = PROVIDER_DECKS[provider];
  if (!deck) throw new Error(`Unknown test card provider: ${String(provider)}`);
  return { ...deck };
}
