/**
 * P5 #53 — Email digest builder + sender.
 * Builds table-based HTML email (GCP light theme, inline CSS).
 * Sends via configurable transactional email API or logs to D1 fallback.
 */

import type { Env } from './types.js';

interface DigestData {
  teamName: string;
  period: string;
  totalRuns: number;
  passRate: number;
  avgScore: number;
  coverageTrend: string;
  regressions: Array<{ name: string; error: string }>;
  anomalies: Array<{ metric: string; direction: string; zScore: number }>;
  dashboardUrl: string;
}

export function buildDigestHtml(data: DigestData): string {
  const regressionsRows = data.regressions.length === 0
    ? '<tr><td style="padding:8px 12px;color:#6B7280">No regressions this period.</td></tr>'
    : data.regressions.slice(0, 10).map((r) =>
        `<tr><td style="padding:6px 12px;border-bottom:1px solid #E5E7EB">${esc(r.name)}</td><td style="padding:6px 12px;border-bottom:1px solid #E5E7EB;color:#EF4444">${esc(r.error)}</td></tr>`
      ).join('');

  const anomalyRows = data.anomalies.length === 0
    ? ''
    : `<h3 style="font-size:14px;margin:16px 0 8px">Top anomalies</h3><table style="width:100%;border-collapse:collapse">${
        data.anomalies.slice(0, 3).map((a) =>
          `<tr><td style="padding:4px 12px">${esc(a.metric)}</td><td style="padding:4px 12px">${esc(a.direction)} (z=${a.zScore.toFixed(1)})</td></tr>`
        ).join('')
      }</table>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;font-family:Inter,-apple-system,sans-serif;background:#FAFAFA">
<table style="width:100%;max-width:600px;margin:0 auto;background:#FFFFFF;border:1px solid #E5E7EB;border-radius:8px;overflow:hidden">
  <tr><td style="background:#10B981;padding:16px 24px;color:#fff;font-size:18px;font-weight:700">${esc(data.teamName)} — ${esc(data.period)} digest</td></tr>
  <tr><td style="padding:20px 24px">
    <table style="width:100%;border-collapse:collapse">
      <tr>
        <td style="padding:8px;text-align:center;background:#ECFDF5;border-radius:6px;width:25%"><div style="font-size:24px;font-weight:700">${data.totalRuns}</div><div style="font-size:11px;color:#6B7280">Runs</div></td>
        <td style="padding:8px;text-align:center;background:#ECFDF5;border-radius:6px;width:25%"><div style="font-size:24px;font-weight:700">${data.passRate}%</div><div style="font-size:11px;color:#6B7280">Pass rate</div></td>
        <td style="padding:8px;text-align:center;background:#EFF6FF;border-radius:6px;width:25%"><div style="font-size:24px;font-weight:700">${data.avgScore}</div><div style="font-size:11px;color:#6B7280">Avg score</div></td>
        <td style="padding:8px;text-align:center;background:#EFF6FF;border-radius:6px;width:25%"><div style="font-size:24px;font-weight:700">${esc(data.coverageTrend)}</div><div style="font-size:11px;color:#6B7280">Coverage</div></td>
      </tr>
    </table>
    <h3 style="font-size:14px;margin:16px 0 8px">Regressions</h3>
    <table style="width:100%;border-collapse:collapse">${regressionsRows}</table>
    ${anomalyRows}
    <div style="margin-top:20px;text-align:center">
      <a href="${esc(data.dashboardUrl)}" style="display:inline-block;padding:10px 24px;background:#10B981;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">View dashboard</a>
    </div>
  </td></tr>
  <tr><td style="padding:12px 24px;border-top:1px solid #E5E7EB;color:#9CA3AF;font-size:11px;text-align:center">Sent by uxinspect</td></tr>
</table>
</body></html>`;
}

export async function sendDigest(
  env: Env,
  teamId: string,
  recipients: string[],
  subject: string,
  html: string,
): Promise<boolean> {
  const apiUrl = (env as any).EMAIL_API_URL;
  const apiKey = (env as any).EMAIL_API_KEY;
  const from = (env as any).EMAIL_FROM || 'digest@uxinspect.com';

  if (!apiUrl || !apiKey) {
    // Fallback: log to D1
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO digest_log (id, team_id, subject, html, sent) VALUES (?1, ?2, ?3, ?4, 0)`,
    ).bind(id, teamId, subject, html).run();
    return false;
  }

  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: recipients, subject, html }),
    });
    return res.ok;
  } catch {
    // Fallback on error
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO digest_log (id, team_id, subject, html, sent) VALUES (?1, ?2, ?3, ?4, 0)`,
    ).bind(id, teamId, subject, html).run();
    return false;
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
