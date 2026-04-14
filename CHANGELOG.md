# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.1] - 2026-04-14

### Added

- New audit: `auditErrorPages` — detects broken or misconfigured error pages (404/500).
- New audit: `auditSri` — verifies Subresource Integrity hashes on third-party scripts and styles.
- New audit: `auditWebWorkers` — inspects Web Worker lifecycle, errors, and resource usage.
- New audit: `detectOrphanAssets` — flags loaded assets with no referencing DOM element.
- New helpers: `parseHar`, `renderWaterfallHtml`, `writeWaterfallHtml` — HAR waterfall visualization.

### Changed

- All 5 modules exported from `src/index.ts` and available via public API.

## [0.9.0] - 2026-04-14

### Added

- 16 keyless audits: INP, LCP element, CLS culprit, hreflang, cookie flags, focus trap, favicon, clickjacking, critical CSS, sourcemap scan, secret scan, tracker sniff, z-index, hydration, storage, CSRF.

## [0.8.0] - 2026-04-14

### Added

- 13 keyless modules: PR comments, CSV export, assertions DSL, flaky detector, badges, sitemap flows, bisect, a11y impact filter, reporter plugin, page object generator, retry, cron schedule, budget file.

## [0.7.0] - 2026-04-14

### Added

- 14 keyless modules: notifications (Slack/Discord/Teams), chaos testing, cross-browser runner, codegen converter, CI tools (precommit, init wizard, worker runtime, metrics exporter).

## [0.6.0] - 2026-04-14

### Added

- 17 priority UX features: SSIM visual diff, visual masks, dark-mode audit, tables, SVGs, media, reading level, dead images, pagination, print, canonical, CPU throttle, Storybook, AI triage, AI codegen, baseline drift, autofix.

## [0.5.0] - 2026-04-14

### Added

- 12 page-level checks: JS/CSS coverage, DOM size, ARIA, heading hierarchy, lang, protocols, font loading, prerender, headless detect, animations, event listeners.
- 4 helpers: OpenAPI contract, A/B compare, watch mode, webhook reporter.
- GitHub Action workflow template.

## [0.4.0] - 2026-04-14

### Added

- New check: `retire` — scans bundled JavaScript for libraries with known vulnerabilities.
- New check: `deadClicks` — flags interactive-looking elements that do nothing when clicked.
- New check: `touchTargets` — verifies tap targets meet minimum size guidelines for mobile.
- New check: `keyboard` — exercises tab order and keyboard-only navigation.
- New check: `longTasks` / INP — measures long tasks and Interaction-to-Next-Paint responsiveness.
- New check: `clsTimeline` — records a frame-by-frame timeline of Cumulative Layout Shift sources.
- New check: `forms` — audits form fields for labels, autocomplete, and error affordances.
- New check: `structuredData` — validates JSON-LD, microdata, and RDFa against schema.org.
- New check: `passiveSecurity` — inspects response headers for common hardening gaps.
- New check: `consoleErrors` — captures browser console errors and warnings during a run.
- New check: `sitemap` — fetches and parses `sitemap.xml`, reporting coverage and errors.
- New check: `redirects` — traces redirect chains and flags loops or excessive hops.
- New check: `exposedPaths` — probes common sensitive paths that should not be publicly reachable.
- New check: `tls` — evaluates the TLS certificate, expiry, and protocol posture.
- New check: `crawl` — shallow crawler that enumerates internal links for downstream checks.
- New check: `contentQuality` — heuristics for readability, heading structure, and empty pages.
- New check: `resourceHints` — reviews `preload`, `preconnect`, `prefetch`, and `dns-prefetch` usage.
- New check: `mixedContent` — detects insecure subresources loaded over HTTPS pages.
- New check: `compression` — verifies text assets are served with gzip or brotli compression.
- New check: `cacheHeaders` — audits `Cache-Control`, `ETag`, and related caching headers.
- New check: `cookieBanner` — confirms a cookie or consent banner renders when expected.
- New check: `thirdParty` — inventories third-party requests and their performance impact.
- New check: `bundleSize` — measures transferred and parsed JavaScript bundle size against a budget.
- New check: `openGraph` — validates Open Graph and Twitter card metadata for share previews.
- New check: `robotsAudit` — fetches `robots.txt` and reports on directives, sitemaps, and conflicts.
- New check: `imageAudit` — flags oversized, unoptimized, or missing-alt images.
- New check: `webfonts` — reviews web font loading strategy, FOIT/FOUT risk, and preloads.
- New check: `motionPrefs` — checks that animations respect `prefers-reduced-motion`.
- Programmatic helper: flaky-retry runner for re-executing unstable flows with configurable backoff.
- Programmatic helper: websocket flow recorder and assertion helpers.
- Programmatic helper: GraphQL flow helpers for query, mutation, and subscription testing.
- Programmatic helper: service-worker audit utilities for scope, lifecycle, and caching.
- Programmatic helper: Real User Monitoring (RUM) client for capturing field metrics from real sessions.
- Programmatic helper: GitHub annotations emitter for inline PR check output.
- Programmatic helper: AMP validation helper for AMP-flavored pages.
- Programmatic helper: BDD / Gherkin runner for writing flows in feature-file syntax.
- Programmatic helper: mailbox email-intercept helper for verifying transactional email flows.
- New reporter: `allure` — emits results in Allure-compatible format for rich reporting.
- New reporter: `tap` — emits Test Anything Protocol output for streaming consumers.
- CLI: `--all` flag to run every available check in a single invocation.
- CLI: per-check `--kebab-flag` switches so each new check can be toggled independently.
- HTML report: 28 new sections, one per new check, with collapsible detail and severity badges.

### Changed

- Expanded built-in check catalog to cover the full set of common audit gaps in one run.
- CLI surface reorganized so flags map one-to-one with the underlying check registry.
- HTML report layout updated to keep the new sections scannable at a glance.
- README and smoke-test coverage updated to reflect the expanded feature set.

### Fixed

- Minor stabilization and consistency fixes across the expanded check set uncovered during the v0.4.0 cycle.

[0.9.1]: https://github.com/uxinspect/uxinspect/releases/tag/v0.9.1
[0.9.0]: https://github.com/uxinspect/uxinspect/releases/tag/v0.9.0
[0.8.0]: https://github.com/uxinspect/uxinspect/releases/tag/v0.8.0
[0.7.0]: https://github.com/uxinspect/uxinspect/releases/tag/v0.7.0
[0.6.0]: https://github.com/uxinspect/uxinspect/releases/tag/v0.6.0
[0.5.0]: https://github.com/uxinspect/uxinspect/releases/tag/v0.5.0
[0.4.0]: https://github.com/uxinspect/uxinspect/releases/tag/v0.4.0
