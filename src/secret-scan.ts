import type { Page } from 'playwright';

export interface SecretFinding {
  kind: string;
  source: string;
  snippet: string;
  line?: number;
  severity: 'high' | 'medium' | 'low';
}

export interface SecretScanResult {
  page: string;
  assetsScanned: number;
  findings: SecretFinding[];
  passed: boolean;
}

export interface SecretScanOptions {
  maxAssets?: number;
  extraPatterns?: { kind: string; pattern: RegExp; severity: 'high' | 'medium' | 'low' }[];
}

interface PatternEntry {
  kind: string;
  pattern: RegExp;
  severity: 'high' | 'medium' | 'low';
}

const BUILT_IN_PATTERNS: PatternEntry[] = [
  {
    kind: 'aws-access-key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    severity: 'high',
  },
  {
    kind: 'aws-secret-key',
    pattern: /\baws_secret_access_key\s*[=:]\s*['"][A-Za-z0-9/+=]{40}['"]/g,
    severity: 'high',
  },
  {
    kind: 'google-api-key',
    pattern: /\bAIza[0-9A-Za-z_\-]{35}\b/g,
    severity: 'high',
  },
  {
    kind: 'github-token',
    pattern: /\bgh[pousr]_[0-9A-Za-z]{36,255}\b/g,
    severity: 'high',
  },
  {
    kind: 'slack-token',
    pattern: /\bxox[abprs]-[0-9]{10,13}-[0-9]{10,13}-[0-9A-Za-z]{24,34}\b/g,
    severity: 'high',
  },
  {
    kind: 'stripe-live',
    pattern: /\bsk_live_[0-9A-Za-z]{24,99}\b/g,
    severity: 'high',
  },
  {
    kind: 'stripe-test',
    pattern: /\bsk_test_[0-9A-Za-z]{24,99}\b/g,
    severity: 'medium',
  },
  {
    kind: 'generic-jwt',
    pattern: /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g,
    severity: 'medium',
  },
  {
    kind: 'generic-api-key',
    pattern: /\b(api[_-]?key|apikey|access[_-]?token)\s*[:=]\s*['"][A-Za-z0-9_\-]{20,}['"]/gi,
    severity: 'medium',
  },
  {
    kind: 'private-key-pem',
    pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    severity: 'high',
  },
  {
    kind: 'bearer-token',
    pattern: /\bBearer\s+[A-Za-z0-9_\-=.]{20,}\b/g,
    severity: 'low',
  },
];

interface ResourceEntry {
  name: string;
  initiatorType: string;
}

function isJsAsset(url: string, initiatorType: string): boolean {
  if (initiatorType === 'script') return true;
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return (
      pathname.endsWith('.js') ||
      pathname.endsWith('.mjs') ||
      pathname.endsWith('.cjs') ||
      pathname.endsWith('.jsx')
    );
  } catch {
    return false;
  }
}

function redactMatch(raw: string): string {
  const capped = raw.length > 60 ? raw.slice(0, 60) : raw;
  if (capped.length <= 8) {
    return '*'.repeat(capped.length);
  }
  const head = capped.slice(0, 4);
  const tail = capped.slice(-4);
  const middle = '*'.repeat(capped.length - 8);
  return `${head}${middle}${tail}`;
}

function lineOfOffset(body: string, offset: number): number {
  let line = 1;
  const limit = Math.min(offset, body.length);
  for (let i = 0; i < limit; i++) {
    if (body.charCodeAt(i) === 10) line++;
  }
  return line;
}

function cloneGlobalRegex(re: RegExp): RegExp {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  return new RegExp(re.source, flags);
}

function scanBody(
  body: string,
  source: string,
  patterns: PatternEntry[],
  seen: Set<string>,
): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const entry of patterns) {
    const re = cloneGlobalRegex(entry.pattern);
    let match: RegExpExecArray | null;
    while ((match = re.exec(body)) !== null) {
      const raw = match[0];
      if (!raw) {
        if (re.lastIndex === match.index) re.lastIndex++;
        continue;
      }
      const snippet = redactMatch(raw);
      const dedupeKey = `${source}|${entry.kind}|${snippet}`;
      if (seen.has(dedupeKey)) {
        if (re.lastIndex === match.index) re.lastIndex++;
        continue;
      }
      seen.add(dedupeKey);
      findings.push({
        kind: entry.kind,
        source,
        snippet,
        line: lineOfOffset(body, match.index),
        severity: entry.severity,
      });
      if (re.lastIndex === match.index) re.lastIndex++;
    }
  }
  return findings;
}

async function collectResourceEntries(page: Page): Promise<ResourceEntry[]> {
  return page.evaluate((): ResourceEntry[] => {
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    return entries.map((e) => ({ name: e.name, initiatorType: e.initiatorType }));
  });
}

async function collectInlineScripts(page: Page): Promise<string[]> {
  return page.$$eval('script:not([src])', (els) =>
    els.map((e) => e.textContent || ''),
  );
}

async function fetchAssetBody(page: Page, url: string): Promise<string | null> {
  try {
    const res = await page.request.get(url);
    if (!res.ok()) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export async function scanSecrets(
  page: Page,
  opts?: SecretScanOptions,
): Promise<SecretScanResult> {
  const maxAssets = opts?.maxAssets ?? 30;
  const extraEntries: PatternEntry[] = (opts?.extraPatterns ?? []).map((p) => ({
    kind: p.kind,
    pattern: p.pattern,
    severity: p.severity,
  }));
  const patterns = [...BUILT_IN_PATTERNS, ...extraEntries];

  const pageUrl = page.url();
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();

  const resourceEntries = await collectResourceEntries(page);
  const jsUrls: string[] = [];
  const seenUrls = new Set<string>();
  for (const entry of resourceEntries) {
    if (!entry.name) continue;
    if (seenUrls.has(entry.name)) continue;
    if (!isJsAsset(entry.name, entry.initiatorType)) continue;
    seenUrls.add(entry.name);
    jsUrls.push(entry.name);
    if (jsUrls.length >= maxAssets) break;
  }

  let assetsScanned = 0;
  for (const url of jsUrls) {
    const body = await fetchAssetBody(page, url);
    if (body === null) continue;
    assetsScanned++;
    const assetFindings = scanBody(body, url, patterns, seen);
    for (const f of assetFindings) findings.push(f);
  }

  const inlineScripts = await collectInlineScripts(page);
  for (let i = 0; i < inlineScripts.length; i++) {
    const body = inlineScripts[i];
    if (!body) continue;
    const source = inlineScripts.length > 1 ? `inline-script#${i}` : 'inline-script';
    const inlineFindings = scanBody(body, source, patterns, seen);
    for (const f of inlineFindings) findings.push(f);
  }

  const passed = !findings.some((f) => f.severity === 'high');

  return {
    page: pageUrl,
    assetsScanned,
    findings,
    passed,
  };
}
