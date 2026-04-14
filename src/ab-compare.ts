import type { InspectResult } from './types.js';

export interface Diff {
  check: string;
  delta: string;
  aValue: string | number;
  bValue: string | number;
  direction: 'regression' | 'improvement';
  severity: 'minor' | 'major' | 'critical';
}

export interface CompareResult {
  labelA: string;
  labelB: string;
  regressions: Diff[];
  improvements: Diff[];
  unchanged: number;
  summary: { regressedChecks: number; improvedChecks: number };
  passed: boolean;
}

type MetricValue = number | boolean | undefined;

interface CheckDescriptor {
  name: string;
  kind: 'numeric' | 'boolean';
  extract: (r: InspectResult) => MetricValue;
  // Extra threshold beyond "b > a" for regression (numeric only).
  regressionThreshold?: number;
}

function truncateLabel(url: string, max = 64): string {
  if (url.length <= max) return url;
  return url.slice(0, max - 1) + '\u2026';
}

function sumBy<T>(arr: T[] | undefined, pick: (x: T) => number): number {
  if (!arr) return 0;
  let total = 0;
  for (const item of arr) total += pick(item);
  return total;
}

function countWhere<T>(arr: T[] | undefined, pred: (x: T) => boolean): number {
  if (!arr) return 0;
  let n = 0;
  for (const item of arr) if (pred(item)) n++;
  return n;
}

const CHECKS: CheckDescriptor[] = [
  {
    name: 'a11y',
    kind: 'numeric',
    extract: (r) =>
      sumBy(r.a11y, (p) => {
        let score = 0;
        for (const v of p.violations) {
          if (v.impact === 'critical') score += 10;
          else if (v.impact === 'serious') score += 5;
          else if (v.impact === 'moderate') score += 2;
          else score += 1;
        }
        return score;
      }),
  },
  {
    name: 'perf',
    kind: 'numeric',
    extract: (r) => {
      if (!r.perf || r.perf.length === 0) return 0;
      const total = sumBy(r.perf, (p) => p.metrics.lcp);
      return Math.round(total / r.perf.length);
    },
    regressionThreshold: 200,
  },
  {
    name: 'visual',
    kind: 'numeric',
    extract: (r) => sumBy(r.visual, (v) => v.diffPixels),
    regressionThreshold: 100,
  },
  {
    name: 'seo',
    kind: 'numeric',
    extract: (r) => sumBy(r.seo, (p) => p.issues.length),
  },
  {
    name: 'links',
    kind: 'numeric',
    extract: (r) => sumBy(r.links, (p) => p.issues.length),
  },
  {
    name: 'pwa',
    kind: 'numeric',
    extract: (r) => countWhere(r.pwa, (p) => !p.passed),
  },
  {
    name: 'security',
    kind: 'numeric',
    extract: (r) => (r.security ? r.security.issues.length : 0),
  },
  {
    name: 'budget',
    kind: 'numeric',
    extract: (r) => (r.budget ? r.budget.length : 0),
  },
  {
    name: 'apiFlows',
    kind: 'numeric',
    extract: (r) => countWhere(r.apiFlows, (f) => !f.passed),
  },
  {
    name: 'retire',
    kind: 'numeric',
    extract: (r) => sumBy(r.retire, (p) => p.findings.length),
  },
  {
    name: 'deadClicks',
    kind: 'numeric',
    extract: (r) => sumBy(r.deadClicks, (p) => p.findings.length),
  },
  {
    name: 'touchTargets',
    kind: 'numeric',
    extract: (r) => sumBy(r.touchTargets, (p) => p.tooSmall.length + p.overlapping.length),
  },
  {
    name: 'keyboard',
    kind: 'numeric',
    extract: (r) => sumBy(r.keyboard, (p) => p.issues.length),
  },
  {
    name: 'longTasks',
    kind: 'numeric',
    extract: (r) => sumBy(r.longTasks, (p) => p.longTasks.length),
  },
  {
    name: 'clsTimeline',
    kind: 'numeric',
    extract: (r) => countWhere(r.clsTimeline, (p) => !p.passed),
  },
  {
    name: 'forms',
    kind: 'numeric',
    extract: (r) => sumBy(r.forms, (p) => p.totalIssues),
  },
  {
    name: 'structuredData',
    kind: 'numeric',
    extract: (r) => sumBy(r.structuredData, (p) => p.issues.length),
  },
  {
    name: 'passiveSecurity',
    kind: 'numeric',
    extract: (r) => sumBy(r.passiveSecurity, (p) => p.issues.length),
  },
  {
    name: 'consoleErrors',
    kind: 'numeric',
    extract: (r) => sumBy(r.consoleErrors, (p) => p.errorCount),
  },
  {
    name: 'sitemap',
    kind: 'boolean',
    extract: (r) => (r.sitemap ? r.sitemap.passed : undefined),
  },
  {
    name: 'redirects',
    kind: 'boolean',
    extract: (r) => (r.redirects ? r.redirects.passed : undefined),
  },
  {
    name: 'exposedPaths',
    kind: 'boolean',
    extract: (r) => (r.exposedPaths ? r.exposedPaths.passed : undefined),
  },
  {
    name: 'tls',
    kind: 'boolean',
    extract: (r) => (r.tls ? r.tls.passed : undefined),
  },
  {
    name: 'crawl',
    kind: 'numeric',
    // CrawlResult has no `passed`; use pagesVisited as a rough indicator.
    // Regression here means b visited fewer pages than a (lost coverage).
    extract: (r) => (r.crawl ? r.crawl.pagesVisited : undefined),
  },
  {
    name: 'contentQuality',
    kind: 'boolean',
    extract: (r) => (r.contentQuality ? r.contentQuality.passed : undefined),
  },
  {
    name: 'resourceHints',
    kind: 'numeric',
    extract: (r) => sumBy(r.resourceHints, (p) => p.issues.length),
  },
  {
    name: 'mixedContent',
    kind: 'numeric',
    extract: (r) => sumBy(r.mixedContent, (p) => p.insecureResources.length),
  },
  {
    name: 'compression',
    kind: 'boolean',
    extract: (r) => (r.compression ? r.compression.passed : undefined),
  },
  {
    name: 'cacheHeaders',
    kind: 'numeric',
    extract: (r) => sumBy(r.cacheHeaders, (p) => p.issues.length),
  },
  {
    name: 'cookieBanner',
    kind: 'numeric',
    extract: (r) => sumBy(r.cookieBanner, (p) => p.issues.length),
  },
  {
    name: 'thirdParty',
    kind: 'numeric',
    extract: (r) => sumBy(r.thirdParty, (p) => p.issues.length),
  },
  {
    name: 'bundleSize',
    kind: 'numeric',
    extract: (r) => sumBy(r.bundleSize, (p) => p.issues.length),
  },
  {
    name: 'openGraph',
    kind: 'numeric',
    extract: (r) => countWhere(r.openGraph, (p) => !p.passed),
  },
  {
    name: 'robotsAudit',
    kind: 'boolean',
    extract: (r) => (r.robotsAudit ? r.robotsAudit.passed : undefined),
  },
  {
    name: 'imageAudit',
    kind: 'numeric',
    extract: (r) => sumBy(r.imageAudit, (p) => p.issues.length),
  },
  {
    name: 'webfonts',
    kind: 'numeric',
    extract: (r) => sumBy(r.webfonts, (p) => p.issues.length),
  },
  {
    name: 'motionPrefs',
    kind: 'numeric',
    extract: (r) => sumBy(r.motionPrefs, (p) => p.issues.length),
  },
  {
    name: 'serviceWorker',
    kind: 'numeric',
    extract: (r) => countWhere(r.serviceWorker, (p) => !p.registered),
  },
  {
    name: 'rum',
    kind: 'numeric',
    extract: (r) => countWhere(r.rum, (p) => !p.passed),
  },
  {
    name: 'amp',
    kind: 'numeric',
    extract: (r) => sumBy(r.amp, (p) => p.issues.length),
  },
];

function severityForNumeric(aVal: number, bVal: number): 'minor' | 'major' | 'critical' {
  const abs = Math.abs(bVal - aVal);
  const pct = aVal > 0 ? abs / aVal : abs > 0 ? Infinity : 0;
  if (pct > 0.5 || abs > 20) return 'critical';
  if (pct > 0.2 || abs > 5) return 'major';
  return 'minor';
}

function formatDelta(aVal: number, bVal: number): string {
  const diff = bVal - aVal;
  const sign = diff > 0 ? '+' : '';
  return `${sign}${diff}`;
}

export function compareInspect(a: InspectResult, b: InspectResult): CompareResult {
  const regressions: Diff[] = [];
  const improvements: Diff[] = [];
  let unchanged = 0;

  for (const desc of CHECKS) {
    const aRaw = desc.extract(a);
    const bRaw = desc.extract(b);
    if (aRaw === undefined && bRaw === undefined) continue;

    if (desc.kind === 'boolean') {
      const aPassed = aRaw === true;
      const bPassed = bRaw === true;
      if (aPassed === bPassed) {
        unchanged++;
        continue;
      }
      if (aPassed && !bPassed) {
        regressions.push({
          check: desc.name,
          delta: 'passed -> failed',
          aValue: 'passed',
          bValue: 'failed',
          direction: 'regression',
          severity: 'critical',
        });
      } else {
        improvements.push({
          check: desc.name,
          delta: 'failed -> passed',
          aValue: 'failed',
          bValue: 'passed',
          direction: 'improvement',
          severity: 'critical',
        });
      }
      continue;
    }

    // Numeric
    const aVal = typeof aRaw === 'number' ? aRaw : 0;
    const bVal = typeof bRaw === 'number' ? bRaw : 0;
    const threshold = desc.regressionThreshold ?? 0;

    if (bVal > aVal + threshold) {
      regressions.push({
        check: desc.name,
        delta: formatDelta(aVal, bVal),
        aValue: aVal,
        bValue: bVal,
        direction: 'regression',
        severity: severityForNumeric(aVal, bVal),
      });
    } else if (aVal > bVal + threshold) {
      improvements.push({
        check: desc.name,
        delta: formatDelta(aVal, bVal),
        aValue: aVal,
        bValue: bVal,
        direction: 'improvement',
        severity: severityForNumeric(aVal, bVal),
      });
    } else {
      unchanged++;
    }
  }

  return {
    labelA: truncateLabel(a.url),
    labelB: truncateLabel(b.url),
    regressions,
    improvements,
    unchanged,
    summary: {
      regressedChecks: regressions.length,
      improvedChecks: improvements.length,
    },
    passed: regressions.length === 0,
  };
}
