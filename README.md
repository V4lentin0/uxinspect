# uxinspect

> The robot user that clicks every button on your site and hands you a failure replay.

[![npm](https://img.shields.io/npm/v/uxinspect.svg?color=10B981)](https://npmjs.com/package/uxinspect)
[![license](https://img.shields.io/npm/l/uxinspect.svg?color=10B981)](LICENSE)
[![checks](https://img.shields.io/badge/checks-65%2B-10B981)](#checks)

uxinspect drives a real browser through your app the way a person would — clicking every button, filling every form, walking every gated route. When something breaks, you get a click-by-click replay you can scrub, plus the console error and failed network call attributed to the exact step that triggered them.

```
demo gif here: replay capture --> viewer --> failure-link --> click reproduction
(record once: ./uxinspect-report/report.html, click "Replay this failure")
```

## Install

```bash
npm install -g uxinspect
npx playwright install chromium
```

## Quickstart

```bash
uxinspect run --url https://yourapp.com --explore --replay
open ./uxinspect-report/report.html
```

That single command:

1. Loads your app in a real Chromium browser
2. Discovers every interactive element (buttons, links, forms, menus)
3. Clicks them all, in every viewport
4. Records the DOM via rrweb so any failure has a scrubbable replay
5. Attributes every console error + 4xx/5xx network call to the click that caused it
6. Drops `report.html` with a "Replay this failure" link next to every red row

## Pro features 💎

The free MIT CLI runs every audit. Pro adds the parts that turn a green report into a debuggable failure.

| Pro capability | What you get |
|---|---|
| **Replay capture (rrweb local)** | Every flow + every explore run is recorded to `.uxinspect/replays/<flow>-<ts>.json`. No cloud. No SaaS. |
| **Static HTML replay viewer** | `uxinspect replay <path>` opens a single-file HTML player. Bundled rrweb-player, no CDN. Send the file in Slack and it just works. |
| **"Replay this failure" link** | Failed flows in `report.html` link straight to the replay viewer at the failure timestamp. Click → see the broken click. |
| **Per-step assertion DSL** | `assert: { console: 'clean', network: 'no-4xx', dom: 'no-error', visual: 'matches' }` per step. 27 step types finally have assertions. |
| **Per-click console + network attribution** | Capture resets before every step. The error/4xx/5xx is pinned to the exact click. No more "where did this come from". |
| **Stuck-spinner / aria-busy timeout** | Click → if `[aria-busy="true"]` or `.spinner` persists past 5s, flagged broken. |
| **Disabled-button verifier** | Walks every `[disabled]` and `[aria-disabled="true"]`, attempts click, asserts no state change. |
| **DOM error-state appearance** | Scans for new `[role="alert"]`, `.error`, error toasts after every click. |
| **Auth-gated route walker** | `storageState` + auto-discovered gated routes via sitemap or config glob. Per-click verifier on every protected page. |
| **Click coverage % per route** | Interactive-element count vs clicked count, per route. `--coverage-min 80` budget flag. |
| **Frustration-signal heuristics** | Detects rage-click (3+ <500ms), u-turn (back <5s), dead-click, error-click in synthetic runs. |
| **SQLite history + trend graph** | `.uxinspect/history.db` via better-sqlite3. Z-score anomaly detection on every metric. |
| **Cross-browser matrix UI** | Side-by-side Chromium/Firefox/WebKit screenshots in the report with diff overlay toggle. |
| **Heatmap from auto-explore** | SVG overlay: clicked (green) vs untested (red). Per page, per device. |
| **SSIM perceptual visual diff** | Anti-alias tolerance config + ignore-region DSL alongside pixelmatch. |
| **Locator caching + self-healing** | Cache resolved locators by selector hash. Retry neighboring strategies on miss. 2x faster reruns. |
| **Diff-against-last-commit** | `uxinspect diff <baseline.json> [current.json]`. Auto-saves last run to `.uxinspect/last.json`. |
| **Ollama bridge (opt-in)** | When heuristic locator fails, optionally POST to `localhost:11434/api/generate`. Zero outbound API keys. |

## Tier comparison

| Capability | Free MIT 🆓 | Pro $19 💎 | Team $99 🏢 | Enterprise $499 🏛️ |
|---|:-:|:-:|:-:|:-:|
| 65+ local audits (a11y, perf, security, SEO, visual) | yes | yes | yes | yes |
| Auto-explore + AI keyless locators | yes | yes | yes | yes |
| HTML / JSON / JUnit / SARIF / Allure / TAP reporters | yes | yes | yes | yes |
| Watch mode + pre-commit hook | yes | yes | yes | yes |
| Replay capture + viewer + failure link | — | yes | yes | yes |
| Per-step assertions + click attribution | — | yes | yes | yes |
| Auth-gated walker + coverage % + frustration signals | — | yes | yes | yes |
| SQLite history + trend graph + anomaly detection | — | yes | yes | yes |
| Cross-browser matrix + heatmap + SSIM diff | — | yes | yes | yes |
| Hosted multi-repo dashboard | — | — | yes | yes |
| PR comment bot (GitHub / GitLab / Bitbucket) | — | — | yes | yes |
| Synthetic monitor scheduler + Slack/Discord/Teams alerts | — | — | yes | yes |
| Branded HTML/PDF reports + public status page | — | — | yes | yes |
| 24-hour email support SLA | — | — | yes | yes |
| SSO / SAML / SCIM / RBAC | — | — | — | yes |
| Tamper-evident audit log | — | — | — | yes |
| WCAG 2.2 AA legal PDF (VPAT 2.5 INT) | — | — | — | yes |
| Custom rule packs (private repo) | — | — | — | yes |
| Self-hosted license server (air-gap) | — | — | — | yes |
| DPA / MSA / SOC2 docs | — | — | — | yes |

**Add-ons**

- **Cloud Replay 🌐 — $49/mo** — drop-in `<5KB` JS collector + production rrweb session replay + real-user heatmaps + funnel analytics. Bolts onto any tier.
- **Framework Packs 📦 — $49 one-time** — Stripe checkout, Next.js App Router, Shopify checkout, Remix, Webflow, WordPress, SvelteKit, Astro, Nuxt. Preset flows + assertions.
- **Sponsor ⭐ — $9/mo** — 60-day early access to new audits, supporter role, monthly office hours.

Full pricing: <https://uxinspect.com/pricing>

## Config file

```ts
// uxinspect.config.ts
import type { InspectConfig } from 'uxinspect';

export default {
  url: 'https://yourapp.com',
  viewports: [
    { name: 'desktop', width: 1280, height: 800 },
    { name: 'mobile', width: 375, height: 667 },
  ],
  flows: [
    {
      name: 'signup',
      steps: [
        { goto: 'https://yourapp.com/signup' },
        { fill: { selector: '#email', text: 'me@example.com' } },
        { click: 'button[type=submit]', assert: { console: 'clean', network: 'no-4xx', dom: 'no-error' } },
        { waitFor: '.welcome' },
      ],
    },
  ],
  checks: { a11y: true, visual: true, perf: true, explore: true, replay: true },
  parallel: true,
  reporters: ['html', 'json', 'junit', 'sarif', 'allure', 'tap'],
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
  url: 'https://yourapp.com',
  checks: { a11y: true, visual: true, explore: true, replay: true },
});

if (!result.passed) process.exit(1);
```

## Programmatic helpers

Composable helpers that sit alongside `inspect()` for specialized flows and integrations.

### `flaky` — retry with flake detection

```ts
import { retryWithFlakeDetection, inspect } from 'uxinspect';

const result = await retryWithFlakeDetection(
  () => inspect(config),
  { maxAttempts: 3 },
);
```

### `websocket` — WebSocket flow support

```ts
import { runWebSocketFlow } from 'uxinspect';

await runWebSocketFlow({
  url: 'wss://example.com/socket',
  steps: [
    { send: '{"type":"ping"}' },
    { expect: { contains: 'pong' } },
  ],
});
```

### `graphql` — GraphQL flow support

```ts
import { runGraphQLFlow } from 'uxinspect';

await runGraphQLFlow({
  endpoint: 'https://example.com/graphql',
  steps: [
    { query: '{ viewer { id } }', expect: { path: 'data.viewer.id' } },
  ],
});
```

### `service-worker` — Service Worker audit

```ts
import { auditServiceWorker } from 'uxinspect';

const report = await auditServiceWorker(page);
```

### `rum` — Real User Monitoring

```ts
import { collectRUM, rumClientScript } from 'uxinspect';

const metrics = await collectRUM(page);
// In your production HTML: <script>${rumClientScript()}</script>
```

### `github-annotations` — GitHub Actions PR annotations

```ts
import { emitGitHubAnnotations } from 'uxinspect';

emitGitHubAnnotations(result);
```

### `amp` — AMP HTML validation

```ts
import { validateAmp } from 'uxinspect';

const ampReport = await validateAmp(page);
```

### `bdd` — Gherkin feature file runner

```ts
import { readFileSync } from 'node:fs';
import { parseFeature, featureToFlows, builtinSteps, inspect } from 'uxinspect';

const feature = parseFeature(readFileSync('login.feature', 'utf8'));
const flows = featureToFlows(feature, builtinSteps);
await inspect({ url: 'https://example.com', flows });
```

### `mailbox` — email intercept for signup flows

```ts
import { waitForEmail } from 'uxinspect';

const email = await waitForEmail(
  { provider: 'mailpit', baseUrl: 'https://mail.example.com' },
  { subjectContains: 'Verify' },
);
```

## Checks

100+ built-in audits. 65+ wired into `inspect()` single-run (enable via `checks` or `--all`); all available as library imports.

### Accessibility & UX

| Check | Key | One-liner |
|---|---|---|
| Accessibility | `a11y` | WCAG violations via axe-core on every viewport |
| Keyboard | `keyboard` | Focus trap, tab order, visible focus rings |
| Touch targets | `touchTargets` | WCAG 2.5.5 / 2.5.8 target-size (44/24 px) audit |
| Dead clicks | `deadClicks` | Flags elements that look clickable but do nothing |
| Motion prefs | `motionPrefs` | `prefers-reduced-motion`, dark-mode, print, forced-colors |
| Forms | `forms` | Label, autocomplete, required, validation audit |

```ts
checks: {
  a11y: true,
  keyboard: true,
  touchTargets: true,
  deadClicks: true,
  motionPrefs: true,
  forms: true,
}
```

### Performance

| Check | Key | One-liner |
|---|---|---|
| Lighthouse | `perf` | Core Web Vitals + Lighthouse scoring |
| Long tasks | `longTasks` | Long tasks, LoAF attribution, INP capture |
| CLS timeline | `clsTimeline` | Layout shift timeline with node attribution |
| Bundle size | `bundleSize` | JS/CSS byte budget + duplicate package detection |
| Webfonts | `webfonts` | `font-display`, FOIT/FOUT, oversize font files |
| Images | `imageAudit` | Alt text, lazy-load, modern format, intrinsic dims |
| Resource hints | `resourceHints` | `preload` / `prefetch` / `preconnect` audit |
| Cache headers | `cacheHeaders` | `Cache-Control`, `ETag`, `immutable` audit |
| Compression | `compression` | gzip / brotli + HTTP/2 / HTTP/3 negotiation |

```ts
checks: {
  perf: true,
  longTasks: true,
  clsTimeline: true,
  bundleSize: true,
  webfonts: true,
  imageAudit: true,
  resourceHints: true,
  cacheHeaders: true,
  compression: true,
}
```

### Security

| Check | Key | One-liner |
|---|---|---|
| Headers | `security` | CSP, HSTS, X-Frame-Options, Referrer-Policy, etc. |
| Passive smells | `passiveSecurity` | Surface-level security red flags |
| Retire.js | `retire` | Vulnerable JS library scan (12 lib signatures) |
| TLS | `tls` | Socket audit: protocol, cipher, cert chain |
| Exposed paths | `exposedPaths` | Sensitive path scan (35 signatures) |
| Mixed content | `mixedContent` | Insecure resources on HTTPS pages |

```ts
checks: {
  security: true,
  passiveSecurity: true,
  retire: true,
  tls: true,
  exposedPaths: true,
  mixedContent: true,
}
```

### SEO & Content

| Check | Key | One-liner |
|---|---|---|
| SEO | `seo` | Meta tags, heading structure, canonical |
| Sitemap | `sitemap` | `sitemap.xml` fetch + schema validation |
| Robots | `robotsAudit` | `robots.txt` + meta robots + `X-Robots-Tag` |
| Structured data | `structuredData` | JSON-LD, microdata, `hreflang` |
| Open Graph | `openGraph` | OpenGraph + Twitter Card validation |
| Content quality | `contentQuality` | Flesch-Kincaid readability + duplicate detection |
| Links | `links` | Broken link check across crawled pages |

```ts
checks: {
  seo: true,
  sitemap: true,
  robotsAudit: true,
  structuredData: true,
  openGraph: true,
  contentQuality: true,
  links: true,
}
```

### Network & Infra

| Check | Key | One-liner |
|---|---|---|
| PWA | `pwa` | Manifest + service worker audit |
| Redirects | `redirects` | Redirect chain length + loop detection |
| Crawl | `crawl` | BFS site crawl with configurable depth |
| Third-party | `thirdParty` | Tracker / ad / analytics script analysis |

```ts
checks: {
  pwa: true,
  redirects: true,
  crawl: true,
  thirdParty: true,
}
```

### Visual

| Check | Key | One-liner |
|---|---|---|
| Visual diff | `visual` | Pixelmatch diff against stored baselines |

```ts
checks: { visual: true }
```

### Privacy & Compliance

| Check | Key | One-liner |
|---|---|---|
| Cookie banner | `cookieBanner` | GDPR consent popup detection |
| Console errors | `consoleErrors` | Browser console capture across the run |

```ts
checks: {
  cookieBanner: true,
  consoleErrors: true,
}
```

### Exploration

| Check | Key | One-liner |
|---|---|---|
| Explore | `explore` | Heuristic automated crawling + interaction |
| AI | `ai` | Keyless AI instructions (Playwright role/text locators) |

```ts
checks: {
  explore: true,
  ai: true,
}
```

## CLI flags

Every check has a matching flag. Use `--all` to turn them all on, or pick individually. Flags are boolean; prefix with `--no-` to disable (e.g. `--no-a11y`).

### Core flags

| Flag | Default | Description |
|------|---------|-------------|
| `--url` | required | URL to inspect |
| `--config` | — | Config file (`.ts` / `.js` / `.json`) |
| `--out` | `./uxinspect-report` | Report directory |
| `--baselines` | `./uxinspect-baselines` | Visual baseline directory |
| `--headed` | `false` | Run with visible browser |
| `--parallel` | `false` | Run flows in parallel |
| `--storage-state` | — | Path to auth storageState JSON |
| `--reporters` | `html,json` | Comma list: `html`, `json`, `junit`, `sarif`, `allure`, `tap` |
| `--publish` | — | Dashboard URL to upload report |
| `--publish-token` | — | Bearer token for dashboard upload |
| `--all` | `false` | Enable every check below |

### Check flags

| Category | Flag |
|---|---|
| Accessibility & UX | `--a11y` `--keyboard` `--touch-targets` `--dead-clicks` `--motion-prefs` `--forms` |
| Performance | `--perf` `--long-tasks` `--cls-timeline` `--bundle-size` `--webfonts` `--image-audit` `--resource-hints` `--cache-headers` `--compression` |
| Security | `--security` `--passive-security` `--retire` `--tls` `--exposed-paths` `--mixed-content` |
| SEO & Content | `--seo` `--sitemap` `--robots-audit` `--structured-data` `--open-graph` `--content-quality` `--links` |
| Network & Infra | `--pwa` `--redirects` `--crawl` `--third-party` |
| Visual | `--visual` |
| Privacy & Compliance | `--cookie-banner` `--console-errors` |
| Exploration | `--explore` `--ai` |

Example:

```bash
uxinspect run --url https://example.com --all
uxinspect run --url https://example.com --a11y --perf --retire --seo --visual
```

## Reporters

Pick any combination via `reporters: [...]` or `--reporters html,json,...`.

| Reporter | Output | Use |
|---|---|---|
| `html` | `report.html` | Human-readable dashboard with screenshots + replay links |
| `json` | `report.json` | Machine-readable full result tree |
| `junit` | `junit.xml` | CI test result ingestion |
| `sarif` | `report.sarif` | Code scanning / security tab ingestion |
| `allure` | `allure-results/` | Directory for the Allure UI |
| `tap` | `report.tap` | TAP 14 stream for TAP-compatible tooling |

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

## License

MIT for the core CLI. Pro / Team / Enterprise add proprietary modules under commercial license. See [pricing](https://uxinspect.com/pricing).
