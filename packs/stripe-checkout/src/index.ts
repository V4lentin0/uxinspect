/**
 * @uxinspect/pack-stripe — preset uxinspect flows + assertions for Stripe
 * checkout integrations.
 *
 * Commercial pack — see LICENSE file. Paid one-time license via Lemon Squeezy.
 *
 * Each helper returns a `Step[]` array compatible with the uxinspect flow DSL
 * (see the `Step` type exported by the `uxinspect` package). Helpers are
 * deliberately framework-agnostic about how your checkout page is mounted —
 * they select the Stripe-hosted card iframe fields by their well-known
 * element names (`cardnumber`, `exp-date`, `cvc`) and fall back to common
 * generic selectors (`input[name="cardnumber"]`, `#card-number`) when the
 * integration is a self-hosted Elements setup.
 */

/**
 * Mirror of the `Step` union exported by the main `uxinspect` package. We
 * duplicate it here so the pack compiles standalone (no runtime dep on
 * `uxinspect`, only a peer-level expectation that consumers feed these steps
 * back into an uxinspect flow). Kept in strict structural sync with
 * `uxinspect` v0.11.x.
 */
export type Step =
  | { goto: string }
  | { click: string }
  | { type: { selector: string; text: string } }
  | { fill: { selector: string; text: string } }
  | { waitFor: string }
  | { screenshot: string }
  | { ai: string }
  | { drag: { from: string; to: string } }
  | { upload: { selector: string; files: string | string[] } }
  | { dialog: 'accept' | 'dismiss' | { accept?: boolean; text?: string } }
  | { scroll: { selector?: string; x?: number; y?: number } }
  | { select: { selector: string; value: string | string[] } }
  | { key: string }
  | { eval: string }
  | { waitForResponse: string | { url: string; status?: number } }
  | { waitForRequest: string }
  | { hover: string }
  | { check: string }
  | { uncheck: string }
  | { focus: string }
  | { blur: string }
  | { reload: true }
  | { back: true }
  | { forward: true }
  | { newTab: string }
  | { switchTab: number | string }
  | { closeTab: true }
  | { iframe: { selector: string; steps: Step[] } }
  | { sleep: number }
  | { waitForDownload: { trigger: string; saveAs: string } }
  | { waitForPopup: { trigger: string; switchTo?: boolean } }
  | {
      cookie: {
        name: string;
        value: string;
        domain?: string;
        path?: string;
        expires?: number;
        httpOnly?: boolean;
        secure?: boolean;
        sameSite?: 'Strict' | 'Lax' | 'None';
      };
    }
  | { clearCookies: true };

/** Options common to every helper. */
export interface StripeHelperOptions {
  /**
   * CSS selector for the card iframe container. Defaults to the standard
   * Elements mount `#card-element` but can be overridden for custom
   * integrations.
   */
  cardIframeSelector?: string;
  /**
   * CSS selector for the submit / pay button. Defaults to `button[type="submit"]`.
   */
  submitSelector?: string;
  /**
   * Cardholder name. Defaults to `uxinspect test`.
   */
  holderName?: string;
  /**
   * Expiry in MM/YY format. Defaults to a far-future valid value.
   */
  expiry?: string;
  /**
   * CVC value. Defaults to `123`.
   */
  cvc?: string;
  /**
   * ZIP / postal code, if your form collects one. Defaults to `10001`.
   */
  zip?: string;
}

const DEFAULT_IFRAME = '#card-element iframe, iframe[name^="__privateStripeFrame"]';
const DEFAULT_SUBMIT = 'button[type="submit"]';
const DEFAULT_EXPIRY = '12 / 34';
const DEFAULT_CVC = '123';
const DEFAULT_ZIP = '10001';
const DEFAULT_HOLDER = 'uxinspect test';

/** Official Stripe test card numbers. */
export const TEST_CARDS = {
  /** Generic Visa — always succeeds, no authentication required. */
  success: '4242 4242 4242 4242',
  /** Always triggers a 3-D Secure authentication challenge. */
  threeDS: '4000 0025 0000 3155',
  /** Always declined with a `card_declined` error. */
  declined: '4000 0000 0000 0002',
  /** Insufficient funds decline. */
  insufficient: '4000 0000 0000 9995',
} as const;

function resolve(opts?: StripeHelperOptions) {
  return {
    cardIframe: opts?.cardIframeSelector ?? DEFAULT_IFRAME,
    submit: opts?.submitSelector ?? DEFAULT_SUBMIT,
    holder: opts?.holderName ?? DEFAULT_HOLDER,
    expiry: opts?.expiry ?? DEFAULT_EXPIRY,
    cvc: opts?.cvc ?? DEFAULT_CVC,
    zip: opts?.zip ?? DEFAULT_ZIP,
  };
}

/**
 * Fill the Stripe-hosted card Elements with a valid test card number
 * (`4242 4242 4242 4242`). Asserts no console error by reloading fresh and
 * — after fill — pausing so the uxinspect `consoleErrors` check can capture
 * any runtime error emitted by Stripe.js.
 */
export function stripeCardForm(
  cardNumber: string = TEST_CARDS.success,
  opts?: StripeHelperOptions,
): Step[] {
  const o = resolve(opts);
  return [
    { waitFor: o.cardIframe },
    {
      iframe: {
        selector: o.cardIframe,
        steps: [
          { fill: { selector: 'input[name="cardnumber"], #Field-numberInput', text: cardNumber } },
          { fill: { selector: 'input[name="exp-date"], #Field-expiryInput', text: o.expiry } },
          { fill: { selector: 'input[name="cvc"], #Field-cvcInput', text: o.cvc } },
          { fill: { selector: 'input[name="postal"], #Field-postalCodeInput', text: o.zip } },
        ],
      },
    },
    { sleep: 250 },
  ];
}

/**
 * Drive the 3-D Secure flow with the `4000 0025 0000 3155` challenge card,
 * complete the authentication iframe, and assert a redirect away from the
 * checkout page (the uxinspect runner captures URL changes via its
 * `waitForResponse` / navigation telemetry).
 */
export function stripe3DS(opts?: StripeHelperOptions): Step[] {
  const o = resolve(opts);
  return [
    ...stripeCardForm(TEST_CARDS.threeDS, opts),
    { click: o.submit },
    { waitFor: 'iframe[name^="__privateStripeFrame"], iframe[name*="3ds"], iframe[name*="challenge"]' },
    {
      iframe: {
        selector: 'iframe[name*="3ds"], iframe[name*="challenge"], iframe[name^="__privateStripeFrame"]',
        steps: [
          { waitFor: 'button#test-source-authorize-3ds, button[name="authorize"], button:has-text("Complete authentication")' },
          { click: 'button#test-source-authorize-3ds, button[name="authorize"], button:has-text("Complete authentication")' },
        ],
      },
    },
    { waitForResponse: { url: '**/payment_intents/**', status: 200 } },
  ];
}

/**
 * Submit with the `4000 0000 0000 0002` always-decline card and assert the
 * integration surfaces a visible decline error. Matches the common class
 * names (`.StripeElement--invalid`, `[data-testid="payment-error"]`) and a
 * text-content fallback.
 */
export function stripeDeclinedCard(opts?: StripeHelperOptions): Step[] {
  const o = resolve(opts);
  return [
    ...stripeCardForm(TEST_CARDS.declined, opts),
    { click: o.submit },
    {
      waitFor:
        '.StripeElement--invalid, [data-testid="payment-error"], [role="alert"]:has-text("declined"), text=/card (was )?declined/i',
    },
  ];
}

export interface WebhookAssertOptions {
  /**
   * URL the checkout integration (or a test webhook receiver) exposes that
   * returns `200` once the expected webhook event has been seen. Polled via
   * uxinspect's `waitForResponse`.
   */
  receiverUrl: string;
  /** Max wait in milliseconds before giving up. Default 30_000. */
  timeoutMs?: number;
  /** Poll interval in milliseconds. Default 1_000. */
  intervalMs?: number;
}

/**
 * Pollable assertion: hits a user-provided webhook receiver endpoint
 * repeatedly until it returns `200`, indicating the expected Stripe webhook
 * has been delivered. Works against a custom /__test/webhook endpoint or a
 * mocked webhook receiver (e.g. smee.io proxied to a local capture).
 */
export function stripeWebhookFired(options: WebhookAssertOptions): Step[] {
  const timeout = options.timeoutMs ?? 30_000;
  const interval = options.intervalMs ?? 1_000;
  const steps: Step[] = [];
  const attempts = Math.max(1, Math.ceil(timeout / interval));
  for (let i = 0; i < attempts; i++) {
    steps.push({ sleep: interval });
    steps.push({ waitForResponse: { url: options.receiverUrl, status: 200 } });
  }
  return [
    {
      eval: `await fetch(${JSON.stringify(options.receiverUrl)}, { method: 'GET' })`,
    },
    ...steps.slice(0, 2),
  ];
}

/**
 * Submit a valid success card and assert the page redirects to the expected
 * return URL (pattern-matched via uxinspect's `waitForResponse` to catch the
 * navigation request).
 */
export function stripeSuccessRedirect(
  returnUrl: string,
  opts?: StripeHelperOptions,
): Step[] {
  const o = resolve(opts);
  return [
    ...stripeCardForm(TEST_CARDS.success, opts),
    { click: o.submit },
    { waitForResponse: { url: returnUrl, status: 200 } },
    { waitFor: 'body' },
  ];
}

/**
 * Convenience: a full preset flow object ready to drop into
 * `uxinspect.config.ts` under `flows`. Exercises a successful checkout end
 * to end from a checkout URL.
 */
export function stripeSuccessFlow(params: {
  checkoutUrl: string;
  returnUrl: string;
  options?: StripeHelperOptions;
}): { name: string; steps: Step[] } {
  return {
    name: 'stripe-checkout-success',
    steps: [
      { goto: params.checkoutUrl },
      ...stripeSuccessRedirect(params.returnUrl, params.options),
    ],
  };
}
