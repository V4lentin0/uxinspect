# uxinspect Testing Playbook

The uxinspect playbook is a single flag that turns on every relevant testing gate for a surface in one pass. Three playbooks ship: frontend, backend, combined.

## Quick start

- `uxinspect run --playbook <url>` — FE playbook (78 gates)
- `uxinspect run --playbook-backend <url>` — BE playbook (23 gates)
- `uxinspect run --playbook-all <url>` — combined (101 gates)
- Add `-list` to any flag above to print the gate map and exit without running.

## Cascade precedence

When multiple flags are set, the most-inclusive wins:

`--playbook-all` > `--playbook-backend` > `--playbook`

Explicit `--no-<check>` opt-outs always survive: the playbook only fills gates the caller did not set.

## Frontend playbook (78 gates)

| # | Check | Catches |
|---|-------|---------|
| 1 | a11y | axe-core WCAG violations (contrast, alt, labels, roles) |
| 2 | ariaAudit | invalid ARIA attributes and role mismatches |
| 3 | headings | heading hierarchy skips / missing h1 |
| 4 | langAudit | missing or mismatched <html lang> / per-block lang |
| 5 | keyboard | tab order, focus-ring visibility, keyboard traps |
| 6 | focusTrap | modals/dialogs that do not trap focus correctly |
| 7 | touchTargets | tap targets below 44x44 on mobile viewports |
| 8 | contrastStates | contrast fails on hover/focus/active/disabled states |
| 9 | visual | pixel + SSIM regression vs baseline |
| 10 | perf | Lighthouse LCP / CLS / TBT / INP / a11y score drops |
| 11 | lcpElement | LCP element identity / size changes across runs |
| 12 | clsCulprit | DOM nodes causing layout shifts |
| 13 | inp | Interaction-to-Next-Paint over budget |
| 14 | longTasks | main-thread tasks >50ms during load |
| 15 | clsTimeline | CLS timeline across load + interaction |
| 16 | jsCoverage | unused JS above threshold (bundle bloat) |
| 17 | cssCoverage | unused CSS above threshold |
| 18 | bundleSize | JS/CSS bundle bytes + transfer size budget |
| 19 | webfonts | web-font FOIT/FOUT and missing font-display: swap |
| 20 | fontLoading | font CSS that blocks render |
| 21 | imageAudit | oversized / wrong-format / missing alt images |
| 22 | media | video/audio without captions / autoplay / controls |
| 23 | svgs | inaccessible SVGs (no title, role=img missing) |
| 24 | motionPrefs | animations that ignore prefers-reduced-motion |
| 25 | animations | infinite / unthrottled animations |
| 26 | darkMode | dark-mode regressions (snapshot comparison) |
| 27 | explore | crawler-every-button click pass — broken interactives |
| 28 | deadClicks | non-interactive elements that look clickable |
| 29 | disabledButtons | disabled buttons that still respond to clicks |
| 30 | stuckSpinners | spinners / aria-busy stuck past timeout |
| 31 | errorState | clicks that reveal unexpected error toasts |
| 32 | frustrationSignals | synthetic rage/dead/u-turn/error-click signals |
| 33 | consoleErrors | browser console errors during the run |
| 34 | forms | form a11y (labels, autocomplete, required, error assoc) |
| 35 | formBehavior | empty/invalid/valid submit cycle per form |
| 36 | csrf | CSRF token presence + SameSite cookie flag |
| 37 | cookieFlags | cookies missing Secure / HttpOnly / SameSite |
| 38 | cookieBanner | consent / cookie banner presence + behavior |
| 39 | gdpr | accept/reject flow + cookie-vs-declaration diff |
| 40 | i18n | per-locale missing keys, RTL breakage, overflow |
| 41 | hydration | SSR hydration mismatches (React/Vue/Svelte) |
| 42 | storage | localStorage/sessionStorage/IndexedDB abuse |
| 43 | thirdParty | third-party script perf + count |
| 44 | trackerSniff | unexpected analytics / ad / tracker requests |
| 45 | secretScan | leaked API keys / secrets in HTML or JS |
| 46 | sourcemapScan | exposed production source maps |
| 47 | sri | third-party scripts/styles missing SRI hashes |
| 48 | clickjacking | missing X-Frame-Options / frame-ancestors |
| 49 | errorPages | broken / misconfigured 404 and 500 pages |
| 50 | zIndex | z-index stacking context bugs (overlapping UI) |
| 51 | domSize | excessive DOM node / depth / child count |
| 52 | eventListeners | leaked / excess document-level event listeners |
| 53 | openGraph | missing / invalid OpenGraph + Twitter card meta |
| 54 | structuredData | invalid JSON-LD / structured data |
| 55 | favicon | missing favicon / apple-touch-icon |
| 56 | headlessDetect | anti-bot heuristics tripping on the test browser |
| 57 | links | broken internal links (4xx/5xx/ERR) |
| 58 | canonical | missing / conflicting canonical URLs |
| 59 | hreflang | invalid or asymmetric hreflang tags |
| 60 | resourceHints | missing / wasteful preload / preconnect / dns-prefetch |
| 61 | criticalCss | above-the-fold critical CSS not inlined |
| 62 | amp | AMP validation errors (if AMP pages exist) |
| 63 | prerenderAudit | prerendered HTML diverging from hydrated output |
| 64 | webWorkers | Web Worker lifecycle + error leaks |
| 65 | orphanAssets | loaded assets with no DOM reference |
| 66 | readingLevel | copy above target reading grade |
| 67 | contentQuality | thin / duplicated content blocks |
| 68 | tables | data tables missing headers / captions |
| 69 | pagination | broken pagination / infinite-scroll regressions |
| 70 | deadImages | images that 404 or fail to decode |
| 71 | print | print-CSS layout regressions |
| 72 | pdf | page.pdf() render + page-break + bleed audits |
| 73 | protocols | HTTP/3 + HTTP/2 protocol usage for main-thread assets |
| 74 | xss | unsafe HTML-sink reflections / payload execution in form inputs |
| 75 | clockRace | stale relative-time text after clock fast-forward |
| 76 | jitter | buttons that silently fail on ±px click offsets |
| 77 | srAnnouncements | missing accessible names / empty live regions / unlabeled landmarks |
| 78 | humanPass | real-user journey: open, verify layout/responsive/alignment, click every button, fill every input, scroll + hover + drag, screenshots at every step |

`pseudoLocale` (text truncation + clipped buttons under stretched pseudo-locale) ships as a standalone `--check pseudoLocale` flag. It is not included in the FE playbook gate count so that `humanPass` remains the 78th and final gate. `PLAYBOOK_ENTRIES.length === 78`.

## Backend playbook (23 gates)

| # | Check | Catches |
|---|-------|---------|
| 1 | security | CSP / HSTS / X-Frame-Options / X-Content-Type-Options / Referrer-Policy header coverage |
| 2 | tls | TLS version, cert chain, OCSP, expiry, weak ciphers |
| 3 | sitemap | sitemap.xml presence, validity, URL reachability |
| 4 | robotsAudit | robots.txt presence, syntax, sitemap declaration, sensitive-path leaks |
| 5 | redirects | redirect chains, loops, hop count, http to https upgrade |
| 6 | exposedPaths | common dev/admin/secret paths reachable in prod (.env, .git, /admin, /debug) |
| 7 | mixedContent | http subresources loaded over an https origin |
| 8 | compression | gzip / brotli enablement on text assets |
| 9 | cacheHeaders | cache-control / etag / immutable hashing on static assets |
| 10 | crawl | site-wide crawl: orphan pages, broken internal links, depth budget |
| 11 | links | broken outbound and internal links (4xx / 5xx / ERR) |
| 12 | errorPages | 404 / 500 status codes with correct shell rendering |
| 13 | protocols | HTTP/2 + HTTP/3 negotiation for top assets |
| 14 | sourcemapScan | production .map files exposed publicly |
| 15 | sri | third-party script/style SRI hashes present |
| 16 | clickjacking | X-Frame-Options / frame-ancestors clickjacking defense |
| 17 | csrf | CSRF token + SameSite cookie defense for state-changing routes |
| 18 | cookieFlags | Secure / HttpOnly / SameSite cookie flags |
| 19 | email | SPF / DKIM / DMARC / MX DNS records |
| 20 | authEdge | auth endpoint edge cases (rate-limit, lockout, session fixation, token reuse) |
| 21 | offline | service worker offline / stale-while-revalidate behavior |
| 22 | prerenderAudit | prerendered HTML diverging from hydrated output (SEO crawler view) |
| 23 | humanPassBackend | real-debugger journey: hammer every reachable endpoint with payload variants, record full req/resp round-trips, surface findings |

`concurrency` (race conditions on parallel writes) had no runner wired and was removed. `humanPassBackend` replaced it as gate #23, the final BE gate. `BACKEND_PLAYBOOK_ENTRIES.length === 23`.

## Combined playbook (101 gates)

FE 78 gates + BE 23 gates, deduped (FE wins on any key collision). See the two tables above for the full list.

## Human-pass gate (FE #78) — deep dive

Final journey-style gate that runs LAST after every other FE gate passes. Simulates a real user:

1. Baseline full-page screenshots at desktop (1920x1080) / tablet (768x1024) / mobile (375x667).
2. Per-viewport layout audit: horizontal overflow, clipped text, broken proportions, misaligned siblings. Post-audit screenshot per viewport.
3. Click every interactive element (buttons, links, `[role="button"]`, capped at `maxInteractions`, default 80). Screenshot BEFORE and AFTER every click. Console errors during click recorded as findings. Navigation rollback via `goBack()` to keep subsequent steps on the same origin page.
4. Fill every text input / textarea / contenteditable with three values: realistic ("test value"), long (200-char lorem), XSS-shaped string. Screenshot BEFORE and AFTER each input. Flag `input-refused` if the element rejects all values.
5. Select dropdowns: pick the second option (first is usually a placeholder). Screenshot BEFORE and AFTER.
6. Scroll: top -> 50% -> bottom -> top, screenshot each step. Flag `scroll-broken` if `scrollY` doesn't move.
7. Hover every clickable element (cap 10). Screenshot after. Flag `hover-no-affordance` if no visual change happens on buttons/links.
8. Drag every `[draggable="true"]` element by 50px. Screenshot BEFORE and AFTER. Flag `drag-no-response` if DOM doesn't change.
9. Final full-page screenshot.

**Findings:** `layout-overflow` · `text-clipped` · `misaligned` · `proportions-broken` · `console-error-during-click` · `hover-no-affordance` · `input-refused` · `scroll-broken` · `drag-no-response` · `navigation-failed` · `other`.

**Screenshots:** saved to `<outputDir>/human-pass/NN-<tag>.png` with 2-digit zero-padded monotonic counter. Every path returned in `result.screenshots` in capture order.

## Human-pass backend gate (BE #23) — deep dive

The BE mirror of FE humanPass. Where FE humanPass clicks/hovers/drags like a real user, humanPassBackend acts like a real debugger hammering every reachable endpoint with payload variants and recording the full req/resp round-trip before/after every call.

**Payload variants (8):**

- `baseline` — well-formed request with valid body matching the endpoint's expected schema
- `empty-body` — POST/PUT/PATCH with a completely empty body `{}`
- `invalid-shape` — body with correct keys but wrong value types (string where number expected, etc.)
- `oversize` — body padded to exceed typical size limits (default 1 MB payload)
- `malformed-json` — raw string that is not valid JSON sent with `Content-Type: application/json`
- `unicode` — body containing zero-width characters, RTL overrides, emoji, and null bytes in string values
- `auth-strip` — request sent without any Authorization header or session cookie
- `cors-probe` — preflight OPTIONS + cross-origin `Origin` header to test CORS policy enforcement

**Finding kinds (10):**

- `server-error-5xx` — endpoint returned a 5xx on any variant
- `unexpected-2xx-on-bad-input` — endpoint returned 2xx for `invalid-shape`, `malformed-json`, or `empty-body` where rejection was expected
- `slow-response` — response time exceeded threshold (default 3000ms) on the `baseline` variant
- `missing-auth-enforcement` — `auth-strip` variant received a 2xx response on an authenticated route
- `cors-permissive` — `cors-probe` reveals `Access-Control-Allow-Origin: *` on a credentialed route
- `cors-missing` — `cors-probe` receives no CORS headers on a route that should be cross-origin accessible
- `sensitive-header-leak` — response headers expose internal stack info (`X-Powered-By`, `Server` with version, stack traces in body)
- `idempotency-violation` — identical `baseline` POSTs produce different side effects on repeated calls
- `payload-echo-reflected` — input from `unicode` or `xss`-shaped strings is reflected verbatim in the response body without sanitization
- `other` — any transport error, timeout, or unexpected condition that does not fit the above kinds

Dump files are saved to `<outputDir>/human-pass-backend/NN-<method>-<path>-<variant>-{request,response}.txt` with 2-digit zero-padded ordering.

Never throws — transport errors surface as findings with `{ kind: 'other' }`.

## History

- P5 #46 — frontend playbook consolidation flag (2026-04-xx, 72 gates at launch).
- P6 #47-#51 — XSS / clock-race / jitter / SR-announcements / pseudo-locale added (77 gates).
- P6 #52 — backend playbook consolidation flag (23 gates, pivot 2026-04-17).
- P6 #53 — combined `--playbook-all` flag (FE + BE, cascading precedence).
- P6 #54 — FE humanPass gate (78th and final frontend gate).
- P6 #55 — BE humanPassBackend gate (23rd and final backend gate, replacing `concurrency` placeholder which had no runner wired).

## Files

- `src/playbook.ts` — FE entries + applier + list-formatter.
- `src/playbook-backend.ts` — BE entries + applier + list-formatter.
- `src/playbook-all.ts` — combined resolver (FE wins on collision).
- `src/human-pass-audit.ts` — FE humanPass runner.
- `src/human-pass-backend.ts` — BE humanPassBackend runner.
- `src/human-pass-screenshot.ts` — shared screenshot recorder with monotonic counter + kebab tag sanitizer.
- `src/cli.ts` — CLI flag wiring and cascade precedence.
