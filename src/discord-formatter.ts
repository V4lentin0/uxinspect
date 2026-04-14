import type { InspectResult } from './types.js';

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  timestamp?: string;
  fields?: DiscordEmbedField[];
  footer?: { text: string };
  author?: { name: string; url?: string };
}

export interface DiscordWebhookPayload {
  content?: string;
  username?: string;
  embeds: DiscordEmbed[];
}

export interface DiscordFormatterOptions {
  reportUrl?: string;
  username?: string;
  includeTopFailures?: number;
  mentionOnFail?: string;
}

const COLOR_PASS = 0x10b981;
const COLOR_FAIL = 0xef4444;
const MAX_DESCRIPTION = 4096;
const MAX_FIELD_VALUE = 1024;
const MAX_FIELDS = 25;
const MAX_EMBEDS = 10;
const DEFAULT_USERNAME = 'uxinspect';
const DEFAULT_TOP_FAILURES = 5;
const ELLIPSIS = '…';
const REQUEST_TIMEOUT_MS = 10_000;

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= ELLIPSIS.length) return value.slice(0, max);
  return value.slice(0, max - ELLIPSIS.length) + ELLIPSIS;
}

function safeField(name: string, value: string, inline = true): DiscordEmbedField {
  return { name, value: truncate(value, MAX_FIELD_VALUE), inline };
}

function countA11yByImpact(result: InspectResult, impact: 'critical' | 'serious'): number {
  let n = 0;
  for (const page of result.a11y ?? []) {
    for (const v of page.violations) {
      if (v.impact === impact) n++;
    }
  }
  return n;
}

function countBrokenLinks(result: InspectResult): number {
  let n = 0;
  for (const r of result.links ?? []) n += r.broken.length;
  return n;
}

function countConsoleErrors(result: InspectResult): number {
  let n = 0;
  for (const r of result.consoleErrors ?? []) {
    for (const issue of r.issues) {
      if (
        issue.type === 'error' ||
        issue.type === 'pageerror' ||
        issue.type === 'unhandledrejection'
      ) {
        n++;
      }
    }
  }
  return n;
}

function firstPerfMetrics(result: InspectResult): { lcp: string; cls: string } {
  const first = result.perf?.[0];
  if (!first) return { lcp: '—', cls: '—' };
  const lcp = Number.isFinite(first.metrics.lcp) ? `${Math.round(first.metrics.lcp)}ms` : '—';
  const cls = Number.isFinite(first.metrics.cls) ? first.metrics.cls.toFixed(3) : '—';
  return { lcp, cls };
}

function collectFailureNames(result: InspectResult, limit: number): string[] {
  const names: string[] = [];
  for (const flow of result.flows) {
    if (!flow.passed) names.push(`flow: ${flow.name}${flow.error ? ` — ${flow.error}` : ''}`);
  }
  for (const v of result.visual ?? []) {
    if (!v.passed) names.push(`visual: ${v.page} @ ${v.viewport} (${v.diffPixels}px)`);
  }
  for (const page of result.a11y ?? []) {
    for (const v of page.violations) {
      if (v.impact === 'critical' || v.impact === 'serious') {
        names.push(`a11y[${v.impact}]: ${v.id} — ${v.help}`);
      }
    }
  }
  for (const r of result.links ?? []) {
    for (const b of r.broken) names.push(`link ${b.status}: ${b.url}`);
  }
  for (const b of result.budget ?? []) {
    names.push(`budget ${b.category}/${b.metric}: ${b.message}`);
  }
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const n of names) {
    if (seen.has(n)) continue;
    seen.add(n);
    unique.push(n);
    if (unique.length >= limit) break;
  }
  return unique;
}

function buildMainEmbed(result: InspectResult, opts: DiscordFormatterOptions): DiscordEmbed {
  const passed = result.passed;
  const totalFlows = result.flows.length;
  const passedFlows = result.flows.filter((f) => f.passed).length;
  const visualFails = (result.visual ?? []).filter((v) => !v.passed).length;
  const critical = countA11yByImpact(result, 'critical');
  const serious = countA11yByImpact(result, 'serious');
  const broken = countBrokenLinks(result);
  const consoleErrs = countConsoleErrors(result);
  const { lcp, cls } = firstPerfMetrics(result);
  const durSec = Math.max(0, Math.round(result.durationMs / 1000));

  const title = `${passed ? '✓ Passed' : '✗ Failed'} — UX audit`;
  const description = truncate(`${result.url}\nDuration: ${durSec}s`, MAX_DESCRIPTION);

  const fields: DiscordEmbedField[] = [
    safeField('Flows', `${passedFlows}/${totalFlows}`),
    safeField('A11y criticals', String(critical)),
    safeField('A11y serious', String(serious)),
    safeField('Visual diffs', String(visualFails)),
    safeField('LCP', lcp),
    safeField('CLS', cls),
    safeField('Broken links', String(broken)),
    safeField('Console errors', String(consoleErrs)),
    safeField('Duration', `${durSec}s`),
  ].slice(0, MAX_FIELDS);

  const embed: DiscordEmbed = {
    title,
    description,
    color: passed ? COLOR_PASS : COLOR_FAIL,
    timestamp: result.finishedAt,
    fields,
    footer: { text: 'uxinspect' },
  };
  if (opts.reportUrl) embed.url = opts.reportUrl;
  return embed;
}

function buildFailuresEmbed(result: InspectResult, limit: number): DiscordEmbed | undefined {
  const names = collectFailureNames(result, limit);
  if (names.length === 0) return undefined;
  const body = names.map((n) => `• ${n}`).join('\n');
  return {
    title: 'Top failures',
    description: truncate(body, MAX_DESCRIPTION),
    color: COLOR_FAIL,
  };
}

export function toDiscordEmbed(
  result: InspectResult,
  opts?: DiscordFormatterOptions,
): DiscordWebhookPayload {
  const options: DiscordFormatterOptions = opts ?? {};
  const username = options.username ?? DEFAULT_USERNAME;
  const topN =
    options.includeTopFailures && options.includeTopFailures > 0
      ? Math.floor(options.includeTopFailures)
      : DEFAULT_TOP_FAILURES;

  const embeds: DiscordEmbed[] = [buildMainEmbed(result, options)];
  if (!result.passed) {
    const fail = buildFailuresEmbed(result, topN);
    if (fail) embeds.push(fail);
  }

  const status = result.passed ? 'PASS' : 'FAIL';
  const durSec = Math.max(0, Math.round(result.durationMs / 1000));
  const fallback = `uxinspect ${status} — ${result.url} · ${durSec}s`;
  const mention = !result.passed && options.mentionOnFail ? ` ${options.mentionOnFail}` : '';
  const content = truncate(`${fallback}${mention}`, 2000);

  const payload: DiscordWebhookPayload = {
    content,
    username,
    embeds: embeds.slice(0, MAX_EMBEDS),
  };
  return payload;
}

export async function postDiscordEmbed(
  webhookUrl: string,
  payload: DiscordWebhookPayload,
): Promise<{ ok: boolean; status: number; error?: string }> {
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const ok = res.status === 204 || (res.status >= 200 && res.status < 300);
    if (ok) return { ok: true, status: res.status };
    let body = '';
    try {
      body = await res.text();
    } catch {
      body = '';
    }
    const error = body ? `HTTP ${res.status}: ${truncate(body, 200)}` : `HTTP ${res.status}`;
    return { ok: false, status: res.status, error };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, error: `chat notification failed: ${message}` };
  }
}
