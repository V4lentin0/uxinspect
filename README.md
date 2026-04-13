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
  parallel: true,
  reporters: ['html', 'json', 'junit', 'sarif'],
  ai: { enabled: true },
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
| `--ai` | `false` | Enable keyless AI flow steps |
| `--headed` | `false` | Run with visible browser |
| `--parallel` | `false` | Run flows in parallel |
| `--storage-state` | — | Path to auth storageState JSON |
| `--reporters` | `html,json` | Comma list: `html`, `json`, `junit`, `sarif` |
| `--publish` | — | Dashboard URL to upload report (e.g. `https://dash.example.com`) |
| `--publish-token` | — | Bearer token for dashboard upload |

## AI without keys

`{ ai: 'click the login button' }` resolves natural language to Playwright locators (role → label → placeholder → title → text → CSS). Survives most UI redesigns. Zero API keys required.

## Cloud dashboard (optional)

Self-host a dashboard worker with R2 storage. Push reports from CI:

```bash
uxinspect run --url https://example.com \
  --publish https://uxinspect-dashboard.example.workers.dev \
  --publish-token $TOKEN
```

See `dashboard/` for the worker source and `wrangler.toml`.

## R2 visual baselines (optional)

Set env vars to share baselines across machines/CI:

```bash
export UXINSPECT_R2_ACCOUNT_ID=...
export UXINSPECT_R2_BUCKET=uxinspect-baselines
export UXINSPECT_R2_ACCESS_KEY_ID=...
export UXINSPECT_R2_SECRET_ACCESS_KEY=...
```

Local files still mirror; R2 is the source of truth.

## Serve a saved report

```bash
uxinspect report ./uxinspect-report --port 4173
```

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
