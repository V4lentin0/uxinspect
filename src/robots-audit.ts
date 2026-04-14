export interface RobotsRule {
  userAgent: string;
  path: string;
}

export interface RobotsAuditIssue {
  type:
    | 'missing-robots'
    | 'blocks-all'
    | 'no-sitemap'
    | 'malformed-line'
    | 'wildcard-user-agent-only'
    | 'too-strict';
  detail: string;
}

export interface RobotsAuditResult {
  url: string;
  present: boolean;
  status?: number;
  size?: number;
  userAgents: string[];
  disallowRules: RobotsRule[];
  allowRules: RobotsRule[];
  sitemapUrls: string[];
  crawlDelay?: number;
  hasWildcardDisallow: boolean;
  issues: RobotsAuditIssue[];
  passed: boolean;
}

const KNOWN_DIRECTIVES = new Set([
  'user-agent',
  'disallow',
  'allow',
  'sitemap',
  'crawl-delay',
  'host',
]);

const COMMON_PATHS = ['/about', '/contact', '/blog'];

function resolveRobotsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  try {
    const u = new URL(trimmed);
    return `${u.origin}/robots.txt`;
  } catch {
    return `${trimmed}/robots.txt`;
  }
}

interface ParsedRobots {
  userAgents: string[];
  disallowRules: RobotsRule[];
  allowRules: RobotsRule[];
  sitemapUrls: string[];
  crawlDelay?: number;
  malformed: string[];
}

function parseRobots(text: string): ParsedRobots {
  const userAgents: string[] = [];
  const disallowRules: RobotsRule[] = [];
  const allowRules: RobotsRule[] = [];
  const sitemapUrls: string[] = [];
  const malformed: string[] = [];
  let crawlDelay: number | undefined;

  let currentAgents: string[] = [];
  let lastWasAgent = false;

  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const noComment = raw.replace(/#.*$/, '');
    const line = noComment.trim();
    if (!line) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0) {
      malformed.push(line);
      continue;
    }

    const directive = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (!KNOWN_DIRECTIVES.has(directive)) {
      malformed.push(line);
      continue;
    }

    if (directive === 'user-agent') {
      if (!lastWasAgent) currentAgents = [];
      if (value) {
        currentAgents.push(value);
        if (!userAgents.includes(value)) userAgents.push(value);
      }
      lastWasAgent = true;
      continue;
    }

    lastWasAgent = false;

    if (directive === 'sitemap') {
      if (value) sitemapUrls.push(value);
      continue;
    }

    if (directive === 'host') {
      continue;
    }

    if (directive === 'crawl-delay') {
      const n = Number(value);
      if (!Number.isNaN(n)) {
        crawlDelay = crawlDelay === undefined ? n : Math.max(crawlDelay, n);
      } else {
        malformed.push(line);
      }
      continue;
    }

    const agents = currentAgents.length > 0 ? currentAgents : ['*'];

    if (directive === 'disallow') {
      for (const ua of agents) disallowRules.push({ userAgent: ua, path: value });
    } else if (directive === 'allow') {
      for (const ua of agents) allowRules.push({ userAgent: ua, path: value });
    }
  }

  return { userAgents, disallowRules, allowRules, sitemapUrls, crawlDelay, malformed };
}

function pathMatches(rulePath: string, testPath: string): boolean {
  if (!rulePath) return false;
  if (rulePath === '/' || rulePath === '*') return true;
  const escaped = rulePath
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  const anchored = rulePath.endsWith('$') ? escaped : `^${escaped}`;
  try {
    return new RegExp(anchored).test(testPath);
  } catch {
    return testPath.startsWith(rulePath);
  }
}

export async function auditRobots(baseUrl: string): Promise<RobotsAuditResult> {
  const url = resolveRobotsUrl(baseUrl);
  const issues: RobotsAuditIssue[] = [];

  const result: RobotsAuditResult = {
    url,
    present: false,
    userAgents: [],
    disallowRules: [],
    allowRules: [],
    sitemapUrls: [],
    hasWildcardDisallow: false,
    issues,
    passed: false,
  };

  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      redirect: 'follow',
    });
  } catch (err) {
    issues.push({
      type: 'missing-robots',
      detail: `Failed to fetch robots.txt: ${(err as Error).message}`,
    });
    result.passed = false;
    return result;
  }

  result.status = res.status;

  if (res.status === 404) {
    issues.push({ type: 'missing-robots', detail: `robots.txt returned 404 at ${url}` });
    result.passed = false;
    return result;
  }

  if (!res.ok) {
    issues.push({
      type: 'missing-robots',
      detail: `robots.txt returned HTTP ${res.status} at ${url}`,
    });
    result.passed = false;
    return result;
  }

  const text = await res.text();
  result.present = true;
  result.size = new TextEncoder().encode(text).length;

  const parsed = parseRobots(text);
  result.userAgents = parsed.userAgents;
  result.disallowRules = parsed.disallowRules;
  result.allowRules = parsed.allowRules;
  result.sitemapUrls = parsed.sitemapUrls;
  if (parsed.crawlDelay !== undefined) result.crawlDelay = parsed.crawlDelay;

  for (const line of parsed.malformed) {
    issues.push({ type: 'malformed-line', detail: `Malformed or unknown directive: ${line}` });
  }

  const wildcardDisallows = parsed.disallowRules.filter(r => r.userAgent === '*');
  result.hasWildcardDisallow = wildcardDisallows.some(
    r => r.path === '/' || r.path === '*' || r.path === '/*',
  );

  if (result.hasWildcardDisallow) {
    const wildcardAllows = parsed.allowRules.filter(r => r.userAgent === '*');
    const hasOverride = wildcardAllows.some(r => r.path && r.path !== '');
    if (!hasOverride) {
      issues.push({
        type: 'blocks-all',
        detail: 'User-agent: * has Disallow: / with no Allow overrides',
      });
    }
  }

  if (parsed.sitemapUrls.length === 0) {
    issues.push({
      type: 'no-sitemap',
      detail: 'No Sitemap: directive found in robots.txt',
    });
  }

  if (
    parsed.userAgents.length > 0 &&
    parsed.userAgents.every(ua => ua === '*')
  ) {
    const hasSpecific = parsed.userAgents.some(ua => ua !== '*');
    if (!hasSpecific) {
      issues.push({
        type: 'wildcard-user-agent-only',
        detail: 'Only User-agent: * rules exist; no bot-specific sections defined',
      });
    }
  }

  const wildcardRulesForCheck = parsed.disallowRules.filter(r => r.userAgent === '*' && r.path);
  const wildcardAllowsForCheck = parsed.allowRules.filter(r => r.userAgent === '*' && r.path);
  let blockedCommon = 0;
  for (const common of COMMON_PATHS) {
    const blocked = wildcardRulesForCheck.some(r => pathMatches(r.path, common));
    const allowed = wildcardAllowsForCheck.some(r => pathMatches(r.path, common));
    if (blocked && !allowed) blockedCommon++;
  }
  if (blockedCommon / COMMON_PATHS.length > 0.5) {
    issues.push({
      type: 'too-strict',
      detail: `${blockedCommon}/${COMMON_PATHS.length} common paths (${COMMON_PATHS.join(', ')}) are disallowed`,
    });
  }

  result.passed = issues.length === 0;
  return result;
}
