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

export type Step =
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
  passed: boolean;
}

export interface FlowResult {
  name: string;
  passed: boolean;
  steps: StepResult[];
  screenshots: string[];
  error?: string;
}

export interface StepResult {
  step: Step;
  passed: boolean;
  durationMs: number;
  error?: string;
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
}
