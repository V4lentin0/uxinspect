import type { InspectResult } from './types.js';

export interface NotifyOptions {
  slackWebhook?: string;
  discordWebhook?: string;
  genericWebhook?: string;
}

export async function notify(result: InspectResult, opts: NotifyOptions): Promise<void> {
  const a11y = (result.a11y ?? []).reduce((a, p) => a + p.violations.length, 0);
  const visualFails = (result.visual ?? []).filter((v) => !v.passed).length;
  const flowFails = result.flows.filter((f) => !f.passed).length;
  const status = result.passed ? 'PASS' : 'FAIL';
  const dur = (result.durationMs / 1000).toFixed(1);
  const text = `uxinspect ${status} — ${result.url} · ${dur}s\nflows: ${result.flows.length - flowFails}/${result.flows.length}, a11y: ${a11y}, visual fails: ${visualFails}`;

  const tasks: Promise<unknown>[] = [];
  if (opts.slackWebhook) {
    tasks.push(
      fetch(opts.slackWebhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      }),
    );
  }
  if (opts.discordWebhook) {
    tasks.push(
      fetch(opts.discordWebhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: text }),
      }),
    );
  }
  if (opts.genericWebhook) {
    tasks.push(
      fetch(opts.genericWebhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(result),
      }),
    );
  }
  await Promise.allSettled(tasks);
}
