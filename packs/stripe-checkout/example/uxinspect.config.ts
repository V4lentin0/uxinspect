/**
 * Working example — `uxinspect.config.ts` using @uxinspect/pack-stripe.
 *
 * Run:
 *   npx uxinspect --config=./example/uxinspect.config.ts
 *
 * Requires a real staging checkout URL that mounts Stripe Elements and a
 * small webhook receiver endpoint (any 200-returning HTTP handler that
 * reports the last-seen event — a one-file Worker works fine).
 */

import {
  stripeCardForm,
  stripe3DS,
  stripeDeclinedCard,
  stripeWebhookFired,
  stripeSuccessRedirect,
  stripeSuccessFlow,
} from '@uxinspect/pack-stripe';

const CHECKOUT = 'https://staging.example.com/checkout';
const RETURN = 'https://staging.example.com/thanks';
const WEBHOOK_RECEIVER = 'https://staging.example.com/__test/last-webhook';

export default {
  url: CHECKOUT,
  viewports: [
    { name: 'desktop', width: 1280, height: 800 },
    { name: 'mobile', width: 375, height: 667 },
  ],
  flows: [
    // 1. Happy path
    stripeSuccessFlow({ checkoutUrl: CHECKOUT, returnUrl: RETURN }),

    // 2. Card form fills without console errors
    {
      name: 'card-form-fills-clean',
      steps: [{ goto: CHECKOUT }, ...stripeCardForm()],
    },

    // 3. 3-D Secure challenge redirects
    {
      name: '3ds-challenge-completes',
      steps: [{ goto: CHECKOUT }, ...stripe3DS()],
    },

    // 4. Declined card surfaces an error
    {
      name: 'declined-card-shows-error',
      steps: [{ goto: CHECKOUT }, ...stripeDeclinedCard()],
    },

    // 5. Explicit success redirect assertion
    {
      name: 'success-redirects-to-thanks',
      steps: [{ goto: CHECKOUT }, ...stripeSuccessRedirect(RETURN)],
    },

    // 6. Webhook was fired after a successful charge
    {
      name: 'success-fires-webhook',
      steps: [
        { goto: CHECKOUT },
        ...stripeSuccessRedirect(RETURN),
        ...stripeWebhookFired({ receiverUrl: WEBHOOK_RECEIVER, timeoutMs: 20_000 }),
      ],
    },
  ],
  checks: {
    consoleErrors: true,
    a11y: true,
    forms: true,
    visual: true,
  },
  output: { dir: './report' },
};
