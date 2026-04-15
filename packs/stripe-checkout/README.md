# @uxinspect/pack-stripe

Preset uxinspect flows and assertion helpers for Stripe checkout
integrations. $49 one-time license.

## License

This is a **paid commercial pack** — see [`LICENSE`](./LICENSE). It is
distributed via **Lemon Squeezy** at <https://uxinspect.com>. Purchase
once, use forever, no subscription.

- Proprietary license, single-team use.
- No redistribution, no republication to public registries.
- Ships with the private `@uxinspect/pack-stripe` package name — only
  customers with a valid license have install access.

## Installation

After purchase, log in to your uxinspect account, copy the private npm
auth token from the dashboard, and install:

```bash
npm install @uxinspect/pack-stripe --save-dev
```

The token is associated with the email used at checkout; rotating it is
available from your dashboard.

## Helpers

| Helper | Purpose |
| --- | --- |
| `stripeCardForm(cardNumber?, opts?)` | Fills the Stripe Elements card form with a test card (defaults to `4242 4242 4242 4242`). |
| `stripe3DS(opts?)` | Drives the 3-D Secure challenge flow with the `4000 0025 0000 3155` test card. |
| `stripeDeclinedCard(opts?)` | Submits the `4000 0000 0000 0002` decline card and asserts an error is shown. |
| `stripeWebhookFired({ receiverUrl })` | Pollable assertion against a user-provided webhook receiver. |
| `stripeSuccessRedirect(returnUrl, opts?)` | Submits a valid card and asserts redirect to `returnUrl`. |
| `stripeSuccessFlow({ checkoutUrl, returnUrl })` | Ready-made preset flow for the happy path. |

Each helper returns a `Step[]` array compatible with the uxinspect flow
DSL (the same `Step` union exported by the `uxinspect` package).

## Usage

```ts
// uxinspect.config.ts
import type { InspectConfig } from 'uxinspect';
import {
  stripeSuccessFlow,
  stripeDeclinedCard,
  stripe3DS,
  stripeWebhookFired,
} from '@uxinspect/pack-stripe';

const config: InspectConfig = {
  url: 'https://staging.example.com/checkout',
  flows: [
    stripeSuccessFlow({
      checkoutUrl: 'https://staging.example.com/checkout',
      returnUrl: 'https://staging.example.com/thanks',
    }),
    {
      name: 'declined-card-shows-error',
      steps: [
        { goto: 'https://staging.example.com/checkout' },
        ...stripeDeclinedCard(),
      ],
    },
    {
      name: '3ds-challenge-redirects',
      steps: [
        { goto: 'https://staging.example.com/checkout' },
        ...stripe3DS(),
      ],
    },
    {
      name: 'webhook-delivered',
      steps: [
        { goto: 'https://staging.example.com/checkout' },
        ...stripeSuccessFlow({
          checkoutUrl: 'https://staging.example.com/checkout',
          returnUrl: 'https://staging.example.com/thanks',
        }).steps,
        ...stripeWebhookFired({
          receiverUrl: 'https://staging.example.com/__test/last-webhook',
        }),
      ],
    },
  ],
  checks: { consoleErrors: true, a11y: true },
};

export default config;
```

## Versioning

This pack is versioned independently from the main `uxinspect` CLI. It
targets the `Step` DSL exported by `uxinspect@^0.11`. Major DSL changes
in `uxinspect` will ship as a new major version of this pack.

## Support

- Buyer dashboard: <https://uxinspect.com/account>
- Licensing questions: `licensing@uxinspect.com`

## Third-party trademarks

References to third-party payment provider names in this pack are
nominative only. All such names are property of their respective
owners. This pack is not endorsed by or affiliated with any third-party
payment provider.
