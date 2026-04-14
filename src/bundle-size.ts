import type { Page } from 'playwright';

export type BundleType = 'js' | 'css';

export type BundleFramework = 'react' | 'vue' | 'angular' | 'svelte' | 'jquery' | 'other';

export type BundleIssueType =
  | 'bundle-too-large'
  | 'css-too-large'
  | 'too-much-unused'
  | 'duplicate-package'
  | 'no-minification';

export interface BundleEntry {
  url: string;
  type: BundleType;
  bytes: number;
  transferBytes: number;
  coverageUsedBytes?: number;
  coverageUnusedBytes?: number;
  framework?: BundleFramework;
}

export interface DuplicatePackage {
  name: string;
  versions: string[];
  bundles: string[];
}

export interface BundleSizeIssue {
  type: BundleIssueType;
  target?: string;
  detail: string;
}

export interface BundleSizeResult {
  page: string;
  totalJsBytes: number;
  totalCssBytes: number;
  totalJsTransferBytes: number;
  totalCssTransferBytes: number;
  bundles: BundleEntry[];
  duplicatePackages: DuplicatePackage[];
  issues: BundleSizeIssue[];
  passed: boolean;
}

interface ResourceEntry {
  name: string;
  initiatorType: string;
  encodedBodySize: number;
  decodedBodySize: number;
  transferSize: number;
}

interface CoverageRange {
  start: number;
  end: number;
}

interface CoverageEntry {
  url: string;
  text?: string;
  ranges: CoverageRange[];
}

interface PageWithCoverage {
  coverage?: {
    startJSCoverage: (options?: { resetOnNavigation?: boolean; reportAnonymousScripts?: boolean }) => Promise<void>;
    stopJSCoverage: () => Promise<CoverageEntry[]>;
    startCSSCoverage: (options?: { resetOnNavigation?: boolean }) => Promise<void>;
    stopCSSCoverage: () => Promise<CoverageEntry[]>;
  };
}

const CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_JS_BYTES = 300 * 1024;
const MAX_CSS_BYTES = 100 * 1024;
const MIN_MINIFY_SAMPLE_BYTES = 2048;
const WHITESPACE_RATIO_THRESHOLD = 0.15;
const UNUSED_RATIO_THRESHOLD = 0.5;

function isFetchableUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function classifyResource(entry: ResourceEntry): BundleType | null {
  const initiator = (entry.initiatorType || '').toLowerCase();
  let pathname = '';
  try {
    pathname = new URL(entry.name).pathname.toLowerCase();
  } catch {
    pathname = entry.name.toLowerCase();
  }

  const isJsPath = /\.(m|c)?js(\?|$)/.test(pathname) || pathname.endsWith('.js');
  const isCssPath = pathname.endsWith('.css') || /\.css(\?|$)/.test(pathname);

  if (initiator === 'script' || isJsPath) return 'js';
  if (initiator === 'css' || isCssPath) return 'css';
  if (initiator === 'link' && isCssPath) return 'css';
  return null;
}

function detectFramework(source: string): BundleFramework | undefined {
  if (/react\.production\.min|__REACT_DEVTOOLS|createElement\("/.test(source)) return 'react';
  if (/Vue\.prototype|__VUE__|vue@\d/.test(source)) return 'vue';
  if (/ng\.core|@angular\/core|__angularSeed/.test(source)) return 'angular';
  if (/svelte\//.test(source)) return 'svelte';
  if (/jQuery\.fn\.init|\$\.ajax\.extend/.test(source)) return 'jquery';
  return undefined;
}

function extractPackageVersions(url: string): Array<{ name: string; version: string }> {
  const out: Array<{ name: string; version: string }> = [];
  const re = /\/(@[\w.-]+\/[\w.-]+|[\w.-]+)@(\d+\.\d+\.\d+(?:[\w.-]*)?)\//g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(url)) !== null) {
    const name = match[1];
    const version = match[2];
    if (name && version) out.push({ name, version });
  }
  return out;
}

function computeWhitespaceRatio(source: string): number {
  if (source.length === 0) return 0;
  let whitespace = 0;
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) whitespace++;
  }
  return whitespace / source.length;
}

function isLikelyNotMinified(source: string): boolean {
  if (source.length < MIN_MINIFY_SAMPLE_BYTES) return false;
  const ratio = computeWhitespaceRatio(source);
  return ratio > WHITESPACE_RATIO_THRESHOLD;
}

async function fetchSource(
  url: string,
  page: Page,
): Promise<{ source: string; transferBytes: number } | null> {
  try {
    const res = await page.request.get(url, {
      timeout: REQUEST_TIMEOUT_MS,
      failOnStatusCode: false,
    });
    if (!res.ok()) return null;
    const body = await res.body();
    const source = body.toString('utf8');
    const contentLengthHeader = res.headers()['content-length'];
    const transferBytes = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : body.byteLength;
    return {
      source,
      transferBytes: Number.isFinite(transferBytes) && transferBytes >= 0 ? transferBytes : body.byteLength,
    };
  } catch {
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      const source = new TextDecoder('utf-8').decode(buf);
      const contentLengthHeader = res.headers.get('content-length');
      const transferBytes = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : buf.byteLength;
      return {
        source,
        transferBytes: Number.isFinite(transferBytes) && transferBytes >= 0 ? transferBytes : buf.byteLength,
      };
    } catch {
      return null;
    }
  }
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const runners: Promise<void>[] = [];
  const spawn = async (): Promise<void> => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      try {
        const value = await worker(items[idx]!);
        results[idx] = { status: 'fulfilled', value };
      } catch (reason) {
        results[idx] = { status: 'rejected', reason };
      }
    }
  };
  for (let i = 0; i < Math.min(limit, items.length); i++) runners.push(spawn());
  await Promise.all(runners);
  return results;
}

function mergeCoverage(entries: CoverageEntry[]): Map<string, { used: number; total: number }> {
  const map = new Map<string, { used: number; total: number }>();
  for (const entry of entries) {
    const total = entry.text?.length ?? 0;
    let used = 0;
    for (const range of entry.ranges) {
      const len = Math.max(0, range.end - range.start);
      used += len;
    }
    if (used > total && total > 0) used = total;
    const prev = map.get(entry.url);
    if (prev) {
      map.set(entry.url, { used: prev.used + used, total: prev.total + total });
    } else {
      map.set(entry.url, { used, total });
    }
  }
  return map;
}

export async function analyzeBundles(page: Page): Promise<BundleSizeResult> {
  const pageUrl = page.url();

  const entries = await page.evaluate((): ResourceEntry[] =>
    (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
      .filter((r) => {
        const init = (r.initiatorType || '').toLowerCase();
        return init === 'script' || init === 'css' || init === 'link';
      })
      .map((r) => ({
        name: r.name,
        initiatorType: r.initiatorType,
        encodedBodySize: r.encodedBodySize,
        decodedBodySize: r.decodedBodySize,
        transferSize: r.transferSize,
      })),
  );

  const seen = new Set<string>();
  const targets: Array<{ url: string; type: BundleType; entry: ResourceEntry }> = [];
  for (const entry of entries) {
    if (!isFetchableUrl(entry.name)) continue;
    if (seen.has(entry.name)) continue;
    const type = classifyResource(entry);
    if (!type) continue;
    seen.add(entry.name);
    targets.push({ url: entry.name, type, entry });
  }

  const pageWithCoverage = page as unknown as PageWithCoverage;
  const coverage = pageWithCoverage.coverage;
  let jsCoverage: Map<string, { used: number; total: number }> | null = null;
  let cssCoverage: Map<string, { used: number; total: number }> | null = null;
  if (coverage && typeof coverage.stopJSCoverage === 'function') {
    try {
      const jsEntries = await coverage.stopJSCoverage();
      jsCoverage = mergeCoverage(jsEntries);
    } catch {
      jsCoverage = null;
    }
  }
  if (coverage && typeof coverage.stopCSSCoverage === 'function') {
    try {
      const cssEntries = await coverage.stopCSSCoverage();
      cssCoverage = mergeCoverage(cssEntries);
    } catch {
      cssCoverage = null;
    }
  }

  const fetched = await runWithConcurrency(targets, CONCURRENCY, async (t) => {
    const result = await fetchSource(t.url, page);
    return { target: t, result };
  });

  const bundles: BundleEntry[] = [];
  const issues: BundleSizeIssue[] = [];
  const packageMap = new Map<string, Map<string, Set<string>>>();

  for (const settled of fetched) {
    if (settled.status !== 'fulfilled') continue;
    const { target, result } = settled.value;
    let bytes = target.entry.decodedBodySize;
    let transferBytes = target.entry.transferSize || target.entry.encodedBodySize;
    let source = '';
    if (result) {
      source = result.source;
      if (!bytes || bytes <= 0) bytes = Buffer.byteLength(source, 'utf8');
      if (!transferBytes || transferBytes <= 0) transferBytes = result.transferBytes;
    }
    if (!bytes || bytes <= 0) bytes = transferBytes || 0;
    if (!transferBytes || transferBytes <= 0) transferBytes = bytes;

    const framework = source ? detectFramework(source) : undefined;

    const covMap = target.type === 'js' ? jsCoverage : cssCoverage;
    const cov = covMap?.get(target.url);
    let coverageUsedBytes: number | undefined;
    let coverageUnusedBytes: number | undefined;
    if (cov && cov.total > 0) {
      coverageUsedBytes = cov.used;
      coverageUnusedBytes = Math.max(0, cov.total - cov.used);
    }

    const bundle: BundleEntry = {
      url: target.url,
      type: target.type,
      bytes,
      transferBytes,
      coverageUsedBytes,
      coverageUnusedBytes,
      framework,
    };
    bundles.push(bundle);

    if (target.type === 'js' && bytes > MAX_JS_BYTES) {
      issues.push({
        type: 'bundle-too-large',
        target: target.url,
        detail: `JS bundle ${(bytes / 1024).toFixed(1)}KB exceeds ${(MAX_JS_BYTES / 1024).toFixed(0)}KB budget`,
      });
    }
    if (target.type === 'css' && bytes > MAX_CSS_BYTES) {
      issues.push({
        type: 'css-too-large',
        target: target.url,
        detail: `CSS bundle ${(bytes / 1024).toFixed(1)}KB exceeds ${(MAX_CSS_BYTES / 1024).toFixed(0)}KB budget`,
      });
    }

    if (target.type === 'js' && source && isLikelyNotMinified(source)) {
      issues.push({
        type: 'no-minification',
        target: target.url,
        detail: `JS source has >${Math.round(WHITESPACE_RATIO_THRESHOLD * 100)}% whitespace; likely not minified`,
      });
    }

    for (const pkg of extractPackageVersions(target.url)) {
      let versions = packageMap.get(pkg.name);
      if (!versions) {
        versions = new Map<string, Set<string>>();
        packageMap.set(pkg.name, versions);
      }
      let urls = versions.get(pkg.version);
      if (!urls) {
        urls = new Set<string>();
        versions.set(pkg.version, urls);
      }
      urls.add(target.url);
    }
  }

  const duplicatePackages: DuplicatePackage[] = [];
  for (const [name, versions] of packageMap) {
    if (versions.size < 2) continue;
    const versionList = Array.from(versions.keys()).sort();
    const bundleSet = new Set<string>();
    for (const urls of versions.values()) {
      for (const u of urls) bundleSet.add(u);
    }
    duplicatePackages.push({ name, versions: versionList, bundles: Array.from(bundleSet) });
    issues.push({
      type: 'duplicate-package',
      target: name,
      detail: `package "${name}" loaded at ${versionList.length} versions: ${versionList.join(', ')}`,
    });
  }

  let totalJsBytes = 0;
  let totalCssBytes = 0;
  let totalJsTransferBytes = 0;
  let totalCssTransferBytes = 0;
  let totalBytes = 0;
  let totalUnused = 0;
  let sawCoverage = false;
  for (const b of bundles) {
    if (b.type === 'js') {
      totalJsBytes += b.bytes;
      totalJsTransferBytes += b.transferBytes;
    } else {
      totalCssBytes += b.bytes;
      totalCssTransferBytes += b.transferBytes;
    }
    totalBytes += b.bytes;
    if (typeof b.coverageUnusedBytes === 'number') {
      totalUnused += b.coverageUnusedBytes;
      sawCoverage = true;
    }
  }

  if (sawCoverage && totalBytes > 0 && totalUnused / totalBytes > UNUSED_RATIO_THRESHOLD) {
    issues.push({
      type: 'too-much-unused',
      detail: `${((totalUnused / totalBytes) * 100).toFixed(1)}% of bundle bytes unused across JS+CSS`,
    });
  }

  return {
    page: pageUrl,
    totalJsBytes,
    totalCssBytes,
    totalJsTransferBytes,
    totalCssTransferBytes,
    bundles,
    duplicatePackages,
    issues,
    passed: issues.length === 0,
  };
}
