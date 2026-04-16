# uxinspect TODO — personal-use priority (v6)

**Vision:** robot user clicks every interactive element in nissan's apps, verifies nothing broken, blocks deploy on regression. Dev-time tool for personal use.

**Scope pivot (2026-04-16):** build product for nissan only. Sale is far-future optional. Strip billing/SaaS/enterprise/compliance/community/RUM/packs. Focus = local audits + dev loop.

**Status legend:** EXISTS / PARTIAL / MISSING (audit 2026-04-16, v0.11.0)

---

# P0 — core engine (must-have for personal dev loop)

### 1. Per-step assertion DSL — DONE (passed-p0-1-v1)
Extend `Step` with `assert: { console?, network?, dom?, visual?, timing?, form? }`.
`src/types.ts`, `src/index.ts` step executor + `src/step-assertions.test.ts`.

### 2. Replay capture (rrweb local) — DONE (passed-p0-2-v1)
Record DOM events during every flow + explore. Save `.uxinspect/replays/<flow>-<ts>.json`.
`src/replay.ts` + `src/replay.test.ts`. Fixed IIFE bug that hid `window.rrweb`.

### 3. Static HTML replay viewer — DONE (passed-p0-3-v1)
Single-file HTML with `rrweb-player` bundled inline. CLI: `uxinspect replay <path>`.
`src/replay-viewer.ts` + `src/replay-viewer.test.ts`.

### 4. Replay link in HTML report — DONE (passed-p0-4-v1)
On flow failure, embed link in report HTML pointing to replay viewer at failure timestamp.
`src/report.ts` `renderFlow()` + 3 new cases in `src/report.test.ts`.

### 5. Per-click console error attribution — DONE (passed-p0-5-v1)
Reset capture before each step, attribute errors to specific click.
`src/console-errors.ts` + `src/console-errors.test.ts` (7 tests: fingerprinting, per-step attribution, pageerror/unhandledrejection, normalize path+number, detach).

### 6. Per-click network failure attribution — DONE (passed-p0-6-v1)
Same pattern as #5 for 4xx/5xx per click.
`src/network-attribution.ts` + `src/network-attribution.test.ts` (7 tests: per-step attribution, 2xx/3xx ignored, 5xx method/url/requestId, drop outside-window, step separation, in-flight drain, stopCapture idempotency).

---

# P1 — per-click verifiers (catch real bugs in my apps)

### 7. Stuck-spinner / aria-busy timeout — DONE (passed-p1-7-v1)
`src/stuck-spinner-audit.ts` + test. Wired in `src/index.ts` + `--stuck-spinners` CLI.

### 8. Disabled-button click verifier — DONE (passed-p1-8-v1)
`src/disabled-buttons-audit.ts` + test. Wired in `src/index.ts` + `--disabled-buttons` CLI.

### 9. DOM error-state appearance — DONE (passed-p1-9-v1)
`src/error-state-audit.ts` + test. Exports: `snapshotErrorState`, `diffErrorStateAppearance`.

### 10. Form validation behavior — DONE (passed-p1-10-v1)
Extended `src/forms-audit.ts`, `src/forms-behavior.test.ts` covers empty/invalid/valid submit cycle.

### 11. Modal backdrop-close — DONE (passed-p1-11-v1)
`src/focus-trap-audit.ts` handles Esc + backdrop-click. `src/modal-backdrop.test.ts` covers both.

### 12. Auth-gated route walker — DONE (passed-p1-12-v1)
`src/auth-walker.ts` + test. Exports `walkAuthGatedRoutes`, `resolveRoutes`.

### 13. Click coverage % per route — DONE (passed-p1-13-v1)
`src/coverage.ts` + test. `--coverage-min` CLI budget check in `src/cli.ts`.

### 14. Frustration signals (synthetic) — DONE (passed-p1-14-v1)
`src/frustration-signals.ts` + test. Rage-click + u-turn + dead-click + error-click.

### 15. SQLite history `.uxinspect/history.db` — DONE (passed-p1-15-v1)
`src/history-timeline.ts` lazy-loads `better-sqlite3`. `src/history-sqlite.test.ts` covers schema.

---

# P2 — regression + visual

### 16. Diff-against-baseline CLI — DONE (passed-p2-16-v1)
`src/diff-run.ts` + test. `uxinspect diff` CLI. Auto-saves `.uxinspect/last.json`.

### 17. Anomaly detector (z-score) — DONE (passed-p2-17-v1)
`src/history-timeline.ts` + `src/history-anomaly.test.ts`. Z-score flag on trend graph.

### 18. Cross-browser matrix in report — DONE (passed-p2-18-v1)
`src/cross-browser.ts` with `runCrossBrowser`, `writeCrossBrowserHtmlReport`, `renderCrossBrowserHtml`.

### 19. Heatmap SVG from auto-explore — DONE (passed-p2-19-v1)
`src/heatmap.ts` + test. Clicked (green) vs untested (red) SVG.

### 20. SSIM perceptual visual diff — DONE (passed-p2-20-v1)
`src/visual-ssim.ts` + `src/visual-diff.test.ts`. SSIM alongside pixelmatch, ignore-region mask.

### 21. Animation/font freeze — DONE (passed-p2-21-v1)
`src/visual-capture.ts` + test. Freeze animations, waitFonts, lazy-scroll, stitch full-page.

### 22. Self-healing locators — DONE (passed-p2-22-v1)
`src/ai.ts` `selfHealEnabled()`, self-heal events + `src/locator-cache.ts` cache bumping.

---

# P3 — dev loop integration

### 23. Ollama bridge (fuzzy locator fallback) — DONE (passed-p3-23-v1)
`src/ai.ts` `ollamaFallback`, `createOllamaHealHook`. Config `ai.fallback.ollama`. `src/ollama.test.ts`.

### 24. NL `extract()` with Zod schema — DONE (passed-p3-24-v1)
`src/extract.ts` + test. Extract step type in `src/types.ts`.

### 25. NL `observe()` to discover actions — DONE (passed-p3-25-v1)
`src/ai.ts` `observe()` export. Returns clickable/interactive elements + descriptions.

### 26. Git diff mode (test only changed routes) — DONE (passed-p3-26-v1)
`src/git-diff-mode.ts` + test. `--changed` CLI flag.

### 27. Fast mode (sub-30s) — DONE (passed-p3-27-v1)
`src/fast-mode.ts` + test. `--fast` CLI flag, watch-mode default.

### 28. Pre-push hook — DONE (passed-p3-28-v1)
`src/precommit.ts` handles `pre-commit` + `pre-push` HookType. `uxinspect install-hook pre-push` CLI.

### 29. Browser-extension recorder (Chrome MV3) — DONE (passed-p3-29-v1)
`apps/recorder-extension/` MV3 manifest + background + content + popup.

### 30. AI-narrated step names — DONE (passed-p3-30-v1)
`src/ai.ts` `generateStepName()` export. Uses Ollama for DOM-context step names during recording.

### 31. VS Code extension — DONE (passed-p3-31-v1)
`apps/vscode-extension/` TypeScript extension package.

---

# P4 — local audits

### 32. i18n / RTL / locale overflow — DONE (passed-p4-32-v1)
`src/i18n-audit.ts` + `src/i18n-audit.test.ts`. Missing translation keys, RTL breaks, locale overflow.

### 33. GDPR consent flow simulator — DONE (passed-p4-33-v1)
`src/gdpr-audit.ts` + test. Accept/reject simulation, cookie-vs-declaration diff.

### 34. Color contrast at every state (hover/focus/disabled) — DONE (passed-p4-34-v1)
`src/contrast-states-audit.ts` + test. Per-state contrast walk + WCAG flag.

### 35. Auth-edge audit (expired/refresh/CSRF rotation) — DONE (passed-p4-35-v1)
`src/auth-edge-audit.ts` + test. Token expiry/refresh/logout/session-fixation/CSRF.

### 36. Offline / flaky-network — DONE (passed-p4-36-v1)
`src/offline-audit.ts` + test. Service-worker behavior under throttle/offline.

### 37. Concurrency (2-tab race detection) — DONE (passed-p4-37-v1)
`src/concurrency-audit.ts` + test. 2-tab same-user race detection.

### 38. Email rendering — DONE (passed-p4-38-v1)
`src/email-audit.ts` + test. Local SMTP sink bridge + transactional email screenshot.

### 39. PDF/print — DONE (passed-p4-39-v1)
`src/pdf-audit.ts` + test. Print-CSS, page-break, header/footer bleed.

### 40. MCP server (Claude Code / Cursor / Copilot) — DONE (passed-p4-40-v1)
`apps/mcp-server/` — MCP server exposing uxinspect tools+resources. Callable from Claude Code directly.

---

# P5 — personal convenience (aggregate + monitor my own projects)

### 41. Multi-repo local dashboard — MISSING
Aggregate uxinspect runs across my 12 projects (swiftguest, prosmetrics, appsclicks, trackerity, etc.) into one local SPA. Reads SQLite history from each repo's `.uxinspect/history.db`.
reuse already-deployed `apps/dashboard` at app.uxinspect.com for this.

### 42. Synthetic monitor — EXISTS
CF Cron runs flows on schedule against my prod URLs. Alert on regression.
`apps/api/src/scheduled.ts` already live.

### 43. Personal alert webhooks — DONE (passed-p5-43-v1)
`src/alerts.ts` renders Slack / Discord / Teams / Telegram payloads + `sendAlert` + `sendTelegram`. 10 tests in `src/alerts.test.ts`.

### 44. CLI self-test against fixture — DONE (passed-p5-44-v1)
`src/self-test.ts` + `src/self-test.test.ts` + `examples/fixture-site/`.
CLI: `uxinspect self-test` boots HTTP server, runs inspect, asserts known outcomes.

### 45. Test coverage ramp — MISSING
130 untested modules. Target 50%+. Prioritize: explore, console-errors, ai locator, history-timeline, budget-diff, cross-browser.

---

# P6 — 1-plugin frontend playbook (pivot 2026-04-17)

User ask: "all relevant frontend tests in 1 plugin so I won't need to use so many".

### 46. `--playbook` consolidation flag — DONE (passed-p5-46-v1)
`src/playbook.ts` + `src/playbook.test.ts`. `uxinspect run --playbook <url>` enables 72 FE gates in one pass. `--playbook-list` prints the coverage map. Respects explicit `--no-<check>` opt-outs.

### 47. Clock-freeze / time-race audit — DONE (passed-p6-47-v1)
`src/clock-race-audit.ts` + `src/clock-race-audit.test.ts`. `page.clock.install` + `fastForward` + `runFor`, flags `relative-time-stuck` / `relative-time-regressed`. Wired into ChecksConfig.clockRace + InspectResult + playbook.

### 48. XSS payload filler — DONE (passed-p6-48-v1)
`src/xss-audit.ts` + tests. Walks text inputs / textarea / contenteditable, types known payloads, flags executed / reflected-unescaped / page-error. Wired into ChecksConfig.xss + InspectResult + playbook.

### 49. Jitter / human-misclick simulation — DONE (passed-p6-49-v1)
`src/jitter-audit.ts` + tests. ±N-px click offsets + MutationObserver, flags silent-click / inconsistent-response / off-target-trigger. Wired into ChecksConfig.jitter + InspectResult + playbook.

### 50. Virtual screen-reader announcements — DONE (passed-p6-50-v1)
`src/sr-announcements-audit.ts` + tests. Native AccName 1.2 + role + state computation. Flags missing-accessible-name, empty-live-region, role-without-state, landmark-unlabeled, button-label-mismatch, announcement-empty. Wired into ChecksConfig.srAnnouncements + InspectResult + playbook.

### 51. Pseudo-locale long-string audit — DONE (passed-p6-51-v1)
`src/pseudo-locale-audit.ts` + tests. `toPseudoLocale` transform (accented + stretched + bracketed), walks text nodes via TreeWalker, flags truncated-text / clipped-button / overflowing-container / hidden-by-overflow. Non-destructive (restores originals). Wired into ChecksConfig.pseudoLocale + InspectResult + playbook.

**Frontend playbook: 77/77 gates complete.**

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
