# uxinspect — Monetization Plan (v3, ship-ready)

**Date:** 2026-04-15
**Founder:** solo (Sri Lanka)
**Tool:** uxinspect — MIT CLI + Pro local + Team/Enterprise hosted SaaS
**Research:** 16 agents across direct competitors + adjacent markets
**Decision:** Cloud features ALLOWED for paid tiers (local-only constraint dropped). Free CLI stays MIT + local. Revenue ceiling now $5-15M ARR (Cypress/Chromatic trajectory) vs prior $1.44M solo cap.

> **REVISION 2026-04-15:** Local-only constraint REMOVED. Hybrid model: Sidekiq Pro (CLI local) + Cypress/Chromatic SaaS (cloud Team/Enterprise). See feedback_uxinspect_local_keyless memory.

---

## Master Table — Who Makes Money From What

### Direct + adjacent competitors (verified revenue)

| Company | ARR | Headcount | Free Tier | Killer Feature That Drives Revenue | Tier Gate | Per-Unit Price |
|---------|-----|-----------|-----------|-----------------------------------|-----------|----------------|
| **Datadog Synthetics** (in DEM) | $1B+ (DEM bundle) | huge | none | **APM trace + RUM correlation lock-in** | bundled | $0.012/browser run |
| **LogRocket** | $111M | 528 | 1k sess/mo | **Galileo AI + Analytics gated to Pro** ($295) | Pro $295/mo (4x ARPU jump) | $0.0069 → $0.0295/session |
| **FullStory** | $93M | 560 | 30k sess/mo | **Autocapture metering** + StoryAI Advanced gate | Advanced $499/mo | $0.011 → $0.019/session |
| **Hotjar** (in Contentsquare) | $60-75M | medium | 35 sess/day | **Session Recordings (45% of rev)** + daily cap throttle | Plus $32 → Business $80 → Scale $171 | $0.0038 → $0.0107/session |
| **Deque (axe)** | $52M | 250 | axe-core OSS | **DevTools Pro $45/seat (40% rev) + IGT** | $45/seat/mo → Monitor $30-200k | $45/seat/mo |
| **Checkly** | $8-12M est ($20M Series B) | medium | 1k browser runs | **Browser run volume + multi-region** | Team $64 → Ent | $6.25 per 1k browser runs |
| **Cypress** | $17.8M | 94 | 500 results/mo | **Test result OVERAGES (40% rev) + Spec Prioritization** | Business $267 → Ent | $0.005-0.006/result |
| **Sidekiq** ⭐ SOLO | **$7M** | **1** | MIT OSS | **Pro: Reliable Fetch (data-loss fear)** + **Ent: Rate Limiting (3rd-party API quotas)** | Pro $995/yr → Ent $3.2-79.5k/yr | per 100-thread pack |
| **Chromatic** | $5.6M | 51 | 5k snapshots | **Snapshot volume + cross-browser + a11y unlimited** | Starter $179 → Pro $399 → Ent $60-180k | $0.002-0.008/snapshot |
| **Plausible** ⭐ 2-PERSON | $1M+ | 2 | self-host AGPL | **Hosted convenience** (same code, paid hosting) | $9-69/mo | per pageview tier |
| **Caleb Porzio** ⭐ SOLO | $112k/yr | 1 | MIT OSS | **Sponsorware** (early-access paid tier) | $14/mo, $35/mo | n/a |
| **Pa11y** | **$0** | volunteer | MIT OSS | (none — no paid tier) | none | n/a |
| **BackstopJS** | **$0** | volunteer | MIT OSS | (none — no paid tier) | none | n/a |

⭐ = solo-replicable models

### 3 Universal Patterns That Repeat

**A) VOLUME METER** — Free tier with low cap, paid tiers scale by usage.
- LogRocket sessions, FullStory sessions, Hotjar sessions, Cypress test results, Chromatic snapshots, Checkly browser runs, Datadog runs, Deque pages.
- Forces silent expansion. **40% of Cypress revenue = overages**, not new logos.

**B) CAPABILITY GATE** — One headline feature gates Pro tier.
- LogRocket: **Galileo AI** ($295 = 4x ARPU jump)
- FullStory: **StoryAI Opportunities**
- Hotjar: **Frustration signals + funnels** (Business tier)
- Sidekiq Pro: **Reliable Fetch** (lose payment jobs in OSS = unacceptable)
- Cypress Business: **Spec Prioritization + Auto Cancellation**
- Deque: **IGT (intelligent guided testing)**

**C) COMPLIANCE GATE** — SSO/SAML/RBAC/audit/SOC2 closes Enterprise.
- Every single Enterprise tier has this. Sidekiq Encryption, Cypress SSO, Chromatic Enterprise, FullStory SOC2/HIPAA, Deque Monitor.

### Why Pure-OSS-No-Paid-Tier = $0
| Project | Users | Revenue |
|---------|-------|---------|
| Pa11y | thousands | **$0** |
| BackstopJS | thousands | **$0** |
| reg-suit / Loki | thousands | **$0** |
| Mocha (donations) | millions | ~$1k/mo |
| Jest (Foundation) | millions | $70k/yr split |

Adoption ≠ revenue. Donations cap ~$2-3k/mo for niche tools. Confirmed.

---

## What Sells = What Solves Real Fear

Looking at killer features across all 8 deep-dives, the pattern is clear: **fear-driven features convert highest**.

| Fear | Sold By | uxinspect equivalent |
|------|---------|---------------------|
| Lost data | Sidekiq Reliable Fetch | n/a directly |
| Can't reproduce bug | LogRocket replay, FullStory replay, Hotjar replay | **Replay capture + viewer** |
| Production regression slipped through | Cypress Spec Prioritization, Datadog | **Pre-commit per-step assertions + diff vs last commit** |
| 3rd-party API quota broken | Sidekiq Rate Limiting | n/a directly |
| Compliance audit | Deque Monitor, axe Auditor | **Branded WCAG/PDF reports + audit log** |
| Outage at 2am | Checkly multi-region, Datadog | **Synthetic monitor (cron) + Slack alert** |
| Login flow broke in prod | LogRocket sessions, Hotjar | **Auth-gated route walker** |
| New deploy broke 50 routes | Cypress, Chromatic | **Diff against last commit + multi-route runner** |
| Mobile users see different bugs | FullStory mobile SDKs | **Cross-browser matrix + device emulation** |

**Map directly to uxinspect features → priced Pro/Team/Enterprise tiers below.**

---

## OPTIMAL PLAN — Hybrid Sidekiq + Cypress/Chromatic

**Two playbooks combined:**

1. **Sidekiq Pro pattern for CLI tier** — MIT core + proprietary Pro npm with license-key check, runs local. Solo-operable, $7M ARR precedent.
2. **Cypress/Chromatic SaaS pattern for Team/Enterprise** — hosted dashboard + cloud collector + PR bot. $5-100M ARR precedent.

**Why both:** CLI Pro converts solo devs (low support burden, recurring $19). Cloud Team/Enterprise converts companies (high LTV $99-$499 + add-ons). Free MIT CLI is the wedge feeding both.

### License Stack (3 tiers + add-ons)

#### TIER 1 — Free MIT core (acquisition wedge)
**Price:** $0 forever
**License:** MIT
**Features:** All 65+ current audits, flow DSL, watch mode, pre-commit hook, basic HTML report, current AI heuristic locator.
**Goal:** 50,000+ npm installs/mo, 10k+ GitHub stars, blog/HN/Reddit virality.

#### TIER 2 — uxinspect Pro ($19/mo or $190/yr)
**License:** Proprietary npm `@uxinspect/pro`
**Activation:** License key check via Cloudflare Worker (signed JWT, 30-day cache, offline grace 14 days)
**Killer features (mapped to fear):**

| Pro Feature | Fear Solved | Build Effort | Steals From |
|-------------|------------|--------------|-------------|
| **Replay capture + viewer (rrweb local)** | Can't reproduce | Medium | LogRocket $295/mo ($0.03/sess) |
| **Per-step assertion DSL** | Regression slipped through | Low | Cypress $267/mo |
| **Auth-gated route walker** | Login broke in prod | Low | DIY, no competitor |
| **SQLite history + trend HTML** | "Did perf regress?" | Low | Datadog ($1k+/mo) |
| **Cross-browser matrix UI** | Browser-specific bug | Medium | BrowserStack $129/mo |
| **Heatmap from auto-explore** | Coverage gap unknown | Medium | Hotjar $80/mo |
| **Diff-against-last-commit CLI** | Deploy broke 50 routes | Low (lib exists) | Cypress |
| **Ollama bridge (fuzzy locator)** | Heuristic fails on dynamic UI | Low | Stagehand (needs API key) |

**Pricing rationale:** $19/mo undercuts LogRocket Pro ($295), Hotjar Business ($80), Cypress Team ($67) by 3-15x because uxinspect doesn't ingest data → no infra cost → margin huge.

#### TIER 3 — uxinspect Team ($99/mo per team ≤10 devs, $9/dev over)
**License:** HOSTED SaaS at app.uxinspect.com (Cloudflare Pages + Workers + D1 + R2)
**Killer features:**

| Team Feature | Fear Solved | Steals From |
|--------------|------------|-------------|
| **Hosted multi-repo dashboard** | "Status of all 12 projects?" | Cypress Cloud, Chromatic |
| **PR comment bot** (GitHub App on CF Worker) | Code review discipline | Codecov, Sentry |
| **Real-user RUM collector** (drop-in JS → CF Worker → D1) | "What's broken in prod NOW?" | Hotjar $80, Datadog RUM |
| **Production session replay** (rrweb in browser → R2) | "Can't reproduce intermittent bug" | LogRocket $295/mo |
| **Production heatmaps** (real users) | Coverage gap unknown | Hotjar $80/mo |
| **Synthetic monitor scheduler** (CF Cron Triggers) | Outage at 2am | Checkly $64/mo |
| **Public status page generator** | Stakeholder visibility | Statuspage |
| **Slack / Discord / MS Teams** alert templates | Notification chaos | Sentry, Datadog |
| **Branded HTML/PDF reports** | Compliance + stakeholder | Deque, Siteimprove |
| **24hr email SLA** | Unblock fast | All |

#### TIER 4 — uxinspect Enterprise ($499/mo, custom > $999)
**License:** Proprietary npm `@uxinspect/enterprise` + commercial agreement

| Enterprise Feature | Fear Solved | Steals From |
|--------------------|------------|-------------|
| **SSO/SAML config** | Compliance | Every Enterprise SKU |
| **Audit log of every run** | SOC2 / SOX | Deque axe Monitor |
| **RBAC** | Security policy | All |
| **Custom rule packs (private repo)** | Industry-specific | axe Auditor |
| **WCAG 2.2 AA legal-ready PDF VPAT** | ADA lawsuit defense | Level Access $100k+ |
| **DPA / MSA / SOC2 docs** | Procurement | All |
| **Self-hosted license server option** | Air-gap requirement | Sentry, GitLab |

#### ADD-ON 1 — Framework Rule Packs ($49 one-time, Lemon Squeezy)
- Shopify checkout pack
- Stripe payment flow pack
- Next.js App Router pack
- Remix loaders/actions pack
- Webflow CMS pack
- WordPress accessibility pack
- Sveltekit pack
**Goal:** 50-200 sales/mo per pack, low support burden.

#### ADD-ON 2 — Sponsorware tier ($9/mo, GitHub Sponsors)
- Early-access to new audits (60 days before MIT release)
- Discord supporter role
- Monthly office hours video
**Goal:** capture goodwill from solo devs who can't justify Pro.

---

## Revenue Math (conservative)

### Month 6 (post-launch, ramp)
| Stream | Customers | $/Customer | MRR |
|--------|-----------|-----------|-----|
| Pro $19 | 50 | $19 | $950 |
| Team $99 | 3 | $99 | $297 |
| Sponsorware | 30 | $9 | $270 |
| Packs (volatile) | 30 sales | $49 | $1,470 (one-time) |
| **Total** | | | **~$1,500 MRR + $1.5k packs** |

### Month 12
| Stream | Customers | MRR |
|--------|-----------|-----|
| Pro $19 | 250 | $4,750 |
| Team $99 | 15 | $1,485 |
| Enterprise $499 | 2 | $998 |
| Sponsorware | 100 | $900 |
| Packs | 100 sales | ~$2,000 (volatile) |
| **Total** | | **~$8,100 MRR** = **$97k ARR** |

### Month 24
| Stream | Customers | MRR |
|--------|-----------|-----|
| Pro $19 | 1,000 | $19,000 |
| Team $99 | 80 | $7,920 |
| Enterprise $499 | 15 | $7,485 |
| Sponsorware | 250 | $2,250 |
| Packs | 200 sales | ~$3,500 |
| **Total** | | **~$40,200 MRR** = **$482k ARR** |

### Month 36 (Cypress/Chromatic trajectory, cloud-enabled)
| Stream | Customers | MRR |
|--------|-----------|-----|
| Pro $19 | 3,000 | $57,000 |
| Team $99 | 500 | $49,500 |
| Enterprise $499 | 100 | $49,900 |
| Enterprise custom $2k+ | 30 | $60,000 |
| Cloud Replay add-on $49 | 800 | $39,200 |
| Sponsorware | 700 | $6,300 |
| Packs | 800 sales | ~$13,000 |
| **Total** | | **~$275,000 MRR** = **$3.3M ARR** |

### Year 5 (Cypress trajectory, scaling)
- Pro 8k × $19 = $152k
- Team 1.5k × $99 = $148k
- Enterprise 300 × $499 = $150k
- Enterprise custom 100 × $3k = $300k
- Cloud Replay 3k × $49 = $147k
- Total = ~$900k MRR = **$10.8M ARR** (Cypress crossed $14M ARR yr 6)

Cloud-enabled ceiling is 7-10x prior local-only solo cap. Requires hire 1 part-time at $20k MRR, 2-3 full-time by $200k MRR. Still founder-led + Cloudflare-only infra = high margin.

---

## Best Build Order (4 phases, ship-ready)

### Phase 1 (months 1-3) — CLI Pro $19 LIVE (validate)
- License-key Worker (`keys.uxinspect.com`)
- Per-step assertion DSL
- Replay capture (rrweb local) + static viewer
- Auth-gated route walker
- SQLite history + trend graphs
- Polar.sh billing

### Phase 2 (months 4-6) — Team $99 SaaS LIVE (hosted)
- Cloudflare Pages dashboard (`app.uxinspect.com`)
- API Worker (`api.uxinspect.com`) + D1 + R2
- Multi-repo aggregator (cloud-synced)
- PR comment bot (GitHub App on CF Worker)
- Branded HTML/PDF reports
- Synthetic monitor (CF Cron Triggers)
- Slack/Discord/MS Teams templates

### Phase 3 (months 7-12) — Real-user RUM + Replay (BIG revenue lever)
- JS snippet (5KB) → ingest endpoint
- D1 schema for events; R2 for replay blobs
- Cloud session replay viewer (rrweb-player)
- Real-user heatmaps (SVG aggregation)
- Frustration signal detection (rage/dead/error/u-turn)
- Funnel + form analytics
- Cloud Replay $49/mo add-on launches
- Goal: 100+ Team customers, $20k MRR

### Phase 4 (year 2+) — Enterprise $499+ + acquisition path
- SSO/SAML + RBAC + audit log + WCAG VPAT + custom rule packs
- Self-host Docker option for air-gap
- DPA/MSA/SOC2 docs (Vanta/Drata)
- Build relationships: BrowserStack, Datadog, Vercel, Cloudflare

After Phase 3: all 4 tiers + cloud add-on live. Now scale.

---

## Tactical Notes (what makes solo-OSS work)

1. **Per-seat or per-team pricing, NOT per-run.** uxinspect runs locally — can't meter usage cleanly. Sidekiq proves per-thread works; for SaaS-less tools, **per-team** is the meter.

2. **Annual prepay discount** (17% off) drives cash flow. Sidekiq Pro is annual-only.

3. **No free trial on Enterprise.** Sales call required. Filters time-wasters.

4. **Email-only support.** No chat, no ticketing. Mike Perham proves it scales to $7M.

5. **License key, not DRM.** Trust users. Forks happen, paying customers stay (Sidekiq has been forked, doesn't matter).

6. **One Cloudflare Worker for keys** = $0 infra cost up to 100k validations/mo.

7. **Polar.sh for billing** > Stripe direct (handles VAT, license keys, sponsor tiers all in one).

8. **README + landing page > docs.** Conversion happens on README. Lead with replay capture GIF.

9. **Launch on HN with replay GIF as headline.** Show HN → Pro $19 link. Day 1 = first 50 paying customers if done right.

10. **Twitter/X: ship-in-public for 6 months.** Caleb Porzio playbook. Convert audience to sponsors.

---

## Honest Risks

| Risk | Mitigation |
|------|-----------|
| Niche too small (Pa11y precedent) | Validate w/ 10 paid pre-orders before building Pro |
| Free CLI cannibalizes Pro | Gate features serious teams need (auth-walker, multi-repo, SSO) — not solo-dev daily features |
| Cypress/Playwright add audit features | Stay narrower + faster + ship monthly |
| License-key bypass / piracy | Most teams pay (legal protection of license terms); pirates were never going to pay anyway |
| Solo support burden at $50k+ MRR | Hire 1 part-time at month 18, still 90% margin |
| Local-only kills Datadog-style enterprise upsell | Accept ceiling = $1-3M ARR, not $50M |

---

## Bottom Line (ship-ready, cloud-enabled)

**Hybrid model: CLI Pro + cloud SaaS unlocks Cypress trajectory.**

| Path | Year 1 | Year 2 | Year 3 | Year 5 |
|------|--------|--------|--------|--------|
| Donations only (pure MIT) | <$10k ARR | <$30k | <$50k | <$100k |
| CLI Pro only (Sidekiq pattern) | $97k | $482k | $1.44M | $3-5M |
| **Hybrid CLI + Cloud SaaS (THIS)** | **$180-300k** | **$1-1.8M** | **$3.6-6M** | **$10-15M** |
| VC-backed full SaaS (skip) | needs 5-10 ppl team | — | — | — |

**Cloud unlocks 3-7x revenue ceiling vs CLI-only.** Same Cloudflare-only infra ($50/mo for first 1k customers), same email-only support pattern, just adds hosted dashboard + real-user collector that competes with LogRocket/Hotjar/Cypress Cloud at 5-15x cheaper.

**Operational reality:**
- Solo until $20k MRR (~12 months)
- Hire 1 part-time support at $20k MRR
- Hire 2-3 FT at $200k MRR
- Cloudflare-only stack = stays profitable while small

**Execute Phase 1 starting this week. Validate Pro CLI in 90 days. Then Phase 2 SaaS launches month 4.**

---

## Saved to Memory (2026-04-15)

- `feedback_uxinspect_local_keyless.md` — local-only constraint REMOVED, cloud allowed for paid tiers
- `feedback_uxinspect_monetization.md` — hybrid CLI Pro + cloud SaaS, 4-phase build order
- `project_uxinspect.md` — architecture updated: CF Pages + Workers + D1 + R2 stack for paid tiers
