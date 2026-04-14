import crypto from 'node:crypto';
import type { InspectResult } from './types.js';

export interface WebhookReporterOptions {
  url: string;
  method?: 'POST' | 'PUT';
  headers?: Record<string, string>;
  timeout?: number;
  retries?: number;
  hmacSecret?: string;
  payloadMode?: 'full' | 'summary';
  onlyOnFail?: boolean;
}

export interface WebhookReporterOutcome {
  posted: boolean;
  status?: number;
  attempts: number;
  error?: string;
  skipped?: boolean;
}

interface SummaryPayload {
  url: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  passed: boolean;
  summary: Record<string, number>;
}

const CHECK_KEYS = [
  'flows',
  'a11y',
  'perf',
  'visual',
  'seo',
  'links',
  'pwa',
  'budget',
  'apiFlows',
  'retire',
  'deadClicks',
  'touchTargets',
  'keyboard',
  'longTasks',
  'clsTimeline',
  'forms',
  'structuredData',
  'passiveSecurity',
  'consoleErrors',
  'resourceHints',
  'mixedContent',
  'cacheHeaders',
  'cookieBanner',
  'thirdParty',
  'bundleSize',
  'openGraph',
  'imageAudit',
  'webfonts',
  'motionPrefs',
  'serviceWorker',
  'rum',
  'amp',
] as const;

function buildSummary(result: InspectResult): SummaryPayload {
  const summary: Record<string, number> = {};
  for (const key of CHECK_KEYS) {
    const value = (result as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      summary[key] = value.length;
    }
  }
  return {
    url: result.url,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    passed: result.passed,
    summary,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function postWebhookReport(
  result: InspectResult,
  opts: WebhookReporterOptions,
): Promise<WebhookReporterOutcome> {
  if (opts.onlyOnFail === true && result.passed === true) {
    return { posted: false, attempts: 0, skipped: true };
  }

  const payloadMode: 'full' | 'summary' = opts.payloadMode ?? 'full';
  const payload: InspectResult | SummaryPayload =
    payloadMode === 'summary' ? buildSummary(result) : result;
  const body = JSON.stringify(payload);

  const method: 'POST' | 'PUT' = opts.method ?? 'POST';
  const timeout = opts.timeout ?? 15000;
  const maxRetries = opts.retries ?? 2;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'uxinspect/webhook-reporter',
    ...(opts.headers ?? {}),
  };

  if (opts.hmacSecret) {
    const sig = crypto.createHmac('sha256', opts.hmacSecret).update(body).digest('hex');
    headers['X-UxInspect-Signature'] = `sha256=${sig}`;
  }

  const totalAttempts = maxRetries + 1;
  let attempts = 0;
  let lastStatus: number | undefined;
  let lastError: string | undefined;

  for (let i = 0; i < totalAttempts; i++) {
    attempts = i + 1;
    try {
      const res = await fetch(opts.url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeout),
      });
      lastStatus = res.status;
      if (res.status >= 200 && res.status < 300) {
        return { posted: true, status: res.status, attempts };
      }
      if (res.status >= 500 && i < totalAttempts - 1) {
        await sleep(500 * Math.pow(2, i));
        continue;
      }
      return {
        posted: false,
        status: res.status,
        attempts,
        error: `HTTP ${res.status}`,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (i < totalAttempts - 1) {
        await sleep(500 * Math.pow(2, i));
        continue;
      }
      return {
        posted: false,
        attempts,
        ...(lastStatus !== undefined ? { status: lastStatus } : {}),
        error: lastError,
      };
    }
  }

  return {
    posted: false,
    attempts,
    ...(lastStatus !== undefined ? { status: lastStatus } : {}),
    ...(lastError !== undefined ? { error: lastError } : {}),
  };
}
