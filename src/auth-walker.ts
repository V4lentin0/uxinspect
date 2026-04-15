import { promises as fs } from 'node:fs';
import path from 'node:path';
import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page } from 'playwright';
import { explore, type ExploreOptions } from './explore.js';
import { attachConsoleCapture } from './console-errors.js';
import { fetchSitemapUrls } from './sitemap-flows.js';

export type AuthWalkBrowser = 'chromium' | 'firefox' | 'webkit';

export interface AuthWalkVisit {
  url: string;
  status: number | null;
  errors: string[];
  consoleErrors: string[];
  networkErrors: string[];
  pagesVisited?: number;
  buttonsClicked?: number;
  formsSubmitted?: number;
  durationMs: number;
  errorStates?: string[];
}

export interface AuthWalkFailure {
  url: string;
  error: string;
  durationMs: number;
}

export interface AuthWalkResult {
  visited: AuthWalkVisit[];
  failed: AuthWalkFailure[];
}

export interface AuthWalkerOptions {
  storageStatePath: string;
  routes: string[] | string;
  baseUrl: string;
  perRoute?: (page: Page, url: string) => Promise<void>;
  concurrency?: number;
  browser?: AuthWalkBrowser;
  headless?: boolean;
  explore?: boolean | ExploreOptions;
  navigationTimeoutMs?: number;
  checkErrorStates?: boolean;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_NAV_TIMEOUT_MS = 30_000;
const ERROR_STATE_SELECTORS = [
  '[role="alert"]',
  '[aria-invalid="true"]',
  '.error',
  '.alert-danger',
  '.error-message',
  '.toast-error',
];

function browserLauncher(name: AuthWalkBrowser | undefined) {
  if (name === 'firefox') return firefox;
  if (name === 'webkit') return webkit;
  return chromium;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function looksLikeSitemapUrl(s: string): boolean {
  if (!/^https?:\/\//i.test(s)) return false;
  return /\.xml(\?|#|$)/i.test(s) || /sitemap/i.test(s);
}

function looksLikeGlob(s: string): boolean {
  return /[*?[\]{}]/.test(s);
}

function resolveUrl(base: string, route: string): string {
  try {
    return new URL(route, base).toString();
  } catch {
    return route;
  }
}

function globToRegex(glob: string): RegExp {
  // Convert glob (with *, **, ?) to regex; anchored.
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '.';
    } else if ('.+^$|(){}[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  re += '$';
  return new RegExp(re);
}

async function expandGlobFromFiles(pattern: string, baseUrl: string): Promise<string[]> {
  // Treat the pattern as a path glob against the filesystem, reading each match as a URL list file.
  const dir = path.dirname(pattern.replace(/\*+.*/, ''));
  const existsDir = await pathExists(dir);
  if (!existsDir) return [];
  const regex = globToRegex(pattern);
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    let names: string[] = [];
    try {
      names = await fs.readdir(d);
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(d, name);
      let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        await walk(full);
      } else if (regex.test(full)) {
        try {
          const body = await fs.readFile(full, 'utf8');
          for (const line of body.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
              out.push(resolveUrl(baseUrl, trimmed));
            }
          }
        } catch {
          // skip unreadable file
        }
      }
    }
  };
  await walk(dir);
  return out;
}

export async function resolveRoutes(routes: string[] | string, baseUrl: string): Promise<string[]> {
  if (Array.isArray(routes)) {
    return dedupe(routes.map((r) => resolveUrl(baseUrl, r)));
  }
  const spec = String(routes);

  if (looksLikeSitemapUrl(spec)) {
    const urls = await fetchSitemapUrls(spec).catch(() => [] as string[]);
    return dedupe(urls);
  }

  // If it's a file path that exists, read line-by-line.
  if (await pathExists(spec)) {
    const body = await fs.readFile(spec, 'utf8');
    const urls: string[] = [];
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      urls.push(resolveUrl(baseUrl, trimmed));
    }
    return dedupe(urls);
  }

  if (looksLikeGlob(spec)) {
    const urls = await expandGlobFromFiles(spec, baseUrl);
    return dedupe(urls);
  }

  // Fallback: treat as a single path/URL.
  return dedupe([resolveUrl(baseUrl, spec)]);
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    if (!seen.has(it)) {
      seen.add(it);
      out.push(it);
    }
  }
  return out;
}

async function detectErrorStates(page: Page): Promise<string[]> {
  const selectors = ERROR_STATE_SELECTORS;
  const found: string[] = [];
  for (const sel of selectors) {
    try {
      const count = await page.locator(sel).count();
      if (count > 0) found.push(`${sel} (${count})`);
    } catch {
      // ignore
    }
  }
  return found;
}

async function defaultPerRoute(page: Page, _url: string, opts: AuthWalkerOptions): Promise<{ explore?: { pagesVisited: number; buttonsClicked: number; formsSubmitted: number; errors: string[]; consoleErrors: string[]; networkErrors: string[] }; errorStates: string[] }> {
  const result: { explore?: any; errorStates: string[] } = { errorStates: [] };
  const exploreOpt = opts.explore ?? true;
  if (exploreOpt !== false) {
    const eo = typeof exploreOpt === 'object' ? exploreOpt : {};
    result.explore = await explore(page, eo);
  }
  if (opts.checkErrorStates !== false) {
    result.errorStates = await detectErrorStates(page);
  }
  return result;
}

async function visitOne(
  context: BrowserContext,
  url: string,
  opts: AuthWalkerOptions,
): Promise<{ visit: AuthWalkVisit } | { fail: AuthWalkFailure }> {
  const started = Date.now();
  const page = await context.newPage();
  const consoleCap = attachConsoleCapture(page);
  const networkErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('response', (res) => {
    if (res.status() >= 400) networkErrors.push(`${res.status()} ${res.url()}`);
  });
  try {
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: opts.navigationTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS,
    });
    const status = response?.status() ?? null;
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});

    let perRouteExtras: { explore?: any; errorStates?: string[] } = {};
    if (opts.perRoute) {
      await opts.perRoute(page, url);
      // Still check for error states if requested (independent of explore).
      if (opts.checkErrorStates !== false) {
        perRouteExtras.errorStates = await detectErrorStates(page);
      }
    } else {
      perRouteExtras = await defaultPerRoute(page, url, opts);
    }

    const consoleResult = consoleCap.result();
    const consoleErrors = consoleResult.issues
      .filter((i) => i.type !== 'warning')
      .map((i) => i.message);
    consoleCap.detach();

    const mergedConsoleErrors = perRouteExtras.explore?.consoleErrors
      ? dedupe([...consoleErrors, ...perRouteExtras.explore.consoleErrors])
      : consoleErrors;
    const mergedNetworkErrors = perRouteExtras.explore?.networkErrors
      ? dedupe([...networkErrors, ...perRouteExtras.explore.networkErrors])
      : networkErrors;
    const mergedErrors = perRouteExtras.explore?.errors
      ? dedupe([...pageErrors, ...perRouteExtras.explore.errors])
      : pageErrors;

    const visit: AuthWalkVisit = {
      url,
      status,
      errors: mergedErrors,
      consoleErrors: mergedConsoleErrors,
      networkErrors: mergedNetworkErrors,
      pagesVisited: perRouteExtras.explore?.pagesVisited,
      buttonsClicked: perRouteExtras.explore?.buttonsClicked,
      formsSubmitted: perRouteExtras.explore?.formsSubmitted,
      errorStates: perRouteExtras.errorStates ?? [],
      durationMs: Date.now() - started,
    };
    await page.close().catch(() => {});
    return { visit };
  } catch (e) {
    consoleCap.detach();
    await page.close().catch(() => {});
    const msg = e instanceof Error ? e.message : String(e);
    return { fail: { url, error: msg, durationMs: Date.now() - started } };
  }
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = Math.max(1, Math.min(limit, items.length || 1));
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners: Promise<void>[] = [];
  for (let w = 0; w < n; w++) {
    runners.push(
      (async () => {
        while (true) {
          const i = cursor++;
          if (i >= items.length) return;
          results[i] = await worker(items[i]!, i);
        }
      })(),
    );
  }
  await Promise.all(runners);
  return results;
}

export async function walkAuthGatedRoutes(opts: AuthWalkerOptions): Promise<AuthWalkResult> {
  if (!opts.storageStatePath) {
    throw new Error('walkAuthGatedRoutes requires storageStatePath');
  }
  if (!opts.baseUrl) {
    throw new Error('walkAuthGatedRoutes requires baseUrl');
  }
  if (!(await pathExists(opts.storageStatePath))) {
    throw new Error(`storageStatePath not found: ${opts.storageStatePath}`);
  }

  const urls = await resolveRoutes(opts.routes, opts.baseUrl);
  if (urls.length === 0) {
    return { visited: [], failed: [] };
  }

  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const launcher = browserLauncher(opts.browser);
  const headless = opts.headless ?? true;

  let browser: Browser | undefined;
  const visited: AuthWalkVisit[] = [];
  const failed: AuthWalkFailure[] = [];

  try {
    browser = await launcher.launch({ headless });
    // Each URL gets a fresh context so storageState is always loaded cleanly.
    const results = await runWithConcurrency(urls, concurrency, async (url) => {
      const context = await browser!.newContext({ storageState: opts.storageStatePath });
      try {
        return await visitOne(context, url, opts);
      } finally {
        await context.close().catch(() => {});
      }
    });
    for (const r of results) {
      if ('visit' in r) visited.push(r.visit);
      else failed.push(r.fail);
    }
  } finally {
    await browser?.close().catch(() => {});
  }

  return { visited, failed };
}
