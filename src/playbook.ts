/**
 * P5 #46 — Frontend testing playbook: one flag that enables every uxinspect
 * check relevant to a modern Vite/React/TS frontend in a single pass.
 *
 * The user asked for "all relevant frontend tests in 1 plugin so I won't need
 * to use so many". `uxinspect run --playbook <url>` turns on the consolidated
 * set below so the consumer never has to remember which flags to stack.
 *
 * Each entry documents the bug class it catches. Gates that are pure
 * backend/infra (TLS, sitemap, robots, mixed-content, redirects, exposed
 * paths, service-worker server-side, crawl) are deliberately excluded —
 * they're covered by the backend track of the wider stack and would add
 * wall-clock cost without catching frontend regressions.
 *
 * NOTE (per user instruction 2026-04-17): the `humanPass` gate at the END of
 * `PLAYBOOK_ENTRIES` runs LAST — it is the final step that only fires after
 * every other gate above has passed, walking the feature as a real user
 * would (open, verify layout/responsive/alignment, click every button, fill
 * every input, scroll + hover + drag, screenshots at every step).
 */
import type { ChecksConfig } from './types.js';

export interface PlaybookEntry {
  /** ChecksConfig field turned on by the playbook. */
  readonly check: keyof ChecksConfig;
  /** One-line rationale — what bug class this catches. */
  readonly catches: string;
}

/**
 * Canonical playbook — the frontend gates that must pass before a feature
 * ships. Order is stable for deterministic docs/reporting.
 */
export const PLAYBOOK_ENTRIES: readonly PlaybookEntry[] = [
  { check: 'a11y', catches: 'axe-core WCAG violations (contrast, alt, labels, roles)' },
  { check: 'ariaAudit', catches: 'invalid ARIA attributes and role mismatches' },
  { check: 'headings', catches: 'heading hierarchy skips / missing h1' },
  { check: 'langAudit', catches: 'missing or mismatched <html lang> / per-block lang' },
  { check: 'keyboard', catches: 'tab order, focus-ring visibility, keyboard traps' },
  { check: 'focusTrap', catches: 'modals/dialogs that do not trap focus correctly' },
  { check: 'touchTargets', catches: 'tap targets below 44x44 on mobile viewports' },
  { check: 'contrastStates', catches: 'contrast fails on hover/focus/active/disabled states' },
  { check: 'visual', catches: 'pixel + SSIM regression vs baseline' },
  { check: 'perf', catches: 'Lighthouse LCP / CLS / TBT / INP / a11y score drops' },
  { check: 'lcpElement', catches: 'LCP element identity / size changes across runs' },
  { check: 'clsCulprit', catches: 'DOM nodes causing layout shifts' },
  { check: 'inp', catches: 'Interaction-to-Next-Paint over budget' },
  { check: 'longTasks', catches: 'main-thread tasks >50ms during load' },
  { check: 'clsTimeline', catches: 'CLS timeline across load + interaction' },
  { check: 'jsCoverage', catches: 'unused JS above threshold (bundle bloat)' },
  { check: 'cssCoverage', catches: 'unused CSS above threshold' },
  { check: 'bundleSize', catches: 'JS/CSS bundle bytes + transfer size budget' },
  { check: 'webfonts', catches: 'web-font FOIT/FOUT and missing font-display: swap' },
  { check: 'fontLoading', catches: 'font CSS that blocks render' },
  { check: 'imageAudit', catches: 'oversized / wrong-format / missing alt images' },
  { check: 'media', catches: 'video/audio without captions / autoplay / controls' },
  { check: 'svgs', catches: 'inaccessible SVGs (no title, role=img missing)' },
  { check: 'motionPrefs', catches: 'animations that ignore prefers-reduced-motion' },
  { check: 'animations', catches: 'infinite / unthrottled animations' },
  { check: 'darkMode', catches: 'dark-mode regressions (snapshot comparison)' },
  { check: 'explore', catches: 'crawler-every-button click pass — broken interactives' },
  { check: 'deadClicks', catches: 'non-interactive elements that look clickable' },
  { check: 'disabledButtons', catches: 'disabled buttons that still respond to clicks' },
  { check: 'stuckSpinners', catches: 'spinners / aria-busy stuck past timeout' },
  { check: 'errorState', catches: 'clicks that reveal unexpected error toasts' },
  { check: 'frustrationSignals', catches: 'synthetic rage/dead/u-turn/error-click signals' },
  { check: 'consoleErrors', catches: 'browser console errors during the run' },
  { check: 'forms', catches: 'form a11y (labels, autocomplete, required, error assoc)' },
  { check: 'formBehavior', catches: 'empty/invalid/valid submit cycle per form' },
  { check: 'csrf', catches: 'CSRF token presence + SameSite cookie flag' },
  { check: 'cookieFlags', catches: 'cookies missing Secure / HttpOnly / SameSite' },
  { check: 'cookieBanner', catches: 'consent / cookie banner presence + behavior' },
  { check: 'gdpr', catches: 'accept/reject flow + cookie-vs-declaration diff' },
  { check: 'i18n', catches: 'per-locale missing keys, RTL breakage, overflow' },
  { check: 'hydration', catches: 'SSR hydration mismatches (React/Vue/Svelte)' },
  { check: 'storage', catches: 'localStorage/sessionStorage/IndexedDB abuse' },
  { check: 'thirdParty', catches: 'third-party script perf + count' },
  { check: 'trackerSniff', catches: 'unexpected analytics / ad / tracker requests' },
  { check: 'secretScan', catches: 'leaked API keys / secrets in HTML or JS' },
  { check: 'sourcemapScan', catches: 'exposed production source maps' },
  { check: 'sri', catches: 'third-party scripts/styles missing SRI hashes' },
  { check: 'clickjacking', catches: 'missing X-Frame-Options / frame-ancestors' },
  { check: 'errorPages', catches: 'broken / misconfigured 404 and 500 pages' },
  { check: 'zIndex', catches: 'z-index stacking context bugs (overlapping UI)' },
  { check: 'domSize', catches: 'excessive DOM node / depth / child count' },
  { check: 'eventListeners', catches: 'leaked / excess document-level event listeners' },
  { check: 'openGraph', catches: 'missing / invalid OpenGraph + Twitter card meta' },
  { check: 'structuredData', catches: 'invalid JSON-LD / structured data' },
  { check: 'favicon', catches: 'missing favicon / apple-touch-icon' },
  { check: 'headlessDetect', catches: 'anti-bot heuristics tripping on the test browser' },
  { check: 'links', catches: 'broken internal links (4xx/5xx/ERR)' },
  { check: 'canonical', catches: 'missing / conflicting canonical URLs' },
  { check: 'hreflang', catches: 'invalid or asymmetric hreflang tags' },
  { check: 'resourceHints', catches: 'missing / wasteful preload / preconnect / dns-prefetch' },
  { check: 'criticalCss', catches: 'above-the-fold critical CSS not inlined' },
  { check: 'amp', catches: 'AMP validation errors (if AMP pages exist)' },
  { check: 'prerenderAudit', catches: 'prerendered HTML diverging from hydrated output' },
  { check: 'webWorkers', catches: 'Web Worker lifecycle + error leaks' },
  { check: 'orphanAssets', catches: 'loaded assets with no DOM reference' },
  { check: 'readingLevel', catches: 'copy above target reading grade' },
  { check: 'contentQuality', catches: 'thin / duplicated content blocks' },
  { check: 'tables', catches: 'data tables missing headers / captions' },
  { check: 'pagination', catches: 'broken pagination / infinite-scroll regressions' },
  { check: 'deadImages', catches: 'images that 404 or fail to decode' },
  { check: 'print', catches: 'print-CSS layout regressions' },
  { check: 'pdf', catches: 'page.pdf() render + page-break + bleed audits' },
  { check: 'protocols', catches: 'HTTP/3 + HTTP/2 protocol usage for main-thread assets' },
  { check: 'xss', catches: 'unsafe HTML-sink reflections / payload execution in form inputs' },
  { check: 'clockRace', catches: 'stale relative-time text after clock fast-forward' },
  { check: 'jitter', catches: 'buttons that silently fail on ±px click offsets' },
  { check: 'srAnnouncements', catches: 'missing accessible names / empty live regions / unlabeled landmarks' },
  { check: 'pseudoLocale', catches: 'text truncation + clipped buttons under stretched pseudo-locale' },
  { check: 'humanPass', catches: 'real-user journey: open, verify layout/responsive/alignment, click every button, fill every input, scroll + hover + drag, screenshots at every step' },
];

/**
 * Merge playbook-enabled checks onto whatever the caller already set. Any
 * check the caller explicitly enabled or disabled wins — the playbook only
 * fills in gaps. This lets `--playbook --no-visual` work intuitively.
 */
export function applyPlaybookChecks(existing: ChecksConfig | undefined): ChecksConfig {
  const next: ChecksConfig = { ...(existing ?? {}) };
  for (const entry of PLAYBOOK_ENTRIES) {
    if (next[entry.check] === undefined) {
      (next as Record<string, unknown>)[entry.check] = true;
    }
  }
  return next;
}

/**
 * Pretty-print the playbook coverage map for CLI `--playbook --list` so the
 * user can see exactly which gates are on and what each catches.
 */
export function formatPlaybook(): string {
  const width = Math.max(...PLAYBOOK_ENTRIES.map((e) => e.check.length));
  const lines = [
    `uxinspect frontend playbook — ${PLAYBOOK_ENTRIES.length} gates`,
    '',
    ...PLAYBOOK_ENTRIES.map(
      (e) => `  ${String(e.check).padEnd(width)}  ${e.catches}`,
    ),
  ];
  return lines.join('\n');
}
