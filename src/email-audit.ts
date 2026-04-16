import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Browser, BrowserContext } from 'playwright';
import type { EmailConfig, EmailResult, EmailIssue, EmailRecord, EmailViewport, EmailRenderProfile } from './types.js';

/**
 * P4 #42 — Email rendering audit.
 *
 * Bridges to a dev SMTP capture with an HTTP API (URL is user-supplied —
 * any service exposing a REST-style list/fetch of captured messages works).
 *
 * For each captured message in the configured time window the audit:
 *   1. Fetches the raw HTML and plain-text bodies and a small set of headers.
 *   2. Renders the HTML via headless Playwright at each configured viewport
 *      (defaults: desktop 600x800 and mobile 375x600).
 *   3. Re-renders the HTML through a handful of "client approximation"
 *      profiles (e.g. `<style>` stripped, plain-text fallback only) to
 *      simulate common webmail quirks — screenshots are saved so reviewers
 *      can spot layout breakage without touching a real mail client.
 *   4. Runs a checklist of issues (see `EmailIssue.type`) — plain-text
 *      alternative present, subject length, missing `alt` on remote images,
 *      dark-mode media query presence, and DKIM/SPF header presence.
 *
 * No brand names are referenced — the capture API is user-configured via
 * `emailCaptureUrl`. Cloud-only: `emailCaptureUrl` may point to a Cloudflare
 * email worker, a hosted capture API, or any HTTP endpoint the user stands up.
 */

const DEFAULT_OUT_DIR = '.uxinspect/emails';
const DEFAULT_VIEWPORTS: EmailViewport[] = [
  { name: 'desktop', width: 600, height: 800 },
  { name: 'mobile', width: 375, height: 600 },
];
const DEFAULT_RENDER_PROFILES: EmailRenderProfile[] = [
  'as-sent',
  'style-stripped',
  'plain-text-fallback',
];
const FETCH_TIMEOUT_MS = 15_000;

const SUBJECT_LINE_ASCII_LIMIT = 78;
const SUBJECT_LINE_MOBILE_LIMIT = 40;

/**
 * Run the email rendering audit end to end.
 *
 * Accepts an optional `browser` so callers that already have a Playwright
 * instance can reuse it; otherwise we lazy-launch one via `playwright`'s
 * chromium driver. Tests pass their own lightweight stubs.
 */
export async function runEmailAudit(
  opts: EmailConfig & {
    browser?: Browser;
    fetchImpl?: typeof fetch;
    /** Skip the Playwright render phase — run only the checklist rules. */
    skipScreenshots?: boolean;
  },
): Promise<EmailResult> {
  const startedAt = new Date().toISOString();
  const outDir = opts.outDir ?? DEFAULT_OUT_DIR;
  const viewports = opts.viewports?.length ? opts.viewports : DEFAULT_VIEWPORTS;
  const renderProfiles = opts.renderProfiles?.length
    ? opts.renderProfiles
    : DEFAULT_RENDER_PROFILES;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  if (!opts.emailCaptureUrl || typeof opts.emailCaptureUrl !== 'string') {
    throw new Error('runEmailAudit: emailCaptureUrl is required');
  }

  const listResult = await fetchMessageList(
    opts.emailCaptureUrl,
    opts.authToken,
    fetchImpl,
  ).catch((err: Error) => ({ error: err.message, messages: [] as RawMessage[] }));

  if ('error' in listResult) {
    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      captureUrl: opts.emailCaptureUrl,
      scanned: 0,
      emails: [],
      issues: [
        {
          type: 'capture-unreachable',
          messageId: '',
          message: `unable to reach capture API: ${listResult.error}`,
        },
      ],
      passed: false,
    };
  }

  const rawMessages = listResult.messages;
  const sinceTs = typeof opts.sinceTs === 'number' ? opts.sinceTs : 0;
  const filtered = rawMessages.filter((m) => {
    if (!sinceTs) return true;
    const ts = parseTs(m.receivedAt);
    return ts >= sinceTs;
  });

  await fs.mkdir(outDir, { recursive: true });

  // Lazy-load Playwright only when we actually have work to render. Callers
  // that pass their own `browser` reuse it; otherwise we dynamically import
  // chromium. When `skipScreenshots` is set (or no messages match), the audit
  // still runs every checklist rule but produces no PNGs.
  let browser = opts.browser;
  let ownsBrowser = false;
  let context: BrowserContext | undefined;
  const wantsScreenshots = !opts.skipScreenshots && filtered.length > 0;
  if (wantsScreenshots) {
    if (!browser) {
      try {
        const { chromium } = await import('playwright');
        browser = await chromium.launch({ headless: true });
        ownsBrowser = true;
      } catch {
        // Playwright unavailable — proceed with checklist-only audit.
        browser = undefined;
      }
    }
    if (browser) context = await browser.newContext();
  }

  const emails: EmailRecord[] = [];
  const issues: EmailIssue[] = [];

  try {
    for (const raw of filtered) {
      const full = await fetchMessageFull(
        opts.emailCaptureUrl,
        raw.id,
        opts.authToken,
        fetchImpl,
      ).catch(() => raw);

      const record = await auditSingleMessage({
        message: full,
        context,
        outDir,
        viewports,
        renderProfiles,
      });
      emails.push(record);
      for (const issue of record.issues) issues.push(issue);
    }
  } finally {
    await context?.close().catch(() => undefined);
    if (ownsBrowser && browser) await browser.close().catch(() => undefined);
  }

  // Any FATAL issue fails the audit. DKIM/SPF in dev is "warn only".
  const fatal = issues.some((i) => FATAL_ISSUES.has(i.type));

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    captureUrl: opts.emailCaptureUrl,
    scanned: emails.length,
    emails,
    issues,
    passed: !fatal,
  };
}

const FATAL_ISSUES: ReadonlySet<EmailIssue['type']> = new Set([
  'missing-plain-text-alternative',
  'subject-too-long',
  'remote-image-missing-alt',
  'capture-unreachable',
  'render-failed',
]);

interface RawMessage {
  id: string;
  subject: string;
  from: string;
  to: string[];
  receivedAt: string;
  htmlBody?: string;
  textBody?: string;
  headers?: Record<string, string>;
  hasPlainTextAlternative?: boolean;
}

interface FetchListResult {
  messages: RawMessage[];
}

async function fetchMessageList(
  url: string,
  authToken: string | undefined,
  fetchImpl: typeof fetch,
): Promise<FetchListResult> {
  const res = await fetchWithTimeout(fetchImpl, url, authHeaders(authToken));
  if (!res.ok) {
    throw new Error(`capture list returned HTTP ${res.status}`);
  }
  const body: unknown = await res.json();
  const arr = Array.isArray(body)
    ? body
    : isObject(body) && Array.isArray((body as { messages?: unknown }).messages)
      ? ((body as { messages: unknown[] }).messages as unknown[])
      : [];
  return { messages: arr.map(parseRaw) };
}

async function fetchMessageFull(
  baseUrl: string,
  id: string,
  authToken: string | undefined,
  fetchImpl: typeof fetch,
): Promise<RawMessage> {
  // If the base URL already looks like a list endpoint, derive the item URL
  // by appending `/{id}` — callers can point emailCaptureUrl at any list
  // endpoint and we will best-effort the per-message fetch.
  const itemUrl = joinUrl(baseUrl, id);
  const res = await fetchWithTimeout(fetchImpl, itemUrl, authHeaders(authToken));
  if (!res.ok) throw new Error(`capture item returned HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (!isObject(body)) throw new Error('capture item body was not an object');
  return parseRaw({ ...body, id: (body as { id?: string }).id ?? id });
}

function parseRaw(input: unknown): RawMessage {
  const raw = isObject(input) ? input : {};
  const id = stringOr(raw['id'] ?? raw['ID'] ?? raw['_id'], '');
  const subject = stringOr(raw['subject'] ?? raw['Subject'], '');
  const from = stringOr(raw['from'] ?? raw['From'], '');
  const toRaw = raw['to'] ?? raw['To'];
  const to = Array.isArray(toRaw)
    ? (toRaw.map((t) => stringOr(t, '')).filter(Boolean) as string[])
    : typeof toRaw === 'string' && toRaw
      ? [toRaw]
      : [];
  const receivedAt = stringOr(
    raw['receivedAt'] ?? raw['date'] ?? raw['Created'] ?? raw['Date'],
    new Date().toISOString(),
  );
  const htmlBody =
    typeof raw['htmlBody'] === 'string'
      ? (raw['htmlBody'] as string)
      : typeof raw['html'] === 'string'
        ? (raw['html'] as string)
        : typeof raw['HTML'] === 'string'
          ? (raw['HTML'] as string)
          : undefined;
  const textBody =
    typeof raw['textBody'] === 'string'
      ? (raw['textBody'] as string)
      : typeof raw['text'] === 'string'
        ? (raw['text'] as string)
        : typeof raw['Text'] === 'string'
          ? (raw['Text'] as string)
          : undefined;
  const headers = isObject(raw['headers']) ? (raw['headers'] as Record<string, string>) : undefined;
  const explicitMultipart =
    typeof raw['hasPlainTextAlternative'] === 'boolean'
      ? (raw['hasPlainTextAlternative'] as boolean)
      : undefined;
  return {
    id,
    subject,
    from,
    to,
    receivedAt,
    htmlBody,
    textBody,
    headers,
    hasPlainTextAlternative: explicitMultipart,
  };
}

interface AuditSingleOpts {
  message: RawMessage;
  context: BrowserContext | undefined;
  outDir: string;
  viewports: EmailViewport[];
  renderProfiles: EmailRenderProfile[];
}

async function auditSingleMessage(opts: AuditSingleOpts): Promise<EmailRecord> {
  const { message, context, outDir, viewports, renderProfiles } = opts;
  const issues: EmailIssue[] = [];
  const screenshots: { viewport: string; profile: EmailRenderProfile; path: string }[] = [];
  const safeId = safeMessageId(message.id);

  // RFC 2046 check — either server-reported or inferred from presence of both bodies.
  const hasPlainText = Boolean(
    message.hasPlainTextAlternative ??
      (typeof message.textBody === 'string' && message.textBody.trim().length > 0),
  );
  if (!hasPlainText) {
    issues.push({
      type: 'missing-plain-text-alternative',
      messageId: message.id,
      message:
        'no plain-text alternative body (RFC 2046 multipart/alternative recommended for transactional email)',
    });
  }

  // Subject length checks (ASCII 78-col soft wrap & mobile preview window).
  const subjectLen = [...message.subject].length;
  if (subjectLen > SUBJECT_LINE_ASCII_LIMIT) {
    issues.push({
      type: 'subject-too-long',
      messageId: message.id,
      message: `subject is ${subjectLen} chars — exceeds RFC 2822 78-char soft limit`,
    });
  } else if (subjectLen > SUBJECT_LINE_MOBILE_LIMIT) {
    issues.push({
      type: 'subject-too-long-mobile',
      messageId: message.id,
      message: `subject is ${subjectLen} chars — may be truncated in mobile preview panes (<${SUBJECT_LINE_MOBILE_LIMIT})`,
    });
  }

  // Remote images without alt text.
  const html = message.htmlBody ?? '';
  if (html) {
    const missingAlt = findRemoteImagesWithoutAlt(html);
    for (const src of missingAlt) {
      issues.push({
        type: 'remote-image-missing-alt',
        messageId: message.id,
        message: `remote image has no alt attribute: ${src}`,
      });
    }
  }

  // Dark-mode media-query presence (bonus, warn only).
  const hasDarkMode = /@media[^{]*prefers-color-scheme\s*:\s*dark/i.test(html);
  if (!hasDarkMode) {
    issues.push({
      type: 'no-dark-mode-styles',
      messageId: message.id,
      message: 'no @media (prefers-color-scheme: dark) rule found (advisory)',
    });
  }

  // DKIM / SPF / Authentication-Results headers (warn when missing — dev env expected).
  const headers = message.headers ?? {};
  const headerKeys = Object.keys(headers).map((k) => k.toLowerCase());
  const hasDkim = headerKeys.some((k) => k === 'dkim-signature');
  const hasSpf = headerKeys.some((k) => k === 'received-spf');
  const hasAuthResults = headerKeys.some((k) => k === 'authentication-results');
  if (!hasDkim && !hasAuthResults) {
    issues.push({
      type: 'missing-dkim',
      messageId: message.id,
      message:
        'no DKIM-Signature or Authentication-Results header (dev capture may strip these — warn only)',
    });
  }
  if (!hasSpf && !hasAuthResults) {
    issues.push({
      type: 'missing-spf',
      messageId: message.id,
      message: 'no Received-SPF or Authentication-Results header (dev capture may strip these — warn only)',
    });
  }

  // Render screenshots across viewports x profiles. Bail out politely when no
  // browser context was provided (unit tests that just want checklist output).
  if (context && html) {
    for (const viewport of viewports) {
      for (const profile of renderProfiles) {
        const renderedHtml = applyRenderProfile(html, message.textBody, profile);
        const file = path.join(
          outDir,
          `${safeId}-${viewport.name}-${profile}.png`,
        );
        try {
          await renderAndShot(context, renderedHtml, viewport, file);
          screenshots.push({ viewport: viewport.name, profile, path: file });
        } catch (err) {
          issues.push({
            type: 'render-failed',
            messageId: message.id,
            message: `render failed (${viewport.name}/${profile}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }
      }
    }
  }

  return {
    id: message.id,
    subject: message.subject,
    from: message.from,
    to: message.to,
    receivedAt: message.receivedAt,
    hasPlainTextAlternative: hasPlainText,
    subjectLength: subjectLen,
    hasDarkModeStyles: hasDarkMode,
    hasDkim,
    hasSpf,
    hasAuthResults,
    screenshots,
    issues,
  };
}

async function renderAndShot(
  context: BrowserContext,
  html: string,
  viewport: EmailViewport,
  outPath: string,
): Promise<void> {
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 10_000 });
    await page.screenshot({ path: outPath, fullPage: true });
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * Approximate cross-client rendering. Some webmail providers strip `<style>`
 * tags, rewrite `<link>` elements, or fall back to plain-text on images-off.
 * We render the message through a handful of worst-case transforms so the
 * reviewer can see how the email degrades without hitting a real mail client.
 */
export function applyRenderProfile(
  html: string,
  textBody: string | undefined,
  profile: EmailRenderProfile,
): string {
  switch (profile) {
    case 'as-sent':
      return wrapFragment(html);
    case 'style-stripped': {
      // Strip <style>...</style> blocks and inline style attributes. Common when
      // webmail clients route mail through a stricter sanitiser.
      const noStyleBlock = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
      const noInline = noStyleBlock.replace(/\sstyle="[^"]*"/gi, '');
      return wrapFragment(noInline);
    }
    case 'plain-text-fallback': {
      const text = textBody && textBody.trim().length
        ? textBody
        : stripTags(html);
      return `<!DOCTYPE html><html><body style="font-family:monospace;white-space:pre-wrap;padding:16px">${escapeHtml(text)}</body></html>`;
    }
    default:
      return wrapFragment(html);
  }
}

function wrapFragment(html: string): string {
  if (/<html[\s>]/i.test(html)) return html;
  return `<!DOCTYPE html><html><body>${html}</body></html>`;
}

function stripTags(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+\n/g, '\n')
    .trim();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Scan HTML for remote images that lack an `alt` attribute. Data-URI images
 * are ignored (inline and typically covered by surrounding text). The audit
 * focuses on *remote* fetches which are the ones that can go wrong when a
 * webmail client strips them.
 */
export function findRemoteImagesWithoutAlt(html: string): string[] {
  const missing: string[] = [];
  const imgRe = /<img\b[^>]*>/gi;
  for (const match of html.matchAll(imgRe)) {
    const tag = match[0];
    const srcMatch = /\ssrc\s*=\s*"([^"]*)"|\ssrc\s*=\s*'([^']*)'/i.exec(tag);
    const src = srcMatch ? srcMatch[1] ?? srcMatch[2] ?? '' : '';
    if (!src) continue;
    if (src.startsWith('data:')) continue;
    if (src.startsWith('cid:')) continue;
    const isRemote = /^https?:\/\//i.test(src) || src.startsWith('//');
    if (!isRemote) continue;
    const altAttr = /\salt\s*=/i.test(tag);
    if (!altAttr) missing.push(src);
  }
  return missing;
}

function safeMessageId(id: string): string {
  return (id || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 96);
}

function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function joinUrl(base: string, suffix: string): string {
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const s = suffix.startsWith('/') ? suffix : `/${suffix}`;
  return `${b}${s}`;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { headers, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringOr(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function parseTs(v: string): number {
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : 0;
}
