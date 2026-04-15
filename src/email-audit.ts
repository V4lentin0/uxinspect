import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Page } from 'playwright';

export type EmailClient = 'gmail-web' | 'apple-mail-web' | 'outlook-web';

export interface EmailAuditOptions {
  mailpitUrl?: string;
  mailhogUrl?: string;
  triggerAction?: (page: Page) => Promise<void>;
  expectedSubject?: string;
  to?: string;
  clients?: EmailClient[];
  timeoutMs?: number;
  pollMs?: number;
  outputDir?: string;
  beforeSnapshotMs?: number;
  viewport?: { width: number; height: number };
}

export interface EmailAuditIssue {
  client: EmailClient;
  issue: string;
  severity: 'info' | 'warning' | 'error';
}

export interface EmailAuditResult {
  emailFound: boolean;
  provider?: 'mailpit' | 'mailhog';
  subject?: string;
  from?: string;
  to?: string[];
  htmlBody?: string;
  textBody?: string;
  messageId?: string;
  screenshots: Partial<Record<EmailClient, string>>;
  issues: EmailAuditIssue[];
  warnings: string[];
  skipped?: boolean;
  skipReason?: string;
  passed: boolean;
}

interface RawEmailSummary {
  id: string;
  subject: string;
  from: string;
  to: string[];
  created: string;
}

interface RawEmail {
  id: string;
  subject: string;
  from: string;
  to: string[];
  html?: string;
  text?: string;
  created: string;
}

const DEFAULT_MAILPIT_URL = 'http://localhost:8025';
const DEFAULT_MAILHOG_URL = 'http://localhost:8025';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_CLIENTS: EmailClient[] = ['gmail-web', 'apple-mail-web', 'outlook-web'];
const REACHABILITY_TIMEOUT_MS = 2_000;

const CLIENT_VIEWPORTS: Record<EmailClient, { width: number; height: number }> = {
  'gmail-web': { width: 760, height: 900 },
  'apple-mail-web': { width: 720, height: 900 },
  'outlook-web': { width: 820, height: 900 },
};

export async function auditEmailRendering(
  page: Page,
  opts: EmailAuditOptions = {},
): Promise<EmailAuditResult> {
  const clients = opts.clients && opts.clients.length ? opts.clients : DEFAULT_CLIENTS;
  const outputDir = opts.outputDir ?? path.join(process.cwd(), 'uxinspect-report', 'email');
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const mailpitUrl = opts.mailpitUrl ?? DEFAULT_MAILPIT_URL;
  const mailhogUrl = opts.mailhogUrl ?? DEFAULT_MAILHOG_URL;

  const warnings: string[] = [];
  const issues: EmailAuditIssue[] = [];
  const screenshots: Partial<Record<EmailClient, string>> = {};

  const mailpitReachable = await isReachable(mailpitUrl + '/api/v1/info');
  let mailhogReachable = false;
  if (!mailpitReachable && mailhogUrl !== mailpitUrl) {
    mailhogReachable = await isReachable(mailhogUrl + '/api/v2/messages');
  }

  const provider: 'mailpit' | 'mailhog' | undefined = mailpitReachable
    ? 'mailpit'
    : mailhogReachable
      ? 'mailhog'
      : undefined;

  if (!provider) {
    return {
      emailFound: false,
      screenshots: {},
      issues: [],
      warnings: [
        `mailpit unreachable at ${mailpitUrl}`,
        `mailhog unreachable at ${mailhogUrl}`,
      ],
      skipped: true,
      skipReason: 'neither mailpit nor mailhog reachable',
      passed: true,
    };
  }

  const baseUrl = provider === 'mailpit' ? mailpitUrl : mailhogUrl;

  const beforeIds = await listMessages(provider, baseUrl)
    .then((list) => new Set(list.map((m) => m.id)))
    .catch(() => new Set<string>());

  if (opts.triggerAction) {
    try {
      await opts.triggerAction(page);
    } catch (e: any) {
      warnings.push(`triggerAction threw: ${e?.message ?? String(e)}`);
    }
  }

  const email = await pollForNewEmail(provider, baseUrl, {
    beforeIds,
    expectedSubject: opts.expectedSubject,
    to: opts.to,
    timeoutMs,
    pollMs,
  });

  if (!email) {
    return {
      emailFound: false,
      provider,
      screenshots: {},
      issues: [],
      warnings: [...warnings, `no matching email received within ${timeoutMs}ms`],
      passed: false,
    };
  }

  const html = email.html ?? '';
  const text = email.text ?? '';

  if (!html && !text) {
    warnings.push('email has no html or text body');
  }

  await fs.mkdir(outputDir, { recursive: true }).catch(() => {});
  const slug = slugify(email.subject || email.id || 'email');

  for (const client of clients) {
    try {
      const shotPath = path.join(outputDir, `${slug}.${client}.png`);
      const clientIssues = await renderClientScreenshot(page, html, client, shotPath, opts);
      screenshots[client] = shotPath;
      for (const ci of clientIssues) issues.push(ci);
    } catch (e: any) {
      issues.push({
        client,
        issue: `render failed: ${e?.message ?? String(e)}`,
        severity: 'error',
      });
    }
  }

  const passed = issues.every((i) => i.severity !== 'error');

  return {
    emailFound: true,
    provider,
    subject: email.subject,
    from: email.from,
    to: email.to,
    htmlBody: html || undefined,
    textBody: text || undefined,
    messageId: email.id,
    screenshots,
    issues,
    warnings,
    passed,
  };
}

async function renderClientScreenshot(
  page: Page,
  html: string,
  client: EmailClient,
  outPath: string,
  opts: EmailAuditOptions,
): Promise<EmailAuditIssue[]> {
  const issues: EmailAuditIssue[] = [];
  const viewport = opts.viewport ?? CLIENT_VIEWPORTS[client];

  // Static HTML analysis for client-specific constraints.
  if (html) {
    if (client === 'gmail-web' && /<style[^>]*>[\s\S]*?<\/style>/i.test(html)) {
      // Gmail strips <style> in embedded blocks for some configs; flag informational.
      if (!/data-embedded-safe/.test(html)) {
        issues.push({
          client,
          issue: '<style> blocks may be stripped by Gmail; inline critical CSS',
          severity: 'warning',
        });
      }
    }
    if (client === 'outlook-web' && /display\s*:\s*flex/i.test(html)) {
      issues.push({
        client,
        issue: 'flexbox in email breaks in Outlook; use tables for layout',
        severity: 'warning',
      });
    }
    if (client === 'outlook-web' && /position\s*:\s*(absolute|fixed)/i.test(html)) {
      issues.push({
        client,
        issue: 'absolute/fixed positioning not supported in Outlook',
        severity: 'warning',
      });
    }
    if (/<script[\s>]/i.test(html)) {
      issues.push({
        client,
        issue: '<script> tags are stripped by every major webmail client',
        severity: 'warning',
      });
    }
    if (/on(click|load|error|mouseover)=/i.test(html)) {
      issues.push({
        client,
        issue: 'inline event handlers are stripped by every major webmail client',
        severity: 'warning',
      });
    }
    const imgNoAlt = html.match(/<img\b(?![^>]*\balt=)[^>]*>/gi);
    if (imgNoAlt && imgNoAlt.length) {
      issues.push({
        client,
        issue: `${imgNoAlt.length} <img> without alt attribute (hurts accessibility + blocked-image fallback)`,
        severity: 'info',
      });
    }
  }

  const renderedHtml = wrapForClient(html, client);
  const encoded = Buffer.from(renderedHtml, 'utf8').toString('base64');
  const dataUrl = `data:text/html;base64,${encoded}`;

  const previous = page.viewportSize();
  try {
    await page.setViewportSize(viewport);
    await page.goto(dataUrl, { waitUntil: 'load', timeout: 10_000 });
    if (opts.beforeSnapshotMs && opts.beforeSnapshotMs > 0) {
      await page.waitForTimeout(opts.beforeSnapshotMs);
    }
    await page.screenshot({ path: outPath, fullPage: true });
  } finally {
    if (previous) {
      await page.setViewportSize(previous).catch(() => {});
    }
  }

  return issues;
}

function wrapForClient(html: string, client: EmailClient): string {
  const css = clientResetCss(client);
  const body = html || '<p style="font-family:system-ui;color:#6b7280">(empty email)</p>';

  if (client === 'gmail-web') {
    // Gmail strips <style> and <link> in the email body. Simulate by injecting
    // only inline-style-safe wrapper; <style> content will still render in a
    // browser iframe but we drop <style> blocks to approximate.
    const stripped = body.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    return baseDoc(css, stripped);
  }

  if (client === 'outlook-web') {
    // Outlook.com on the web supports most CSS but not flexbox/grid reliably.
    // Keep as-is but with reset CSS.
    return baseDoc(css, body);
  }

  // apple-mail-web: very permissive, keep everything.
  return baseDoc(css, body);
}

function baseDoc(css: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`;
}

function clientResetCss(client: EmailClient): string {
  const common = `body{margin:0;padding:16px;font-family:Arial,Helvetica,sans-serif;background:#f5f5f5;color:#1f2937;} img{max-width:100%;height:auto;border:0;}`;
  if (client === 'gmail-web') {
    return common + `body{font-family:Arial,sans-serif;} a{color:#1a73e8;}`;
  }
  if (client === 'outlook-web') {
    return (
      common +
      `body{font-family:'Segoe UI',Arial,sans-serif;} *{-ms-text-size-adjust:100%;} table{border-collapse:collapse;}`
    );
  }
  // apple-mail-web
  return common + `body{font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',sans-serif;}`;
}

async function isReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(REACHABILITY_TIMEOUT_MS),
    });
    return res.ok || res.status === 404 || res.status === 405;
  } catch {
    return false;
  }
}

async function pollForNewEmail(
  provider: 'mailpit' | 'mailhog',
  baseUrl: string,
  opts: {
    beforeIds: Set<string>;
    expectedSubject?: string;
    to?: string;
    timeoutMs: number;
    pollMs: number;
  },
): Promise<RawEmail | null> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await listMessages(provider, baseUrl);
      const fresh = list.filter((m) => !opts.beforeIds.has(m.id));
      const match = fresh.find((m) => matchesFilters(m, opts));
      if (match) {
        const hydrated = await fetchMessage(provider, baseUrl, match.id);
        if (hydrated) return hydrated;
      }
    } catch {
      // swallow; continue polling until deadline
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(opts.pollMs, remaining));
  }
  return null;
}

function matchesFilters(
  m: RawEmailSummary,
  opts: { expectedSubject?: string; to?: string },
): boolean {
  if (opts.expectedSubject && !m.subject.includes(opts.expectedSubject)) return false;
  if (opts.to) {
    const needle = opts.to.toLowerCase();
    if (!m.to.some((t) => t.toLowerCase().includes(needle))) return false;
  }
  return true;
}

async function listMessages(
  provider: 'mailpit' | 'mailhog',
  baseUrl: string,
): Promise<RawEmailSummary[]> {
  if (provider === 'mailpit') {
    const res = await fetch(joinUrl(baseUrl, '/api/v1/messages'), {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`mailpit list ${res.status}`);
    const data = (await res.json()) as any;
    const arr = Array.isArray(data?.messages) ? data.messages : [];
    return arr.map(parseMailpitSummary);
  }
  const res = await fetch(joinUrl(baseUrl, '/api/v2/messages'), {
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`mailhog list ${res.status}`);
  const data = (await res.json()) as any;
  const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
  return items.map(parseMailhogSummary);
}

async function fetchMessage(
  provider: 'mailpit' | 'mailhog',
  baseUrl: string,
  id: string,
): Promise<RawEmail | null> {
  if (provider === 'mailpit') {
    const res = await fetch(
      joinUrl(baseUrl, `/api/v1/message/${encodeURIComponent(id)}`),
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    return {
      id,
      subject: String(data?.Subject ?? ''),
      from: addrString(data?.From) || '',
      to: Array.isArray(data?.To) ? data.To.map(addrString).filter(Boolean) : [],
      html: typeof data?.HTML === 'string' ? data.HTML : undefined,
      text: typeof data?.Text === 'string' ? data.Text : undefined,
      created: String(data?.Date ?? new Date().toISOString()),
    };
  }
  const res = await fetch(
    joinUrl(baseUrl, `/api/v1/messages/${encodeURIComponent(id)}`),
    { signal: AbortSignal.timeout(5_000) },
  );
  if (!res.ok) return null;
  const data = (await res.json()) as any;
  const html = extractMailhogBody(data, 'text/html');
  const text = extractMailhogBody(data, 'text/plain');
  return {
    id,
    subject: getMailhogHeader(data, 'Subject') ?? '',
    from: getMailhogHeader(data, 'From') ?? '',
    to: getMailhogHeaders(data, 'To'),
    html: html || undefined,
    text: text || undefined,
    created: String(data?.Created ?? new Date().toISOString()),
  };
}

function parseMailpitSummary(raw: any): RawEmailSummary {
  return {
    id: String(raw?.ID ?? ''),
    subject: String(raw?.Subject ?? ''),
    from: addrString(raw?.From),
    to: Array.isArray(raw?.To) ? raw.To.map(addrString).filter(Boolean) : [],
    created: String(raw?.Created ?? ''),
  };
}

function parseMailhogSummary(raw: any): RawEmailSummary {
  return {
    id: String(raw?.ID ?? raw?.id ?? ''),
    subject: getMailhogHeader(raw, 'Subject') ?? '',
    from: getMailhogHeader(raw, 'From') ?? '',
    to: getMailhogHeaders(raw, 'To'),
    created: String(raw?.Created ?? ''),
  };
}

function getMailhogHeader(raw: any, name: string): string | undefined {
  const headers = raw?.Content?.Headers ?? raw?.Raw?.Headers;
  if (!headers) return undefined;
  const v = headers[name];
  return Array.isArray(v) && v.length ? String(v[0]) : undefined;
}

function getMailhogHeaders(raw: any, name: string): string[] {
  const headers = raw?.Content?.Headers ?? raw?.Raw?.Headers;
  if (!headers) return [];
  const v = headers[name];
  return Array.isArray(v) ? v.map(String) : [];
}

function extractMailhogBody(raw: any, mime: string): string {
  const parts = raw?.MIME?.Parts;
  if (Array.isArray(parts)) {
    for (const p of parts) {
      const ct = p?.Headers?.['Content-Type']?.[0] ?? '';
      if (ct.toLowerCase().includes(mime)) {
        return String(p?.Body ?? '');
      }
    }
  }
  const ct = (raw?.Content?.Headers?.['Content-Type']?.[0] ?? '').toLowerCase();
  if (ct.includes(mime)) {
    return String(raw?.Content?.Body ?? '');
  }
  return '';
}

function addrString(a: any): string {
  if (!a) return '';
  if (typeof a === 'string') return a;
  const addr = a.Address ?? a.address ?? '';
  const name = a.Name ?? a.name ?? '';
  if (addr && name) return `${name} <${addr}>`;
  return addr || name || '';
}

function joinUrl(base: string, path: string): string {
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'email';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
