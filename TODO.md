# uxinspect TODO — Priority P0 → P10 (v5)

**Vision:** dev-time click verifier — robot user clicks every interactive element, verifies nothing broken, blocks deploy on regression.
**Order:** P0 = most critical, ship first. Tasks spread evenly P0-P10. Local UI/UX features front-loaded.
**Goal:** $300k ARR yr1 → $5M yr3 → $25M yr5.

**Status:** ✅ EXISTS / 🟡 PARTIAL / ❌ MISSING (audit 2026-04-15, v0.11.0)
**Tier:** 🆓 Free MIT / 💎 Pro $19 / 🏢 Team $99 SaaS / 🏛️ Enterprise $499 / 🌐 Cloud add-on $49 / 📦 Pack $49 / ⭐ Sponsor $9

---

# 🔴 P0 — Ship immediately (Pro launch foundation)

The 8 tasks that unlock revenue. Pro $19 goes live after these.

### 1. License-key infrastructure 💎 — MISSING
CF Worker `keys.uxinspect.com/verify`. Signed JWT (Ed25519). 30d cache, 14d offline grace. Polar.sh billing.
**Files:** new `apps/keys-worker/`, new `src/license.ts`.

### 2. Per-step assertion DSL 💎 — MISSING
Extend Step with `assert: { console?: 'clean', network?: 'no-4xx', dom?: 'no-error', visual?: 'matches' }`. 27 step types currently have ZERO assertions.
**Files:** `src/types.ts`, `src/index.ts` step executor.

### 3. Replay capture (rrweb local) 💎 — MISSING
Add rrweb. Record DOM events during every flow + explore. Save `.uxinspect/replays/<flow>-<ts>.json`.
**Files:** new `src/replay.ts`.

### 4. Static HTML replay viewer 💎 — MISSING
Single-file HTML with `rrweb-player` bundled inline (no CDN). CLI: `uxinspect replay <path>`.
**Files:** new `src/replay-viewer.ts`, `src/cli.ts`.

### 5. "Replay this failure" link in HTML report 💎 — MISSING
When flow fails, embed link in report HTML pointing to replay viewer at failure timestamp. **The demo GIF.**
**Files:** `src/report.ts:508-513` extend `renderFlow()`.

### 6. Per-click console error attribution 💎 — PARTIAL
Reset capture before each step, attribute errors to specific click.
**Files:** `src/console-errors.ts`, `src/index.ts:477,590`.

### 7. Per-click network failure attribution 💎 — PARTIAL
Same pattern as #6 for network 4xx/5xx per click.
**Files:** new `src/network-attribution.ts`.

### 8. README + landing page rewrite 🆓+💎
Lead with Pro features + replay GIF. Landing at `uxinspect.com/pricing`.

---

# 🟠 P1 — Sticky retention (Pro stays sticky)

Per-click verifiers that catch real bugs. After this, Pro customers don't churn.

### 9. Stuck-spinner / aria-busy timeout 💎 — MISSING
After each click, if `[aria-busy="true"]` or `.spinner`/`.loading`/`[role=progressbar]` persists >5s, flag broken.
**Files:** new `src/stuck-spinner-audit.ts`.

### 10. Disabled-button click verifier 💎 — MISSING
Walk all `[disabled]` and `[aria-disabled="true"]`, attempt click, assert NO state change.
**Files:** new `src/disabled-buttons-audit.ts`.

### 11. DOM error-state appearance check 💎 — MISSING
After each click, scan for new `[role="alert"]`, `.error`, `.alert-danger`, error toast.
**Files:** new `src/error-state-audit.ts`.

### 12. Form validation behavior detector 💎 — PARTIAL
Submit empty → expect error; submit invalid → expect error; submit valid → expect error clears.
**Files:** extend `src/forms-audit.ts`.

### 13. Modal backdrop-close detector 💎 — PARTIAL
Now: Esc only. Add: click backdrop / outside modal area, verify closes.
**Files:** extend `src/focus-trap-audit.ts`.

### 14. Auth-gated route walker 💎 — PARTIAL
storageState already loads. Add: auto-discover gated routes via sitemap or config glob, run per-click verifier on each.
**Files:** extend `src/driver.ts`, new `src/auth-walker.ts`.

### 15. Click coverage % per route 💎 — MISSING
Count interactive elements per route, divide by clicked count, render %. `--coverage-min 80` budget flag.
**Files:** extend `src/explore.ts`, new `src/coverage.ts`.

### 16. Frustration signal heuristics (synthetic) 💎 — MISSING
Detect rage-click (3+ <500ms), u-turn (back <5s), dead-click, error-click, thrashed-cursor during synthetic runs.
**Files:** new `src/frustration-signals.ts`.

### 17. SQLite history `.uxinspect/history.db` 💎 — PARTIAL
Migrate from JSON to SQLite (better-sqlite3). Schema: runs, flows, audits, metrics.
**Files:** rewrite storage in `src/history-timeline.ts`.

---

# 🟡 P2 — Pro completeness (visual + AI + history)

Pro tier feature parity vs LogRocket/Cypress/Chromatic.

### 18. Trend graph HTML migration 💎 — ✅ EXISTS
Already shipped. Migrate render to read SQLite from #17.

### 19. Diff-against-last-commit CLI command 💎 — PARTIAL
Add `uxinspect diff <baseline.json> [current.json]` subcommand. Auto-save last run to `.uxinspect/last.json`.
**Files:** `src/cli.ts`.

### 20. Anomaly detector (z-score on metrics) 💎 — MISSING
z-score over local SQLite history, flag outliers in trend graph.
**Files:** extend `src/history-timeline.ts`.

### 21. Cross-browser matrix UI in report 💎 — PARTIAL
Lib done. Render side-by-side chromium/firefox/webkit screenshots in HTML report with diff overlay toggle.
**Files:** `src/report.ts`, `src/cross-browser.ts`.

### 22. Heatmap from auto-explore (SVG) 💎 — MISSING
Log click coords during BFS explore. Render SVG overlay clicked (green) vs untested (red).
**Files:** new `src/heatmap.ts`.

### 23. Visual diff: SSIM perceptual 💎 — MISSING
Add SSIM algorithm option alongside pixelmatch. Anti-alias tolerance config, ignore-region DSL.
**Files:** extend visual diff modules.

### 24. Animation freezing + font-load wait 💎 — MISSING
Auto-disable CSS animations, wait `document.fonts.ready`, lazy-load auto-scroll, scroll-and-stitch full-page.
**Files:** extend visual capture modules.

### 25. Locator caching 💎 — ✅ EXISTS
Cache resolved locators by selector hash. Skip LLM/heuristic on cache hit (Stagehand pattern, 2x faster).
**Files:** `src/locator-cache.ts` (new), `src/ai.ts` (wired), `src/cli.ts` (`cache stats|clear`), `src/locator-cache.test.ts` (6 tests).
Persistent cache in shared `.uxinspect/history.db`, SHA-256 key over (instruction + url + viewport), LRU eviction at 10k entries, stale entries revalidated via `page.locator(...).count()` on hit.

### 26. Self-healing locators 💎 — MISSING
When locator fails, retry with neighboring strategies, update cache.
**Files:** extend `src/ai.ts`.

---

# 🟢 P3 — AI + dev loop integration

Make uxinspect part of inner dev loop. Sub-30s runs.

### 27. Ollama bridge (opt-in fuzzy locator) 💎 — MISSING
When heuristic fails, optionally POST to `localhost:11434/api/generate` with DOM snippet.
**Files:** extend `src/ai.ts`, config `ai.fallback.ollama`.

### 28. NL `extract()` with Zod schema 💎 — MISSING
New step type that extracts structured data from page using Zod schema (Stagehand pattern).
**Files:** new `src/extract.ts`, extend `src/types.ts`.

### 29. NL `observe()` to discover actions 💎 — MISSING
Stagehand pattern: returns list of clickable/interactive elements with descriptions.
**Files:** extend `src/ai.ts`.

### 30. Git diff mode (test only changed routes) 💎 — MISSING
Read `git diff --name-only HEAD~1`, map files → routes via config, run only those flows. CLI `--changed`.
**Files:** new `src/git-diff-mode.ts`.

### 31. Fast inner-loop mode (sub-30s) 💎 — MISSING
`--fast` flag = skip slow audits, parallelize aggressively, target <30s. Default in watch mode.
**Files:** `src/cli.ts`, `src/index.ts`.

### 32. Pre-push hook variant 💎 — MISSING
Same shape as pre-commit, full audit instead of fast subset.
**Files:** extend `src/precommit.ts`.

### 33. Browser-extension recorder (Chrome MV3) 💎 — MISSING
Chrome extension that exports flow code to clipboard/file. Better UX than CLI prompt.
**Files:** new `apps/recorder-extension/`.

### 34. AI-narrated step name generation 💎 — MISSING
During recording, use Ollama (opt-in) to generate human-readable step names from DOM context.

### 35. VS Code extension 💎 — MISSING
Show broken interactions inline in editor, jump to flow definition.
**Files:** new `apps/vscode-extension/`.

---

# 🔵 P4 — More local audits + IDE/MCP

Audit categories that close competitor parity.

### 36. i18n / RTL / locale overflow audit 💎 — MISSING
Detect missing translation keys, RTL layout breaks, text overflow per locale.
**Files:** new `src/i18n-audit.ts`.

### 37. GDPR consent flow simulator 💎 — MISSING
Simulate accept/reject paths, verify cookies match consent declaration.
**Files:** new `src/gdpr-audit.ts`.

### 38. Color contrast at every state (hover/focus/disabled) 💎 — MISSING
Walk interactive elements, measure contrast at each state, flag failures.
**Files:** new `src/contrast-states-audit.ts`.

### 39. Auth-edge audit (expired/refresh/CSRF rotation) 💎 — MISSING
Simulate token expiry, refresh, logout, session-fixation, CSRF rotation.
**Files:** new `src/auth-edge-audit.ts`.

### 40. Offline / flaky-network audit 💎 — MISSING
Test service-worker behavior under throttle/offline.
**Files:** new `src/offline-audit.ts`.

### 41. Concurrency audit (2-tab race detection) 💎 — MISSING
Open 2 tabs same user, perform conflicting actions, detect races.
**Files:** new `src/concurrency-audit.ts`.

### 42. Email rendering audit 💎 — MISSING
Mailpit/MailHog bridge, screenshot transactional emails across clients.
**Files:** new `src/email-audit.ts`.

### 43. PDF/print audit 💎 — MISSING
Print-CSS validation, page-break correctness, header/footer bleed.
**Files:** new `src/pdf-audit.ts`.

### 44. MCP server (Claude/Cursor/Copilot) 💎 — MISSING
Expose uxinspect as MCP server for IDE agents.
**Files:** new `apps/mcp-server/`.

---

# 🟣 P5 — Team SaaS launch (cloud goes live)

Hosted dashboard. Team $99 LIVE. CF Pages + Workers + D1 + R2.

### 45. Cloudflare Worker API (`api.uxinspect.com`) 🏢 — MISSING
Worker + D1 + R2. Endpoints: ingest, auth, billing webhooks, results query.
**Files:** new `apps/api/`.

### 46. Cloudflare Pages dashboard (`app.uxinspect.com`) 🏢 — MISSING
Per-team workspace, multi-repo aggregator, trend charts, run history, RBAC.
**Files:** new `apps/dashboard/`.

### 47. PR comment bot (GitHub App) 🏢 — MISSING
GitHub App on CF Worker. Reads CLI JSON output from CI artifacts. Posts diff-vs-main as PR comment.
**Files:** new `apps/github-bot/`.

### 48. Multi-repo dashboard 🏢 — MISSING
Aggregates N repos into unified dashboard. Status of all 12 projects in one view.

### 49. Branded HTML reports + PDF export 🏢 — MISSING
Custom logo/colors via license-keyed config. PDF via Playwright print-to-PDF.
**Files:** extend `src/report.ts`, new `src/pdf-export.ts`.

### 50. Synthetic monitor scheduler (CF Cron Triggers) 🏢 — MISSING
Cloud cron runs flows on schedule against prod, alerts on regression vs baseline.
**Files:** extend `apps/api/` Worker.

### 51. Public status page generator 🏢 — MISSING
Per-team status page at `status.uxinspect.com/<team>`. Uptime SLA tracking.
**Files:** new `apps/status/`.

### 52. Slack/Discord/MS Teams alert templates 🏢 — PARTIAL
Polished templates with regression details, broken click reproducer, screenshot, replay link.

### 53. Email digest (daily/weekly summary) 🏢 — MISSING
Scheduled email summary of test runs, regressions, coverage trends.
**Files:** extend `apps/api/`.

---

# 🩷 P6 — Team expansion + community

CI integrations + community = Team tier completeness.

### 54. PR status check (UI tests, a11y, perf) 🏢 — MISSING
GitHub status check API. Block merge on regression.
**Files:** part of `apps/github-bot/`.

### 55. GitLab/Bitbucket/Azure DevOps integrations 🏢 — MISSING
Same as PR bot for non-GitHub providers.
**Files:** extend `apps/github-bot/`.

### 56. Sharding / parallelization across runners 🏢 — MISSING
Split test runs across CI workers, merge results in cloud.
**Files:** extend `apps/api/`.

### 57. 24-hr email support SLA 🏢 — process
Help Scout or Plain. Auto-routing for Team customers.

### 58. REST API for results 🏢 — MISSING
Public REST API to query results, runs, flows from cloud dashboard.
**Files:** extend `apps/api/`.

### 59. GitHub Sponsors tier setup ⭐ — MISSING
Sponsorware $9/mo. Discord supporter role. Monthly office hours. Early-access (60d before MIT release).

### 60. Discord community 🆓 — MISSING
Public Discord. Channels: support, showcase, contributions, sponsors-only.

### 61. Monthly office hours 🆓+⭐ — process
Recurring Zoom/Meet. Sponsors-only Q&A.

---

# 🟤 P7 — Cloud collector core (BIGGEST REVENUE LEVER)

Real-user RUM + production replay. Steals from LogRocket/FullStory/Hotjar 5-15x cheaper.

### 62. Drop-in JS collector snippet (<5KB) 🌐 — MISSING
Captures: page-view, click events, Web Vitals (LCP/INP/CLS), console errors, network failures.
**Files:** new `packages/collector/`.

### 63. Ingest endpoint + storage 🌐 — MISSING
`api.uxinspect.com/v1/ingest`. Auth via site-id token. Batched events → D1. Rate limit per plan.
**Files:** extend `apps/api/`, D1 migrations.

### 64. Production session replay (rrweb → R2) 🌐 — MISSING
rrweb in collector → R2 blob. Replay viewer at `app.uxinspect.com/replay/<id>`.
**Why:** undercuts LogRocket $295/mo at $49/mo.

### 65. Real-user heatmaps (SVG aggregation) 🌐 — MISSING
Aggregate click coords from D1 → SVG renderer in dashboard. Per page, per device, per traffic source.
**Why:** undercuts Hotjar $80/mo.

### 66. Frustration signals from real users 🌐 — MISSING
Detect rage/dead/u-turn/error-click in real-user data. Auto-clip to replay around event.

### 67. Funnel analytics (real-user) 🌐 — MISSING
Define funnels in dashboard, measure drop-off from real users with replay link per drop-off.

### 68. Form analytics (real-user) 🌐 — MISSING
Field abandon, time-per-field, error rate. Aggregated from collector data.

### 69. Privacy controls 🌐 — MISSING
Default-private inputs, selector-based redaction (`data-private`), GDPR consent integration, IP anonymization.

---

# ⚪ P8 — Cloud expansion + Enterprise foundation

Cloud Replay SKU launch + Enterprise compliance basics.

### 70. Cloud Replay $49/mo SKU launch 🌐 — MISSING
Polar.sh product. Bundles #62-69 standalone for replay-only customers.

### 71. Real-user Web Vitals dashboard 🌐 — MISSING
Field-data CWV (LCP/INP/CLS/FCP/TTFB) over time, by URL/device. CrUX-style.
**Files:** extend `apps/dashboard/`.

### 72. SSO/SAML config 🏛️ — MISSING
License-keyed SAML/OIDC provider config. Restricts dashboard access by org.
**Files:** new `src/sso.ts`, extend `apps/dashboard/`.

### 73. SCIM provisioning 🏛️ — MISSING
Auto-provision/deprovision users via SCIM 2.0.
**Files:** new `apps/api/scim`.

### 74. RBAC 🏛️ — MISSING
Role definitions in license: Owner/Admin/Member/Read-only.
**Files:** new `src/rbac.ts`.

### 75. Audit log of every run 🏛️ — MISSING
SQLite append-only log. Tamper-evident hash chain. Exportable.
**Files:** new `src/audit-log.ts`.

### 76. E2E self-test of CLI 🆓 — MISSING
Run uxinspect against known fixture site, assert expected outcomes.
**Files:** new `src/cli.e2e.test.ts` + `examples/fixture-site/`.

### 77. Increase test coverage (130 untested modules) 🆓 — MISSING
Prioritize: explore, console-errors, ai locator, history-timeline, budget-diff, cross-browser. Target 50%+.

---

# 🩶 P9 — Enterprise complete + first packs

Enterprise tier $499 LIVE. First framework packs.

### 78. Custom rule packs (private repo) 🏛️ — MISSING
Plugin loader for user-defined audit modules. Enterprise-only.
**Files:** new `src/plugin-loader.ts`.

### 79. WCAG 2.2 AA legal-ready PDF (VPAT 2.5 INT) 🏛️ — MISSING
Branded PDF mapping a11y results to WCAG 2.2 SC. VPAT 2.5 INT format. ADA defense.
**Files:** new `src/wcag-vpat.ts`.

### 80. DPA / MSA / SOC2 docs 🏛️ — process
Vanta or Drata. Generates from policies.

### 81. Self-hosted license server (air-gap) 🏛️ — MISSING
Bundle license-validation Worker as Docker image for air-gapped enterprises.
**Files:** new `infra/license-server-docker/`.

### 82. HIPAA BAA support 🏛️ — process
Legal review + contract template.

### 83. Custom data retention 🏛️ — MISSING
Per-team retention config (30/90/365/custom days).
**Files:** extend `apps/api/`.

### 84. Pack: Stripe checkout flow 📦 — MISSING
Preset flows + assertions: card form, 3DS, declined card, success redirect, webhook fired.

### 85. Pack: Next.js App Router 📦 — MISSING
Audit RSC patterns, hydration mismatches, server actions, streaming, route groups.

### 86. Pack: Shopify checkout 📦 — MISSING
Theme sections, app embeds, checkout extensibility, B2B gating.

---

# ⚫ P10 — Long-tail packs

Each pack = 1 week build. Lemon Squeezy checkout. Steady revenue trickle.

### 87. Pack: Remix loaders/actions 📦 — MISSING
Loader error boundaries, action validation, optimistic UI, defer streams.

### 88. Pack: Webflow CMS 📦 — MISSING
Animations, forms, CMS dynamic content, e-commerce.

### 89. Pack: WordPress accessibility 📦 — MISSING
Common theme patterns, plugin conflict detection, comment forms, contact forms.

### 90. Pack: SvelteKit 📦 — MISSING
Loader functions, error pages, form actions, +page.server.

### 91. Pack: Astro 📦 — MISSING
Island hydration, view transitions, content collections, MDX.

### 92. Pack: Nuxt 📦 — MISSING
Nitro, useFetch, server routes, layouts, error pages.

---

# 🚫 OUT OF SCOPE (still skip)

- Real human research panel (Maze/UserTesting category — wrong category)
- Live moderated WebRTC interviews (heavy infra, niche)
- Compliance overlay / a11y fear-selling (toxic, lawsuits)
- Mobile native SDKs until $50k MRR
- Head-on competition with Datadog
- Real device farm (BrowserStack/Sauce already won)
- VC funding unless explicit team-scale decision

---

## Priority Distribution Summary

| Priority | Tasks | Range | Theme | Tier |
|----------|-------|-------|-------|------|
| 🔴 P0 | 8 | #1-#8 | Pro launch foundation | 💎 Pro |
| 🟠 P1 | 9 | #9-#17 | Sticky retention (per-click verifiers) | 💎 Pro |
| 🟡 P2 | 9 | #18-#26 | Pro completeness (visual + AI + history) | 💎 Pro |
| 🟢 P3 | 9 | #27-#35 | AI + dev loop integration | 💎 Pro |
| 🔵 P4 | 9 | #36-#44 | More local audits + IDE/MCP | 💎 Pro |
| 🟣 P5 | 9 | #45-#53 | Team SaaS launch (cloud) | 🏢 Team |
| 🩷 P6 | 8 | #54-#61 | Team expansion + community | 🏢 + ⭐ |
| 🟤 P7 | 8 | #62-#69 | Cloud collector core (BIGGEST LEVER) | 🌐 Cloud |
| ⚪ P8 | 8 | #70-#77 | Cloud expansion + Enterprise basics | 🌐 + 🏛️ |
| 🩶 P9 | 9 | #78-#86 | Enterprise complete + first packs | 🏛️ + 📦 |
| ⚫ P10 | 6 | #87-#92 | Long-tail framework packs | 📦 |
| **TOTAL** | **92** | **#1-#92** | | |

## Tier Unlock Order

```
P0+P1+P2 done → Pro $19 LIVE (months 1-3) → first $1-5k MRR
P3+P4 done → Pro feature-complete (months 4-5) → ramp to $5-10k MRR
P5+P6 done → Team $99 LIVE (months 6-7) → ramp to $15-25k MRR
P7 done → Cloud Replay $49 LIVE (months 8-12) → BIGGEST jump $25-50k MRR
P8+P9 done → Enterprise $499 LIVE (year 2) → $50-150k MRR
P10 ongoing → packs revenue trickle → +$5-10k MRR
```

## Single Most Important Cluster

**P0 #3-#5 (Replay capture + viewer + failure link).** This is the demo GIF, the HN headline, the tweet. Sells $19/mo by itself. Build first.

**P7 #62-#64 (cloud collector + ingest + production replay).** This is the $99/mo Team upgrade trigger that becomes 50% of revenue.

Build P0 → P7 in order, ship as you go. Don't skip ahead.
