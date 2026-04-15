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

export type Step = StepAction & { assert?: AssertConfig };

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
  touchTargets?: boolean | { minSize?: number; onlyViewport?: boolean };
  keyboard?: boolean | { maxTabs?: number; requireFocusRing?: boolean };
  longTasks?: boolean | { durationMs?: number };
  clsTimeline?: boolean | { durationMs?: number };
  forms?: boolean;
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
}

export interface OutputConfig {
  dir?: string;
  baselineDir?: string;
  reportFormat?: 'html' | 'json' | 'both';
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
  touchTargets?: import('./touchtargets.js').TouchTargetResult[];
  keyboard?: import('./keyboard.js').KeyboardAuditResult[];
  longTasks?: import('./longtasks.js').LongTasksResult[];
  clsTimeline?: import('./cls-timeline.js').CLSTimelineResult[];
  forms?: import('./forms-audit.js').FormsAuditResult[];
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
}

export interface ExploreResult {
  pagesVisited: number;
  buttonsClicked: number;
  formsSubmitted: number;
  errors: string[];
  consoleErrors: string[];
  networkErrors: string[];
  replayPath?: string;
}
