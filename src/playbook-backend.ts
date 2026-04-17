/**
 * P6 #52 + #55 — Backend testing playbook: the server-side / infra mirror of the
 * frontend playbook introduced in P5 #46. Pivot 2026-04-17 — a single flag
 * that enables every uxinspect gate relevant to a modern Cloudflare Workers
 * / D1 / edge-deployed backend in one pass.
 *
 * The user asked for "all relevant backend tests in 1 plugin so I won't need
 * to use so many". `uxinspect run --playbook-backend <url>` turns on the
 * consolidated set below so the consumer never has to remember which flags
 * to stack for server headers, TLS, DNS, cookies, auth edges, race
 * conditions, redirects, exposed paths, crawl coverage, and friends.
 *
 * Each entry documents the bug class it catches. Gates that are pure
 * frontend (axe, visual diff, Lighthouse metrics, hydration, focus traps,
 * pseudo-locale overflow, etc.) are deliberately excluded — they're covered
 * by the frontend playbook and would add wall-clock cost without catching
 * backend regressions. The final entry (`humanPassBackend`) runs LAST — it is the debugger-persona gate that exercises every endpoint after all preceding gates pass.
 */
import type { ChecksConfig } from './types.js';

export interface BackendPlaybookEntry {
  /** ChecksConfig field turned on by the playbook. */
  readonly check: keyof ChecksConfig;
  /** One-line rationale — what bug class this catches. */
  readonly catches: string;
}

/**
 * Canonical backend playbook — the server-side / infra gates that must pass
 * before a feature ships. Order is stable for deterministic docs/reporting.
 */
export const BACKEND_PLAYBOOK_ENTRIES: readonly BackendPlaybookEntry[] = [
  { check: 'security', catches: 'CSP / HSTS / X-Frame-Options / X-Content-Type-Options / Referrer-Policy header coverage' },
  { check: 'tls', catches: 'TLS version, cert chain, OCSP, expiry, weak ciphers' },
  { check: 'sitemap', catches: 'sitemap.xml presence, validity, URL reachability' },
  { check: 'robotsAudit', catches: 'robots.txt presence, syntax, sitemap declaration, sensitive-path leaks' },
  { check: 'redirects', catches: 'redirect chains, loops, hop count, http to https upgrade' },
  { check: 'exposedPaths', catches: 'common dev/admin/secret paths reachable in prod (.env, .git, /admin, /debug)' },
  { check: 'mixedContent', catches: 'http subresources loaded over an https origin' },
  { check: 'compression', catches: 'gzip / brotli enablement on text assets' },
  { check: 'cacheHeaders', catches: 'cache-control / etag / immutable hashing on static assets' },
  { check: 'crawl', catches: 'site-wide crawl: orphan pages, broken internal links, depth budget' },
  { check: 'links', catches: 'broken outbound and internal links (4xx / 5xx / ERR)' },
  { check: 'errorPages', catches: '404 / 500 status codes with correct shell rendering' },
  { check: 'protocols', catches: 'HTTP/2 + HTTP/3 negotiation for top assets' },
  { check: 'sourcemapScan', catches: 'production .map files exposed publicly' },
  { check: 'sri', catches: 'third-party script/style SRI hashes present' },
  { check: 'clickjacking', catches: 'X-Frame-Options / frame-ancestors clickjacking defense' },
  { check: 'csrf', catches: 'CSRF token + SameSite cookie defense for state-changing routes' },
  { check: 'cookieFlags', catches: 'Secure / HttpOnly / SameSite cookie flags' },
  { check: 'emailAudit', catches: 'SPF / DKIM / DMARC / MX DNS records' },
  { check: 'authEdge', catches: 'auth endpoint edge cases (rate-limit, lockout, session fixation, token reuse)' },
  { check: 'offline', catches: 'service worker offline / stale-while-revalidate behavior' },
  { check: 'prerenderAudit', catches: 'prerendered HTML diverging from hydrated output (SEO crawler view)' },
  { check: 'humanPassBackend', catches: 'debugger persona: probes every endpoint with payload variants (baseline/empty/invalid/oversize/malformed-json/unicode/auth-strip/cors-probe) + full req/resp dumps before+after every call — final backend gate' },
];

/**
 * Merge backend-playbook-enabled checks onto whatever the caller already
 * set. Any check the caller explicitly enabled or disabled wins — the
 * playbook only fills in gaps. This lets `--playbook-backend --no-tls` work
 * intuitively.
 */
export function applyBackendPlaybookChecks(existing: ChecksConfig | undefined): ChecksConfig {
  const next: ChecksConfig = { ...(existing ?? {}) };
  for (const entry of BACKEND_PLAYBOOK_ENTRIES) {
    if (next[entry.check] === undefined) {
      (next as Record<string, unknown>)[entry.check] = true;
    }
  }
  return next;
}

/**
 * Pretty-print the backend playbook coverage map for CLI
 * `--playbook-backend --list` so the user can see exactly which gates are
 * on and what each catches.
 */
export function formatBackendPlaybook(): string {
  const width = Math.max(...BACKEND_PLAYBOOK_ENTRIES.map((e) => e.check.length));
  const lines = [
    `uxinspect backend playbook — ${BACKEND_PLAYBOOK_ENTRIES.length} gates`,
    '',
    ...BACKEND_PLAYBOOK_ENTRIES.map(
      (e) => `  ${String(e.check).padEnd(width)}  ${e.catches}`,
    ),
  ];
  return lines.join('\n');
}
