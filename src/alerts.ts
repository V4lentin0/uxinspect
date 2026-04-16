/**
 * P5 #52 — Slack / Discord / MS Teams alert templates.
 * Each returns the platform's native webhook payload format.
 */

export interface AlertContext {
  repo?: string;
  branch?: string;
  reportUrl?: string;
  replayUrl?: string;
  screenshotUrl?: string;
}

export interface DiffSummary {
  newFailures?: number;
  fixed?: number;
  scoreDrops?: Array<{ metric: string; from: number; to: number }>;
  coverageDelta?: number;
}

interface ResultLike {
  url: string;
  startedAt: string;
  durationMs: number;
  flows: Array<{ name: string; passed: boolean; error?: string }>;
}

const GREEN = '#10B981';
const RED = '#EF4444';

// ─── Slack Block Kit ─────────────────────────────────────────────

export function renderSlackAlert(
  result: ResultLike,
  diff?: DiffSummary,
  ctx?: AlertContext,
): Record<string, unknown>[] {
  const passed = result.flows.every((f) => f.passed);
  const status = passed ? 'PASS' : 'FAIL';
  const color = passed ? GREEN : RED;
  const failedFlows = result.flows.filter((f) => !f.passed);

  const blocks: Record<string, unknown>[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${status}* | ${result.url} | ${result.startedAt}` },
    },
  ];

  if (ctx?.repo || ctx?.branch) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `${ctx.repo || ''}${ctx.branch ? ` (${ctx.branch})` : ''}` }],
    });
  }

  if (diff && (diff.newFailures || diff.scoreDrops?.length)) {
    let summary = '';
    if (diff.newFailures) summary += `${diff.newFailures} new failure(s). `;
    if (diff.fixed) summary += `${diff.fixed} fixed. `;
    if (diff.scoreDrops) {
      for (const d of diff.scoreDrops) summary += `${d.metric}: ${d.from} -> ${d.to}. `;
    }
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: summary.trim() } });
  }

  if (failedFlows.length > 0) {
    const list = failedFlows.slice(0, 10).map((f) => `- ${f.name}: ${f.error || 'failed'}`).join('\n');
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: list } });
  }

  const actions: Record<string, unknown>[] = [];
  if (ctx?.reportUrl) actions.push({ type: 'button', text: { type: 'plain_text', text: 'View Report' }, url: ctx.reportUrl });
  if (ctx?.replayUrl) actions.push({ type: 'button', text: { type: 'plain_text', text: 'View Replay' }, url: ctx.replayUrl });
  if (actions.length) blocks.push({ type: 'actions', elements: actions });

  return blocks;
}

// ─── Discord Embed ───────────────────────────────────────────────

export function renderDiscordAlert(
  result: ResultLike,
  diff?: DiffSummary,
  ctx?: AlertContext,
): Record<string, unknown> {
  const passed = result.flows.every((f) => f.passed);
  const failedFlows = result.flows.filter((f) => !f.passed);

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: 'URL', value: result.url, inline: true },
    { name: 'Duration', value: `${result.durationMs}ms`, inline: true },
    { name: 'Flows', value: `${result.flows.length} total, ${failedFlows.length} failed`, inline: true },
  ];

  if (diff?.newFailures) fields.push({ name: 'New Failures', value: `${diff.newFailures}`, inline: true });
  if (diff?.coverageDelta) fields.push({ name: 'Coverage Delta', value: `${diff.coverageDelta > 0 ? '+' : ''}${diff.coverageDelta}%`, inline: true });

  return {
    title: passed ? 'PASS' : 'FAIL',
    color: parseInt((passed ? GREEN : RED).replace('#', ''), 16),
    fields,
    timestamp: result.startedAt,
    footer: { text: ctx?.repo || 'uxinspect' },
    thumbnail: ctx?.screenshotUrl ? { url: ctx.screenshotUrl } : undefined,
  };
}

// ─── MS Teams Adaptive Card ──────────────────────────────────────

export function renderTeamsAlert(
  result: ResultLike,
  diff?: DiffSummary,
  ctx?: AlertContext,
): Record<string, unknown> {
  const passed = result.flows.every((f) => f.passed);
  const failedFlows = result.flows.filter((f) => !f.passed);

  const facts: Array<{ title: string; value: string }> = [
    { title: 'Status', value: passed ? 'PASS' : 'FAIL' },
    { title: 'URL', value: result.url },
    { title: 'Duration', value: `${result.durationMs}ms` },
    { title: 'Flows', value: `${result.flows.length} total, ${failedFlows.length} failed` },
  ];

  if (diff?.newFailures) facts.push({ title: 'New Failures', value: `${diff.newFailures}` });

  const actions: Record<string, unknown>[] = [];
  if (ctx?.reportUrl) actions.push({ type: 'Action.OpenUrl', title: 'View Report', url: ctx.reportUrl });
  if (ctx?.replayUrl) actions.push({ type: 'Action.OpenUrl', title: 'View Replay', url: ctx.replayUrl });

  return {
    type: 'AdaptiveCard',
    version: '1.4',
    body: [
      {
        type: 'TextBlock',
        text: `${passed ? 'PASS' : 'FAIL'} — ${result.url}`,
        weight: 'Bolder',
        size: 'Medium',
        color: passed ? 'Good' : 'Attention',
      },
      { type: 'FactSet', facts },
      ...(failedFlows.length > 0 ? [{
        type: 'TextBlock',
        text: failedFlows.slice(0, 10).map((f) => `- ${f.name}: ${f.error || 'failed'}`).join('\n'),
        wrap: true,
      }] : []),
    ],
    actions,
  };
}

// ─── Send to webhook ─────────────────────────────────────────────

export type AlertPlatform = 'slack' | 'discord' | 'teams';

export async function sendAlert(
  webhookUrl: string,
  platform: AlertPlatform,
  payload: unknown,
): Promise<boolean> {
  const body = platform === 'slack'
    ? JSON.stringify({ blocks: payload })
    : platform === 'discord'
      ? JSON.stringify({ embeds: [payload] })
      : JSON.stringify({ type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: payload }] });

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    return res.ok;
  } catch {
    return false;
  }
}
