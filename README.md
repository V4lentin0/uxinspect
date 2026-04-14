# uxinspect

> All-in-one UI/UX testing — tests like a real human, every click, every screen, every accessibility rule, in one CLI.

[![npm](https://img.shields.io/npm/v/uxinspect.svg?color=10B981)](https://npmjs.com/package/uxinspect)
[![license](https://img.shields.io/npm/l/uxinspect.svg?color=10B981)](LICENSE)
[![checks](https://img.shields.io/badge/checks-38-10B981)](#checks)

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

## Checks

38 built-in checks across 8 categories. Enable any subset via `checks` in the config, or use `--all` on the CLI.

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
| `--reporters` | `html,json` | Comma list: `html`, `json`, `junit`, `sarif` |
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

| Capability | uxinspect | E2E frameworks | Visual SaaS | A11y plugins |
|---|:-:|:-:|:-:|:-:|
| Real-user clicks | yes | yes | — | — |
| Multi-browser | yes | partial | — | — |
| Accessibility | yes | plugin | — | yes |
| Performance | yes | — | — | — |
| Visual diff | yes | plugin | paid | — |
| Security headers | yes | — | — | — |
| Vuln JS scan | yes | — | — | — |
| SEO / structured data | yes | — | — | — |
| Auto-explore | yes | — | — | — |
| AI helpers | yes | — | — | — |
| One report | yes | — | — | — |
| Open source | MIT | mixed | no | yes |

## License

MIT
