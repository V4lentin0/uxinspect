import type { InspectResult, A11yViolation } from './types.js';

// Public Block Kit block shape — covers the subset used here.
// See https://api.slack.com/reference/block-kit/blocks for full spec.
export interface SlackBlock {
  type: 'header' | 'section' | 'divider' | 'context' | 'actions';
  text?: { type: 'plain_text' | 'mrkdwn'; text: string };
  fields?: Array<{ type: 'mrkdwn' | 'plain_text'; text: string }>;
  elements?: unknown[];
  block_id?: string;
}

export interface SlackBlockPayload {
  blocks: SlackBlock[];
  attachments?: Array<{ color: string; blocks: SlackBlock[] }>;
  text: string;
}

export interface SlackFormatterOptions {
  reportUrl?: string;
  title?: string;
  includeTopFailures?: number;
  mentionOnFail?: string;
}

interface FailureItem {
  category: string;
  label: string;
}

const COLOR_PASS = '#10B981';
const COLOR_FAIL = '#EF4444';
const DEFAULT_TITLE = 'UX audit report';
const DEFAULT_TOP_FAILURES = 5;

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function countA11yByImpact(
  a11y: InspectResult['a11y'],
  impact: A11yViolation['impact'],
): number {
  if (!a11y) return 0;
  let total = 0;
  for (const page of a11y) {
    for (const v of page.violations) {
      if (v.impact === impact) total += 1;
    }
  }
  return total;
}

function firstLcp(result: InspectResult): number | undefined {
  const perf = result.perf;
  if (!perf || perf.length === 0) return undefined;
  for (const p of perf) {
    const lcp = p.metrics?.lcp;
    if (typeof lcp === 'number' && Number.isFinite(lcp)) return lcp;
  }
  return undefined;
}

function brokenLinkCount(result: InspectResult): number {
  const links = result.links;
  if (!Array.isArray(links)) return 0;
  let count = 0;
  for (const item of links) {
    const rec = item as unknown as { ok?: boolean; broken?: boolean; status?: number };
    if (rec.ok === false || rec.broken === true) count += 1;
    else if (typeof rec.status === 'number' && (rec.status >= 400 || rec.status === 0)) count += 1;
  }
  return count;
}

function collectFailures(result: InspectResult, max: number): FailureItem[] {
  const out: FailureItem[] = [];

  for (const f of result.flows) {
    if (!f.passed) {
      const reason = f.error ? `: ${f.error}` : '';
      out.push({ category: 'flow', label: `${f.name}${reason}` });
      if (out.length >= max) return out;
    }
  }

  for (const page of result.a11y ?? []) {
    if (page.passed) continue;
    for (const v of page.violations) {
      if (v.impact !== 'critical' && v.impact !== 'serious') continue;
      out.push({
        category: 'a11y',
        label: `[${v.impact}] ${v.id} — ${v.help} (${page.page})`,
      });
      if (out.length >= max) return out;
    }
  }

  for (const v of result.visual ?? []) {
    if (v.passed) continue;
    const pct = (v.diffRatio * 100).toFixed(2);
    out.push({
      category: 'visual',
      label: `${v.page} @ ${v.viewport} — ${pct}% diff (${v.diffPixels}px)`,
    });
    if (out.length >= max) return out;
  }

  return out;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + '…';
}

function headerText(result: InspectResult, title: string): string {
  const status = result.passed ? 'Passed' : 'Failed';
  return truncate(`${title} — ${status} (${formatDuration(result.durationMs)})`, 150);
}

function summaryFields(result: InspectResult): Array<{ type: 'mrkdwn'; text: string }> {
  const totalFlows = result.flows.length;
  const passedFlows = result.flows.filter((f) => f.passed).length;
  const critical = countA11yByImpact(result.a11y, 'critical');
  const serious = countA11yByImpact(result.a11y, 'serious');
  const visualFails = (result.visual ?? []).filter((v) => !v.passed).length;
  const lcp = firstLcp(result);
  const lcpText = typeof lcp === 'number' ? `${Math.round(lcp)}ms` : 'n/a';
  const broken = brokenLinkCount(result);
  const status = result.passed ? '✓ Passed' : '✗ Failed';

  return [
    { type: 'mrkdwn', text: `*URL*: ${truncate(result.url, 200)}` },
    { type: 'mrkdwn', text: `*Status*: ${status}` },
    { type: 'mrkdwn', text: `*Duration*: ${formatDuration(result.durationMs)}` },
    { type: 'mrkdwn', text: `*Flows*: ${passedFlows}/${totalFlows}` },
    { type: 'mrkdwn', text: `*A11y violations*: ${critical} critical, ${serious} serious` },
    { type: 'mrkdwn', text: `*Visual diffs*: ${visualFails}` },
    { type: 'mrkdwn', text: `*Perf LCP*: ${lcpText}` },
    { type: 'mrkdwn', text: `*Links*: ${broken} broken` },
  ];
}

function fallbackText(result: InspectResult, title: string): string {
  const status = result.passed ? 'PASS' : 'FAIL';
  const flowFails = result.flows.filter((f) => !f.passed).length;
  const a11y = (result.a11y ?? []).reduce((a, p) => a + p.violations.length, 0);
  const visualFails = (result.visual ?? []).filter((v) => !v.passed).length;
  return truncate(
    `${title}: ${status} — ${result.url} · ${formatDuration(result.durationMs)} · flows ${
      result.flows.length - flowFails
    }/${result.flows.length} · a11y ${a11y} · visual fails ${visualFails}`,
    500,
  );
}

export function toSlackBlocks(
  result: InspectResult,
  opts?: SlackFormatterOptions,
): SlackBlockPayload {
  const title = opts?.title ?? DEFAULT_TITLE;
  const topN = Math.max(0, opts?.includeTopFailures ?? DEFAULT_TOP_FAILURES);
  const blocks: SlackBlock[] = [];

  if (opts?.mentionOnFail && !result.passed) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: opts.mentionOnFail },
    });
  }

  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: headerText(result, title) },
  });

  blocks.push({
    type: 'section',
    fields: summaryFields(result),
  });

  blocks.push({ type: 'divider' });

  const failures = collectFailures(result, topN);
  if (failures.length > 0) {
    const body = failures
      .map((f) => `• *[${f.category}]* ${truncate(f.label, 240)}`)
      .join('\n');
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Top failures (${failures.length})*\n${body}` },
    });
  } else if (!result.passed) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*Top failures*: no categorised failures recorded.' },
    });
  }

  const reportLink = opts?.reportUrl ? `<${opts.reportUrl}|open report>` : 'local';
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `* report: ${reportLink} • ${result.finishedAt}`,
      },
    ],
  });

  const color = result.passed ? COLOR_PASS : COLOR_FAIL;
  return {
    blocks,
    attachments: [{ color, blocks: [] }],
    text: fallbackText(result, title),
  };
}

export async function postSlackBlocks(
  webhookUrl: string,
  payload: SlackBlockPayload,
): Promise<{ ok: boolean; status: number; error?: string }> {
  try {
    const res = await globalThis.fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    const ok = res.status >= 200 && res.status < 300;
    if (ok) return { ok: true, status: res.status };
    return { ok: false, status: res.status, error: `chat notification failed: HTTP ${res.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, error: `chat notification error: ${msg}` };
  }
}
