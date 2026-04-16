# uxinspect TODO — personal-use priority (v6)

**Vision:** robot user clicks every interactive element in nissan's apps, verifies nothing broken, blocks deploy on regression. Dev-time tool for personal use.

**Scope pivot (2026-04-16):** build product for nissan only. Sale is far-future optional. Strip billing/SaaS/enterprise/compliance/community/RUM/packs. Focus = local audits + dev loop.

**Status legend:** EXISTS / PARTIAL / MISSING (audit 2026-04-16, v0.11.0)

---

# P0 — core engine (must-have for personal dev loop)

### 1. Per-step assertion DSL — MISSING
Extend `Step` with `assert: { console?: 'clean', network?: 'no-4xx', dom?: 'no-error', visual?: 'matches' }`.
`src/types.ts`, `src/index.ts` step executor.

### 2. Replay capture (rrweb local) — MISSING
Record DOM events during every flow + explore. Save `.uxinspect/replays/<flow>-<ts>.json`.
new `src/replay.ts`.

### 3. Static HTML replay viewer — MISSING
Single-file HTML with `rrweb-player` bundled inline. CLI: `uxinspect replay <path>`.
new `src/replay-viewer.ts`.

### 4. Replay link in HTML report — MISSING
On flow failure, embed link in report HTML pointing to replay viewer at failure timestamp.
`src/report.ts` extend `renderFlow()`.

### 5. Per-click console error attribution — PARTIAL
Reset capture before each step, attribute errors to specific click.
`src/console-errors.ts`, `src/index.ts`.

### 6. Per-click network failure attribution — PARTIAL
Same pattern as #5 for 4xx/5xx per click.
new `src/network-attribution.ts`.

---

# P1 — per-click verifiers (catch real bugs in my apps)

### 7. Stuck-spinner / aria-busy timeout — MISSING
After each click, flag if `[aria-busy="true"]` / `.spinner` / `.loading` persists >5s.
new `src/stuck-spinner-audit.ts`.

### 8. Disabled-button click verifier — MISSING
Walk `[disabled]` + `[aria-disabled="true"]`, attempt click, assert no state change.
new `src/disabled-buttons-audit.ts`.

### 9. DOM error-state appearance — MISSING
After each click, scan for new `[role="alert"]`, `.error`, `.alert-danger`, error toast.
new `src/error-state-audit.ts`.

### 10. Form validation behavior — PARTIAL
Submit empty → error. Invalid → error. Valid → error clears.
extend `src/forms-audit.ts`.

### 11. Modal backdrop-close — PARTIAL
Currently Esc only. Add: click outside modal, verify closes.
extend `src/focus-trap-audit.ts`.

### 12. Auth-gated route walker — PARTIAL
storageState loads already. Add auto-discover gated routes via sitemap/config, run per-click on each.
extend `src/driver.ts`, new `src/auth-walker.ts`.

### 13. Click coverage % per route — MISSING
Count interactive vs clicked, render %. `--coverage-min 80` budget.
extend `src/explore.ts`, new `src/coverage.ts`.

### 14. Frustration signals (synthetic) — MISSING
Rage-click (3+ <500ms), u-turn (back <5s), dead-click, error-click during synthetic runs.
new `src/frustration-signals.ts`.

### 15. SQLite history `.uxinspect/history.db` — PARTIAL
Migrate JSON → SQLite (better-sqlite3). Schema: runs, flows, audits, metrics.
rewrite `src/history-timeline.ts`.

---

# P2 — regression + visual

### 16. Diff-against-baseline CLI — PARTIAL
`uxinspect diff <baseline.json> [current.json]`. Auto-save last run to `.uxinspect/last.json`.
`src/cli.ts`.

### 17. Anomaly detector (z-score) — MISSING
z-score over SQLite history, flag outliers in trend graph.
extend `src/history-timeline.ts`.

### 18. Cross-browser matrix in report — PARTIAL
Render side-by-side chromium/firefox/webkit screenshots with diff overlay toggle.
`src/report.ts`, `src/cross-browser.ts`.

### 19. Heatmap SVG from auto-explore — MISSING
Log click coords during BFS, render SVG: clicked (green) vs untested (red).
new `src/heatmap.ts`.

### 20. SSIM perceptual visual diff — MISSING
Add SSIM alongside pixelmatch. Anti-alias tolerance, ignore-region DSL.
extend visual diff modules.

### 21. Animation/font freeze — MISSING
Auto-disable CSS animations, wait `document.fonts.ready`, scroll-and-stitch full-page.
extend visual capture modules.

### 22. Self-healing locators — MISSING
On locator fail, retry with neighboring strategies, update cache.
extend `src/ai.ts`.

---

# P3 — dev loop integration

### 23. Ollama bridge (fuzzy locator fallback) — MISSING
When heuristic fails, POST to `localhost:11434/api/generate` with DOM snippet.
extend `src/ai.ts`, config `ai.fallback.ollama`.

### 24. NL `extract()` with Zod schema — MISSING
New step type: extract structured data from page via Zod.
new `src/extract.ts`, extend `src/types.ts`.

### 25. NL `observe()` to discover actions — MISSING
Returns list of clickable/interactive elements with descriptions.
extend `src/ai.ts`.

### 26. Git diff mode (test only changed routes) — MISSING
Read `git diff --name-only HEAD~1`, map files → routes, run only those flows. `--changed`.
new `src/git-diff-mode.ts`.

### 27. Fast mode (sub-30s) — MISSING
`--fast` = skip slow audits, parallelize, <30s target. Default in watch mode.
`src/cli.ts`, `src/index.ts`.

### 28. Pre-push hook — MISSING
Full audit variant of pre-commit.
extend `src/precommit.ts`.

### 29. Browser-extension recorder (Chrome MV3) — MISSING
Record flows, export code to clipboard/file.
new `apps/recorder-extension/`.

### 30. AI-narrated step names — MISSING
Use Ollama to name steps from DOM context during recording.

### 31. VS Code extension — MISSING
Show broken interactions inline, jump to flow definition.
new `apps/vscode-extension/`.

---

# P4 — local audits

### 32. i18n / RTL / locale overflow — MISSING
Missing translation keys, RTL breaks, text overflow per locale.
new `src/i18n-audit.ts`.

### 33. GDPR consent flow simulator — MISSING
Simulate accept/reject, verify cookies match consent declaration.
new `src/gdpr-audit.ts`.

### 34. Color contrast at every state (hover/focus/disabled) — MISSING
Walk interactives, measure contrast per state, flag fails.
new `src/contrast-states-audit.ts`.

### 35. Auth-edge audit (expired/refresh/CSRF rotation) — MISSING
Simulate token expiry, refresh, logout, session-fixation, CSRF.
new `src/auth-edge-audit.ts`.

### 36. Offline / flaky-network — MISSING
Service-worker behavior under throttle/offline.
new `src/offline-audit.ts`.

### 37. Concurrency (2-tab race detection) — MISSING
Open 2 tabs same user, conflicting actions, detect races.
new `src/concurrency-audit.ts`.

### 38. Email rendering — MISSING
Mailpit/MailHog bridge (or local SMTP sink), screenshot transactional emails.
new `src/email-audit.ts`.

### 39. PDF/print — MISSING
Print-CSS validation, page-break correctness, header/footer bleed.
new `src/pdf-audit.ts`.

### 40. MCP server (Claude Code / Cursor / Copilot) — MISSING
Expose uxinspect as MCP server. HUGE personal win — call from Claude Code directly.
new `apps/mcp-server/`.

---

# P5 — personal convenience (aggregate + monitor my own projects)

### 41. Multi-repo local dashboard — MISSING
Aggregate uxinspect runs across my 12 projects (swiftguest, prosmetrics, appsclicks, trackerity, etc.) into one local SPA. Reads SQLite history from each repo's `.uxinspect/history.db`.
reuse already-deployed `apps/dashboard` at app.uxinspect.com for this.

### 42. Synthetic monitor — EXISTS
CF Cron runs flows on schedule against my prod URLs. Alert on regression.
`apps/api/src/scheduled.ts` already live.

### 43. Personal alert webhooks — PARTIAL
Slack/Discord/Telegram on my prod URL regressions. Keep templates simple (my own use).
extend `apps/api/`.

### 44. CLI self-test against fixture — MISSING
`uxinspect self-test` runs against bundled fixture site, asserts known outcomes.
new `src/cli.e2e.test.ts` + `examples/fixture-site/`.

### 45. Test coverage ramp — MISSING
130 untested modules. Target 50%+. Prioritize: explore, console-errors, ai locator, history-timeline, budget-diff, cross-browser.

---

# Already deployed (keep running, no further invest unless personal need)

- keys.uxinspect.com — Ed25519 license signer (unused; keep idle)
- api.uxinspect.com — monitor scheduler + ingest (personal use)
- app.uxinspect.com — dashboard (target for #41)
- pr.uxinspect.com — GitHub bot (comment on my own PRs)
- status.uxinspect.com — public status page (personal prod monitoring)

---

# DROPPED (sale-only scope, not needed for personal use)

- License-key infrastructure + Polar billing (keys-worker idle, no product)
- Multi-tenant SaaS dashboard logic (Team/Enterprise tiers)
- GitHub App billing / installation pricing
- SSO / SAML / SCIM / RBAC / audit log / custom retention
- Self-hosted license server / air-gap Docker
- WCAG VPAT 2.5 PDF (legal product)
- DPA / MSA / SOC2 / HIPAA BAA (compliance paperwork)
- Cloud RUM collector + production replay + real-user heatmaps / frustration / funnel / form analytics / Web Vitals dashboard (Hotjar/LogRocket category)
- Cloud Replay $49 SKU
- Framework "packs" as paid add-ons (Stripe, Next.js, Shopify, Remix, Webflow, WordPress, SvelteKit, Astro, Nuxt)
- GitHub Sponsors / Discord community / office hours
- GitLab/Bitbucket/Azure DevOps PR integrations (I use GitHub only)
- PR status check as billing gate
- Public REST API for 3rd-party consumption
- Branded PDF reports (logo/color config)
- 24-hr email support SLA
- CI sharding across external runners
- Mobile native SDK
- Real device farm
- VC funding
- Pricing page / landing sales copy

---

# Build order

Strict serial: P0 → P1 → P2 → P3 → P4 → P5. One feature at a time, merge-protocol per `.claude/CLAUDE.md` (local test → typecheck → uxinspect self-run → merge no-ff → retest on main → tag passed-X-vN).

Most valuable first 3 for me:
1. #1 assertion DSL (unlocks every other check)
2. #2+#3+#4 replay (debug my own flaky tests)
3. #40 MCP (call from Claude Code = daily use)
