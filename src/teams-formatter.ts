import type { InspectResult } from './types.js';

export interface AdaptiveCard {
  type: 'AdaptiveCard';
  version: string;
  body: AdaptiveElement[];
  actions?: AdaptiveAction[];
  $schema?: string;
}

export type AdaptiveElement =
  | { type: 'TextBlock'; text: string; size?: string; weight?: string; color?: string; wrap?: boolean; spacing?: string }
  | { type: 'FactSet'; facts: Array<{ title: string; value: string }> }
  | { type: 'ColumnSet'; columns: Array<{ type: 'Column'; width?: string; items: AdaptiveElement[] }> }
  | { type: 'Container'; items: AdaptiveElement[]; style?: string }
  | { type: 'Image'; url: string };

export type AdaptiveAction = { type: 'Action.OpenUrl'; title: string; url: string };

interface CardContent extends AdaptiveCard {
  msteams?: {
    entities: Array<{ type: 'mention'; text: string; mentioned: { id: string; name: string } }>;
  };
}

export interface TeamsPayload {
  type: 'message';
  attachments: Array<{
    contentType: 'application/vnd.microsoft.card.adaptive';
    contentUrl: null;
    content: AdaptiveCard;
  }>;
}

export interface TeamsFormatterOptions {
  reportUrl?: string;
  title?: string;
  includeTopFailures?: number;
  mentionOnFail?: { name: string; id: string };
}

const SCHEMA_URL = 'http://adaptivecards.io/schemas/adaptive-card.json';
const CARD_VERSION = '1.4';

function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function countA11y(result: InspectResult, impact: 'critical' | 'serious'): number {
  let n = 0;
  for (const p of result.a11y ?? []) for (const v of p.violations) if (v.impact === impact) n += 1;
  return n;
}

function countVisualDiffs(result: InspectResult): number {
  return (result.visual ?? []).filter((v) => !v.passed).length;
}

function countBrokenLinks(result: InspectResult): number {
  let n = 0;
  for (const l of result.links ?? []) n += l.broken.length;
  return n;
}

function countConsoleErrors(result: InspectResult): number {
  let n = 0;
  for (const c of result.consoleErrors ?? []) n += c.errorCount;
  return n;
}

function avgMetric(result: InspectResult, key: 'lcp' | 'cls'): number {
  const perf = result.perf ?? [];
  if (perf.length === 0) return 0;
  return perf.reduce((a, p) => a + (p.metrics[key] ?? 0), 0) / perf.length;
}

function flowsSummary(result: InspectResult): string {
  const total = result.flows.length;
  const passed = result.flows.filter((f) => f.passed).length;
  return `${passed}/${total}`;
}

function topFailures(result: InspectResult, limit: number): string[] {
  const out: string[] = [];
  const push = (line: string): boolean => {
    out.push(line);
    return out.length >= limit;
  };
  for (const f of result.flows) {
    if (!f.passed) {
      const reason = f.error ?? f.steps.find((s) => !s.passed)?.error ?? 'flow failed';
      if (push(`Flow "${f.name}": ${reason}`)) return out;
    }
  }
  for (const page of result.a11y ?? []) {
    for (const v of page.violations) {
      if (v.impact === 'critical' || v.impact === 'serious') {
        if (push(`A11y ${v.impact}: ${v.id} — ${v.help}`)) return out;
      }
    }
  }
  for (const v of result.visual ?? []) {
    if (!v.passed) {
      if (push(`Visual diff ${v.page} (${v.viewport}): ${(v.diffRatio * 100).toFixed(2)}%`)) return out;
    }
  }
  for (const page of result.links ?? []) {
    for (const b of page.broken) {
      if (push(`Broken link ${b.url} (${b.status})`)) return out;
    }
  }
  return out;
}

export function toTeamsCard(result: InspectResult, opts?: TeamsFormatterOptions): TeamsPayload {
  const options = opts ?? {};
  const limit = Math.max(0, options.includeTopFailures ?? 5);
  const title = options.title ?? (result.passed ? 'uxinspect — PASS' : 'uxinspect — FAIL');

  const body: AdaptiveElement[] = [];
  body.push({
    type: 'TextBlock',
    text: title,
    size: 'Large',
    weight: 'Bolder',
    color: result.passed ? 'Good' : 'Attention',
    wrap: true,
  });
  body.push({
    type: 'TextBlock',
    text: result.url,
    size: 'Small',
    color: 'Accent',
    wrap: true,
    spacing: 'None',
  });

  const facts: Array<{ title: string; value: string }> = [
    { title: 'Status', value: result.passed ? 'PASS' : 'FAIL' },
    { title: 'Duration', value: fmtMs(result.durationMs) },
    { title: 'Flows', value: flowsSummary(result) },
    { title: 'A11y critical', value: String(countA11y(result, 'critical')) },
    { title: 'A11y serious', value: String(countA11y(result, 'serious')) },
    { title: 'Visual diffs', value: String(countVisualDiffs(result)) },
    { title: 'LCP', value: fmtMs(avgMetric(result, 'lcp')) },
    { title: 'CLS', value: avgMetric(result, 'cls').toFixed(3) },
    { title: 'Broken links', value: String(countBrokenLinks(result)) },
    { title: 'Console errors', value: String(countConsoleErrors(result)) },
  ];
  body.push({ type: 'FactSet', facts });

  const failures = topFailures(result, limit);
  if (failures.length > 0) {
    const items: AdaptiveElement[] = [
      { type: 'TextBlock', text: 'Top issues', weight: 'Bolder', wrap: true },
    ];
    for (const line of failures) {
      items.push({ type: 'TextBlock', text: `- ${line}`, wrap: true, spacing: 'Small' });
    }
    body.push({ type: 'Container', style: result.passed ? 'good' : 'attention', items });
  } else if (result.passed) {
    body.push({
      type: 'Container',
      style: 'good',
      items: [{ type: 'TextBlock', text: 'All checks passed.', wrap: true }],
    });
  }

  const content: CardContent = {
    type: 'AdaptiveCard',
    $schema: SCHEMA_URL,
    version: CARD_VERSION,
    body,
  };

  if (options.reportUrl) {
    content.actions = [{ type: 'Action.OpenUrl', title: 'View report', url: options.reportUrl }];
  }

  if (options.mentionOnFail && !result.passed) {
    const { name, id } = options.mentionOnFail;
    const mentionText = `<at>${name}</at>`;
    body.push({
      type: 'TextBlock',
      text: `${mentionText} please review.`,
      wrap: true,
      spacing: 'Medium',
    });
    content.msteams = {
      entities: [{ type: 'mention', text: mentionText, mentioned: { id, name } }],
    };
  }

  return {
    type: 'message',
    attachments: [
      { contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content },
    ],
  };
}

export async function postTeamsCard(
  webhookUrl: string,
  payload: TeamsPayload,
): Promise<{ ok: boolean; status: number; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      let detail = '';
      try {
        detail = await res.text();
      } catch {
        detail = '';
      }
      return {
        ok: false,
        status: res.status,
        error: `chat notification webhook failed: ${res.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`,
      };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 0,
      error: aborted ? 'chat notification webhook timed out' : `chat notification webhook error: ${message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
