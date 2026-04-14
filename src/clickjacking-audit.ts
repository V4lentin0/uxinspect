import type { Page, BrowserContext } from 'playwright';

export interface ClickjackingResult {
  page: string;
  xFrameOptions: string | null;
  cspFrameAncestors: string | null;
  embeddingAllowed: boolean;
  embedError?: string;
  protections: {
    hasXFO: boolean;
    xfoDenies: boolean;
    hasCspFA: boolean;
    cspDenies: boolean;
  };
  severity: 'high' | 'medium' | 'low' | 'none';
  passed: boolean;
}

interface HeaderPair {
  xFrameOptions: string | null;
  contentSecurityPolicy: string | null;
}

interface IframeProbeResult {
  embeddingAllowed: boolean;
  embedError?: string;
}

const IFRAME_WAIT_MS = 3000;
const REQUEST_TIMEOUT_MS = 5000;

function normalizeHeaderValue(value: string | string[] | null | undefined): string | null {
  if (value == null) return null;
  if (Array.isArray(value)) return value.join(', ');
  return value;
}

function pickHeader(headers: Record<string, string>, name: string): string | null {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      const v = headers[key];
      return typeof v === 'string' ? v : null;
    }
  }
  return null;
}

function extractFrameAncestors(csp: string | null): string | null {
  if (!csp) return null;
  const policies = csp.split(',');
  for (const policy of policies) {
    const directives = policy.split(';');
    for (const directive of directives) {
      const trimmed = directive.trim();
      if (!trimmed) continue;
      const idx = trimmed.indexOf(' ');
      const name = (idx >= 0 ? trimmed.slice(0, idx) : trimmed).toLowerCase();
      if (name === 'frame-ancestors') {
        const value = idx >= 0 ? trimmed.slice(idx + 1).trim() : '';
        return value;
      }
    }
  }
  return null;
}

function evaluateXfo(xfo: string | null): boolean {
  if (!xfo) return false;
  const v = xfo.trim().toLowerCase();
  return /^(deny|sameorigin)$/i.test(v);
}

function evaluateCspFrameAncestors(value: string | null): boolean {
  if (!value) return false;
  const tokens = value
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return false;
  if (tokens.some((t) => t.toLowerCase() === "'none'")) return true;
  if (tokens.length === 1 && tokens[0]!.toLowerCase() === "'self'") return true;
  return false;
}

async function fetchTargetHeaders(ctx: BrowserContext, url: string): Promise<HeaderPair> {
  try {
    const res = await ctx.request.get(url, {
      maxRedirects: 0,
      timeout: REQUEST_TIMEOUT_MS,
      failOnStatusCode: false,
    });
    const raw = res.headers();
    const xfo = normalizeHeaderValue(pickHeader(raw, 'x-frame-options'));
    const csp = normalizeHeaderValue(pickHeader(raw, 'content-security-policy'));
    return { xFrameOptions: xfo, contentSecurityPolicy: csp };
  } catch {
    return { xFrameOptions: null, contentSecurityPolicy: null };
  }
}

interface NavigationEntrySnapshot {
  name: string;
  type: string;
}

async function getNavigationEntry(page: Page): Promise<NavigationEntrySnapshot | null> {
  try {
    return await page.evaluate((): NavigationEntrySnapshot | null => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      if (!nav) return null;
      return { name: nav.name, type: nav.type };
    });
  } catch {
    return null;
  }
}

async function probeIframeEmbedding(ctx: BrowserContext, target: string): Promise<IframeProbeResult> {
  let probe: Page | null = null;
  try {
    probe = await ctx.newPage();
  } catch (err) {
    return { embeddingAllowed: false, embedError: err instanceof Error ? err.message : 'failed to open probe page' };
  }

  const consoleErrors: string[] = [];
  probe.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (/x-frame-options|frame-ancestors|refused to (display|frame)/i.test(text)) {
        consoleErrors.push(text);
      }
    }
  });
  probe.on('pageerror', (err) => {
    consoleErrors.push(err.message);
  });

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head><body><iframe id="probe-frame" src="${target.replace(/"/g, '&quot;')}" style="width:800px;height:600px" sandbox="allow-same-origin allow-scripts"></iframe></body></html>`;

  try {
    await probe.setContent(html, { waitUntil: 'load', timeout: REQUEST_TIMEOUT_MS });
  } catch (err) {
    try {
      await probe.close();
    } catch {
      /* ignore */
    }
    return { embeddingAllowed: false, embedError: err instanceof Error ? err.message : 'setContent failed' };
  }

  let loaded = false;
  let loadError: string | undefined;
  try {
    await probe.waitForFunction(
      (): boolean => {
        const el = document.getElementById('probe-frame');
        if (!(el instanceof HTMLIFrameElement)) return false;
        try {
          const doc = el.contentDocument;
          if (doc && doc.body) return true;
        } catch {
          return true;
        }
        return false;
      },
      undefined,
      { timeout: IFRAME_WAIT_MS },
    );
    loaded = true;
  } catch (err) {
    loadError = err instanceof Error ? err.message : 'iframe did not load';
  }

  let embeddingAllowed = false;
  if (loaded) {
    try {
      embeddingAllowed = await probe.evaluate((): boolean => {
        const el = document.getElementById('probe-frame');
        if (!(el instanceof HTMLIFrameElement)) return false;
        try {
          const doc = el.contentDocument;
          if (!doc) return false;
          const body = doc.body;
          if (!body) return false;
          const hasContent = body.children.length > 0 || (body.textContent ?? '').trim().length > 0;
          return hasContent;
        } catch {
          return false;
        }
      });
    } catch {
      embeddingAllowed = false;
    }
  }

  if (!embeddingAllowed && consoleErrors.length > 0) {
    loadError = loadError ? `${loadError}; ${consoleErrors[0]}` : consoleErrors[0];
  }

  try {
    await probe.close();
  } catch {
    /* ignore */
  }

  return {
    embeddingAllowed,
    embedError: embeddingAllowed ? undefined : loadError,
  };
}

function computeSeverity(
  embeddingAllowed: boolean,
  hasXFO: boolean,
  xfoDenies: boolean,
  hasCspFA: boolean,
  cspDenies: boolean,
): 'high' | 'medium' | 'low' | 'none' {
  if (xfoDenies || cspDenies) return 'none';
  if (embeddingAllowed) {
    if (!hasXFO && !hasCspFA) return 'high';
    return 'medium';
  }
  if (!hasXFO && !hasCspFA) return 'low';
  return 'low';
}

export async function auditClickjacking(page: Page, ctx: BrowserContext): Promise<ClickjackingResult> {
  const target = page.url();

  const navEntry = await getNavigationEntry(page);
  const fetchUrl = navEntry?.name && /^https?:/i.test(navEntry.name) ? navEntry.name : target;
  const headers: HeaderPair = await fetchTargetHeaders(ctx, fetchUrl);

  const xFrameOptions = headers.xFrameOptions;
  const cspFrameAncestors = extractFrameAncestors(headers.contentSecurityPolicy);

  const hasXFO = xFrameOptions !== null && xFrameOptions.trim().length > 0;
  const xfoDenies = evaluateXfo(xFrameOptions);
  const hasCspFA = cspFrameAncestors !== null && cspFrameAncestors.trim().length > 0;
  const cspDenies = evaluateCspFrameAncestors(cspFrameAncestors);

  const probe = await probeIframeEmbedding(ctx, target);
  const embeddingAllowed = probe.embeddingAllowed;
  const embedError = probe.embedError;

  const severity = computeSeverity(embeddingAllowed, hasXFO, xfoDenies, hasCspFA, cspDenies);
  const passed = xfoDenies || cspDenies || !embeddingAllowed;

  const result: ClickjackingResult = {
    page: target,
    xFrameOptions,
    cspFrameAncestors,
    embeddingAllowed,
    protections: {
      hasXFO,
      xfoDenies,
      hasCspFA,
      cspDenies,
    },
    severity,
    passed,
  };
  if (embedError !== undefined) result.embedError = embedError;
  return result;
}
