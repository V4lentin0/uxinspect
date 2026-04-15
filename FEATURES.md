# uxinspect — Master Feature Catalog (Competitor Superset)

**Source:** 16 parallel agent scans of every direct + adjacent competitor (2026-04-15)
**Goal:** copy every applicable feature into uxinspect to be the most robust UI/UX testing platform in the category
**Constraint:** Free CLI runs local. Pro CLI runs local with license-key. Team/Enterprise hosted SaaS (CF Pages + Workers + D1 + R2).

> **REVISION 2026-04-15:** Local-only constraint REMOVED. Cloud features added (see Category 23 reinstated list — RUM collector, real-user replay, hosted dashboard, etc).

**Status legend:**
- ✅ EXISTS in uxinspect v0.11.0
- 🟡 PARTIAL (lib done, needs CLI/UI/wiring)
- ❌ MISSING (build it)
- 🚫 SKIP (breaks local-only constraint, not in scope)

**Tier legend:** 🆓 Free MIT / 💎 Pro $19 / 🏢 Team $99 / 🏛️ Enterprise $499 / 📦 Pack $49

---

## SOURCES SCANNED (1,400+ features total)

| Source | Features Catalogued |
|--------|---------------------|
| Cypress + Cloud | 100+ |
| Playwright + MS Testing | 100+ |
| Chromatic | 120 |
| Percy + Applitools | 82 |
| LogRocket | 90 |
| FullStory | 79 |
| Hotjar + Contentsquare | 135 |
| Datadog DEM (Synthetics + RUM + Replay) | 90 |
| Checkly | 100 |
| Sentry | 101 |
| AI testers (Octomind/Checksum/Momentic/Tusk/Stagehand/Browser-Use) | 210 |
| Deque axe ecosystem | 100+ rules + IGTs + 6 SKUs |
| A11y tools (Stark/Pa11y/Lighthouse/WAVE/Tenon/Siteimprove/Level Access) | 150 |
| OSS visual+a11y (BackstopJS/reg-suit/Loki/Argos/Pa11y/jest-axe/cypress-axe/playwright-axe) | 130 |
| Perf tools (Lighthouse/PSI/WebPageTest/SpeedCurve/Calibre/DebugBear/Treo) | 150 |
| Research panels (Maze/UserTesting/Lookback/Userbrain/Lyssna/Useberry) | 150 (mostly SKIP) |

---

## CATEGORY 1 — Browser Driver & Flow DSL

| # | Feature | Status | Tier | Source |
|---|---------|--------|------|--------|
| 1 | Click step | ✅ | 🆓 | Cypress, Playwright |
| 2 | Type/fill step | ✅ | 🆓 | Cypress, Playwright |
| 3 | Goto step | ✅ | 🆓 | All |
| 4 | Wait step | ✅ | 🆓 | All |
| 5 | Hover step | ✅ | 🆓 | Cypress, Playwright |
| 6 | Drag step | ✅ | 🆓 | Cypress, Playwright |
| 7 | Upload files | ✅ | 🆓 | Cypress, Playwright |
| 8 | Dialog accept/dismiss | ✅ | 🆓 | All |
| 9 | Iframe step (nested) | ✅ | 🆓 | Cypress, Playwright |
| 10 | Cookie set/clear | ✅ | 🆓 | Cypress, Playwright |
| 11 | Tab switch/close/new | ✅ | 🆓 | Playwright |
| 12 | Wait for response/request | ✅ | 🆓 | Playwright |
| 13 | Eval JS in page | ✅ | 🆓 | Cypress, Playwright |
| 14 | Scroll | ✅ | 🆓 | All |
| 15 | Reload/back/forward | ✅ | 🆓 | Playwright |
| 16 | **Per-step assertion DSL** (console clean / network 2xx / dom no-error / visual matches) | ❌ | 💎 | Playwright `expect`, Cypress chai |
| 17 | **Conditional step (if/then)** | ❌ | 💎 | Stagehand `agent()` |
| 18 | **Loop step (forEach over data)** | ❌ | 💎 | Cypress fixtures |
| 19 | **Custom step plugin loader** | ❌ | 🏛️ | Cypress custom commands |
| 20 | **Step group / sub-flow** | ❌ | 💎 | Playwright `test.step` |
| 21 | **Step-level timeout override** | ❌ | 💎 | Cypress, Playwright |
| 22 | **Soft assertions (continue on fail)** | ❌ | 💎 | Playwright `expect.soft` |
| 23 | **Network throttling (Slow 3G, etc.)** | ✅ | 🆓 | Lighthouse, WebPageTest |
| 24 | **Geolocation override** | ❌ | 💎 | Playwright |
| 25 | **Permissions grant** | ❌ | 💎 | Playwright |
| 26 | **Clipboard read/write** | ❌ | 💎 | Playwright |
| 27 | **Authentication via storageState** | ✅ | 🆓 | Playwright |
| 28 | **HTTP credentials / Basic auth** | ❌ | 💎 | Playwright, Pa11y |
| 29 | **Client certificates (mTLS)** | ❌ | 🏛️ | Playwright |
| 30 | **Proxy support** | ❌ | 💎 | Playwright |

---

## CATEGORY 2 — Locator / AI

| # | Feature | Status | Tier | Source |
|---|---------|--------|------|--------|
| 31 | Heuristic locator (role→label→text→css) | ✅ | 🆓 | Stagehand, Playwright `getBy*` |
| 32 | **Locator caching** | ❌ | 💎 | Stagehand auto-cache |
| 33 | **Self-healing locators** | ❌ | 💎 | Octomind, Checksum, Momentic |
| 34 | **Fuzzy match (Levenshtein)** | ❌ | 💎 | none direct |
| 35 | **Ollama local LLM bridge** | ❌ | 💎 | Browser-Use, Stagehand (with key) |
| 36 | **Multi-LLM ensemble (opt-in)** | ❌ | 💎 | Octomind |
| 37 | **NL `act()` primitive** | 🟡 | 💎 | Stagehand |
| 38 | **NL `extract()` to Zod schema** | ❌ | 💎 | Stagehand |
| 39 | **NL `observe()` to discover actions** | ❌ | 💎 | Stagehand |
| 40 | **NL `agent()` autonomous mode** | ❌ | 💎 | Stagehand, Browser-Use |
| 41 | **Vision (screenshot+LLM)** opt-in | ❌ | 💎 | Browser-Use vision_detail |
| 42 | **Sensitive-data redaction in prompts** | ❌ | 💎 | Browser-Use |
| 43 | **Locator description metadata** | ❌ | 💎 | Playwright `locator.describe()` |

---

## CATEGORY 3 — Per-Click Verification (CORE)

| # | Feature | Status | Tier | Source |
|---|---------|--------|------|--------|
| 44 | Console error capture (session-level) | ✅ | 🆓 | LogRocket, Sentry |
| 45 | Network failure capture (session-level) | ✅ | 🆓 | LogRocket, Sentry |
| 46 | **Per-click console error attribution** | 🟡 | 💎 | LogRocket per-event |
| 47 | **Per-click network failure attribution** | 🟡 | 💎 | LogRocket |
| 48 | **Stuck-spinner detector (aria-busy >Xs)** | ❌ | 💎 | none direct (gap!) |
| 49 | **Modal won't-close detector (Esc + backdrop)** | 🟡 | 💎 | DIY (gap!) |
| 50 | **Form validation behavior cycle** | 🟡 | 💎 | DIY (gap!) |
| 51 | **DOM error-state appearance check** | ❌ | 💎 | DIY (gap!) |
| 52 | **Disabled-button click verifier** | ❌ | 💎 | DIY (gap!) |
| 53 | **Click coverage % per route** | ❌ | 💎 | Cypress UI Coverage |
| 54 | **Auth-gated route walker** | 🟡 | 💎 | DIY (gap!) |
| 55 | **404/500 reachability check** | ✅ | 🆓 | DIY |
| 56 | **Rage-click detection (3+ <500ms)** | ❌ | 💎 | LogRocket, FullStory, Hotjar |
| 57 | **Dead-click detection** | ✅ | 🆓 | LogRocket, FullStory, Hotjar |
| 58 | **U-turn detection (back <5s)** | ❌ | 💎 | Hotjar |
| 59 | **Error-click (click→console err)** | ❌ | 💎 | LogRocket, FullStory |
| 60 | **Thrashed-cursor detection** | ❌ | 💎 | Hotjar, FullStory |
| 61 | **Form abandonment signal** | ❌ | 🏢 | FullStory, Contentsquare |

---

## CATEGORY 4 — Replay Capture (KILLER FEATURE)

| # | Feature | Status | Tier | Source |
|---|---------|--------|------|--------|
| 62 | **rrweb capture during synthetic runs** | ❌ | 💎 | LogRocket, Sentry, Hotjar |
| 63 | **Static HTML replay viewer (offline)** | ❌ | 💎 | none direct (uxinspect unique) |
| 64 | **Replay link from failed step** | ❌ | 💎 | LogRocket, Sentry |
| 65 | **Speed controls + skip-inactivity** | ❌ | 💎 | LogRocket, Hotjar |
| 66 | **Timeline scrubber with DOM diff** | ❌ | 💎 | LogRocket |
| 67 | **Console + network logs in replay** | ❌ | 💎 | LogRocket, Sentry |
| 68 | **Privacy masking (PII default block)** | ❌ | 💎 | LogRocket, Sentry, FullStory |
| 69 | **Selective record (selector blocklist)** | ❌ | 💎 | LogRocket, FullStory `data-private` |
| 70 | **Canvas/WebGL capture** | ❌ | 💎 | LogRocket |
| 71 | **Shadow DOM capture** | ❌ | 💎 | LogRocket, Playwright |
| 72 | **iframe capture** | ❌ | 💎 | LogRocket, Playwright |
| 73 | **Multi-tab session stitching** | ❌ | 💎 | LogRocket |
| 74 | **Replay clip / highlight reel** | ❌ | 💎 | Hotjar, Lookback |
| 75 | **Replay annotations / notes** | ❌ | 💎 | Hotjar, Lookback |
| 76 | **Rage-click/dead-click filters in replay** | ❌ | 💎 | Hotjar, LogRocket |

---

## CATEGORY 5 — Visual Regression

| # | Feature | Status | Tier | Source |
|---|---------|--------|------|--------|
| 77 | Pixelmatch diff | ✅ | 🆓 | BackstopJS, Argos |
| 78 | **SSIM perceptual diff** | ❌ | 💎 | Argos (odiff), Loki |
| 79 | **Anti-alias tolerance** | 🟡 | 💎 | reg-suit `enableAntialias` |
| 80 | **Ignore regions DSL** | ❌ | 💎 | Percy, Chromatic, BackstopJS |
| 81 | **Dynamic region auto-mask** | ❌ | 💎 | Percy Intelli-ignore, Applitools Dynamic match |
| 82 | **Per-component baselines** | 🟡 | 💎 | Chromatic, Loki |
| 83 | **Branch-aware baselines** | ❌ | 💎 | Chromatic, Argos |
| 84 | **Cross-browser visual diff** | 🟡 | 💎 | Chromatic, Percy |
| 85 | **Cross-viewport visual diff** | ✅ | 🆓 | All |
| 86 | **Visual review approval workflow** | ❌ | 🏢 | Chromatic, Percy, Argos |
| 87 | **Baseline acceptance UI (web)** | ❌ | 🏢 | Chromatic, Argos |
| 88 | **Animation freezing (auto)** | ❌ | 💎 | Argos auto-disable, Chromatic SteadySnap |
| 89 | **Font-load wait (document.fonts.ready)** | ❌ | 💎 | Argos, Loki |
| 90 | **Lazy-load auto-scroll then capture** | ❌ | 💎 | Argos |
| 91 | **Scroll-and-stitch full-page** | ❌ | 💎 | Argos, Playwright fullPage |
| 92 | **Hover state capture per element** | ❌ | 💎 | BackstopJS hoverSelector |
| 93 | **Theme/mode matrix (light/dark/locale)** | ❌ | 💎 | Chromatic modes |
| 94 | **TurboSnap (skip unchanged stories)** | ❌ | 🏢 | Chromatic (45% cost saving) |
| 95 | **Match levels (Strict/Layout/Content/Dynamic)** | ❌ | 💎 | Applitools |
| 96 | **OCR-aware diff (ignore font shifts)** | ❌ | 🏛️ | Percy OCR |
| 97 | **A11y contrast advisor in visual** | ❌ | 💎 | Applitools |

---

## CATEGORY 6 — Accessibility (a11y)

| # | Feature | Status | Tier | Source |
|---|---------|--------|------|--------|
| 98 | axe-core all WCAG 2.0/2.1 rules (~95) | ✅ | 🆓 | Deque axe |
| 99 | **WCAG 2.2 AA mapping** | 🟡 | 💎 | axe Auditor |
| 100 | **WCAG 2.2 AAA opt-in rules** | ❌ | 💎 | axe-core |
| 101 | **EN 301 549 / Section 508 / ACAA tags** | ❌ | 💎 | axe-core |
| 102 | Color contrast audit | ✅ | 🆓 | axe, Stark, Lighthouse |
| 103 | **Color contrast at every state** (hover/focus/disabled) | ❌ | 💎 | DIY (gap!) |
| 104 | Keyboard nav / focus order audit | ✅ | 🆓 | axe, Stark |
| 105 | **Tab order visualizer (annotated SVG)** | ❌ | 💎 | Stark, axe DevTools |
| 106 | Touch-target size (WCAG 2.5.5/2.5.8) | ✅ | 🆓 | axe, Stark |
| 107 | Form labels + aria-describedby | ✅ | 🆓 | axe, Pa11y |
| 108 | ARIA validation + roles | ✅ | 🆓 | axe |
| 109 | Heading hierarchy | ✅ | 🆓 | axe, Lighthouse |
| 110 | Landmark structure | ✅ | 🆓 | axe |
| 111 | Image alt text | ✅ | 🆓 | axe |
| 112 | Video captions / track | ❌ | 💎 | axe, Lighthouse |
| 113 | Language audit | ✅ | 🆓 | axe |
| 114 | **Vision simulator (4 color-blind types)** | ❌ | 💎 | Stark |
| 115 | **Screen reader preview/simulation** | ❌ | 🏛️ | Stark Pro |
| 116 | **Accessibility tree snapshot regression** | ❌ | 💎 | Playwright `toMatchAriaSnapshot` |
| 117 | **Auto-fix suggestions (alt text via Ollama)** | ❌ | 💎 | Stark AI |
| 118 | Focus trap detection | ✅ | 🆓 | axe |
| 119 | **Intelligent Guided Tests (IGTs)** for SPA, modal, forms | ❌ | 💎 | axe DevTools Pro |
| 120 | **WCAG/VPAT 2.5 INT PDF report** | ❌ | 🏛️ | Deque Auditor, Level Access |
| 121 | **Compliance score per page/site** | ❌ | 🏢 | axe Monitor, Siteimprove |
| 122 | **PDF accessibility audit** | ❌ | 🏛️ | Siteimprove, Level Access |
| 123 | **Mobile a11y (RN/iOS/Android)** | ❌ | 🚫 | axe Mobile, Level Access |

---

## CATEGORY 7 — Performance

| # | Feature | Status | Tier | Source |
|---|---------|--------|------|--------|
| 124 | Lighthouse perf score | ✅ | 🆓 | Lighthouse, PSI |
| 125 | Core Web Vitals (LCP/FCP/CLS/TBT/SI) | ✅ | 🆓 | All |
| 126 | INP (Interaction-to-Next-Paint) | ✅ | 🆓 | Lighthouse 12+ |
| 127 | **Long tasks with LoAF attribution** | ✅ | 🆓 | Lighthouse |
| 128 | **CLS timeline + node attribution** | ✅ | 🆓 | Lighthouse, DebugBear |
| 129 | **LCP element identification** | ✅ | 🆓 | Lighthouse |
| 130 | JS/CSS bundle size + duplicate detection | ✅ | 🆓 | Lighthouse, DebugBear |
| 131 | JS/CSS coverage (unused %) | ✅ | 🆓 | Lighthouse |
| 132 | **Bundle analyzer tree-map** | ❌ | 💎 | DebugBear |
| 133 | Font loading audit (font-display, FOIT) | ✅ | 🆓 | Lighthouse |
| 134 | Image quality/lazy-load/modern formats | ✅ | 🆓 | Lighthouse |
| 135 | Resource hints validation | ✅ | 🆓 | Lighthouse |
| 136 | HTTP cache headers audit | ✅ | 🆓 | Lighthouse |
| 137 | gzip/brotli compression | ✅ | 🆓 | Lighthouse |
| 138 | Third-party impact analysis | ✅ | 🆓 | Lighthouse, DebugBear |
| 139 | **Third-party request blocking experiments** | ❌ | 💎 | WebPageTest, DebugBear |
| 140 | **Filmstrip / Speed Index video** | ❌ | 💎 | WebPageTest, DebugBear |
| 141 | HAR export | ✅ | 🆓 | Playwright, WebPageTest |
| 142 | **Trace export (Chrome DevTools format)** | ✅ | 🆓 | Playwright, Lighthouse |
| 143 | **Performance budget DSL + fail-on-budget** | 🟡 | 💎 | LHCI, Calibre, DebugBear |
| 144 | **Performance trend graph over commits** | ✅ | 💎 | Calibre, SpeedCurve, DebugBear |
| 145 | **Server-Timing display** | ❌ | 💎 | WebPageTest, SpeedCurve |
| 146 | **HTTP/2/3, QUIC detection** | ❌ | 💎 | WebPageTest |
| 147 | **CrUX field data overlay** | ❌ | 💎 | PSI, Calibre, DebugBear |
| 148 | **Carbon emission audit** | ❌ | 💎 | WebPageTest Carbon Control |
| 149 | **Critical CSS extraction** | ✅ | 🆓 | uxinspect 0.11 |
| 150 | **Source map exposure scan** | ✅ | 🆓 | uxinspect 0.11 |

---

## CATEGORY 8 — Security

| # | Feature | Status | Tier | Source |
|---|---------|--------|------|--------|
| 151 | Security headers (CSP, HSTS, X-Frame, Referrer-Policy) | ✅ | 🆓 | Mozilla Observatory |
| 152 | Retire.js library scan | ✅ | 🆓 | Retire.js, Snyk |
| 153 | TLS/HTTPS audit | ✅ | 🆓 | DIY |
| 154 | **Sensitive path scan (35 signatures)** | ✅ | 🆓 | uxinspect 0.11 |
| 155 | Mixed HTTP/HTTPS detection | ✅ | 🆓 | DIY |
| 156 | **Cookie flag audit (Secure/HttpOnly/SameSite)** | ✅ | 🆓 | uxinspect 0.11 |
| 157 | **CSRF defense audit** | ✅ | 🆓 | uxinspect 0.11 |
| 158 | **Clickjacking defense (X-Frame, CSP frame-ancestors)** | ✅ | 🆓 | uxinspect 0.11 |
| 159 | **API key/secret leakage scan** | ✅ | 🆓 | uxinspect 0.11 |
| 160 | **Subresource Integrity (SRI) validation** | ✅ | 🆓 | uxinspect 0.11 |
| 161 | **GDPR consent flow simulator** | ❌ | 💎 | DIY (gap!) |
| 162 | **Cookie consent declaration vs actual cookies** | ❌ | 💎 | DIY (gap!) |

---

## CATEGORY 9 — SEO + Content

| # | Feature | Status | Tier | Source |
|---|---------|--------|------|--------|
| 163 | Meta tags + heading + canonical | ✅ | 🆓 | Lighthouse SEO |
| 164 | Sitemap.xml validation | ✅ | 🆓 | DIY |
| 165 | Robots.txt audit | ✅ | 🆓 | DIY |
| 166 | JSON-LD / microdata / hreflang | ✅ | 🆓 | Lighthouse |
| 167 | OpenGraph + Twitter Card | ✅ | 🆓 | DIY |
| 168 | Flesch-Kincaid readability | ✅ | 🆓 | DIY |
| 169 | Broken link crawler | ✅ | 🆓 | Pa11y CI |
| 170 | **i18n / RTL / overflow audit per locale** | ❌ | 💎 | DIY (gap!) |
| 171 | **Missing translation key detector** | ❌ | 💎 | DIY (gap!) |

---

## CATEGORY 10 — Auto-Exploration / Crawl

| # | Feature | Status | Tier | Source |
|---|---------|--------|------|--------|
| 172 | BFS crawler (50 clicks / 20 pages default) | ✅ | 🆓 | uxinspect explore.ts |
| 173 | Link-only sitemap crawl (depth 2 / 50 pages) | ✅ | 🆓 | uxinspect crawl.ts |
| 174 | **Auto-discovery of test flows (record from prod)** | ❌ | 💎 | Checksum, Octomind |
| 175 | **Auto-fill forms during crawl** | ✅ | 🆓 | uxinspect explore |
| 176 | **Ignore-list selector during crawl** | ❌ | 💎 | DIY |
| 177 | **Authenticated crawl** | 🟡 | 💎 | DIY |
| 178 | **Heatmap from auto-explore (SVG, coverage gaps)** | ❌ | 💎 | none direct |

---

## CATEGORY 11 — Reporting

| # | Feature | Status | Tier | Source |
|---|---------|--------|------|--------|
| 179 | HTML dashboard report | ✅ | 🆓 | All |
| 180 | JSON report | ✅ | 🆓 | All |
| 181 | JUnit XML | ✅ | 🆓 | All |
| 182 | SARIF (security tab) | ✅ | 🆓 | DIY, Snyk |
| 183 | Allure results | ✅ | 🆓 | Cypress, Playwright |
| 184 | TAP 14 stream | ✅ | 🆓 | DIY |
| 185 | **Failure replay link in report** | ❌ | 💎 | Sentry, LogRocket |
| 186 | **Side-by-side cross-browser diff in report** | 🟡 | 💎 | DIY (gap!) |
| 187 | **Branded HTML report (custom logo/colors)** | ❌ | 🏢 | Deque Pro, Siteimprove |
| 188 | **PDF export (via Playwright print)** | ❌ | 🏢 | Deque Auditor |
| 189 | **VPAT 2.5 INT format PDF** | ❌ | 🏛️ | Deque, Level Access |
| 190 | **Trend graph HTML over commits** | ✅ | 💎 | Calibre, DebugBear |
| 191 | **Filmstrip in report** | ❌ | 💎 | WebPageTest, Lighthouse |
| 192 | **Markdown report (PR comment-friendly)** | ❌ | 🏢 | DIY |

---

## CATEGORY 12 — History & Trends

| # | Feature | Status | Tier | Source |
|---|---------|--------|------|--------|
| 193 | History store (currently JSON files) | 🟡 | 💎 | Calibre, DebugBear, SpeedCurve |
| 194 | **SQLite history `.uxinspect/history.db`** | ❌ | 💎 | DIY |
| 195 | **Trend SVG sparklines (LCP, perf, a11y)** | ✅ | 💎 | Calibre, DebugBear |
| 196 | **Diff-against-last-commit CLI** | 🟡 | 💎 | Cypress diff |
| 197 | **Anomaly detection (z-score on metrics)** | ❌ | 💎 | Datadog, FullStory |
| 198 | **Run comparison view (HTML side-by-side)** | ❌ | 💎 | WebPageTest, Calibre |
| 199 | **Run history retention configurable** | ❌ | 💎 | LogRocket, Sentry |

---

## CATEGORY 13 — CI Integration

| # | Feature | Status | Tier | Source |
|---|---------|--------|------|--------|
| 200 | GitHub Actions annotations | ✅ | 🆓 | Cypress, Playwright |
| 201 | Pre-commit hook generator | ✅ | 🆓 | Husky |
| 202 | **Pre-push hook variant (full audit)** | ❌ | 💎 | DIY |
| 203 | **Git diff mode (test only changed routes)** | ❌ | 💎 | Cypress affected, Chromatic TurboSnap |
| 204 | **Fast inner-loop mode (sub-30s)** | ❌ | 💎 | DIY |
| 205 | **Watch mode (re-run on file change)** | ✅ | 💎 | Vitest, Playwright UI |
| 206 | **PR comment bot (GitHub App)** | ❌ | 🏢 | Codecov, Sentry, Chromatic |
| 207 | **PR status check (UI tests, a11y, perf)** | ❌ | 🏢 | Chromatic, Cypress |
| 208 | **GitLab/Bitbucket/Azure DevOps integrations** | ❌ | 🏢 | Cypress, Chromatic |
| 209 | **CircleCI / Jenkins / Travis templates** | ❌ | 🏢 | Cypress, Playwright |
| 210 | **Vercel / Netlify deploy-triggered runs** | ❌ | 🏢 | Checkly |
| 211 | **Bot-branch skip glob** | ❌ | 🏢 | Chromatic |
| 212 | **Sharding / parallelization across runners** | ❌ | 💎 | Playwright, Cypress |
| 213 | **Blob reporter + merge-reports for sharding** | ❌ | 💎 | Playwright |
| 214 | **CI exit codes (regression vs new vs none)** | ✅ | 🆓 | All |

---

## CATEGORY 14 — Notifications

| # | Feature | Status | Tier | Source |
|---|---------|--------|------|--------|
| 215 | Slack webhook | ✅ | 🆓 | All |
| 216 | Discord webhook | ✅ | 🆓 | DIY |
| 217 | Generic webhook | ✅ | 🆓 | All |
| 218 | **Polished alert templates with reproducer + screenshot + replay link** | ❌ | 🏢 | LogRocket, Sentry |
| 219 | **MS Teams** | ❌ | 🏢 | Sentry, Datadog |
| 220 | **PagerDuty** | ❌ | 🏛️ | Sentry, Checkly |
| 221 | **Opsgenie** | ❌ | 🏛️ | Sentry, Checkly |
| 222 | **Email digest** | ❌ | 🏢 | LogRocket, Calibre |
| 223 | **SMS (via Twilio webhook)** | ❌ | 🏛️ | Checkly |
| 224 | **Fail-only mode** | ✅ | 🆓 | DIY |
| 225 | **Recovery notifications** | ❌ | 🏢 | Checkly |

---

## CATEGORY 15 — Recorder

| # | Feature | Status | Tier | Source |
|---|---------|--------|------|--------|
| 226 | CLI `uxinspect record` | ✅ | 🆓 | Playwright codegen |
| 227 | **Browser extension recorder (Chrome MV3)** | ❌ | 💎 | Stagehand, Datadog test recorder |
| 228 | **AI-narrated step name generation** | ❌ | 💎 | Octomind, Checksum |
| 229 | **Auto-add `toBeVisible` assertion in codegen** | ❌ | 💎 | Playwright 1.55 |

---

## CATEGORY 16 — Browsers / Devices

| # | Feature | Status | Tier | Source |
|---|---------|--------|------|--------|
| 230 | Chromium / Firefox / WebKit | ✅ | 🆓 | Playwright |
| 231 | Headed / headless modes | ✅ | 🆓 | Playwright |
| 232 | Device presets (iPhone, Pixel) | ✅ | 🆓 | Playwright devices[] |
| 233 | **Real device cloud (Sauce, BrowserStack)** | ❌ | 🚫 | breaks local-only |
| 234 | **Cross-browser matrix run + side-by-side report UI** | 🟡 | 💎 | Chromatic |
| 235 | **Mobile emulation per-flow** | ✅ | 🆓 | Playwright |
| 236 | **Persistent profile / user data dir** | ❌ | 💎 | Playwright 1.54 |
| 237 | **Multi-tab / multi-window testing** | ❌ | 💎 | Playwright |

---

## CATEGORY 17 — Synthetic Monitoring (Schedule)

| # | Feature | Status | Tier | Source |
|---|---------|--------|------|--------|
| 238 | **Cron / launchd / systemd scheduler wrapper** | ❌ | 🏢 | Checkly, Datadog |
| 239 | **Multi-location run (via VPS list)** | ❌ | 🚫 | Checkly, Datadog (cloud) |
| 240 | **Heartbeat / healthcheck endpoint** | ❌ | 🏢 | Checkly |
| 241 | **Alert on regression vs `.uxinspect/last.json`** | ❌ | 🏢 | Checkly, Datadog |
| 242 | **SSL cert expiry alerting** | ❌ | 🏢 | Checkly |
| 243 | **Public status page generator** | ❌ | 🏢 | Checkly |
| 244 | **Maintenance windows (mute alerts)** | ❌ | 🏢 | Checkly |

---

## CATEGORY 18 — Plugin / Extensibility

| # | Feature | Status | Tier | Source |
|---|---------|--------|------|--------|
| 245 | **Custom audit plugin loader** | ❌ | 🏛️ | Pa11y reporters, Cypress plugins |
| 246 | **Custom rule pack (private repo)** | ❌ | 🏛️ | Deque Auditor |
| 247 | **Custom reporter API** | ✅ | 🆓 | All |
| 248 | **Hooks: beforeAll / afterEach / etc** | 🟡 | 💎 | Playwright fixtures |
| 249 | **TypeScript types bundled** | ✅ | 🆓 | All |

---

## CATEGORY 19 — Team / Multi-repo

| # | Feature | Status | Tier | Source |
|---|---------|--------|------|--------|
| 250 | **Multi-repo dashboard (static HTML aggregator)** | ❌ | 🏢 | Cypress Cloud, Chromatic |
| 251 | **Per-project workspace** | ❌ | 🏢 | All Enterprise |
| 252 | **Tags + filters across runs** | ❌ | 🏢 | Cypress, Sentry |
| 253 | **Saved queries / saved views** | ❌ | 🏢 | Sentry |

---

## CATEGORY 20 — Enterprise / Compliance

| # | Feature | Status | Tier | Source |
|---|---------|--------|------|--------|
| 254 | **SSO/SAML config** | ❌ | 🏛️ | All Enterprise |
| 255 | **SCIM provisioning** | ❌ | 🏛️ | Sentry, Cypress |
| 256 | **RBAC** | ❌ | 🏛️ | All |
| 257 | **Audit log of every run** | ❌ | 🏛️ | Sentry, Deque |
| 258 | **DPA / MSA / SOC2 docs** | ❌ | 🏛️ | All Enterprise |
| 259 | **HIPAA BAA** | ❌ | 🏛️ | LogRocket, Sentry |
| 260 | **Self-hosted license server (air-gap)** | ❌ | 🏛️ | Sentry self-host, GitLab CE |
| 261 | **Custom data retention** | ❌ | 🏛️ | All |

---

## CATEGORY 21 — API + MCP

| # | Feature | Status | Tier | Source |
|---|---------|--------|------|--------|
| 262 | **REST API for results** | ❌ | 🏢 | All |
| 263 | **MCP server (Claude/Cursor IDE)** | ❌ | 💎 | Octomind, Stagehand, Momentic, Checkly, Sentry, Deque |
| 264 | **VS Code extension (lint inline)** | ❌ | 💎 | axe Linter, Stylelint |

---

## CATEGORY 22 — Framework Packs (📦 add-on)

| # | Feature | Status | Tier | Source |
|---|---------|--------|------|--------|
| 265 | **Stripe checkout pack** | ❌ | 📦 | DIY |
| 266 | **Next.js App Router pack** | ❌ | 📦 | DIY |
| 267 | **Shopify checkout pack** | ❌ | 📦 | DIY |
| 268 | **Remix loaders/actions pack** | ❌ | 📦 | DIY |
| 269 | **Webflow CMS pack** | ❌ | 📦 | DIY |
| 270 | **WordPress accessibility pack** | ❌ | 📦 | DIY |
| 271 | **SvelteKit pack** | ❌ | 📦 | DIY |
| 272 | **Stack-pack guidance (React/Vue/WP)** | ❌ | 📦 | Lighthouse stack-packs |

---

## CATEGORY 23 — REINSTATED (cloud allowed as of 2026-04-15)

Local-only constraint dropped. These features now BUILD as cloud SaaS Team/Enterprise tier:

| # | Feature | Tier | Source |
|---|---------|------|--------|
| 273 | **Real-user RUM collector** (drop-in JS → CF Worker → D1) | 🏢 | Hotjar, Datadog RUM, FullStory |
| 274 | **Real-user heatmap from production** | 🏢 | Hotjar $80/mo |
| 275 | **Real-user session replay from prod** (rrweb → R2) | 🌐 Cloud Replay $49 | LogRocket $295, FullStory |
| 276 | **Hosted dashboard at app.uxinspect.com** | 🏢 | Cypress Cloud, Chromatic |
| 277 | **API + REST endpoints for results** | 🏢 | All Enterprise |
| 278 | **Public status page generator** | 🏢 | Statuspage, Checkly |
| 279 | **Frustration signals from real users** (rage/dead/u-turn/error) | 🏢 | LogRocket, FullStory, Hotjar |
| 280 | **Funnel analytics from real users** | 🏢 | Hotjar, FullStory |
| 281 | **Form analytics from real users** (field abandon, time, errors) | 🏢 | Contentsquare, FullStory |
| 282 | **Privacy controls** (default-private inputs, redaction selectors, GDPR) | 🏢 | LogRocket, Sentry, FullStory |

## CATEGORY 24 — STILL OUT OF SCOPE

| # | Feature | Why SKIP |
|---|---------|----------|
| 283 | Real human research panel (Maze/UserTesting) | Wrong category, not the moat |
| 284 | Live moderated WebRTC interviews | Heavy infra, niche |
| 285 | Browser cloud / device farm | BrowserStack/Sauce won; not the wedge |
| 286 | Mobile native SDK (iOS/Android) | Out of scope until $50k MRR |
| 287 | Compliance overlay / a11y fear-selling | Toxic, lawsuits |
| 288 | Head-on competition with Datadog | Use Cloudflare cost moat instead |
| 289 | VC-backed full SaaS model | Skip unless explicit team-scale decision |

---

## SUMMARY — uxinspect Coverage Score

| Category | Total | ✅ EXISTS | 🟡 PARTIAL | ❌ MISSING | 🚫 SKIP |
|----------|-------|----------|-----------|-----------|---------|
| Browser Driver / DSL | 30 | 16 | 1 | 13 | 0 |
| Locator / AI | 13 | 1 | 1 | 11 | 0 |
| Per-Click Verification | 18 | 4 | 4 | 10 | 0 |
| Replay Capture | 15 | 0 | 0 | 15 | 0 |
| Visual Regression | 21 | 2 | 4 | 15 | 0 |
| Accessibility | 26 | 13 | 1 | 11 | 1 |
| Performance | 27 | 19 | 1 | 7 | 0 |
| Security | 12 | 10 | 0 | 2 | 0 |
| SEO + Content | 9 | 7 | 0 | 2 | 0 |
| Auto-Exploration | 7 | 3 | 1 | 3 | 0 |
| Reporting | 14 | 6 | 1 | 7 | 0 |
| History & Trends | 7 | 1 | 2 | 4 | 0 |
| CI Integration | 15 | 3 | 0 | 12 | 0 |
| Notifications | 11 | 4 | 0 | 7 | 0 |
| Recorder | 4 | 1 | 0 | 3 | 0 |
| Browsers / Devices | 8 | 4 | 1 | 2 | 1 |
| Synthetic Monitoring | 7 | 0 | 0 | 6 | 1 |
| Plugin / Extensibility | 5 | 2 | 1 | 2 | 0 |
| Team / Multi-repo | 4 | 0 | 0 | 4 | 0 |
| Enterprise / Compliance | 8 | 0 | 0 | 8 | 0 |
| API + MCP | 3 | 0 | 0 | 3 | 0 |
| Framework Packs | 8 | 0 | 0 | 8 | 0 |
| **TOTAL** | **272** | **96 (35%)** | **17 (6%)** | **150 (55%)** | **3 (1%)** |
| **OUT OF SCOPE** | 9 | — | — | — | 9 (skip) |

**uxinspect already at 35% coverage of full competitor superset.** Add 60 more (PARTIAL→DONE + critical MISSING) to hit 70% = "robust" tier.

---

## TOP 30 MUST-BUILD (revenue-prioritized superset)

These 30 features close the most competitive gap AND drive Pro/Team/Enterprise revenue:

### Pro $19/mo (build first — 20 features)
1. License-key infra (Worker + JWT + Polar.sh)
2. Per-step assertion DSL (#16)
3. Replay capture rrweb (#62)
4. Static replay viewer (#63)
5. Replay link from failed step (#64)
6. Per-click console error attribution (#46)
7. Per-click network failure attribution (#47)
8. Stuck-spinner detector (#48)
9. Modal won't-close (#49)
10. Form validation cycle (#50)
11. DOM error-state appearance (#51)
12. Disabled-button verifier (#52)
13. Click coverage % (#53)
14. Auth-gated route walker (#54)
15. SQLite history (#194)
16. Diff-against-last-commit CLI (#196)
17. Cross-browser matrix UI (#234)
18. Heatmap from auto-explore (#178)
19. Ollama bridge (#35)
20. Git diff mode + Fast inner-loop (#203 + #204)

### Team $99/mo (next — 7 features)
21. PR comment bot GitHub App (#206)
22. Multi-repo dashboard (#250)
23. Branded HTML/PDF reports (#187 + #188)
24. Synthetic monitor scheduler (#238 + #241)
25. Polished alert templates (#218)
26. PR status check (#207)
27. MS Teams / Email digest (#219 + #222)

### Enterprise $499/mo (then — 7 features)
28. SSO/SAML + RBAC + Audit log (#254 + #256 + #257)
29. WCAG 2.5 VPAT PDF (#189 + #120)
30. Custom rule packs / plugin loader (#245 + #246)

After this 30-feature superset → uxinspect competes head-to-head with Cypress, Chromatic, LogRocket, axe DevTools all at once for 1/15th the price.

---

## Build Order (revised, monetization-aware)

```
Sprints 1-2: License infra + Pro features 2-15 (15 weeks)
  → Pro $19 LIVE with replay + verifier + history + diff

Sprints 3-4: Team features 21-27 (4 weeks)
  → Team $99 LIVE

Sprint 5: Enterprise features 28-30 (3 weeks)
  → Enterprise $499 LIVE

Sprint 6+: Framework packs (1 week each, ongoing)

Then: backfill from full 272-feature catalog by user demand
```
