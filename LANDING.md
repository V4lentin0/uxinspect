# uxinspect.com landing + pricing — copy spec

> 1-page copy spec for the marketing Pages site.
> Design tokens: bg #FAFAFA, primary #10B981 (bg #ECFDF5, light #6EE7B7), secondary #3B82F6 (bg #EFF6FF), text #1D1D1F, borders #E5E7EB, Inter, 6–8 px radius, subtle shadows. No dark, no gradients, no emojis in UI. No third-party brand names in user-facing copy.
> Single Cloudflare Pages site. Routes: `/` (hero + pricing), `/pricing` (anchor-scrolls to tier table).

---

## Route: `/`

### Hero (above fold)

**H1 (72 px, weight 700, #1D1D1F, max-width 720):**
The robot user that clicks every button on your site and hands you the failure replay.

**Subhead (20 px, weight 400, #4B5563, max-width 640):**
Dev-time click verifier. Drives a real browser through every button, form and gated route. When something breaks, you get a scrubbable DOM replay plus the console error and failed network call pinned to the exact click that triggered them.

**Primary CTA (#10B981 bg, white text, 14 px, 6 px radius, 40 px tall):** `npm install -g uxinspect`
**Secondary CTA (transparent bg, #3B82F6 text, border #3B82F6, same size):** View pricing → scrolls to `#pricing`

**Trust line (13 px, #6B7280):** Free MIT CLI · No account, no cloud, no data leaves your machine · Pro tier adds failure replay.

---

### Demo strip (full-width card, #FFFFFF bg, border #E5E7EB, 8 px radius, shadow-sm)

Three-column side-by-side mock (desktop only, stacks on mobile):

**Col 1 — Report row (failed):**
```
signup → checkout                                ✗ FAIL
Step 7: click #submit
Console: TypeError: cart is undefined
Network: POST /api/order → 500
[Replay this failure]  ← green button
```

**Col 2 — Replay viewer scrubbing timeline:**
```
00:00 ──●────────────●──────────── 00:07
        load         click #submit (failed)

[DOM snapshot at 00:04.2]
[Cursor hovering over disabled-looking submit]
```

**Col 3 — Attribution detail:**
```
Step 7 · 00:04.2
  ├─ click target: #submit
  ├─ console: TypeError at checkout.js:142
  ├─ network: POST /api/order → 500 (142 ms)
  └─ DOM diff: [role=alert] appeared
```

**Caption under strip (14 px, #4B5563):** Record once. One HTML file. Scrub the timeline, see every DOM mutation, the failing click highlighted next to the exact network call that broke.

---

### Why it exists (3 stat cards, 3-col grid)

Card style: #FFFFFF bg, border #E5E7EB, 8 px radius, padding 24 px, shadow-sm.

**Card 1 — big number (48 px #10B981 weight 700):** 65+
Label: **Built-in audits.** Accessibility, performance, security, SEO, visual diff — every check wired into a single run.

**Card 2 — big number (48 px #10B981):** 0
Label: **Keys required.** Keyless AI locators resolve natural language to role/label/text selectors. No API keys, no cloud calls.

**Card 3 — big number (48 px #10B981):** 100%
Label: **Local by default.** Free CLI records, replays and reports entirely on your laptop or your CI runner. You own the artifacts.

---

### Feature rows (alternating left/right, 2 cols, 80 px gap)

Image placeholder: screenshot or animated sequence on one side, text on the other.

**Row 1 — Failure replay you can scrub**
Every flow and every auto-explore run records DOM events to a single JSON. One command opens a self-contained HTML viewer with a scrubbable timeline. Failed flows in the report link straight to the replay at the moment of failure.

**Row 2 — Attribution pinned to the click**
Console capture resets before every step. The error, the 4xx, the 5xx — each pinned to the exact click that fired them. No more grepping a run log to figure out which click broke.

**Row 3 — Per-step assertion DSL**
`assert: { console: 'clean', network: 'no-4xx', dom: 'no-error', visual: 'matches' }` on any of the 27 step types. Red when the click fails the assertion, green when it passes. CI-friendly exit codes.

**Row 4 — Catches the bugs users feel**
Stuck spinner still spinning after 5 s? Flagged. Disabled button that fires a handler anyway? Flagged. Click that makes a `[role=alert]` appear? Flagged. Dead click, rage click, U-turn, error click — all detected in a synthetic run.

**Row 5 — Auth-gated walker**
Load a `storageState` once, discover gated routes via sitemap or config glob, run the per-click verifier on every protected page. The robot user knows how to log in.

---

### Pricing section `#pricing`

H2 (40 px, weight 700, #1D1D1F, centered): **Pricing that stays out of your way**

Subhead (18 px, #4B5563, centered, max-width 560):
Free MIT CLI forever. Pro adds the parts that turn a green report into a debuggable failure. Everything else bolts on à la carte.

#### Tier cards (5-col grid on desktop, stacks on mobile)

Card base: #FFFFFF bg, border #E5E7EB, 8 px radius, padding 28 px, shadow-sm. Pro card highlighted: border #10B981 2 px, tag "Most popular" in #ECFDF5 pill.

---

**Free · MIT**
$0 forever

- 65+ local audits (a11y, perf, security, SEO, visual)
- Auto-explore + keyless AI locators
- HTML / JSON / JUnit / SARIF reporters
- Watch mode + pre-commit hook
- Self-host dashboard worker optional

CTA: `npm install -g uxinspect` (copy button, #F3F4F6 bg, mono font)

---

**Pro · $19/mo** (or $190/yr — 2 months free)

Everything in Free, plus:

- **Failure replay capture + single-file HTML viewer**
- **"Replay this failure" link in every red report row**
- **Per-step assertion DSL** (27 step types)
- **Per-click console + network attribution**
- **Stuck-spinner / aria-busy timeout** (default 5 s, configurable)
- **Disabled-button verifier** — asserts disabled elements truly inert
- **DOM error-state appearance diff** — catches new alerts/toasts per click
- **Auth-gated route walker** + click coverage % per route
- **Frustration-signal heuristics** (rage, U-turn, dead, error)
- **SQLite history + trend graph + anomaly detection**
- **Cross-browser matrix + heatmap + SSIM visual diff**
- **Locator caching + self-healing retry**
- **Diff-against-last-commit CLI**

CTA: **Start Pro trial** (#10B981 bg, white text)
Fine print: 14-day trial. Offline grace 14 days. License key check, no runtime phone-home.

---

**Team · $99/mo per team** (≤10 seats, $9/seat over)

Everything in Pro, plus:

- **Hosted multi-repo dashboard** (Cloudflare-hosted)
- **PR comment bot** for major git hosts
- **Synthetic monitor scheduler** + chat/webhook alerts
- **Branded HTML / PDF reports** + public status page
- **24-hour email support SLA**

CTA: **Start Team trial** (#10B981 bg, white text)

---

**Enterprise · $499/mo** (or custom)

Everything in Team, plus:

- **SSO / SAML / SCIM / RBAC**
- **Tamper-evident audit log**
- **WCAG 2.2 AA legal PDF (VPAT 2.5 INT)**
- **Custom rule packs (private repo)**
- **Self-hosted license server (air-gap)**
- **DPA / MSA / SOC 2 docs**

CTA: **Contact sales** (#3B82F6 text, border #3B82F6)

---

#### Add-ons (3-col grid below tier cards, smaller)

Card base: same as tier cards, padding 20 px.

**Cloud Replay · $49/mo**
Drop-in `<5 KB` JS collector. Production session replay, real-user heatmaps, funnel analytics. Bolts onto any tier.

**Framework Packs · $49 one-time**
Preset flows and assertions for common commerce, CMS and app-router setups. Nine packs at launch. Buy what you use.

**Sponsor · $9/mo**
60-day early access to new audits, supporter role in the changelog, monthly office hours.

---

### Pricing FAQ (accordion, 2-col on desktop)

**Does the free tier stay free?**
Yes. MIT forever. The 65+ audits, auto-explore, keyless locators, reporters, watch mode — none of it ever gets paywalled. Pro adds new proprietary modules; it does not take anything away.

**Do you see my data?**
No. Free CLI and Pro CLI run entirely on your machine. License key verification is a short JWT roundtrip once per 30 days, cached; everything else is offline. Cloud Replay is a separate opt-in add-on with its own collector.

**Offline CI runners?**
Yes. Pro license check has a 14-day offline grace. Cache the JWT in CI secrets and you run air-gapped.

**Refunds?**
30-day no-questions refund on Pro. Team and Enterprise are annual with prorated refunds.

**Can I self-host the dashboard?**
Yes on all tiers. Dashboard worker source ships with the repo. Team tier adds the managed Cloudflare-hosted version.

**Billing regions?**
USD, EUR, GBP. VAT handled automatically. Receipts on demand.

---

### Footer (#FFFFFF bg, border-top #E5E7EB, 48 px padding-y)

4-col grid: Product · Docs · Company · Legal. Each col has 13 px label weight 600 + 13 px links weight 400 #4B5563.

- **Product**: Features · Pricing · Changelog · Status
- **Docs**: Quickstart · CLI · Programmatic API · Reporters · Checks
- **Company**: About · Blog · Contact · Sponsor
- **Legal**: License · Terms · Privacy · DPA

Base row: ©2026 uxinspect · MIT core on GitHub · Built in Sri Lanka.

---

## Copy rules for this site

- Never name competitor products. Say "the major CI providers", "common chat tools", "real-user replay platforms". Technical file formats (JSON, JUnit, SARIF) are fine — they are standards, not brands.
- Keep all prices in one place (the tier table). Do not repeat $19 in three different sections.
- Every CTA is either `npm install -g uxinspect`, "Start Pro trial", "Start Team trial", or "Contact sales". No other buttons.
- Use the word "click" liberally. The product is about click verification; say the thing.
- No emojis in the rendered UI. Internal markdown icons in this spec get replaced by inline SVG before ship.
- Billing deferred — the CTA buttons link to a "Coming soon — join the waitlist" form until the license worker is live. Do not wire checkout until the keys-worker ships.
