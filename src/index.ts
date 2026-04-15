import path from 'node:path';
import { Driver, networkPresets } from './driver.js';
import { checkA11y, annotateA11y } from './a11y.js';
import { checkPerf } from './perf.js';
import { checkVisual } from './visual.js';
import { explore } from './explore.js';
import { checkSeo } from './seo.js';
import { checkLinks } from './links.js';
import { checkPwa } from './pwa.js';
import { checkSecurityHeaders } from './security.js';
import { checkBudget } from './budget.js';
import { notify } from './notify.js';
import { AIHelper } from './ai.js';
import { writeReport } from './report.js';
import { r2StoreFromEnv } from './store.js';
import { runApiFlows } from './api.js';
import { checkRetireJs } from './retire.js';
import { checkDeadClicks } from './deadclicks.js';
import { auditTouchTargets } from './touchtargets.js';
import { auditKeyboard } from './keyboard.js';
import { captureLongTasks } from './longtasks.js';
import { captureClsTimeline } from './cls-timeline.js';
import { auditForms } from './forms-audit.js';
import { checkStructuredData } from './structured-data.js';
import { auditPassiveSecurity } from './passive-security.js';
import { attachConsoleCapture } from './console-errors.js';
import { auditSitemap } from './sitemap.js';
import { auditRedirects } from './redirects.js';
import { scanExposedPaths } from './exposed-paths.js';
import { auditTls } from './tls.js';
import { crawlSite } from './crawl.js';
import { analyzePage as analyzeContent, analyzeBatch as analyzeContentBatch } from './content-quality.js';
import { auditResourceHints } from './resource-hints.js';
import { checkMixedContent } from './mixed-content.js';
import { auditCompression } from './compression.js';
import { auditCacheHeaders } from './cache-headers.js';
import { auditCookieBanner } from './cookie-banner.js';
import { auditThirdParty } from './third-party.js';
import { analyzeBundles } from './bundle-size.js';
import { checkOpenGraph } from './open-graph.js';
import { auditRobots } from './robots-audit.js';
import { auditImages } from './image-audit.js';
import { auditWebfonts } from './webfonts.js';
import { auditMotionPrefs } from './motion-prefs.js';
import { auditServiceWorker } from './service-worker.js';
import { collectRUM } from './rum.js';
import { validateAmp } from './amp.js';
import { auditJsCoverage } from './js-coverage.js';
import { auditCssCoverage } from './css-coverage.js';
import { auditDomSize } from './dom-audit.js';
import { auditAria } from './aria-audit.js';
import { auditHeadings } from './heading-hierarchy.js';
import { auditLang } from './lang-audit.js';
import { auditProtocols } from './protocol-audit.js';
import { auditFontLoading } from './font-loading.js';
import { auditPrerender } from './prerender-audit.js';
import { auditHeadlessDetect } from './headless-detect.js';
import { auditAnimations } from './animation-audit.js';
import { auditEventListeners } from './event-listener-audit.js';
import { auditDarkMode } from './dark-mode-audit.js';
import { auditTables } from './table-audit.js';
import { auditSvgs } from './svg-audit.js';
import { auditMedia } from './media-audit.js';
import { auditReadingLevel } from './reading-level.js';
import { detectDeadImages } from './dead-images.js';
import { auditPagination } from './pagination-audit.js';
import { auditPrint } from './print-audit.js';
import { auditCanonical } from './canonical-audit.js';
import { auditSri } from './sri-audit.js';
import { auditWebWorkers } from './web-worker-audit.js';
import { detectOrphanAssets } from './orphan-assets.js';
import { auditInp } from './inp-audit.js';
import { auditLcpElement } from './lcp-element.js';
import { auditClsCulprit } from './cls-culprit.js';
import { auditHreflang } from './hreflang-audit.js';
import { auditCookieFlags } from './cookie-flags-audit.js';
import { auditFocusTrap } from './focus-trap-audit.js';
import { auditFavicons } from './favicon-audit.js';
import { auditClickjacking } from './clickjacking-audit.js';
import { extractCriticalCss } from './critical-css.js';
import { scanSourceMaps } from './sourcemap-scan.js';
import { scanSecrets } from './secret-scan.js';
import { sniffTrackers } from './tracker-sniff.js';
import { auditZIndex } from './zindex-audit.js';
import { auditHydration } from './hydration-audit.js';
import { auditStorage } from './storage-audit.js';
import { auditCsrf } from './csrf-audit.js';
import { auditErrorPages } from './error-page-audit.js';
import type {
  InspectConfig,
  InspectResult,
  FlowResult,
  StepResult,
  Step,
  A11yResult,
  PerfResult,
  VisualResult,
} from './types.js';
import type { Page } from 'playwright';
import type { RetireResult } from './retire.js';
import type { DeadClickResult } from './deadclicks.js';
import type { TouchTargetResult } from './touchtargets.js';
import type { KeyboardAuditResult } from './keyboard.js';
import type { LongTasksResult } from './longtasks.js';
import type { CLSTimelineResult } from './cls-timeline.js';
import type { FormsAuditResult } from './forms-audit.js';
import type { StructuredDataResult } from './structured-data.js';
import type { PassiveSecurityResult } from './passive-security.js';
import type { ConsoleCapture } from './console-errors.js';
import type { PageContentInfo } from './content-quality.js';
import type { ResourceHintsResult } from './resource-hints.js';
import type { MixedContentResult } from './mixed-content.js';
import type { CacheHeadersResult } from './cache-headers.js';
import type { CookieBannerResult } from './cookie-banner.js';
import type { ThirdPartyResult } from './third-party.js';
import type { BundleSizeResult } from './bundle-size.js';
import type { OpenGraphResult } from './open-graph.js';
import type { ImageAuditResult } from './image-audit.js';
import type { WebfontsResult } from './webfonts.js';
import type { MotionPrefsResult } from './motion-prefs.js';
import type { ServiceWorkerResult } from './service-worker.js';
import type { RUMResult } from './rum.js';
import type { AmpResult } from './amp.js';
import type { JsCoverageResult } from './js-coverage.js';
import type { CssCoverageResult } from './css-coverage.js';
import type { DomAuditResult } from './dom-audit.js';
import type { AriaAuditResult } from './aria-audit.js';
import type { HeadingHierarchyResult } from './heading-hierarchy.js';
import type { LangAuditResult } from './lang-audit.js';
import type { ProtocolAuditResult } from './protocol-audit.js';
import type { FontLoadingResult } from './font-loading.js';
import type { PrerenderAuditResult } from './prerender-audit.js';
import type { HeadlessDetectResult } from './headless-detect.js';
import type { AnimationAuditResult } from './animation-audit.js';
import type { EventListenerAuditResult } from './event-listener-audit.js';
import type { DarkModeResult } from './dark-mode-audit.js';
import type { TableAuditResult } from './table-audit.js';
import type { SvgAuditResult } from './svg-audit.js';
import type { MediaAuditResult } from './media-audit.js';
import type { ReadingLevelResult } from './reading-level.js';
import type { DeadImageResult } from './dead-images.js';
import type { PaginationResult } from './pagination-audit.js';
import type { PrintAuditResult } from './print-audit.js';
import type { CanonicalAuditResult } from './canonical-audit.js';
import type { SriAuditResult } from './sri-audit.js';
import type { WebWorkerAuditResult } from './web-worker-audit.js';
import type { OrphanAssetResult } from './orphan-assets.js';
import type { InpAuditResult } from './inp-audit.js';
import type { LcpElementResult } from './lcp-element.js';
import type { ClsCulpritResult } from './cls-culprit.js';
import type { HreflangAuditResult } from './hreflang-audit.js';
import type { CookieFlagsResult } from './cookie-flags-audit.js';
import type { FocusTrapResult } from './focus-trap-audit.js';
import type { FaviconAuditResult } from './favicon-audit.js';
import type { ClickjackingResult } from './clickjacking-audit.js';
import type { CriticalCssResult } from './critical-css.js';
import type { SourceMapScanResult } from './sourcemap-scan.js';
import type { SecretScanResult } from './secret-scan.js';
import type { TrackerSniffResult } from './tracker-sniff.js';
import type { ZIndexAuditResult } from './zindex-audit.js';
import type { HydrationAuditResult } from './hydration-audit.js';
import type { StorageAuditResult } from './storage-audit.js';
import type { CsrfAuditResult } from './csrf-audit.js';
import type { ErrorPageAuditResult } from './error-page-audit.js';

export * from './types.js';
export { Driver, networkPresets } from './driver.js';
export { AIHelper } from './ai.js';
export { checkSeo } from './seo.js';
export { checkLinks } from './links.js';
export { checkPwa } from './pwa.js';
export { checkSecurityHeaders } from './security.js';
export { checkBudget } from './budget.js';
export { notify } from './notify.js';
export { runApiFlows } from './api.js';
export { checkRetireJs } from './retire.js';
export { checkDeadClicks } from './deadclicks.js';
export { auditTouchTargets } from './touchtargets.js';
export { auditKeyboard } from './keyboard.js';
export { captureLongTasks } from './longtasks.js';
export { captureClsTimeline } from './cls-timeline.js';
export { auditForms } from './forms-audit.js';
export { checkStructuredData } from './structured-data.js';
export { auditPassiveSecurity } from './passive-security.js';
export { attachConsoleCapture } from './console-errors.js';
export { auditSitemap } from './sitemap.js';
export { auditRedirects } from './redirects.js';
export { scanExposedPaths } from './exposed-paths.js';
export { auditTls } from './tls.js';
export { crawlSite } from './crawl.js';
export { analyzePage as analyzeContent, analyzeBatch as analyzeContentBatch } from './content-quality.js';
export { auditResourceHints } from './resource-hints.js';
export { checkMixedContent } from './mixed-content.js';
export { auditCompression } from './compression.js';
export { auditCacheHeaders } from './cache-headers.js';
export { auditCookieBanner } from './cookie-banner.js';
export { auditThirdParty } from './third-party.js';
export { analyzeBundles } from './bundle-size.js';
export { checkOpenGraph } from './open-graph.js';
export { auditRobots } from './robots-audit.js';
export { auditImages } from './image-audit.js';
export { auditWebfonts } from './webfonts.js';
export { auditMotionPrefs } from './motion-prefs.js';
export { auditServiceWorker } from './service-worker.js';
export { collectRUM, rumClientScript } from './rum.js';
export { validateAmp } from './amp.js';
export { retryWithFlakeDetection, classifyFlakeRate, defaultIsTransient } from './flaky.js';
export { runGraphQLFlow } from './graphql.js';
export { runWebSocketFlow } from './websocket.js';
export { waitForEmail, extractLinks as extractEmailLinks, extractCode as extractEmailCode } from './mailbox.js';
export { parseFeature, featureToFlows, builtinSteps } from './bdd.js';
export { emitGitHubAnnotations, writeSummary as writeGitHubSummary } from './github-annotations.js';
export { auditJsCoverage } from './js-coverage.js';
export { auditCssCoverage } from './css-coverage.js';
export { auditDomSize } from './dom-audit.js';
export { auditAria } from './aria-audit.js';
export { auditHeadings } from './heading-hierarchy.js';
export { auditLang } from './lang-audit.js';
export { auditProtocols } from './protocol-audit.js';
export { auditFontLoading } from './font-loading.js';
export { auditPrerender } from './prerender-audit.js';
export { auditHeadlessDetect } from './headless-detect.js';
export { auditAnimations } from './animation-audit.js';
export { auditEventListeners } from './event-listener-audit.js';
export { runOpenApiContract } from './contract-openapi.js';
export { compareInspect } from './ab-compare.js';
export { runWatchMode } from './watch-mode.js';
export { postWebhookReport } from './webhook-reporter.js';
export { auditDarkMode } from './dark-mode-audit.js';
export { auditTables } from './table-audit.js';
export { auditSvgs } from './svg-audit.js';
export { auditMedia } from './media-audit.js';
export { auditReadingLevel } from './reading-level.js';
export { detectDeadImages } from './dead-images.js';
export { auditPagination } from './pagination-audit.js';
export { auditPrint } from './print-audit.js';
export { auditCanonical } from './canonical-audit.js';
export { compareSsim, ssimFromBuffers } from './visual-ssim.js';
export { resolveMaskRegions, takeMaskedScreenshot, applyMaskToPng, screenshotWithPlaywrightMask } from './visual-mask.js';
export { setCpuThrottling, clearCpuThrottling, applyCpuPreset, measureUnderThrottle } from './cpu-throttle.js';
export { listStories, captureStorybook } from './storybook.js';
export { triageFailure, triageBatch, TRIAGE_RULES } from './ai-triage.js';
export { generateFlow, scanInteractions, flowToSnippet } from './ai-codegen.js';
export { loadDriftDb, saveDriftDb, recordRun, shouldAutoApprove, detectRegression } from './baseline-drift.js';
export { generateAutoFixes, autoFixesToMarkdown } from './autofix.js';
export { toSlackBlocks, postSlackBlocks } from './slack-formatter.js';
export { toDiscordEmbed, postDiscordEmbed } from './discord-formatter.js';
export { toTeamsCard, postTeamsCard } from './teams-formatter.js';
export { runChaos } from './chaos.js';
export { runCrossBrowser, renderCrossBrowserHtml } from './cross-browser.js';
export { convertCodegen, convertCodegenFile, flowToPlaywrightSnippet } from './codegen-converter.js';
export { installPrecommit, uninstallPrecommit, generateHookScript } from './precommit.js';
export { runInitWizard, generateConfigFile, generateWorkflowFile } from './init-wizard.js';
export { runWorkerRuntime, extractMeta, extractAssets } from './worker-runtime.js';
export { extractMetrics, toPrometheusText, toOtlpJson, pushOtlp } from './metrics-exporter.js';
export { generateConfigSchema, writeSchemaFile } from './json-schema.js';
export { parseShardArg, shardFlows, shardConfig, shardSummary } from './shard.js';
export { diffReports, formatDiff, loadReport, diffReportFiles } from './budget-diff.js';
export { loadHistory, renderHistoryHtml, writeHistoryHtml } from './history-timeline.js';
export { toPrComment, renderGithubComment, renderGitlabComment, renderBitbucketComment } from './pr-comment.js';
export { flowsToCsv, a11yToCsv, perfToCsv, visualToCsv, linksToCsv, consoleErrorsToCsv, summaryToCsv, writeAllCsvs } from './csv-exporter.js';
export { parseAssertion, resolveMetric, evaluateAssertions, formatAssertionFailures } from './assertions.js';
export { detectFlakiness, formatFlakyReport } from './flaky-detector.js';
export { renderBadge, statusBadge, a11yBadge, perfBadge, lcpBadge, visualBadge, writeBadges } from './badge.js';
export { fetchSitemapUrls, urlsToFlows, sitemapToFlows } from './sitemap-flows.js';
export { bisect, defaultRegressionOracle } from './bisect.js';
export { runFilteredA11y, filterViolationsByImpact, WCAG_TAG_GROUPS } from './a11y-filter.js';
export { ReporterRegistry, defaultReporterRegistry, runReporters, loadReporterFromPath, jsonFileReporter } from './reporter-plugin.js';
export { scanPageObject, renderPageObjectClass, generatePageObject } from './page-object.js';
export { retry, retryWithStats, computeBackoff } from './retry.js';
export { parseCron, nextFireTime, runSchedule } from './schedule.js';
export { loadBudgetFile, validateBudgetFile, applyBudget, mergeBudgets, discoverBudgetFile } from './budget-file.js';
export { auditInp } from './inp-audit.js';
export { auditLcpElement } from './lcp-element.js';
export { auditClsCulprit } from './cls-culprit.js';
export { auditHreflang } from './hreflang-audit.js';
export { auditCookieFlags } from './cookie-flags-audit.js';
export { auditFocusTrap } from './focus-trap-audit.js';
export { auditFavicons } from './favicon-audit.js';
export { auditClickjacking } from './clickjacking-audit.js';
export { extractCriticalCss } from './critical-css.js';
export { scanSourceMaps } from './sourcemap-scan.js';
export { scanSecrets } from './secret-scan.js';
export { sniffTrackers } from './tracker-sniff.js';
export { auditZIndex } from './zindex-audit.js';
export { auditHydration } from './hydration-audit.js';
export { auditStorage } from './storage-audit.js';
export { auditCsrf } from './csrf-audit.js';
export { auditErrorPages } from './error-page-audit.js';
export { parseHar, renderWaterfallHtml, writeWaterfallHtml } from './har-waterfall.js';
export { detectOrphanAssets } from './orphan-assets.js';
export { auditSri } from './sri-audit.js';
export { auditWebWorkers } from './web-worker-audit.js';

export async function inspect(config: InspectConfig): Promise<InspectResult> {
  const startedAt = new Date();
  const viewports = config.viewports ?? [{ name: 'desktop', width: 1280, height: 800 }];
  const checks = config.checks ?? { a11y: true, perf: false, visual: true, explore: false };
  const outputDir = config.output?.dir ?? './uxinspect-report';
  const baselineDir = config.output?.baselineDir ?? './uxinspect-baselines';
  const store = r2StoreFromEnv();
  const flows = config.flows ?? [{ name: 'load', steps: [{ goto: config.url }] }];

  const driver = new Driver();
  const flowResults: FlowResult[] = [];
  const a11yResults: A11yResult[] = [];
  const perfResults: PerfResult[] = [];
  const visualResults: VisualResult[] = [];
  const seoResults: InspectResult['seo'] = [];
  const linkResults: InspectResult['links'] = [];
  const pwaResults: InspectResult['pwa'] = [];
  const retireResults: RetireResult[] = [];
  const deadClickResults: DeadClickResult[] = [];
  const touchTargetResults: TouchTargetResult[] = [];
  const keyboardResults: KeyboardAuditResult[] = [];
  const longTasksResults: LongTasksResult[] = [];
  const clsTimelineResults: CLSTimelineResult[] = [];
  const formsResults: FormsAuditResult[] = [];
  const structuredDataResults: StructuredDataResult[] = [];
  const passiveSecurityResults: PassiveSecurityResult[] = [];
  const consoleErrorResults: ConsoleCapture[] = [];
  const pageContentInfos: PageContentInfo[] = [];
  const resourceHintsResults: ResourceHintsResult[] = [];
  const mixedContentResults: MixedContentResult[] = [];
  const cacheHeadersResults: CacheHeadersResult[] = [];
  const cookieBannerResults: CookieBannerResult[] = [];
  const thirdPartyResults: ThirdPartyResult[] = [];
  const bundleSizeResults: BundleSizeResult[] = [];
  const openGraphResults: OpenGraphResult[] = [];
  const imageAuditResults: ImageAuditResult[] = [];
  const webfontsResults: WebfontsResult[] = [];
  const motionPrefsResults: MotionPrefsResult[] = [];
  const serviceWorkerResults: ServiceWorkerResult[] = [];
  const rumResults: RUMResult[] = [];
  const ampResults: AmpResult[] = [];
  const jsCoverageResults: JsCoverageResult[] = [];
  const cssCoverageResults: CssCoverageResult[] = [];
  const domSizeResults: DomAuditResult[] = [];
  const ariaAuditResults: AriaAuditResult[] = [];
  const headingsResults: HeadingHierarchyResult[] = [];
  const langAuditResults: LangAuditResult[] = [];
  const protocolsResults: ProtocolAuditResult[] = [];
  const fontLoadingResults: FontLoadingResult[] = [];
  const prerenderAuditResults: PrerenderAuditResult[] = [];
  const headlessDetectResults: HeadlessDetectResult[] = [];
  const animationsResults: AnimationAuditResult[] = [];
  const eventListenersResults: EventListenerAuditResult[] = [];
  const darkModeResults: DarkModeResult[] = [];
  const tablesResults: TableAuditResult[] = [];
  const svgsResults: SvgAuditResult[] = [];
  const mediaResults: MediaAuditResult[] = [];
  const readingLevelResults: ReadingLevelResult[] = [];
  const deadImagesResults: DeadImageResult[] = [];
  const paginationResults: PaginationResult[] = [];
  const printResults: PrintAuditResult[] = [];
  const canonicalResults: CanonicalAuditResult[] = [];
  const sriResults: SriAuditResult[] = [];
  const webWorkersResults: WebWorkerAuditResult[] = [];
  const orphanAssetsResults: OrphanAssetResult[] = [];
  const inpResults: InpAuditResult[] = [];
  const lcpElementResults: LcpElementResult[] = [];
  const clsCulpritResults: ClsCulpritResult[] = [];
  const hreflangResults: HreflangAuditResult[] = [];
  const cookieFlagsResults: CookieFlagsResult[] = [];
  const focusTrapResults: FocusTrapResult[] = [];
  const faviconResults: FaviconAuditResult[] = [];
  const clickjackingResults: ClickjackingResult[] = [];
  const criticalCssResults: CriticalCssResult[] = [];
  const sourcemapScanResults: SourceMapScanResult[] = [];
  const secretScanResults: SecretScanResult[] = [];
  const trackerSniffResults: TrackerSniffResult[] = [];
  const zIndexResults: ZIndexAuditResult[] = [];
  const hydrationResults: HydrationAuditResult[] = [];
  const storageResults: StorageAuditResult[] = [];
  const csrfResults: CsrfAuditResult[] = [];
  const errorPagesResults: ErrorPageAuditResult[] = [];
  let securityResult: InspectResult['security'];
  let exploreResult: InspectResult['explore'];

  try {
    for (const vp of viewports) {
      await driver.launch({
        viewport: { width: vp.width, height: vp.height },
        headless: !config.headed && !config.debug,
        storageState: config.storageState,
        browser: config.browser,
        device: config.device,
        locale: config.locale,
        timezoneId: config.timezoneId,
        geolocation: config.geolocation,
        throttle: config.network ? networkPresets[config.network] : undefined,
        recordVideo: config.video ? path.join(outputDir, 'video') : undefined,
        recordHar: config.har ? path.join(outputDir, 'trace.har') : undefined,
        trace: config.trace ? path.join(outputDir, 'trace.zip') : undefined,
        slowMo: config.slowMo ?? (config.debug ? 500 : undefined),
        mocks: config.mocks,
      });
      const ai = new AIHelper({
        model: config.ai?.model,
        cachePath: path.join(outputDir, 'ai-cache.json'),
      });

      const runOne = async (flow: { name: string; steps: Step[] }): Promise<{
        flow: FlowResult;
        a11y?: A11yResult;
        visual?: VisualResult;
        seo?: InspectResult['seo'] extends Array<infer T> | undefined ? T : never;
        links?: InspectResult['links'] extends Array<infer T> | undefined ? T : never;
        pwa?: InspectResult['pwa'] extends Array<infer T> | undefined ? T : never;
        retire?: RetireResult;
        deadClicks?: DeadClickResult;
        touchTargets?: TouchTargetResult;
        keyboard?: KeyboardAuditResult;
        longTasks?: LongTasksResult;
        clsTimeline?: CLSTimelineResult;
        forms?: FormsAuditResult;
        structuredData?: StructuredDataResult;
        passiveSecurity?: PassiveSecurityResult;
        consoleErrors?: ConsoleCapture;
        contentInfo?: PageContentInfo;
        resourceHints?: ResourceHintsResult;
        mixedContent?: MixedContentResult;
        cacheHeaders?: CacheHeadersResult;
        cookieBanner?: CookieBannerResult;
        thirdParty?: ThirdPartyResult;
        bundleSize?: BundleSizeResult;
        openGraph?: OpenGraphResult;
        imageAudit?: ImageAuditResult;
        webfonts?: WebfontsResult;
        motionPrefs?: MotionPrefsResult;
        serviceWorker?: ServiceWorkerResult;
        rum?: RUMResult;
        amp?: AmpResult;
        jsCoverage?: JsCoverageResult;
        cssCoverage?: CssCoverageResult;
        domSize?: DomAuditResult;
        ariaAudit?: AriaAuditResult;
        headings?: HeadingHierarchyResult;
        langAudit?: LangAuditResult;
        protocols?: ProtocolAuditResult;
        fontLoading?: FontLoadingResult;
        prerenderAudit?: PrerenderAuditResult;
        headlessDetect?: HeadlessDetectResult;
        animations?: AnimationAuditResult;
        eventListeners?: EventListenerAuditResult;
        darkMode?: DarkModeResult;
        tables?: TableAuditResult;
        svgs?: SvgAuditResult;
        media?: MediaAuditResult;
        readingLevel?: ReadingLevelResult;
        deadImages?: DeadImageResult;
        pagination?: PaginationResult;
        print?: PrintAuditResult;
        canonical?: CanonicalAuditResult;
        sri?: SriAuditResult;
        webWorkers?: WebWorkerAuditResult;
        orphanAssets?: OrphanAssetResult;
        inp?: InpAuditResult;
        lcpElement?: LcpElementResult;
        clsCulprit?: ClsCulpritResult;
        hreflang?: HreflangAuditResult;
        cookieFlags?: CookieFlagsResult;
        focusTrap?: FocusTrapResult;
        favicon?: FaviconAuditResult;
        clickjacking?: ClickjackingResult;
        criticalCss?: CriticalCssResult;
        sourcemapScan?: SourceMapScanResult;
        secretScan?: SecretScanResult;
        trackerSniff?: TrackerSniffResult;
        zIndex?: ZIndexAuditResult;
        hydration?: HydrationAuditResult;
        storage?: StorageAuditResult;
        csrf?: CsrfAuditResult;
        errorPages?: ErrorPageAuditResult;
      }> => {
        const page = await driver.newPage();
        const console = checks.consoleErrors ? attachConsoleCapture(page) : null;
        if (config.ai?.enabled) await ai.init(page);
        const flowResult = await runFlow(page, flow.name, flow.steps, ai);
        const a11y = checks.a11y ? await checkA11y(page).catch((e) => emptyA11y(page.url(), e)) : undefined;
        if (a11y && a11y.violations.length > 0) {
          await annotateA11y(page, a11y, path.join(outputDir, 'a11y', `${flow.name}-${vp.name}.png`)).catch(() => {});
        }
        const visual = checks.visual
          ? await checkVisual(page, flow.name, vp.name, { baselineDir, outputDir, store: store ?? undefined }).catch((e) => emptyVisual(page.url(), vp.name, e))
          : undefined;
        const seoR = checks.seo ? await checkSeo(page).catch(() => undefined) : undefined;
        const linksR = checks.links
          ? await checkLinks(page, typeof checks.links === 'object' ? checks.links : {}).catch(() => undefined)
          : undefined;
        const pwaR = checks.pwa ? await checkPwa(page).catch(() => undefined) : undefined;
        const retireR = checks.retire ? await checkRetireJs(page).catch(() => undefined) : undefined;
        const touchR = checks.touchTargets
          ? await auditTouchTargets(page, typeof checks.touchTargets === 'object' ? checks.touchTargets : {}).catch(() => undefined)
          : undefined;
        const keyboardR = checks.keyboard
          ? await auditKeyboard(page, typeof checks.keyboard === 'object' ? checks.keyboard : {}).catch(() => undefined)
          : undefined;
        const longTasksR = checks.longTasks
          ? await captureLongTasks(page, typeof checks.longTasks === 'object' ? checks.longTasks.durationMs : undefined).catch(() => undefined)
          : undefined;
        const clsR = checks.clsTimeline
          ? await captureClsTimeline(page, typeof checks.clsTimeline === 'object' ? checks.clsTimeline.durationMs : undefined).catch(() => undefined)
          : undefined;
        const formsR = checks.forms ? await auditForms(page).catch(() => undefined) : undefined;
        const structuredR = checks.structuredData ? await checkStructuredData(page).catch(() => undefined) : undefined;
        const passiveSecR = checks.passiveSecurity ? await auditPassiveSecurity(page).catch(() => undefined) : undefined;
        const contentR = checks.contentQuality
          ? await analyzeContent(page, typeof checks.contentQuality === 'object' ? checks.contentQuality : {}).catch(() => undefined)
          : undefined;
        const deadR = checks.deadClicks
          ? await checkDeadClicks(page, typeof checks.deadClicks === 'object' ? checks.deadClicks : {}).catch(() => undefined)
          : undefined;
        const resourceHintsR = checks.resourceHints ? await auditResourceHints(page).catch(() => undefined) : undefined;
        const mixedContentR = checks.mixedContent ? await checkMixedContent(page).catch(() => undefined) : undefined;
        const cacheHeadersR = checks.cacheHeaders ? await auditCacheHeaders(page).catch(() => undefined) : undefined;
        const cookieBannerR = checks.cookieBanner ? await auditCookieBanner(page).catch(() => undefined) : undefined;
        const thirdPartyR = checks.thirdParty ? await auditThirdParty(page).catch(() => undefined) : undefined;
        const bundleSizeR = checks.bundleSize ? await analyzeBundles(page).catch(() => undefined) : undefined;
        const openGraphR = checks.openGraph ? await checkOpenGraph(page).catch(() => undefined) : undefined;
        const imageAuditR = checks.imageAudit ? await auditImages(page).catch(() => undefined) : undefined;
        const webfontsR = checks.webfonts ? await auditWebfonts(page).catch(() => undefined) : undefined;
        const motionPrefsR = checks.motionPrefs ? await auditMotionPrefs(page).catch(() => undefined) : undefined;
        const swR = checks.serviceWorker ? await auditServiceWorker(page).catch(() => undefined) : undefined;
        const rumR = checks.rum
          ? await collectRUM(page, typeof checks.rum === 'object' ? checks.rum : {}).catch(() => undefined)
          : undefined;
        const ampR = checks.amp ? await validateAmp(page).catch(() => undefined) : undefined;
        const jsCovR = checks.jsCoverage
          ? await auditJsCoverage(page, typeof checks.jsCoverage === 'object' ? checks.jsCoverage : {}).catch(() => undefined)
          : undefined;
        const cssCovR = checks.cssCoverage
          ? await auditCssCoverage(page, typeof checks.cssCoverage === 'object' ? checks.cssCoverage : {}).catch(() => undefined)
          : undefined;
        const domSizeR = checks.domSize
          ? await auditDomSize(page, typeof checks.domSize === 'object' ? checks.domSize : {}).catch(() => undefined)
          : undefined;
        const ariaR = checks.ariaAudit ? await auditAria(page).catch(() => undefined) : undefined;
        const headingsR = checks.headings ? await auditHeadings(page).catch(() => undefined) : undefined;
        const langR = checks.langAudit ? await auditLang(page).catch(() => undefined) : undefined;
        const protocolsR = checks.protocols ? await auditProtocols(page).catch(() => undefined) : undefined;
        const fontLoadR = checks.fontLoading ? await auditFontLoading(page).catch(() => undefined) : undefined;
        const prerenderR = checks.prerenderAudit ? await auditPrerender(page).catch(() => undefined) : undefined;
        const headlessR = checks.headlessDetect ? await auditHeadlessDetect(page).catch(() => undefined) : undefined;
        const animationsR = checks.animations ? await auditAnimations(page).catch(() => undefined) : undefined;
        const eventListenersR = checks.eventListeners ? await auditEventListeners(page).catch(() => undefined) : undefined;
        const darkModeR = checks.darkMode
          ? await auditDarkMode(page, typeof checks.darkMode === 'object' ? checks.darkMode : {}).catch(() => undefined)
          : undefined;
        const tablesR = checks.tables ? await auditTables(page).catch(() => undefined) : undefined;
        const svgsR = checks.svgs ? await auditSvgs(page).catch(() => undefined) : undefined;
        const mediaR = checks.media ? await auditMedia(page).catch(() => undefined) : undefined;
        const readingLevelR = checks.readingLevel
          ? await auditReadingLevel(page, typeof checks.readingLevel === 'object' ? checks.readingLevel : {}).catch(() => undefined)
          : undefined;
        const deadImagesR = checks.deadImages ? await detectDeadImages(page).catch(() => undefined) : undefined;
        const paginationR = checks.pagination
          ? await auditPagination(page, typeof checks.pagination === 'object' ? checks.pagination : {}).catch(() => undefined)
          : undefined;
        const printR = checks.print
          ? await auditPrint(page, typeof checks.print === 'object' ? checks.print : {}).catch(() => undefined)
          : undefined;
        const canonicalR = checks.canonical
          ? await auditCanonical(page, typeof checks.canonical === 'object' ? checks.canonical : {}).catch(() => undefined)
          : undefined;
        const sriR = checks.sri ? await auditSri(page).catch(() => undefined) : undefined;
        const webWorkersR = checks.webWorkers ? await auditWebWorkers(page).catch(() => undefined) : undefined;
        const orphanAssetsR = checks.orphanAssets ? await detectOrphanAssets(page).catch(() => undefined) : undefined;
        const inpR = checks.inp
          ? await auditInp(page, typeof checks.inp === 'object' ? checks.inp : {}).catch(() => undefined)
          : undefined;
        const lcpElementR = checks.lcpElement ? await auditLcpElement(page).catch(() => undefined) : undefined;
        const clsCulpritR = checks.clsCulprit
          ? await auditClsCulprit(page, typeof checks.clsCulprit === 'object' ? checks.clsCulprit : {}).catch(() => undefined)
          : undefined;
        const hreflangR = checks.hreflang ? await auditHreflang(page).catch(() => undefined) : undefined;
        const cookieFlagsR = checks.cookieFlags ? await auditCookieFlags(page, page.context()).catch(() => undefined) : undefined;
        const focusTrapR = checks.focusTrap ? await auditFocusTrap(page).catch(() => undefined) : undefined;
        const faviconR = checks.favicon ? await auditFavicons(page).catch(() => undefined) : undefined;
        const clickjackingR = checks.clickjacking ? await auditClickjacking(page, page.context()).catch(() => undefined) : undefined;
        const criticalCssR = checks.criticalCss ? await extractCriticalCss(page).catch(() => undefined) : undefined;
        const sourcemapScanR = checks.sourcemapScan ? await scanSourceMaps(page).catch(() => undefined) : undefined;
        const secretScanR = checks.secretScan ? await scanSecrets(page).catch(() => undefined) : undefined;
        const trackerSniffR = checks.trackerSniff ? await sniffTrackers(page).catch(() => undefined) : undefined;
        const zIndexR = checks.zIndex ? await auditZIndex(page).catch(() => undefined) : undefined;
        const hydrationR = checks.hydration ? await auditHydration(page).catch(() => undefined) : undefined;
        const storageR = checks.storage ? await auditStorage(page).catch(() => undefined) : undefined;
        const csrfR = checks.csrf ? await auditCsrf(page, page.context()).catch(() => undefined) : undefined;
        const errorPagesR = checks.errorPages ? await auditErrorPages(page.context(), config.url).catch(() => undefined) : undefined;
        const consoleR = console ? console.result() : undefined;
        if (console) console.detach();
        if (!config.parallel) await page.close();
        return {
          flow: flowResult, a11y, visual,
          seo: seoR as any, links: linksR as any, pwa: pwaR as any,
          retire: retireR, deadClicks: deadR, touchTargets: touchR, keyboard: keyboardR,
          longTasks: longTasksR, clsTimeline: clsR, forms: formsR,
          structuredData: structuredR, passiveSecurity: passiveSecR, consoleErrors: consoleR,
          contentInfo: contentR,
          resourceHints: resourceHintsR, mixedContent: mixedContentR,
          cacheHeaders: cacheHeadersR, cookieBanner: cookieBannerR,
          thirdParty: thirdPartyR, bundleSize: bundleSizeR,
          openGraph: openGraphR, imageAudit: imageAuditR,
          webfonts: webfontsR, motionPrefs: motionPrefsR,
          serviceWorker: swR, rum: rumR, amp: ampR,
          jsCoverage: jsCovR, cssCoverage: cssCovR, domSize: domSizeR,
          ariaAudit: ariaR, headings: headingsR, langAudit: langR,
          protocols: protocolsR, fontLoading: fontLoadR,
          prerenderAudit: prerenderR, headlessDetect: headlessR,
          animations: animationsR, eventListeners: eventListenersR,
          darkMode: darkModeR, tables: tablesR, svgs: svgsR, media: mediaR,
          readingLevel: readingLevelR, deadImages: deadImagesR,
          pagination: paginationR, print: printR, canonical: canonicalR,
          sri: sriR, webWorkers: webWorkersR, orphanAssets: orphanAssetsR,
          inp: inpR, lcpElement: lcpElementR, clsCulprit: clsCulpritR,
          hreflang: hreflangR, cookieFlags: cookieFlagsR, focusTrap: focusTrapR,
          favicon: faviconR, clickjacking: clickjackingR, criticalCss: criticalCssR,
          sourcemapScan: sourcemapScanR, secretScan: secretScanR, trackerSniff: trackerSniffR,
          zIndex: zIndexR, hydration: hydrationR, storage: storageR,
          csrf: csrfR, errorPages: errorPagesR,
        };
      };

      const results = config.parallel ? await Promise.all(flows.map(runOne)) : [];
      if (!config.parallel) for (const flow of flows) results.push(await runOne(flow));
      for (const r of results) {
        flowResults.push(r.flow);
        if (r.a11y) a11yResults.push(r.a11y);
        if (r.visual) visualResults.push(r.visual);
        if (r.seo) seoResults!.push(r.seo as any);
        if (r.links) linkResults!.push(r.links as any);
        if (r.pwa) pwaResults!.push(r.pwa as any);
        if (r.retire) retireResults.push(r.retire);
        if (r.deadClicks) deadClickResults.push(r.deadClicks);
        if (r.touchTargets) touchTargetResults.push(r.touchTargets);
        if (r.keyboard) keyboardResults.push(r.keyboard);
        if (r.longTasks) longTasksResults.push(r.longTasks);
        if (r.clsTimeline) clsTimelineResults.push(r.clsTimeline);
        if (r.forms) formsResults.push(r.forms);
        if (r.structuredData) structuredDataResults.push(r.structuredData);
        if (r.passiveSecurity) passiveSecurityResults.push(r.passiveSecurity);
        if (r.consoleErrors) consoleErrorResults.push(r.consoleErrors);
        if (r.contentInfo) pageContentInfos.push(r.contentInfo);
        if (r.resourceHints) resourceHintsResults.push(r.resourceHints);
        if (r.mixedContent) mixedContentResults.push(r.mixedContent);
        if (r.cacheHeaders) cacheHeadersResults.push(r.cacheHeaders);
        if (r.cookieBanner) cookieBannerResults.push(r.cookieBanner);
        if (r.thirdParty) thirdPartyResults.push(r.thirdParty);
        if (r.bundleSize) bundleSizeResults.push(r.bundleSize);
        if (r.openGraph) openGraphResults.push(r.openGraph);
        if (r.imageAudit) imageAuditResults.push(r.imageAudit);
        if (r.webfonts) webfontsResults.push(r.webfonts);
        if (r.motionPrefs) motionPrefsResults.push(r.motionPrefs);
        if (r.serviceWorker) serviceWorkerResults.push(r.serviceWorker);
        if (r.rum) rumResults.push(r.rum);
        if (r.amp) ampResults.push(r.amp);
        if (r.jsCoverage) jsCoverageResults.push(r.jsCoverage);
        if (r.cssCoverage) cssCoverageResults.push(r.cssCoverage);
        if (r.domSize) domSizeResults.push(r.domSize);
        if (r.ariaAudit) ariaAuditResults.push(r.ariaAudit);
        if (r.headings) headingsResults.push(r.headings);
        if (r.langAudit) langAuditResults.push(r.langAudit);
        if (r.protocols) protocolsResults.push(r.protocols);
        if (r.fontLoading) fontLoadingResults.push(r.fontLoading);
        if (r.prerenderAudit) prerenderAuditResults.push(r.prerenderAudit);
        if (r.headlessDetect) headlessDetectResults.push(r.headlessDetect);
        if (r.animations) animationsResults.push(r.animations);
        if (r.eventListeners) eventListenersResults.push(r.eventListeners);
        if (r.darkMode) darkModeResults.push(r.darkMode);
        if (r.tables) tablesResults.push(r.tables);
        if (r.svgs) svgsResults.push(r.svgs);
        if (r.media) mediaResults.push(r.media);
        if (r.readingLevel) readingLevelResults.push(r.readingLevel);
        if (r.deadImages) deadImagesResults.push(r.deadImages);
        if (r.pagination) paginationResults.push(r.pagination);
        if (r.print) printResults.push(r.print);
        if (r.canonical) canonicalResults.push(r.canonical);
        if (r.sri) sriResults.push(r.sri);
        if (r.webWorkers) webWorkersResults.push(r.webWorkers);
        if (r.orphanAssets) orphanAssetsResults.push(r.orphanAssets);
        if (r.inp) inpResults.push(r.inp);
        if (r.lcpElement) lcpElementResults.push(r.lcpElement);
        if (r.clsCulprit) clsCulpritResults.push(r.clsCulprit);
        if (r.hreflang) hreflangResults.push(r.hreflang);
        if (r.cookieFlags) cookieFlagsResults.push(r.cookieFlags);
        if (r.focusTrap) focusTrapResults.push(r.focusTrap);
        if (r.favicon) faviconResults.push(r.favicon);
        if (r.clickjacking) clickjackingResults.push(r.clickjacking);
        if (r.criticalCss) criticalCssResults.push(r.criticalCss);
        if (r.sourcemapScan) sourcemapScanResults.push(r.sourcemapScan);
        if (r.secretScan) secretScanResults.push(r.secretScan);
        if (r.trackerSniff) trackerSniffResults.push(r.trackerSniff);
        if (r.zIndex) zIndexResults.push(r.zIndex);
        if (r.hydration) hydrationResults.push(r.hydration);
        if (r.storage) storageResults.push(r.storage);
        if (r.csrf) csrfResults.push(r.csrf);
        if (r.errorPages) errorPagesResults.push(r.errorPages);
      }

      if (checks.perf) {
        const port = driver.cdpPort;
        if (port) {
          perfResults.push(await checkPerf(config.url, port).catch((e) => emptyPerf(config.url, e)));
        } else {
          perfResults.push(emptyPerf(config.url, new Error('no CDP port available')));
        }
      }

      if (checks.explore) {
        const opts = typeof checks.explore === 'object' ? checks.explore : {};
        const ePage = await driver.newPage();
        await ePage.goto(config.url);
        exploreResult = await explore(ePage, opts);
        await ePage.close();
      }

      if (checks.security) {
        securityResult = await checkSecurityHeaders(config.url).catch(() => undefined);
      }

      await ai.close();
      await driver.close();
    }
  } finally {
    await driver.close();
  }

  let sitemapResult: InspectResult['sitemap'];
  let redirectsResult: InspectResult['redirects'];
  let tlsResult: InspectResult['tls'];
  let exposedPathsResult: InspectResult['exposedPaths'];
  let crawlResult: InspectResult['crawl'];
  let contentQualityResult: InspectResult['contentQuality'];

  if (checks.sitemap) {
    sitemapResult = await auditSitemap(config.url, typeof checks.sitemap === 'object' ? checks.sitemap : {}).catch(() => undefined);
  }
  if (checks.redirects) {
    redirectsResult = await auditRedirects(config.url, typeof checks.redirects === 'object' ? checks.redirects : {}).catch(() => undefined);
  }
  if (checks.tls) {
    tlsResult = await auditTls(config.url).catch(() => undefined);
  }
  if (checks.exposedPaths) {
    exposedPathsResult = await scanExposedPaths(config.url, typeof checks.exposedPaths === 'object' ? checks.exposedPaths : {}).catch(() => undefined);
  }
  if (checks.crawl) {
    crawlResult = await crawlSite(config.url, typeof checks.crawl === 'object' ? checks.crawl : {}).catch(() => undefined);
  }
  if (checks.contentQuality && pageContentInfos.length) {
    contentQualityResult = analyzeContentBatch(pageContentInfos, typeof checks.contentQuality === 'object' ? checks.contentQuality : {});
  }

  let compressionResult: InspectResult['compression'];
  let robotsAuditResult: InspectResult['robotsAudit'];
  if (checks.compression) {
    compressionResult = await auditCompression(config.url).catch(() => undefined);
  }
  if (checks.robotsAudit) {
    robotsAuditResult = await auditRobots(config.url).catch(() => undefined);
  }

  const finishedAt = new Date();
  const baselinePassed =
    flowResults.every((f) => f.passed) &&
    a11yResults.every((a) => a.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious').length === 0) &&
    visualResults.every((v) => v.passed) &&
    (!checks.links || (linkResults ?? []).every((l) => l.passed)) &&
    (!checks.security || securityResult?.passed !== false) &&
    retireResults.every((r) => (r as any).passed !== false) &&
    deadClickResults.every((r) => (r as any).passed !== false) &&
    touchTargetResults.every((r) => (r as any).passed !== false) &&
    keyboardResults.every((r) => (r as any).passed !== false) &&
    longTasksResults.every((r) => (r as any).passed !== false) &&
    clsTimelineResults.every((r) => (r as any).passed !== false) &&
    formsResults.every((r) => (r as any).passed !== false) &&
    structuredDataResults.every((r) => (r as any).passed !== false) &&
    passiveSecurityResults.every((r) => (r as any).passed !== false) &&
    consoleErrorResults.every((r) => (r as any).passed !== false) &&
    (sitemapResult === undefined || (sitemapResult as any).passed !== false) &&
    (redirectsResult === undefined || (redirectsResult as any).passed !== false) &&
    (tlsResult === undefined || (tlsResult as any).passed !== false) &&
    (exposedPathsResult === undefined || (exposedPathsResult as any).passed !== false) &&
    (crawlResult === undefined || (crawlResult as any).passed !== false) &&
    (contentQualityResult === undefined || (contentQualityResult as any).passed !== false) &&
    resourceHintsResults.every((r) => (r as any).passed !== false) &&
    mixedContentResults.every((r) => (r as any).passed !== false) &&
    cacheHeadersResults.every((r) => (r as any).passed !== false) &&
    cookieBannerResults.every((r) => (r as any).passed !== false) &&
    thirdPartyResults.every((r) => (r as any).passed !== false) &&
    bundleSizeResults.every((r) => (r as any).passed !== false) &&
    openGraphResults.every((r) => (r as any).passed !== false) &&
    imageAuditResults.every((r) => (r as any).passed !== false) &&
    webfontsResults.every((r) => (r as any).passed !== false) &&
    motionPrefsResults.every((r) => (r as any).passed !== false) &&
    serviceWorkerResults.every((r) => (r as any).passed !== false) &&
    rumResults.every((r) => (r as any).passed !== false) &&
    ampResults.every((r) => (r as any).passed !== false) &&
    jsCoverageResults.every((r) => (r as any).passed !== false) &&
    cssCoverageResults.every((r) => (r as any).passed !== false) &&
    domSizeResults.every((r) => (r as any).passed !== false) &&
    ariaAuditResults.every((r) => (r as any).passed !== false) &&
    headingsResults.every((r) => (r as any).passed !== false) &&
    langAuditResults.every((r) => (r as any).passed !== false) &&
    protocolsResults.every((r) => (r as any).passed !== false) &&
    fontLoadingResults.every((r) => (r as any).passed !== false) &&
    prerenderAuditResults.every((r) => (r as any).passed !== false) &&
    headlessDetectResults.every((r) => (r as any).passed !== false) &&
    animationsResults.every((r) => (r as any).passed !== false) &&
    eventListenersResults.every((r) => (r as any).passed !== false) &&
    darkModeResults.every((r) => (r as any).passed !== false) &&
    tablesResults.every((r) => (r as any).passed !== false) &&
    svgsResults.every((r) => (r as any).passed !== false) &&
    mediaResults.every((r) => (r as any).passed !== false) &&
    readingLevelResults.every((r) => (r as any).passed !== false) &&
    deadImagesResults.every((r) => (r as any).passed !== false) &&
    paginationResults.every((r) => (r as any).passed !== false) &&
    printResults.every((r) => (r as any).passed !== false) &&
    canonicalResults.every((r) => (r as any).passed !== false) &&
    (compressionResult === undefined || (compressionResult as any).passed !== false) &&
    (robotsAuditResult === undefined || (robotsAuditResult as any).passed !== false);

  const result: InspectResult = {
    url: config.url,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    flows: flowResults,
    a11y: checks.a11y ? a11yResults : undefined,
    perf: checks.perf ? perfResults : undefined,
    visual: checks.visual ? visualResults : undefined,
    explore: exploreResult,
    seo: checks.seo ? seoResults : undefined,
    links: checks.links ? linkResults : undefined,
    pwa: checks.pwa ? pwaResults : undefined,
    security: securityResult,
    retire: checks.retire ? retireResults : undefined,
    deadClicks: checks.deadClicks ? deadClickResults : undefined,
    touchTargets: checks.touchTargets ? touchTargetResults : undefined,
    keyboard: checks.keyboard ? keyboardResults : undefined,
    longTasks: checks.longTasks ? longTasksResults : undefined,
    clsTimeline: checks.clsTimeline ? clsTimelineResults : undefined,
    forms: checks.forms ? formsResults : undefined,
    structuredData: checks.structuredData ? structuredDataResults : undefined,
    passiveSecurity: checks.passiveSecurity ? passiveSecurityResults : undefined,
    consoleErrors: checks.consoleErrors ? consoleErrorResults : undefined,
    sitemap: sitemapResult,
    redirects: redirectsResult,
    exposedPaths: exposedPathsResult,
    tls: tlsResult,
    crawl: crawlResult,
    contentQuality: contentQualityResult,
    resourceHints: checks.resourceHints ? resourceHintsResults : undefined,
    mixedContent: checks.mixedContent ? mixedContentResults : undefined,
    compression: compressionResult,
    cacheHeaders: checks.cacheHeaders ? cacheHeadersResults : undefined,
    cookieBanner: checks.cookieBanner ? cookieBannerResults : undefined,
    thirdParty: checks.thirdParty ? thirdPartyResults : undefined,
    bundleSize: checks.bundleSize ? bundleSizeResults : undefined,
    openGraph: checks.openGraph ? openGraphResults : undefined,
    robotsAudit: robotsAuditResult,
    imageAudit: checks.imageAudit ? imageAuditResults : undefined,
    webfonts: checks.webfonts ? webfontsResults : undefined,
    motionPrefs: checks.motionPrefs ? motionPrefsResults : undefined,
    serviceWorker: checks.serviceWorker ? serviceWorkerResults : undefined,
    rum: checks.rum ? rumResults : undefined,
    amp: checks.amp ? ampResults : undefined,
    jsCoverage: checks.jsCoverage ? jsCoverageResults : undefined,
    cssCoverage: checks.cssCoverage ? cssCoverageResults : undefined,
    domSize: checks.domSize ? domSizeResults : undefined,
    ariaAudit: checks.ariaAudit ? ariaAuditResults : undefined,
    headings: checks.headings ? headingsResults : undefined,
    langAudit: checks.langAudit ? langAuditResults : undefined,
    protocols: checks.protocols ? protocolsResults : undefined,
    fontLoading: checks.fontLoading ? fontLoadingResults : undefined,
    prerenderAudit: checks.prerenderAudit ? prerenderAuditResults : undefined,
    headlessDetect: checks.headlessDetect ? headlessDetectResults : undefined,
    animations: checks.animations ? animationsResults : undefined,
    eventListeners: checks.eventListeners ? eventListenersResults : undefined,
    darkMode: checks.darkMode ? darkModeResults : undefined,
    tables: checks.tables ? tablesResults : undefined,
    svgs: checks.svgs ? svgsResults : undefined,
    media: checks.media ? mediaResults : undefined,
    readingLevel: checks.readingLevel ? readingLevelResults : undefined,
    deadImages: checks.deadImages ? deadImagesResults : undefined,
    pagination: checks.pagination ? paginationResults : undefined,
    print: checks.print ? printResults : undefined,
    canonical: checks.canonical ? canonicalResults : undefined,
    sri: checks.sri ? sriResults : undefined,
    webWorkers: checks.webWorkers ? webWorkersResults : undefined,
    orphanAssets: checks.orphanAssets ? orphanAssetsResults : undefined,
    inp: checks.inp ? inpResults : undefined,
    lcpElement: checks.lcpElement ? lcpElementResults : undefined,
    clsCulprit: checks.clsCulprit ? clsCulpritResults : undefined,
    hreflang: checks.hreflang ? hreflangResults : undefined,
    cookieFlags: checks.cookieFlags ? cookieFlagsResults : undefined,
    focusTrap: checks.focusTrap ? focusTrapResults : undefined,
    favicon: checks.favicon ? faviconResults : undefined,
    clickjacking: checks.clickjacking ? clickjackingResults : undefined,
    criticalCss: checks.criticalCss ? criticalCssResults : undefined,
    sourcemapScan: checks.sourcemapScan ? sourcemapScanResults : undefined,
    secretScan: checks.secretScan ? secretScanResults : undefined,
    trackerSniff: checks.trackerSniff ? trackerSniffResults : undefined,
    zIndex: checks.zIndex ? zIndexResults : undefined,
    hydration: checks.hydration ? hydrationResults : undefined,
    storage: checks.storage ? storageResults : undefined,
    csrf: checks.csrf ? csrfResults : undefined,
    errorPages: checks.errorPages ? errorPagesResults : undefined,
    passed: baselinePassed,
  };

  if (config.apiFlows?.length) {
    const apiResults = await runApiFlows(config.apiFlows).catch(() => []);
    result.apiFlows = apiResults;
    if (apiResults.some((r) => !r.passed)) result.passed = false;
  }

  if (config.budget) {
    const violations = checkBudget(result, config.budget);
    result.budget = violations;
    if (violations.length > 0) result.passed = false;
  }

  await writeReport(result, outputDir, config.reporters);

  if (config.notify) {
    const shouldNotify = !config.notify.onlyOnFail || !result.passed;
    if (shouldNotify) {
      await notify(result, config.notify).catch(() => {});
    }
  }

  return result;
}

async function runFlow(page: Page, name: string, steps: Step[], ai: AIHelper): Promise<FlowResult> {
  const stepResults: StepResult[] = [];
  const screenshots: string[] = [];
  let passed = true;
  let error: string | undefined;

  for (const step of steps) {
    const start = Date.now();
    try {
      await runStep(page, step, ai);
      stepResults.push({ step, passed: true, durationMs: Date.now() - start });
    } catch (e: any) {
      passed = false;
      error = e?.message ?? String(e);
      stepResults.push({ step, passed: false, durationMs: Date.now() - start, error });
      break;
    }
  }

  return { name, passed, steps: stepResults, screenshots, error };
}

async function runStep(page: Page, step: Step, ai: AIHelper): Promise<void> {
  if ('goto' in step) {
    await page.goto(step.goto, { waitUntil: 'domcontentloaded' });
  } else if ('click' in step) {
    await page.click(step.click);
  } else if ('type' in step) {
    await page.type(step.type.selector, step.type.text);
  } else if ('fill' in step) {
    await page.fill(step.fill.selector, step.fill.text);
  } else if ('waitFor' in step) {
    await page.waitForSelector(step.waitFor);
  } else if ('screenshot' in step) {
    await page.screenshot({ path: step.screenshot, fullPage: true });
  } else if ('ai' in step) {
    if (!ai.isAvailable()) throw new Error('AI step requested but AI helper not initialized');
    const ok = await ai.act(step.ai);
    if (!ok) throw new Error(`AI step failed: ${step.ai}`);
  } else if ('drag' in step) {
    await page.dragAndDrop(step.drag.from, step.drag.to);
  } else if ('upload' in step) {
    await page.setInputFiles(step.upload.selector, step.upload.files);
  } else if ('dialog' in step) {
    const d = step.dialog;
    page.once('dialog', (dlg) => {
      const accept = typeof d === 'string' ? d === 'accept' : (d.accept ?? true);
      const text = typeof d === 'object' ? d.text : undefined;
      if (accept) dlg.accept(text); else dlg.dismiss();
    });
  } else if ('scroll' in step) {
    const s = step.scroll;
    if (s.selector) await page.locator(s.selector).scrollIntoViewIfNeeded();
    else await page.evaluate(({ x, y }) => window.scrollTo(x ?? 0, y ?? 0), { x: s.x, y: s.y });
  } else if ('select' in step) {
    await page.selectOption(step.select.selector, step.select.value as any);
  } else if ('key' in step) {
    await page.keyboard.press(step.key);
  } else if ('eval' in step) {
    await page.evaluate(step.eval);
  } else if ('waitForResponse' in step) {
    const s = step.waitForResponse;
    const urlPat = typeof s === 'string' ? s : s.url;
    await page.waitForResponse((res) => {
      const matches = res.url().includes(urlPat) || new RegExp(urlPat).test(res.url());
      if (typeof s === 'object' && s.status) return matches && res.status() === s.status;
      return matches;
    });
  } else if ('waitForRequest' in step) {
    await page.waitForRequest((req) => req.url().includes(step.waitForRequest) || new RegExp(step.waitForRequest).test(req.url()));
  } else if ('hover' in step) {
    await page.hover(step.hover);
  } else if ('check' in step) {
    await page.check(step.check);
  } else if ('uncheck' in step) {
    await page.uncheck(step.uncheck);
  } else if ('focus' in step) {
    await page.focus(step.focus);
  } else if ('blur' in step) {
    await page.locator(step.blur).evaluate((el: any) => el.blur());
  } else if ('reload' in step) {
    await page.reload({ waitUntil: 'domcontentloaded' });
  } else if ('back' in step) {
    await page.goBack({ waitUntil: 'domcontentloaded' });
  } else if ('forward' in step) {
    await page.goForward({ waitUntil: 'domcontentloaded' });
  } else if ('newTab' in step) {
    const ctx = page.context();
    const p = await ctx.newPage();
    await p.goto(step.newTab, { waitUntil: 'domcontentloaded' });
  } else if ('switchTab' in step) {
    const pages = page.context().pages();
    const target = typeof step.switchTab === 'number'
      ? pages[step.switchTab]
      : pages.find((p) => p.url().includes(String(step.switchTab)));
    if (target) await target.bringToFront();
  } else if ('closeTab' in step) {
    await page.close();
  } else if ('iframe' in step) {
    const frame = page.frameLocator(step.iframe.selector);
    for (const s of step.iframe.steps) {
      await runIframeStep(frame, s);
    }
  } else if ('sleep' in step) {
    await page.waitForTimeout(step.sleep);
  } else if ('waitForDownload' in step) {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click(step.waitForDownload.trigger)]);
    await dl.saveAs(step.waitForDownload.saveAs);
  } else if ('waitForPopup' in step) {
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.click(step.waitForPopup.trigger)]);
    await popup.waitForLoadState('domcontentloaded');
    if (step.waitForPopup.switchTo) await popup.bringToFront();
  } else if ('cookie' in step) {
    const c = step.cookie;
    const url = new URL(page.url());
    await page.context().addCookies([{
      name: c.name,
      value: c.value,
      domain: c.domain ?? url.hostname,
      path: c.path ?? '/',
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    }]);
  } else if ('clearCookies' in step) {
    await page.context().clearCookies();
  }
}

async function runIframeStep(frame: import('playwright').FrameLocator, step: Step): Promise<void> {
  if ('click' in step) await frame.locator(step.click).click();
  else if ('fill' in step) await frame.locator(step.fill.selector).fill(step.fill.text);
  else if ('type' in step) await frame.locator(step.type.selector).type(step.type.text);
  else if ('waitFor' in step) await frame.locator(step.waitFor).waitFor();
  else if ('hover' in step) await frame.locator(step.hover).hover();
  else if ('check' in step) await frame.locator(step.check).check();
  else if ('uncheck' in step) await frame.locator(step.uncheck).uncheck();
  else if ('select' in step) await frame.locator(step.select.selector).selectOption(step.select.value as any);
  else if ('key' in step) await frame.locator('body').press(step.key);
}

function emptyA11y(url: string, e: unknown): A11yResult {
  return { page: url, violations: [], passed: false, ...({ error: String(e) } as any) };
}
function emptyPerf(url: string, e: unknown): PerfResult {
  return {
    page: url,
    scores: { performance: 0, accessibility: 0, bestPractices: 0, seo: 0 },
    metrics: { lcp: 0, fcp: 0, cls: 0, tbt: 0, si: 0 },
    ...({ error: String(e) } as any),
  };
}
function emptyVisual(url: string, vp: string, e: unknown): VisualResult {
  return {
    page: url,
    viewport: vp,
    baseline: '',
    current: '',
    diffPixels: 0,
    diffRatio: 0,
    passed: false,
    ...({ error: String(e) } as any),
  };
}
