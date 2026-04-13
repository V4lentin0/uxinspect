# uxinspect

> All-in-one UI/UX testing — tests like a real human, every click, every screen, every accessibility rule, in one CLI.

[![npm](https://img.shields.io/npm/v/uxinspect.svg)](https://npmjs.com/package/uxinspect)
[![license](https://img.shields.io/npm/l/uxinspect.svg)](LICENSE)

## What it does

One command runs everything you need to ship a frontend with confidence:

- **Real-user flows** — clicks, types, navigates, just like a person
- **Accessibility audit** — full WCAG check on every page
- **Performance scores** — Core Web Vitals, LCP, CLS, TBT
- **Visual diff** — pixel-perfect regression detection across viewports
- **Auto-exploration** — bot clicks every button, finds the bugs you forgot
- **AI mode** (optional) — `act("checkout the cart")` survives UI redesigns
- **One HTML report** — every result, every screenshot, in one place

## Install

```bash
npm install -g uxinspect
npx playwright install chromium
```

## Quick start

```bash
uxinspect run --url https://example.com --explore
```

Open `./uxinspect-report/report.html` to see results.

## Config file

```ts
// uxinspect.config.ts
import type { InspectConfig } from 'uxinspect';

export default {
  url: 'https://example.com',
  viewports: [
    { name: 'desktop', width: 1280, height: 800 },
    { name: 'mobile', width: 375, height: 667 },
  ],
  flows: [
    {
      name: 'signup',
      steps: [
        { goto: 'https://example.com/signup' },
        { fill: { selector: '#email', text: 'me@example.com' } },
        { click: 'button[type=submit]' },
        { waitFor: '.welcome' },
      ],
    },
  ],
  checks: { a11y: true, visual: true, perf: true, explore: true },
  ai: { enabled: true, apiKey: process.env.AI_KEY },
} satisfies InspectConfig;
```

```bash
uxinspect run --config ./uxinspect.config.ts
```

## Programmatic API

```ts
import { inspect } from 'uxinspect';

const result = await inspect({
  url: 'https://example.com',
  checks: { a11y: true, visual: true, explore: true },
});

if (!result.passed) process.exit(1);
```

## CLI options

| Flag | Default | Description |
|------|---------|-------------|
| `--url` | required | URL to inspect |
| `--config` | — | Config file (`.ts`/`.js`/`.json`) |
| `--a11y` | `true` | Accessibility audit |
| `--perf` | `false` | Performance audit |
| `--visual` | `true` | Visual diff against baseline |
| `--explore` | `false` | Auto-click every interactive element |
| `--out` | `./uxinspect-report` | Report directory |
| `--baselines` | `./uxinspect-baselines` | Visual baseline directory |
| `--ai-key` | — | API key to enable AI helpers |

## How it compares

| Capability | uxinspect | Cypress | Visual SaaS | A11y plugin |
|---|:-:|:-:|:-:|:-:|
| Real-user clicks | ✅ | ✅ | — | — |
| Multi-browser | ✅ | partial | — | — |
| Accessibility | ✅ | plugin | — | ✅ |
| Performance | ✅ | — | — | — |
| Visual diff | ✅ | plugin | ✅ paid | — |
| Auto-explore | ✅ | — | — | — |
| AI helpers | ✅ | — | — | — |
| One report | ✅ | — | — | — |
| Open source | ✅ MIT | mixed | ❌ | ✅ |

## License

MIT
