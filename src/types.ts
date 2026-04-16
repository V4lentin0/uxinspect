export type {
  I18nConfig,
  I18nResult,
  I18nIssue,
  I18nIssueKind,
  I18nIssueSeverity,
  I18nLocaleSummary,
} from './i18n-audit.js';

export interface InspectConfig {
  url: string;
  flows?: Flow[];
  viewports?: Viewport[];
  checks?: ChecksConfig;
  output?: OutputConfig;
  ai?: AIConfig;
  headed?: boolean;
  parallel?: boolean;
  storageState?: string;
  reporters?: ('html' | 'json' | 'junit' | 'sarif' | 'allure' | 'tap')[];
  browser?: 'chromium' | 'firefox' | 'webkit';
  device?: string;
  locale?: string;
  timezoneId?: string;
  geolocation?: { latitude: number; longitude: number };
  network?: 'slow-3g' | 'fast-3g' | '4g' | 'wifi';
  trace?: boolean;
  video?: boolean;
  har?: boolean;
  budget?: import('./budget.js').Budget;
  notify?: {
    slackWebhook?: string;
    discordWebhook?: string;
    genericWebhook?: string;
    onlyOnFail?: boolean;
  };
  mocks?: RouteMock[];
  debug?: boolean;
  slowMo?: number;
  apiFlows?: ApiFlow[];
  gatedRoutes?: string[] | string;
  gatedRoutesOptions?: {
    concurrency?: number;
    explore?: boolean | import('./explore.js').ExploreOptions;
    navigationTimeoutMs?: number;
    checkErrorStates?: boolean;
  };
  /** Visual diff algorithm + ignore-region DSL (P2 #23). */
  visualDiff?: VisualDiffConfig;
  /** Map of changed-file glob patterns → route patterns (P3 #30 — git-diff mode). */
  routeMap?: import('./git-diff-mode.js').RouteMap;
  /**
   * Internal (P3 #30): explicit list of route patterns to filter flows by.
   * Populated by the CLI when `--changed` / `--since` is passed. When set,
   * only flows whose `goto` URLs match at least one pattern run. Callers
   * outside the CLI can set this manually to scope a run.
   */
  changedRoutes?: string[];
  /**
   * Fast inner-loop mode (P3 #31). Skips slow audits (Lighthouse perf, link
   * crawler, site crawl, exposed-paths probe, bundle-size, TLS, sitemap,
   * redirects, compression, robots), forces flow parallelization, and pins the
   * browser to chromium. Targets sub-30s wall-clock runs for watch/dev loops.
   * Audits that are explicitly enabled via `checks` are still skipped — pass
   * `fast: false` to opt back into a full run.
   */
  fast?: boolean;
  /** P5 #49 — Custom branding for HTML reports. Pro+ license required. */
  branding?: BrandingConfig;
  /** Email rendering audit (P4 #42). Requires `checks.emailAudit === true`. */
  emailAuditConfig?: EmailConfig;
}

export interface RouteMock {
  pattern: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  action: 'abort' | { status?: number; headers?: Record<string, string>; body?: string; contentType?: string };
}

export interface Flow {
  name: string;
  steps: Step[];
}

export interface ApiFlow {
  name: string;
  steps: ApiStep[];
}

export type ApiStep =
  | { request: { method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS'; url: string; headers?: Record<string, string>; body?: unknown } }
  | { expect: { status?: number; statusIn?: number[]; headerIncludes?: { name: string; value: string }; bodyIncludes?: string; jsonPath?: { path: string; equals?: unknown; exists?: boolean } } };

export interface ApiFlowResult {
  name: string;
  passed: boolean;
  steps: { step: ApiStep; passed: boolean; durationMs: number; status?: number; error?: string }[];
  error?: string;
}

export interface AssertConfig {
  /** Console-error assertion.
   *  - `'clean'` — no new console errors during the step.
   *  - `{ allow }` — allow console errors whose message contains any of the
   *    listed substrings; any other new error fails the step. */
  console?: 'clean' | { allow?: string[] };
  /** Network assertion.
   *  - `'no-4xx'` — no new 4xx responses.
   *  - `'no-5xx'` — no new 5xx responses.
   *  - `'no-errors'` — no new 4xx or 5xx responses.
   *  - `{ allow }` — allow explicit status codes (e.g. `[404, 429]`); any
   *    other 4xx/5xx fails the step. */
  network?: 'no-4xx' | 'no-5xx' | 'no-errors' | { allow?: number[] };
  /** DOM assertion.
   *  - `'no-error'` — no new `[role="alert"]`, `.error`, or `.alert-danger`
   *    elements appeared since step start.
   *  - `{ selector, mustExist }` — selector must be present after the step.
   *  - `{ selector, mustNotExist }` — selector must NOT be present. */
  dom?:
    | 'no-error'
    | { selector: string; mustExist?: boolean; mustNotExist?: boolean };
  /** Visual assertion.
   *  - `'matches'` — screenshot matches stored baseline (auto-saves on first run).
   *  - `{ name, threshold }` — named baseline with custom drift threshold
   *    (ratio, e.g. `0.01` = 1% of pixels). */
  visual?: 'matches' | { name: string; threshold?: number };
  /** Timing budget — step must complete within `maxMs`. */
  timing?: { maxMs: number };
  /** Exercise the form validation cycle on the page — empty submit → expect
   *  error; invalid submit → expect error; valid submit → expect error clears.
   *  Optionally scope to a specific form selector via an object form. */
  form?: 'validates' | { validates: true; formSelector?: string };
}

export interface AssertionFailure {
  kind: 'console' | 'network' | 'dom' | 'visual' | 'timing' | 'form';
  message: string;
  details?: unknown;
}

export type Step = StepAction & {
  assert?: AssertConfig;
  /** P3 #34 — Human-readable step label (auto-generated or user-provided). */
  label?: string;
  /** P2 #24 — Apply stable-capture options (freeze animations, wait fonts,
   *  lazy-load auto-scroll, scroll-and-stitch) to screenshot-taking steps
   *  and to the visual-assertion screenshot. Has no effect on non-capturing
   *  steps. Defaults: freezeAnimations + waitFonts ON, autoScrollLazy + stitch OFF. */
  captureOptions?: import('./visual-capture.js').CaptureOptions;
};

/**
 * P3 #28 — NL extract step. Runs `prompt` against the page (DOM text snapshot),
 * parses the returned JSON via the given Zod schema, and stores the result in
 * the flow context under `into`. Later steps in the same flow may reference
 * the stored value.
 */
export interface ExtractStep {
  type: 'extract';
  prompt: string;
  /** Zod-compatible schema with `.parse(data)` (and optional `.shape`). */
  schema: { parse: (data: unknown) => unknown; shape?: Record<string, unknown> };
  /** Flow-context key under which to store the parsed output. */
  into: string;
}

export type StepAction =
  | { goto: string }
  | { click: string }
  | { type: { selector: string; text: string } }
  | { fill: { selector: string; text: string } }
  | { waitFor: string }
  | { screenshot: string }
  | { ai: string }
  | ExtractStep
  | { drag: { from: string; to: string } }
  | { upload: { selector: string; files: string | string[] } }
  | { dialog: 'accept' | 'dismiss' | { accept?: boolean; text?: string } }
  | { scroll: { selector?: string; x?: number; y?: number } }
  | { select: { selector: string; value: string | string[] } }
  | { key: string }
  | { eval: string }
  | { waitForResponse: string | { url: string; status?: number } }
  | { waitForRequest: string }
  | { hover: string }
  | { check: string }
  | { uncheck: string }
  | { focus: string }
  | { blur: string }
  | { reload: true }
  | { back: true }
  | { forward: true }
  | { newTab: string }
  | { switchTab: number | string }
  | { closeTab: true }
  | { iframe: { selector: string; steps: Step[] } }
  | { sleep: number }
  | { waitForDownload: { trigger: string; saveAs: string } }
  | { waitForPopup: { trigger: string; switchTo?: boolean } }
  | { cookie: { name: string; value: string; domain?: string; path?: string; expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: 'Strict' | 'Lax' | 'None' } }
  | { clearCookies: true };

export interface Viewport {
  name: string;
  width: number;
  height: number;
}

export interface ChecksConfig {
  a11y?: boolean;
  perf?: boolean;
  visual?: boolean;
  explore?: boolean | { maxClicks?: number };
  seo?: boolean;
  links?: boolean | { maxLinks?: number; sameOriginOnly?: boolean };
  pwa?: boolean;
  security?: boolean;
  retire?: boolean;
  deadClicks?: boolean | { maxElements?: number; waitAfterClickMs?: number };
  disabledButtons?: boolean | { selectors?: string[]; maxButtons?: number; waitAfterClickMs?: number; screenshotDir?: string };
  touchTargets?: boolean | { minSize?: number; onlyViewport?: boolean };
  keyboard?: boolean | { maxTabs?: number; requireFocusRing?: boolean };
  longTasks?: boolean | { durationMs?: number };
  clsTimeline?: boolean | { durationMs?: number };
  forms?: boolean;
  formBehavior?: boolean | { formSelector?: string };
  structuredData?: boolean;
  passiveSecurity?: boolean;
  consoleErrors?: boolean;
  sitemap?: boolean | { checkUrls?: boolean; sampleSize?: number };
  redirects?: boolean | { maxHops?: number };
  exposedPaths?: boolean | { concurrency?: number; extraPaths?: string[] };
  tls?: boolean;
  crawl?: boolean | { maxDepth?: number; maxPages?: number; sameOriginOnly?: boolean };
  contentQuality?: boolean | { minWords?: number; dupThreshold?: number };
  resourceHints?: boolean;
  mixedContent?: boolean;
  compression?: boolean;
  cacheHeaders?: boolean;
  cookieBanner?: boolean;
  thirdParty?: boolean;
  bundleSize?: boolean;
  openGraph?: boolean;
  robotsAudit?: boolean;
  imageAudit?: boolean;
  webfonts?: boolean;
  motionPrefs?: boolean;
  serviceWorker?: boolean;
  rum?: boolean | { durationMs?: number };
  amp?: boolean;
  jsCoverage?: boolean | { threshold?: number };
  cssCoverage?: boolean | { threshold?: number };
  domSize?: boolean | { maxNodes?: number; maxDepth?: number; maxChildren?: number };
  ariaAudit?: boolean;
  headings?: boolean;
  langAudit?: boolean;
  protocols?: boolean;
  fontLoading?: boolean;
  prerenderAudit?: boolean;
  headlessDetect?: boolean;
  animations?: boolean;
  eventListeners?: boolean;
  darkMode?: boolean | { screenshotDir?: string; sampleSelectors?: string[] };
  tables?: boolean;
  svgs?: boolean;
  media?: boolean;
  readingLevel?: boolean | { maxGrade?: number; mainSelector?: string };
  deadImages?: boolean;
  pagination?: boolean | { scrollProbes?: number };
  print?: boolean | { screenshotPath?: string };
  /** P4 #43 — Chromium-only PDF audit. Renders via `page.pdf()` and inspects bytes via `pdfjs-dist`. */
  pdf?: boolean | import('./pdf-audit.js').PdfConfig;
  canonical?: boolean | { followChain?: boolean };
  sri?: boolean;
  webWorkers?: boolean;
  orphanAssets?: boolean;
  inp?: boolean | { interactSelectors?: string[]; maxInteractions?: number; delayBetweenMs?: number };
  lcpElement?: boolean;
  clsCulprit?: boolean | { durationMs?: number };
  hreflang?: boolean;
  cookieFlags?: boolean;
  gdpr?: boolean | import('./gdpr-audit.js').GdprConfig;
  focusTrap?: boolean;
  favicon?: boolean;
  clickjacking?: boolean;
  criticalCss?: boolean;
  sourcemapScan?: boolean;
  secretScan?: boolean;
  trackerSniff?: boolean;
  zIndex?: boolean;
  hydration?: boolean;
  storage?: boolean;
  csrf?: boolean;
  authEdge?: boolean | import('./auth-edge-audit.js').AuthEdgeConfig;
  errorPages?: boolean;
  stuckSpinners?: boolean | { timeoutMs?: number; selectors?: string[]; pollIntervalMs?: number; captureScreenshot?: boolean; screenshotDir?: string };
  errorState?: boolean | { selectors?: string[]; allowExisting?: boolean };
  frustrationSignals?: boolean | {
    rageClickWindowMs?: number;
    rageClickThreshold?: number;
    deadClickWaitMs?: number;
    uTurnWindowMs?: number;
    errorClickWindowMs?: number;
    thrashedCursorWindowMs?: number;
    thrashedCursorThreshold?: number;
  };
  /** P4 #36 — Per-locale i18n / RTL / text-overflow audit. */
  i18n?: boolean | import('./i18n-audit.js').I18nConfig;
  /** P4 #38 — Per-state colour contrast audit (default/hover/focus/active/disabled). */
  contrastStates?: boolean | ContrastConfig;
  /** P4 #40 — Offline / flaky-network audit. Boolean turns it on with defaults; object passes through to `runOfflineAudit`. */
  offline?: boolean | OfflineConfig;
  /** Email rendering audit (P4 #42) — requires `emailAuditConfig` on the root InspectConfig. */
  emailAudit?: boolean;
  /** P6 #48 — XSS payload filler. Walks form fields, types known payloads, reports unsafe reflections / executions. */
  xss?: boolean | import('./xss-audit.js').XssAuditOptions;
  /** P6 #47 — Clock-race audit. Hijacks page.clock, fast-forwards, flags stuck/regressed relative-time text. */
  clockRace?: boolean | import('./clock-race-audit.js').ClockRaceAuditOptions;
  /** P6 #49 — Jitter / human-misclick audit. Re-clicks buttons with ±N-px offsets, flags silent/inconsistent handlers. */
  jitter?: boolean | import('./jitter-audit.js').JitterAuditOptions;
  /** P6 #50 — Virtual screen-reader announcements audit. */
  srAnnouncements?: boolean | import('./sr-announcements-audit.js').SrAuditOptions;
  /** P6 #51 — Pseudo-locale long-string audit (truncation / clipping / overflow). */
  pseudoLocale?: boolean | import('./pseudo-locale-audit.js').PseudoAuditOptions;
}

/** P4 #38 — Interaction states measured by {@link runContrastStatesAudit}. */
export type ContrastState = 'default' | 'hover' | 'focus' | 'active' | 'disabled';

/** P4 #38 — Configuration for the per-state contrast audit. */
export interface ContrastConfig {
  /** WCAG level to enforce for text contrast. Defaults to `'AA'`. */
  targetLevel?: 'AA' | 'AAA';
  /** CSS selectors whose matching elements should be ignored entirely. */
  skip?: string[];
  /** Interaction states to simulate. Defaults to every state. */
  states?: ContrastState[];
  /** Cap candidate count (defense against huge pages). Defaults to 200. */
  maxElements?: number;
}

/** P4 #38 — Single contrast violation from a simulated interaction state. */
export interface ContrastViolation {
  selector: string;
  state: ContrastState;
  /** `'text'` for foreground-vs-background text contrast; `'focus-ring'` for outline/ring vs surface. */
  kind: 'text' | 'focus-ring';
  level: 'AA' | 'AAA';
  ratio: number;
  required: number;
  foreground: string;
  background: string;
  isLarge: boolean;
  fontSizePx?: number;
  snippet?: string;
  message: string;
}

/** P4 #38 — Aggregate result of {@link runContrastStatesAudit}. */
export interface ContrastResult {
  page: string;
  scanned: number;
  states: ContrastState[];
  targetLevel: 'AA' | 'AAA';
  violations: ContrastViolation[];
  stateCounts: Record<ContrastState, number>;
  passed: boolean;
}

/**
 * P4 #40 — Offline / flaky-network audit result. See `src/offline-audit.ts`
 * for details. Re-exported from the module's public surface so consumers can
 * import the types without reaching into `offline-audit.js`.
 */
export type OfflineScenarioId = import('./offline-audit.js').OfflineScenarioId;
export type OfflineConfig = import('./offline-audit.js').OfflineConfig;
export type OfflineIssueType = import('./offline-audit.js').OfflineIssueType;
export type OfflineIssue = import('./offline-audit.js').OfflineIssue;
export type OfflineScenarioResult = import('./offline-audit.js').OfflineScenarioResult;
export type OfflineResult = import('./offline-audit.js').OfflineResult;

export interface OutputConfig {
  dir?: string;
  baselineDir?: string;
  reportFormat?: 'html' | 'json' | 'both';
  /** P2 #24 — Apply stable-capture options (freeze animations, wait fonts,
   *  lazy-load auto-scroll, scroll-and-stitch) to visual diff screenshots.
   *  Defaults: freezeAnimations + waitFonts ON, autoScrollLazy + stitch OFF. */
  captureOptions?: import('./visual-capture.js').CaptureOptions;
}

export interface OllamaFallbackConfig {
  /** Enable local LLM fallback for locator resolution. Default false. */
  enabled?: boolean;
  /** Model name. Default 'llama3.2'. */
  model?: string;
  /** Endpoint URL. Default 'http://localhost:11434/api/generate'. */
  endpoint?: string;
  /** Request timeout in ms. Default 5000 (canonical per P3 #27 spec). */
  timeoutMs?: number;
  /** Legacy alias for `timeoutMs`. */
  timeout?: number;
}

export interface AIConfig {
  enabled?: boolean;
  model?: string;
  /** Opt-in local language model fallback for locator resolution. */
  fallback?: {
    ollama?: OllamaFallbackConfig;
  };
}

/** P3 #29 — Observable interactive element discovered by observe(). */
export interface ObservableAction {
  selector: string;
  description: string;
  elementType: string;
  visibleText: string;
  boundingBox: { x: number; y: number; width: number; height: number } | null;
}

export interface ObserveOptions {
  /** Only return elements whose description matches this substring (case-insensitive). */
  filter?: string;
  /** Max results. Default 50. */
  limit?: number;
}

/** P5 #49 — Custom branding for HTML reports + PDF export. Pro+ only. */
export interface BrandingConfig {
  /** Company logo URL or base64 data URI. Max-height 40px in report header. */
  logo?: string;
  /** Primary accent color (overrides --green CSS var). */
  primaryColor?: string;
  /** Company name (replaces "uxinspect" in report header). */
  companyName?: string;
  /** Custom footer text row. */
  footerText?: string;
}

export interface InspectResult {
  url: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  flows: FlowResult[];
  a11y?: A11yResult[];
  perf?: PerfResult[];
  visual?: VisualResult[];
  explore?: ExploreResult;
  seo?: import('./seo.js').SeoResult[];
  links?: import('./links.js').LinkCheckResult[];
  pwa?: import('./pwa.js').PwaResult[];
  security?: import('./security.js').SecurityHeadersResult;
  budget?: import('./budget.js').BudgetViolation[];
  apiFlows?: ApiFlowResult[];
  retire?: import('./retire.js').RetireResult[];
  deadClicks?: import('./deadclicks.js').DeadClickResult[];
  disabledButtons?: import('./disabled-buttons-audit.js').DisabledButtonsResult[];
  touchTargets?: import('./touchtargets.js').TouchTargetResult[];
  keyboard?: import('./keyboard.js').KeyboardAuditResult[];
  longTasks?: import('./longtasks.js').LongTasksResult[];
  clsTimeline?: import('./cls-timeline.js').CLSTimelineResult[];
  forms?: import('./forms-audit.js').FormsAuditResult[];
  formBehavior?: import('./forms-audit.js').FormBehaviorResult[];
  structuredData?: import('./structured-data.js').StructuredDataResult[];
  passiveSecurity?: import('./passive-security.js').PassiveSecurityResult[];
  consoleErrors?: import('./console-errors.js').ConsoleCapture[];
  sitemap?: import('./sitemap.js').SitemapAuditResult;
  redirects?: import('./redirects.js').RedirectAuditResult;
  exposedPaths?: import('./exposed-paths.js').ExposedPathsResult;
  tls?: import('./tls.js').TLSAuditResult;
  crawl?: import('./crawl.js').CrawlResult;
  contentQuality?: import('./content-quality.js').ContentQualityResult;
  resourceHints?: import('./resource-hints.js').ResourceHintsResult[];
  mixedContent?: import('./mixed-content.js').MixedContentResult[];
  compression?: import('./compression.js').CompressionAuditResult;
  cacheHeaders?: import('./cache-headers.js').CacheHeadersResult[];
  cookieBanner?: import('./cookie-banner.js').CookieBannerResult[];
  thirdParty?: import('./third-party.js').ThirdPartyResult[];
  bundleSize?: import('./bundle-size.js').BundleSizeResult[];
  openGraph?: import('./open-graph.js').OpenGraphResult[];
  robotsAudit?: import('./robots-audit.js').RobotsAuditResult;
  imageAudit?: import('./image-audit.js').ImageAuditResult[];
  webfonts?: import('./webfonts.js').WebfontsResult[];
  motionPrefs?: import('./motion-prefs.js').MotionPrefsResult[];
  serviceWorker?: import('./service-worker.js').ServiceWorkerResult[];
  rum?: import('./rum.js').RUMResult[];
  amp?: import('./amp.js').AmpResult[];
  jsCoverage?: import('./js-coverage.js').JsCoverageResult[];
  cssCoverage?: import('./css-coverage.js').CssCoverageResult[];
  domSize?: import('./dom-audit.js').DomAuditResult[];
  ariaAudit?: import('./aria-audit.js').AriaAuditResult[];
  headings?: import('./heading-hierarchy.js').HeadingHierarchyResult[];
  langAudit?: import('./lang-audit.js').LangAuditResult[];
  protocols?: import('./protocol-audit.js').ProtocolAuditResult[];
  fontLoading?: import('./font-loading.js').FontLoadingResult[];
  prerenderAudit?: import('./prerender-audit.js').PrerenderAuditResult[];
  headlessDetect?: import('./headless-detect.js').HeadlessDetectResult[];
  animations?: import('./animation-audit.js').AnimationAuditResult[];
  eventListeners?: import('./event-listener-audit.js').EventListenerAuditResult[];
  darkMode?: import('./dark-mode-audit.js').DarkModeResult[];
  tables?: import('./table-audit.js').TableAuditResult[];
  svgs?: import('./svg-audit.js').SvgAuditResult[];
  media?: import('./media-audit.js').MediaAuditResult[];
  readingLevel?: import('./reading-level.js').ReadingLevelResult[];
  deadImages?: import('./dead-images.js').DeadImageResult[];
  pagination?: import('./pagination-audit.js').PaginationResult[];
  print?: import('./print-audit.js').PrintAuditResult[];
  pdf?: import('./pdf-audit.js').PdfResult[];
  canonical?: import('./canonical-audit.js').CanonicalAuditResult[];
  sri?: import('./sri-audit.js').SriAuditResult[];
  webWorkers?: import('./web-worker-audit.js').WebWorkerAuditResult[];
  orphanAssets?: import('./orphan-assets.js').OrphanAssetResult[];
  inp?: import('./inp-audit.js').InpAuditResult[];
  lcpElement?: import('./lcp-element.js').LcpElementResult[];
  clsCulprit?: import('./cls-culprit.js').ClsCulpritResult[];
  hreflang?: import('./hreflang-audit.js').HreflangAuditResult[];
  cookieFlags?: import('./cookie-flags-audit.js').CookieFlagsResult[];
  gdpr?: import('./gdpr-audit.js').GdprResult[];
  focusTrap?: import('./focus-trap-audit.js').FocusTrapResult[];
  favicon?: import('./favicon-audit.js').FaviconAuditResult[];
  clickjacking?: import('./clickjacking-audit.js').ClickjackingResult[];
  criticalCss?: import('./critical-css.js').CriticalCssResult[];
  sourcemapScan?: import('./sourcemap-scan.js').SourceMapScanResult[];
  secretScan?: import('./secret-scan.js').SecretScanResult[];
  trackerSniff?: import('./tracker-sniff.js').TrackerSniffResult[];
  zIndex?: import('./zindex-audit.js').ZIndexAuditResult[];
  hydration?: import('./hydration-audit.js').HydrationAuditResult[];
  storage?: import('./storage-audit.js').StorageAuditResult[];
  csrf?: import('./csrf-audit.js').CsrfAuditResult[];
  authEdge?: import('./auth-edge-audit.js').AuthEdgeResult[];
  errorPages?: import('./error-page-audit.js').ErrorPageAuditResult[];
  stuckSpinners?: import('./stuck-spinner-audit.js').StuckSpinnerResult[];
  errorState?: import('./error-state-audit.js').ErrorStateResult;
  authWalk?: import('./auth-walker.js').AuthWalkResult;
  frustrationSignals?: import('./frustration-signals.js').FrustrationSignalResult[];
  /** Per-locale i18n / RTL / overflow audit results (P4 #36). */
  i18n?: import('./i18n-audit.js').I18nResult[];
  /** Per-state colour contrast findings (P4 #38). */
  contrastStates?: ContrastResult[];
  /** P4 #40 — Offline / flaky-network audit results, one per page that was tested. */
  offline?: import('./offline-audit.js').OfflineResult[];
  /** Email rendering audit (P4 #42). */
  emailAudit?: EmailResult;
  /** P6 #48 — XSS payload filler results (one per page probed). */
  xss?: import('./xss-audit.js').XssAuditResult[];
  /** P6 #47 — Clock-race audit results (one per page probed). */
  clockRace?: import('./clock-race-audit.js').ClockRaceResult[];
  /** P6 #49 — Jitter audit results (one per page probed). */
  jitter?: import('./jitter-audit.js').JitterResult[];
  /** P6 #50 — Virtual screen-reader audit results (one per page probed). */
  srAnnouncements?: import('./sr-announcements-audit.js').SrAuditResult[];
  /** P6 #51 — Pseudo-locale audit results (one per page probed). */
  pseudoLocale?: import('./pseudo-locale-audit.js').PseudoAuditResult[];
  /** Self-heal events emitted by the AI helper when a locator drifts (P2 #26). */
  selfHealEvents?: import('./ai.js').SelfHealEvent[];
  /**
   * Fast mode metadata (P3 #31). Present only when the run was started with
   * `config.fast === true`. Lists which audits were skipped and surfaces a
   * warning when the run exceeded the 30s target.
   */
  fastMeta?: {
    /** Camel-case audit names that fast mode forced off (e.g. 'perf', 'links'). */
    skippedAudits: string[];
    /** Wall-clock target in milliseconds (always 30_000 today). */
    targetMs: number;
    /** Filled when `durationMs > targetMs`. */
    warning?: string;
  };
  passed: boolean;
}

export type {
  AuthEdgeConfig,
  AuthEdgeResult,
  AuthEdgeIssue,
  AuthEdgeIssueKind,
  AuthEdgeScenario,
  AuthEdgeScenarioResult,
} from './auth-edge-audit.js';

export interface FlowResult {
  name: string;
  passed: boolean;
  steps: StepResult[];
  screenshots: string[];
  error?: string;
  /** Path to the rrweb replay JSON, e.g. `.uxinspect/replays/<flow>-<ts>.json` (P0 #3). */
  replayPath?: string;
  /** Path to the static replay-viewer HTML emitted by `uxinspect replay` (P0 #4). */
  replayViewerPath?: string;
  /** Epoch ms when the failure occurred — used to seek the rrweb player. */
  failureTimestamp?: number;
  /** Epoch ms when the replay started recording — used to compute seek offset. */
  replayStartedAt?: number;
}

export interface StepResult {
  step: Step;
  passed: boolean;
  durationMs: number;
  error?: string;
  assertions?: AssertionFailure[];
  consoleErrors?: import('./console-errors.js').StepConsoleCapture;
  /** Network 4xx/5xx responses observed during this step (P0 #7). */
  networkFailures?: import('./network-attribution.js').NetworkFailure[];
}

export interface A11yResult {
  page: string;
  violations: A11yViolation[];
  passed: boolean;
}

export interface A11yViolation {
  id: string;
  impact: 'minor' | 'moderate' | 'serious' | 'critical';
  description: string;
  help: string;
  helpUrl: string;
  nodes: { html: string; target: string[] }[];
}

export interface PerfResult {
  page: string;
  scores: {
    performance: number;
    accessibility: number;
    bestPractices: number;
    seo: number;
  };
  metrics: {
    lcp: number;
    fcp: number;
    cls: number;
    tbt: number;
    si: number;
  };
}

export interface VisualResult {
  page: string;
  viewport: string;
  baseline: string;
  current: string;
  diff?: string;
  diffPixels: number;
  diffRatio: number;
  passed: boolean;
  /** Algorithm used for this comparison (P2 #23). Omitted when pixelmatch is used to preserve backwards compatibility. */
  algorithm?: 'pixelmatch' | 'ssim';
  /** Mean SSIM score across windows when `algorithm === 'ssim'`. 1.0 == identical. */
  ssim?: number;
  /** Count of SSIM windows whose score fell below the region threshold. */
  changedRegions?: number;
}

/**
 * P4 #41 — Concurrency audit re-exports. The concrete types live in
 * `src/concurrency-audit.ts`; re-exporting from the types barrel lets
 * consumers `import type { ConcurrencyConfig, ConcurrencyResult, RaceIssue }`
 * alongside the other audit types.
 */
export type {
  ConcurrencyConfig,
  ConcurrencyResult,
  ConcurrencyScenario,
  RaceIssue,
  ScenarioResult,
} from './concurrency-audit.js';

/**
 * Ignore-region DSL (P2 #23). Either an absolute rectangle or a selector to resolve at runtime.
 * Both baseline and current images are masked with the same regions before diffing.
 */
export type VisualIgnoreRegion =
  | { x: number; y: number; w: number; h: number }
  | { x: number; y: number; width: number; height: number }
  | { selector: string };

/**
 * Visual diff configuration (P2 #23).
 * Backwards compatible: when omitted, the default algorithm is `pixelmatch` with the
 * same threshold / failRatio semantics as before.
 */
export interface VisualDiffConfig {
  /** Algorithm to run. Defaults to `pixelmatch`. */
  algorithm?: 'pixelmatch' | 'ssim';
  /**
   * Anti-alias tolerance.
   * - pixelmatch: passed through as the `threshold` option (higher = more tolerant).
   * - ssim: passed as the Gaussian window size (higher = more tolerant to small shifts). Defaults
   *   to 11 which matches the Wang et al. SSIM paper.
   */
  antialiasTolerance?: number;
  /** Regions to mask with a solid fill on both baseline and current before diffing. */
  ignoreRegions?: VisualIgnoreRegion[];
  /** Pixelmatch colour-distance threshold (0..1). Ignored for SSIM. */
  threshold?: number;
  /** Ratio of differing pixels (pixelmatch) above which the result fails. Ignored for SSIM. */
  failRatio?: number;
  /**
   * SSIM pass threshold (0..1). Ignored for pixelmatch.
   * A mean SSIM >= this value passes. Defaults to 0.98.
   */
  ssimThreshold?: number;
  /** Fill colour used when masking ignore regions (hex `#rrggbb` or `rgb(r,g,b)`). Defaults to black. */
  maskColor?: string;
}

export interface BrokenInteraction {
  key: string;
  reason: 'error-state-appeared';
  newErrors: { selector: string; snippet: string; text: string }[];
}

export interface ExploreResult {
  pagesVisited: number;
  buttonsClicked: number;
  formsSubmitted: number;
  errors: string[];
  consoleErrors: string[];
  networkErrors: string[];
  replayPath?: string;
  stuckSpinners?: import('./stuck-spinner-audit.js').StuckSpinnerFinding[];
  brokenInteractions?: BrokenInteraction[];
  coverage?: {
    clicked: number;
    total: number;
    percent: number;
    byTag: Record<string, number>;
    missed: Array<{ selector: string; snippet: string }>;
  };
  frustrationSignals?: import('./frustration-signals.js').FrustrationSignalResult;
  heatmap?: {
    viewport: { name: string; width: number; height: number };
    clicks: import('./heatmap.js').ClickRecord[];
    untested: import('./heatmap.js').UntestedRecord[];
    hoverOnly?: import('./heatmap.js').HoverOnlyRecord[];
    screenshotUrl?: string;
  };
  /** P3 #34 — Auto-generated step labels from BFS explore. */
  stepLabels?: string[];
}

/* ─────────────────────────────────────────────────────────────────
 * P4 #42 — Email rendering audit.
 * ───────────────────────────────────────────────────────────────── */

export interface EmailViewport {
  name: string;
  width: number;
  height: number;
}

// ───────────────────────────────────────────────────────────────────────────
// P4 #43 — PDF audit types
// ───────────────────────────────────────────────────────────────────────────

/**
 * Configuration for {@link import('./pdf-audit.js').runPdfAudit}.
 *
 * CHROMIUM-ONLY: `page.pdf()` is implemented exclusively in Chromium.
 * Non-Chromium pages are short-circuited with a `wrong-browser` issue.
 */
export interface PdfConfig {
  /** Routes to audit; default = current page only. Reserved for batch mode. */
  routes?: string[];
  /** Paper size. Custom sizes given in PostScript points (1in = 72pt). */
  pageSize?: 'A4' | 'Letter' | { w: number; h: number };
  /**
   * Pixels / points reserved at top / bottom for headers and footers.
   * Any rendered PDF text landing inside these strips is flagged as bleed.
   * Defaults: 36pt (~0.5in) top AND bottom.
   */
  headerFooterAllowedYs?: { top: number; bottom: number };
  /** Where to save the generated `.pdf` (for debugging / CI artifacts). Default `.uxinspect/pdf/`. */
  outDir?: string;
  /** Flag runs that exceed this many pages (e.g. unbounded report explosion). */
  expectedMaxPages?: number;
}

export type PdfIssueType =
  | 'wrong-browser'
  | 'pdf-render-failed'
  | 'pdf-parse-failed'
  | 'pdfjs-missing'
  | 'too-many-pages'
  | 'header-bleed'
  | 'footer-bleed'
  | 'break-inside-straddle'
  | 'image-overflow'
  | 'no-page-rule'
  | 'print-rule-no-effect';

export interface PdfIssue {
  type: PdfIssueType;
  severity: 'info' | 'warn' | 'error';
  selector?: string;
  detail: string;
}

export interface PdfTextItem {
  text: string;
  /** x position in PDF points (origin top-left, after coord inversion). */
  x: number;
  /** y position in PDF points from page top. */
  y: number;
  width: number;
  height: number;
}

/**
 * Cross-client rendering profiles. Each profile transforms the captured HTML
 * in a way that approximates a common webmail quirk so the reviewer can see
 * how the email degrades without hitting a real mail client.
 *  - `as-sent`: the HTML as received
 *  - `style-stripped`: strips `<style>` blocks and inline `style=""` attrs
 *  - `plain-text-fallback`: renders the text alternative as monospace
 */
export type EmailRenderProfile = 'as-sent' | 'style-stripped' | 'plain-text-fallback';

export type EmailIssueType =
  | 'missing-plain-text-alternative'
  | 'subject-too-long'
  | 'subject-too-long-mobile'
  | 'remote-image-missing-alt'
  | 'no-dark-mode-styles'
  | 'missing-dkim'
  | 'missing-spf'
  | 'capture-unreachable'
  | 'render-failed';

export interface EmailIssue {
  type: EmailIssueType;
  messageId: string;
  message: string;
}

export interface EmailScreenshot {
  viewport: string;
  profile: EmailRenderProfile;
  path: string;
}

export interface EmailRecord {
  id: string;
  subject: string;
  from: string;
  to: string[];
  receivedAt: string;
  hasPlainTextAlternative: boolean;
  subjectLength: number;
  hasDarkModeStyles: boolean;
  hasDkim: boolean;
  hasSpf: boolean;
  hasAuthResults: boolean;
  screenshots: EmailScreenshot[];
  issues: EmailIssue[];
}

/**
 * Audit configuration. The capture bridge is user-provided and unbranded:
 * any HTTP list-/fetch-style endpoint works (dev SMTP capture with HTTP API,
 * Cloudflare email worker, hosted capture service).
 */
export interface EmailConfig {
  /** URL of the dev SMTP capture's list endpoint. Item URLs are derived as `${url}/${id}`. */
  emailCaptureUrl: string;
  /** Optional bearer token sent as `Authorization: Bearer <token>`. */
  authToken?: string;
  /** Only audit messages received at or after this epoch-ms timestamp. */
  sinceTs?: number;
  /** Viewports to render each message in. Defaults: desktop 600x800 and mobile 375x600. */
  viewports?: EmailViewport[];
  /** Render profiles to approximate cross-client rendering. Defaults: all three. */
  renderProfiles?: EmailRenderProfile[];
  /** Screenshot output directory. Default: `.uxinspect/emails`. */
  outDir?: string;
}

export interface EmailResult {
  startedAt: string;
  finishedAt: string;
  captureUrl: string;
  scanned: number;
  emails: EmailRecord[];
  issues: EmailIssue[];
  passed: boolean;
}

export interface PdfPage {
  pageNumber: number;
  widthPt: number;
  heightPt: number;
  items: PdfTextItem[];
}

export interface PdfLayoutDrift {
  selector: string;
  hadPrintRule: boolean;
  changed: boolean;
  screen: { x: number; y: number; w: number; h: number; display: string; visible: boolean };
  print: { x: number; y: number; w: number; h: number; display: string; visible: boolean };
}

export interface PdfResult {
  page: string;
  startedAt: string;
  browser: string;
  pageCount: number;
  pages: PdfPage[];
  issues: PdfIssue[];
  layoutDrift: PdfLayoutDrift[];
  pdfPath?: string;
  sizeBytes: number;
  passed: boolean;
}
