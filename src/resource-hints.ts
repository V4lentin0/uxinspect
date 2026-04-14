import type { Page } from 'playwright';

export type ResourceHintIssueType =
  | 'unused-preload'
  | 'missing-as'
  | 'wrong-as'
  | 'redundant-preconnect'
  | 'too-many-preloads'
  | 'missing-crossorigin'
  | 'preload-unused-resource';

export interface ResourceHint {
  rel: string;
  href: string;
  as?: string;
  crossorigin?: string;
  type?: string;
}

export interface ResourceHintIssue {
  type: ResourceHintIssueType;
  detail: string;
  target?: string;
}

export interface ResourceHintsResult {
  page: string;
  hints: ResourceHint[];
  issues: ResourceHintIssue[];
  score: number;
  passed: boolean;
}

interface HintSnapshot {
  hints: ResourceHint[];
  resources: Array<{ name: string; transferSize: number; startTime: number; duration: number; initiatorType: string }>;
}

const HIGH_SEVERITY: ReadonlySet<ResourceHintIssueType> = new Set<ResourceHintIssueType>([
  'missing-as',
  'wrong-as',
  'unused-preload',
  'preload-unused-resource',
  'missing-crossorigin',
  'too-many-preloads',
]);

const VALID_AS_VALUES: ReadonlySet<string> = new Set<string>([
  'audio',
  'document',
  'embed',
  'fetch',
  'font',
  'image',
  'object',
  'script',
  'style',
  'track',
  'video',
  'worker',
]);

const FONT_EXTENSIONS = ['.woff', '.woff2', '.ttf', '.otf', '.eot'];
const SCRIPT_EXTENSIONS = ['.js', '.mjs', '.cjs'];
const STYLE_EXTENSIONS = ['.css'];
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico', '.bmp'];

function inferExpectedAs(href: string): string | null {
  let pathname = href.toLowerCase();
  try {
    pathname = new URL(href, 'https://example.com/').pathname.toLowerCase();
  } catch {}
  if (FONT_EXTENSIONS.some((e) => pathname.endsWith(e))) return 'font';
  if (SCRIPT_EXTENSIONS.some((e) => pathname.endsWith(e))) return 'script';
  if (STYLE_EXTENSIONS.some((e) => pathname.endsWith(e))) return 'style';
  if (IMAGE_EXTENSIONS.some((e) => pathname.endsWith(e))) return 'image';
  return null;
}

function normalizeOrigin(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function normalizeUrl(href: string, base: string): string | null {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

export async function auditResourceHints(page: Page): Promise<ResourceHintsResult> {
  const pageUrl = page.url();

  const snapshot = await page.evaluate(async (): Promise<HintSnapshot> => {
    const selector =
      'link[rel="preload"], link[rel="prefetch"], link[rel="preconnect"], link[rel="dns-prefetch"], link[rel="modulepreload"]';
    const nodes = Array.from(document.querySelectorAll(selector)) as HTMLLinkElement[];
    const hints = nodes.map((l) => {
      const h: { rel: string; href: string; as?: string; crossorigin?: string; type?: string } = {
        rel: (l.getAttribute('rel') || '').toLowerCase().trim(),
        href: l.href || l.getAttribute('href') || '',
      };
      const asAttr = l.getAttribute('as');
      if (asAttr) h.as = asAttr.toLowerCase();
      const co = l.getAttribute('crossorigin');
      if (co !== null) h.crossorigin = co === '' ? 'anonymous' : co.toLowerCase();
      const type = l.getAttribute('type');
      if (type) h.type = type.toLowerCase();
      return h;
    });

    await new Promise<void>((resolve) => {
      const start = performance.now();
      const target = 2500;
      const elapsed = performance.now() - start;
      if (elapsed >= target) resolve();
      else setTimeout(resolve, target - elapsed);
    });

    const resources = performance.getEntriesByType('resource').map((e) => {
      const r = e as PerformanceResourceTiming;
      return {
        name: r.name,
        transferSize: typeof r.transferSize === 'number' ? r.transferSize : 0,
        startTime: typeof r.startTime === 'number' ? r.startTime : 0,
        duration: typeof r.duration === 'number' ? r.duration : 0,
        initiatorType: r.initiatorType || '',
      };
    });

    return { hints, resources };
  });

  const issues: ResourceHintIssue[] = [];
  const hints = snapshot.hints;

  const preloads = hints.filter((h) => h.rel === 'preload');
  const preconnects = hints.filter((h) => h.rel === 'preconnect');

  if (preloads.length > 10) {
    issues.push({
      type: 'too-many-preloads',
      detail: `${preloads.length} preloads declared; >10 defeats the purpose and can delay critical resources`,
    });
  }

  for (const p of preloads) {
    if (!p.as) {
      issues.push({
        type: 'missing-as',
        detail: 'preload declared without an `as` attribute; browsers will ignore it or double-fetch',
        target: p.href,
      });
      continue;
    }
    if (!VALID_AS_VALUES.has(p.as)) {
      issues.push({
        type: 'wrong-as',
        detail: `preload has invalid \`as="${p.as}"\``,
        target: p.href,
      });
      continue;
    }
    const expected = inferExpectedAs(p.href);
    if (expected && expected !== p.as) {
      issues.push({
        type: 'wrong-as',
        detail: `preload \`as="${p.as}"\` does not match resource type (expected "${expected}")`,
        target: p.href,
      });
    }
    if (p.as === 'font' && p.crossorigin !== 'anonymous' && p.crossorigin !== 'use-credentials') {
      issues.push({
        type: 'missing-crossorigin',
        detail: 'font preload must include `crossorigin="anonymous"` or fonts will be fetched twice',
        target: p.href,
      });
    }
  }

  const originSeen = new Map<string, number>();
  for (const c of preconnects) {
    const origin = normalizeOrigin(c.href, pageUrl);
    if (!origin) continue;
    originSeen.set(origin, (originSeen.get(origin) || 0) + 1);
  }
  for (const [origin, count] of originSeen) {
    if (count > 1) {
      issues.push({
        type: 'redundant-preconnect',
        detail: `origin ${origin} has ${count} preconnect hints; one is enough`,
        target: origin,
      });
    }
  }
  const dnsPrefetchOrigins = new Set(
    hints
      .filter((h) => h.rel === 'dns-prefetch')
      .map((h) => normalizeOrigin(h.href, pageUrl))
      .filter((o): o is string => Boolean(o))
  );
  for (const origin of originSeen.keys()) {
    if (dnsPrefetchOrigins.has(origin)) {
      issues.push({
        type: 'redundant-preconnect',
        detail: `origin ${origin} has both preconnect and dns-prefetch; preconnect supersedes dns-prefetch`,
        target: origin,
      });
    }
  }

  const resourceByUrl = new Map<string, { transferSize: number; startTime: number; duration: number }>();
  for (const r of snapshot.resources) {
    const key = r.name;
    const prev = resourceByUrl.get(key);
    if (!prev) {
      resourceByUrl.set(key, { transferSize: r.transferSize, startTime: r.startTime, duration: r.duration });
    } else {
      resourceByUrl.set(key, {
        transferSize: prev.transferSize + r.transferSize,
        startTime: Math.min(prev.startTime || r.startTime, r.startTime || prev.startTime),
        duration: Math.max(prev.duration, r.duration),
      });
    }
  }

  const preloadTargets = [...preloads, ...hints.filter((h) => h.rel === 'modulepreload')];
  for (const p of preloadTargets) {
    const normalized = normalizeUrl(p.href, pageUrl);
    if (!normalized) continue;
    const match = resourceByUrl.get(normalized);
    if (!match) {
      issues.push({
        type: 'unused-preload',
        detail: `preloaded resource never appeared in resource timing within 2.5s; likely unused`,
        target: p.href,
      });
      continue;
    }
    if ((match.transferSize === 0 && match.duration === 0) || match.startTime === 0) {
      issues.push({
        type: 'preload-unused-resource',
        detail: 'preloaded resource has zero transferSize/duration; likely fetched but never consumed',
        target: p.href,
      });
    }
  }

  let score = 100;
  for (const i of issues) {
    score -= HIGH_SEVERITY.has(i.type) ? 12 : 5;
  }
  if (score < 0) score = 0;

  return {
    page: pageUrl,
    hints,
    issues,
    score,
    passed: issues.length === 0,
  };
}
