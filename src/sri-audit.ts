import type { Page } from 'playwright';
import { createHash } from 'node:crypto';

export type SriIssueKind =
  | 'missing-integrity'
  | 'missing-crossorigin'
  | 'invalid-algorithm'
  | 'hash-mismatch'
  | 'weak-algorithm'
  | 'unreachable-asset';

export interface SriEntry {
  url: string;
  element: 'script' | 'link';
  crossOrigin: boolean;
  integrity?: string;
  algorithm?: 'sha256' | 'sha384' | 'sha512' | 'unknown';
  sameOrigin: boolean;
}

export interface SriIssue {
  kind: SriIssueKind;
  url: string;
  message: string;
}

export interface SriAuditResult {
  page: string;
  entries: SriEntry[];
  issues: SriIssue[];
  passed: boolean;
}

interface RawAsset {
  url: string;
  tag: 'script' | 'link';
  integrity: string | null;
  crossorigin: string | null;
}

interface DomSnapshot {
  origin: string;
  assets: RawAsset[];
}

type KnownAlgorithm = 'sha256' | 'sha384' | 'sha512';

const HASH_MISMATCH_CAP = 20;

function isKnownAlgorithm(value: string): value is KnownAlgorithm {
  return value === 'sha256' || value === 'sha384' || value === 'sha512';
}

function parseAlgorithm(integrity: string | null | undefined): SriEntry['algorithm'] {
  if (!integrity) return undefined;
  const firstToken = integrity.trim().split(/\s+/)[0];
  if (!firstToken) return undefined;
  const dashIdx = firstToken.indexOf('-');
  if (dashIdx <= 0) return 'unknown';
  const prefix = firstToken.slice(0, dashIdx).toLowerCase();
  if (isKnownAlgorithm(prefix)) return prefix;
  return 'unknown';
}

function pickStrongestHash(integrity: string): { algorithm: KnownAlgorithm; hash: string } | null {
  const tokens = integrity.trim().split(/\s+/).filter(Boolean);
  const rank: Record<KnownAlgorithm, number> = { sha256: 1, sha384: 2, sha512: 3 };
  let best: { algorithm: KnownAlgorithm; hash: string } | null = null;
  for (const token of tokens) {
    const dashIdx = token.indexOf('-');
    if (dashIdx <= 0) continue;
    const prefix = token.slice(0, dashIdx).toLowerCase();
    const hash = token.slice(dashIdx + 1);
    if (!hash) continue;
    if (!isKnownAlgorithm(prefix)) continue;
    if (!best || rank[prefix] > rank[best.algorithm]) {
      best = { algorithm: prefix, hash };
    }
  }
  return best;
}

function isSameOrigin(assetUrl: string, pageOrigin: string): boolean {
  try {
    const parsed = new URL(assetUrl, pageOrigin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;
    return parsed.origin === pageOrigin;
  } catch {
    return true;
  }
}

function collectSnapshot(page: Page): Promise<DomSnapshot> {
  return page.evaluate((): DomSnapshot => {
    const out: RawAsset[] = [];
    const scripts = document.querySelectorAll('script[src]');
    scripts.forEach((el) => {
      const s = el as HTMLScriptElement;
      const src = s.getAttribute('src');
      if (!src) return;
      out.push({
        url: s.src || src,
        tag: 'script',
        integrity: s.getAttribute('integrity'),
        crossorigin: s.getAttribute('crossorigin'),
      });
    });
    const links = document.querySelectorAll('link[rel~="stylesheet" i][href]');
    links.forEach((el) => {
      const l = el as HTMLLinkElement;
      const href = l.getAttribute('href');
      if (!href) return;
      out.push({
        url: l.href || href,
        tag: 'link',
        integrity: l.getAttribute('integrity'),
        crossorigin: l.getAttribute('crossorigin'),
      });
    });
    return { origin: location.origin, assets: out };
  });
}

function buildEntry(raw: RawAsset, pageOrigin: string): SriEntry {
  const integrity = raw.integrity?.trim() || undefined;
  const entry: SriEntry = {
    url: raw.url,
    element: raw.tag,
    crossOrigin: typeof raw.crossorigin === 'string',
    sameOrigin: isSameOrigin(raw.url, pageOrigin),
  };
  if (integrity) entry.integrity = integrity;
  const algorithm = parseAlgorithm(integrity);
  if (algorithm) entry.algorithm = algorithm;
  return entry;
}

function pushIssue(issues: SriIssue[], kind: SriIssueKind, url: string, message: string): void {
  issues.push({ kind, url, message });
}

function evaluateStaticIssues(entry: SriEntry, issues: SriIssue[]): void {
  if (entry.sameOrigin) return;
  if (!entry.integrity) {
    pushIssue(
      issues,
      'missing-integrity',
      entry.url,
      `Third-party ${entry.element} has no integrity attribute`,
    );
    return;
  }
  if (!entry.crossOrigin) {
    pushIssue(
      issues,
      'missing-crossorigin',
      entry.url,
      `Third-party ${entry.element} has integrity but no crossorigin attribute`,
    );
  }
  if (entry.algorithm === 'unknown') {
    pushIssue(
      issues,
      'invalid-algorithm',
      entry.url,
      `Integrity algorithm is not a recognised SHA variant`,
    );
  } else if (entry.algorithm === 'sha256') {
    pushIssue(
      issues,
      'weak-algorithm',
      entry.url,
      `sha256 is weak for SRI; prefer sha384 or sha512`,
    );
  }
}

function normaliseBase64(input: string): string {
  return input.replace(/=+$/, '');
}

async function verifyHash(
  page: Page,
  entry: SriEntry,
  issues: SriIssue[],
): Promise<void> {
  if (!entry.integrity) return;
  const strongest = pickStrongestHash(entry.integrity);
  if (!strongest) return;
  let status = 0;
  let body: Buffer | null = null;
  try {
    const response = await page.request.get(entry.url, { failOnStatusCode: false });
    status = response.status();
    if (status >= 400) {
      pushIssue(
        issues,
        'unreachable-asset',
        entry.url,
        `Fetch returned HTTP ${status}`,
      );
      return;
    }
    body = await response.body();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    pushIssue(issues, 'unreachable-asset', entry.url, `Fetch failed: ${reason}`);
    return;
  }
  if (!body) return;
  const digest = createHash(strongest.algorithm).update(body).digest('base64');
  if (normaliseBase64(digest) !== normaliseBase64(strongest.hash)) {
    pushIssue(
      issues,
      'hash-mismatch',
      entry.url,
      `Computed ${strongest.algorithm} hash does not match integrity attribute`,
    );
  }
}

function computePassed(issues: SriIssue[]): boolean {
  for (const issue of issues) {
    if (
      issue.kind === 'missing-integrity' ||
      issue.kind === 'hash-mismatch' ||
      issue.kind === 'unreachable-asset'
    ) {
      return false;
    }
  }
  return true;
}

export async function auditSri(page: Page): Promise<SriAuditResult> {
  const pageUrl = page.url();
  const snapshot = await collectSnapshot(page);
  const entries: SriEntry[] = snapshot.assets.map((raw) => buildEntry(raw, snapshot.origin));
  const issues: SriIssue[] = [];

  for (const entry of entries) {
    evaluateStaticIssues(entry, issues);
  }

  const verifiable = entries.filter(
    (e) => !e.sameOrigin && e.integrity && e.algorithm && e.algorithm !== 'unknown',
  );
  const toVerify = verifiable.slice(0, HASH_MISMATCH_CAP);
  for (const entry of toVerify) {
    await verifyHash(page, entry, issues);
  }

  return {
    page: pageUrl,
    entries,
    issues,
    passed: computePassed(issues),
  };
}
