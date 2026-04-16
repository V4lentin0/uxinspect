# @uxinspect/pack-checkout

Preset uxinspect flows for hosted card-checkout patterns. Ships four flows out
of the box, a test-card abstraction over common sandbox decks, and per-flow
assertion presets (console clean, no 4xx, no error DOM, required redirects).

The pack targets generic hosted-card checkout — wherever you render a card
entry iframe, submit, and redirect to a success page. It does not couple to
any single payment provider in its user-facing strings; provider names are
used only as internal config keys to select the correct test deck.

## Install

```
npm install --save-dev @uxinspect/pack-checkout uxinspect
```

## Flows included

| Preset key   | Flow name                         | What it does                                                              |
|--------------|-----------------------------------|---------------------------------------------------------------------------|
| `happyPath`  | `card-checkout-happy-path`        | goto checkout → fill card → submit → success redirect                     |
| `threeDS`    | `card-checkout-3ds-challenge`     | triggers 3DS step-up via the test deck's challenge card and completes it  |
| `declined`   | `card-checkout-declined`          | submits declined test card and asserts an error region appears            |
| `webhook`    | `card-checkout-webhook-fired`     | after success, polls a user-provided catcher URL for the webhook delivery |

Each flow has a matching assertion config under `assertions/` that pins:

```jsonc
{
  "console": "clean",      // no new console errors during the flow
  "network": "no-4xx",     // no new 4xx/5xx responses
  "dom": "no-error",       // no new [role="alert"] / .error / .alert-danger
  "requiredRedirects": [   // expected post-submit navigation
    { "fromPattern": "...", "toPattern": "...", "status": 200 }
  ]
}
```

## Usage

```ts
import { inspect } from 'uxinspect';
import { checkoutPack } from '@uxinspect/pack-checkout';

await inspect({
  url: 'https://shop.example.com',
  ...checkoutPack({
    checkoutUrl: 'https://shop.example.com/checkout',
    successRedirectPattern: 'https://shop.example.com/thank-you**',
    testCards: { provider: 'stripe' },
    webhookCatcherUrl: 'https://webhook.example.com/captured',
    selectors: {
      submit: '#pay-button',
    },
  }),
  checks: { consoleErrors: true, forms: true },
});
```

Or drop flows straight in:

```ts
import { buildFlows } from '@uxinspect/pack-checkout';

const flows = buildFlows({
  checkoutUrl: 'https://shop.example.com/checkout',
  successRedirectPattern: 'https://shop.example.com/thank-you**',
  testCards: { provider: 'braintree' },
  include: ['happyPath', 'declined'],
});
```

## Config shape

```ts
interface CheckoutPackConfig {
  /** Page that hosts the card entry form. */
  checkoutUrl: string;

  /** Glob or URL pattern expected after a successful authorisation. */
  successRedirectPattern: string;

  /**
   * Test card deck. Pick a provider to get a pre-wired success / 3DS /
   * declined set, or pass `custom` and supply your own numbers.
   */
  testCards: {
    provider: 'stripe' | 'braintree' | 'adyen' | 'custom';
    cards?: Partial<{
      success: string;
      threeDS: string;
      declined: string;
      expiry: string;
      cvc: string;
      postalCode: string;
    }>;
  };

  /** Override selectors to match your form. All optional — defaults target
   *  common attributes (`name="email"`, `autocomplete="cc-number"`, etc). */
  selectors?: Partial<{
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
  }>;

  /** Email + cardholder name fixture. */
  customer?: { email: string; name: string };

  /** Catcher endpoint for the webhook flow. Must return
   *  `{ received: true, ... }` or a non-empty array once the webhook
   *  has been delivered. Required only when `webhook` is included. */
  webhookCatcherUrl?: string;

  /** Poll timeout in ms for the webhook flow (default 30000). */
  webhookTimeoutMs?: number;

  /** Which presets to include. Defaults to all four. */
  include?: Array<'happyPath' | 'threeDS' | 'declined' | 'webhook'>;
}
```

## Test cards

Default decks come from each provider's public sandbox documentation and are
inert in production. Override anything via `testCards.cards`.

| Provider   | Success              | 3DS Challenge        | Declined             |
|------------|----------------------|----------------------|----------------------|
| `stripe`   | 4242 4242 4242 4242  | 4000 0000 0000 3220  | 4000 0000 0000 0002  |
| `braintree`| 4111 1111 1111 1111  | 4000 0000 0000 1091  | 4000 1111 1111 1115  |
| `adyen`    | 4111 1111 4555 1142  | 4212 3456 7890 1237  | 4000 3000 1111 2220  |
| `custom`   | (user-supplied)      | (user-supplied)      | (user-supplied)      |

## Webhook verification

The `webhook` flow polls `webhookCatcherUrl` every 1s for up to
`webhookTimeoutMs` ms (default 30s). It passes when the endpoint returns
HTTP 2xx with either a JSON body like `{ received: true, ... }` or a
non-empty array (matching typical request-capture services).

## Development

```
npm install
npm run build
npm test
```

## License

MIT
