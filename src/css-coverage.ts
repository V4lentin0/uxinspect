import type { Page } from 'playwright';

export interface CssCoverageFile {
  url: string;
  total: number;
  used: number;
  unusedRatio: number;
}

export interface CssCoverageResult {
  page: string;
  totalBytes: number;
  usedBytes: number;
  unusedBytes: number;
  unusedRatio: number;
  byFile: CssCoverageFile[];
  passed: boolean;
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
    startCSSCoverage: (options?: { resetOnNavigation?: boolean }) => Promise<void>;
    stopCSSCoverage: () => Promise<CoverageEntry[]>;
  };
}

const DEFAULT_THRESHOLD = 0.5;
const TOP_N = 30;

function emptyResult(pageUrl: string, passed: boolean): CssCoverageResult {
  return {
    page: pageUrl,
    totalBytes: 0,
    usedBytes: 0,
    unusedBytes: 0,
    unusedRatio: 0,
    byFile: [],
    passed,
  };
}

export async function auditCssCoverage(
  page: Page,
  opts?: { threshold?: number },
): Promise<CssCoverageResult> {
  const pageUrl = page.url();
  const threshold = opts?.threshold ?? DEFAULT_THRESHOLD;

  const pageWithCoverage = page as unknown as PageWithCoverage;
  const coverage = pageWithCoverage.coverage;
  if (!coverage || typeof coverage.startCSSCoverage !== 'function' || typeof coverage.stopCSSCoverage !== 'function') {
    return emptyResult(pageUrl, true);
  }

  try {
    await coverage.startCSSCoverage({ resetOnNavigation: false });
  } catch {
    return emptyResult(pageUrl, true);
  }

  try {
    await page.reload({ waitUntil: 'networkidle' });
  } catch {
    try {
      await coverage.stopCSSCoverage();
    } catch {
      /* ignore */
    }
    return emptyResult(pageUrl, true);
  }

  let entries: CoverageEntry[];
  try {
    entries = await coverage.stopCSSCoverage();
  } catch {
    return emptyResult(pageUrl, true);
  }

  const merged = new Map<string, { total: number; used: number }>();
  for (const entry of entries) {
    if (!entry.url || entry.url.startsWith('data:')) continue;
    const total = entry.text?.length ?? 0;
    let used = 0;
    for (const range of entry.ranges) {
      const len = Math.max(0, range.end - range.start);
      used += len;
    }
    if (total > 0 && used > total) used = total;
    const prev = merged.get(entry.url);
    if (prev) {
      merged.set(entry.url, { total: prev.total + total, used: prev.used + used });
    } else {
      merged.set(entry.url, { total, used });
    }
  }

  let totalBytes = 0;
  let usedBytes = 0;
  const files: CssCoverageFile[] = [];
  for (const [url, { total, used }] of merged) {
    totalBytes += total;
    usedBytes += used;
    const unusedRatio = total > 0 ? Math.max(0, (total - used) / total) : 0;
    files.push({ url, total, used, unusedRatio });
  }

  files.sort((a, b) => b.unusedRatio - a.unusedRatio);
  const byFile = files.slice(0, TOP_N);

  const unusedBytes = Math.max(0, totalBytes - usedBytes);
  const unusedRatio = totalBytes > 0 ? unusedBytes / totalBytes : 0;
  const passed = unusedRatio <= threshold;

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
