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
  /** No new console errors recorded between step start and end. */
  console?: 'clean';
  /** No new HTTP 4xx/5xx responses observed during the step. */
  network?: 'no-4xx';
  /** No new `[role="alert"]`, `.error`, or `.alert-danger` elements appeared. */
  dom?: 'no-error';
  /** Screenshot matches stored baseline; if no baseline exists, current is saved as baseline. */
  visual?: 'matches';
}

export interface AssertionFailure {
  kind: 'console' | 'network' | 'dom' | 'visual';
  message: string;
  details?: unknown;
}

export type Step = StepAction & {
  assert?: AssertConfig;
  /** P2 #24 — Apply stable-capture options (freeze animations, wait fonts,
   *  lazy-load auto-scroll, scroll-and-stitch) to screenshot-taking steps
   *  and to the visual-assertion screenshot. Has no effect on non-capturing
   *  steps. Defaults: freezeAnimations + waitFonts ON, autoScrollLazy + stitch OFF. */
  captureOptions?: import('./visual-capture.js').CaptureOptions;
};

export type StepAction =
  | { goto: string }
  | { click: string }
  | { type: { selector: string; text: string } }
  | { fill: { selector: string; text: string } }
  | { waitFor: string }
  | { screenshot: string }
  | { ai: string }
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

export interface OutputConfig {
  dir?: string;
  baselineDir?: string;
  reportFormat?: 'html' | 'json' | 'both';
  /** P2 #24 — Apply stable-capture options (freeze animations, wait fonts,
   *  lazy-load auto-scroll, scroll-and-stitch) to visual diff screenshots.
   *  Defaults: freezeAnimations + waitFonts ON, autoScrollLazy + stitch OFF. */
  captureOptions?: import('./visual-capture.js').CaptureOptions;
}

export interface AIConfig {
  enabled?: boolean;
  model?: string;
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
  errorPages?: import('./error-page-audit.js').ErrorPageAuditResult[];
  stuckSpinners?: import('./stuck-spinner-audit.js').StuckSpinnerResult[];
  errorState?: import('./error-state-audit.js').ErrorStateResult;
  authWalk?: import('./auth-walker.js').AuthWalkResult;
  frustrationSignals?: import('./frustration-signals.js').FrustrationSignalResult[];
  /** Per-locale i18n / RTL / overflow audit results (P4 #36). */
  i18n?: import('./i18n-audit.js').I18nResult[];
  /** Per-state colour contrast findings (P4 #38). */
  contrastStates?: ContrastResult[];
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
}
