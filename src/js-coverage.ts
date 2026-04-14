import type { Page } from 'playwright';

export interface JsCoverageFileEntry {
  url: string;
  total: number;
  used: number;
  unusedRatio: number;
}

export interface JsCoverageResult {
  page: string;
  totalBytes: number;
  usedBytes: number;
  unusedBytes: number;
  unusedRatio: number;
  byFile: JsCoverageFileEntry[];
  passed: boolean;
}

interface CoverageRange {
  count: number;
  startOffset: number;
  endOffset: number;
}

interface CoverageFunction {
  functionName: string;
  isBlockCoverage: boolean;
  ranges: CoverageRange[];
}

interface CoverageEntry {
  url: string;
  scriptId: string;
  source?: string;
  functions: CoverageFunction[];
}

interface PageWithCoverage {
  coverage?: {
    startJSCoverage: (options?: { resetOnNavigation?: boolean; reportAnonymousScripts?: boolean }) => Promise<void>;
    stopJSCoverage: () => Promise<CoverageEntry[]>;
  };
}

function emptyResult(pageUrl: string): JsCoverageResult {
  return {
    page: pageUrl,
    totalBytes: 0,
    usedBytes: 0,
    unusedBytes: 0,
    unusedRatio: 0,
    byFile: [],
    passed: true,
  };
}

function computeUsedBytes(entry: CoverageEntry): number {
  let used = 0;
  for (const fn of entry.functions) {
    for (const r of fn.ranges) {
      if (r.count > 0) {
        const len = r.endOffset - r.startOffset;
        if (len > 0) used += len;
      }
    }
  }
  return used;
}

export async function auditJsCoverage(
  page: Page,
  opts?: { threshold?: number },
): Promise<JsCoverageResult> {
  const threshold = opts?.threshold ?? 0.4;
  const pageUrl = page.url();
  const coverage = (page as unknown as PageWithCoverage).coverage;
  if (!coverage) return emptyResult(pageUrl);

  await coverage.startJSCoverage({ resetOnNavigation: false });
  await page.reload({ waitUntil: 'networkidle' });
  const entries = await coverage.stopJSCoverage();

  const agg = new Map<string, { total: number; used: number }>();
  for (const entry of entries) {
    if (!entry.url || entry.url.startsWith('data:')) continue;
    const total = entry.source?.length ?? 0;
    if (total <= 0) continue;
    let used = computeUsedBytes(entry);
    if (used > total) used = total;
    const prev = agg.get(entry.url);
    if (prev) {
      prev.total += total;
      prev.used += used;
    } else {
      agg.set(entry.url, { total, used });
    }
  }

  let totalBytes = 0;
  let usedBytes = 0;
  const files: JsCoverageFileEntry[] = [];
  for (const [url, v] of agg) {
    totalBytes += v.total;
    usedBytes += v.used;
    const unused = Math.max(0, v.total - v.used);
    files.push({
      url,
      total: v.total,
      used: v.used,
      unusedRatio: v.total > 0 ? unused / v.total : 0,
    });
  }

  const unusedBytes = Math.max(0, totalBytes - usedBytes);
  const unusedRatio = totalBytes > 0 ? unusedBytes / totalBytes : 0;
  const byFile = files.sort((a, b) => b.unusedRatio - a.unusedRatio).slice(0, 30);
  const passed = totalBytes === 0 ? true : unusedRatio <= threshold;

  return {
    page: pageUrl,
    totalBytes,
    usedBytes,
    unusedBytes,
    unusedRatio,
    byFile,
    passed,
  };
}
