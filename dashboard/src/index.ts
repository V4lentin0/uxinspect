interface Env {
  REPORTS: R2Bucket;
  UPLOAD_TOKEN?: string;
}

interface ReportSummary {
  url: string;
  passed: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  flows: { name: string; passed: boolean }[];
  a11y?: { violations: { impact: string }[] }[];
  visual?: { passed: boolean }[];
  perf?: { scores: { performance: number } }[];
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === 'POST' && path === '/upload') return upload(req, env);
    if (req.method === 'GET' && path === '/api/reports') return listReports(env);
    if (req.method === 'GET' && path.startsWith('/r/')) return getReport(path.slice(3), env);
    if (req.method === 'GET' && path === '/') return new Response(indexPage(), { headers: html() });
    return new Response('not found', { status: 404 });
  },
};

async function upload(req: Request, env: Env): Promise<Response> {
  if (env.UPLOAD_TOKEN) {
    const auth = req.headers.get('authorization') ?? '';
    if (auth !== `Bearer ${env.UPLOAD_TOKEN}`) return new Response('unauthorized', { status: 401 });
  }
  const body = await req.json<ReportSummary>();
  const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  await env.REPORTS.put(`${id}.json`, JSON.stringify(body), {
    httpMetadata: { contentType: 'application/json' },
  });
  return Response.json({ id, url: `/r/${id}` });
}

async function listReports(env: Env): Promise<Response> {
  const list = await env.REPORTS.list({ limit: 100 });
  const items = await Promise.all(
    list.objects
      .filter((o) => o.key.endsWith('.json'))
      .sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime())
      .slice(0, 50)
      .map(async (o) => {
        const obj = await env.REPORTS.get(o.key);
        if (!obj) return null;
        const r = await obj.json<ReportSummary>();
        const a11yIssues = (r.a11y ?? []).reduce((a, p) => a + p.violations.length, 0);
        const visualFails = (r.visual ?? []).filter((v) => !v.passed).length;
        return {
          id: o.key.replace('.json', ''),
          url: r.url,
          passed: r.passed,
          startedAt: r.startedAt,
          durationMs: r.durationMs,
          flows: r.flows.length,
          flowFails: r.flows.filter((f) => !f.passed).length,
          a11yIssues,
          visualFails,
        };
      }),
  );
  return Response.json(items.filter(Boolean));
}

async function getReport(id: string, env: Env): Promise<Response> {
  const obj = await env.REPORTS.get(`${id}.json`);
  if (!obj) return new Response('not found', { status: 404 });
  const r = await obj.json<ReportSummary>();
  return new Response(reportPage(r), { headers: html() });
}

function html() {
  return { 'content-type': 'text/html; charset=utf-8' };
}

function shellCss(): string {
  return `<style>
    :root { --bg:#FAFAFA; --card:#FFFFFF; --border:#E5E7EB; --text:#1D1D1F; --muted:#6B7280;
            --green:#10B981; --green-bg:#ECFDF5; --blue:#3B82F6; --blue-bg:#EFF6FF; --red:#EF4444; }
    * { box-sizing: border-box; }
    body { font-family: 'Inter', system-ui, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 32px; max-width: 1100px; margin: 0 auto; }
    h1 { font-size: 24px; margin: 0 0 4px; }
    h2 { font-size: 14px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin: 24px 0 8px; }
    a { color: var(--blue); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .row { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 14px 18px; margin-bottom: 8px; display: grid; grid-template-columns: 80px 1fr auto; gap: 16px; align-items: center; }
    .badge { display: inline-block; padding: 3px 10px; border-radius: 4px; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
    .badge-pass { background: var(--green-bg); color: var(--green); }
    .badge-fail { background: #FEF2F2; color: var(--red); }
    .url { font-weight: 500; }
    .meta { color: var(--muted); font-size: 12px; }
    .stats { display: flex; gap: 12px; font-size: 12px; color: var(--muted); }
    .stat-fail { color: var(--red); font-weight: 600; }
    .empty { text-align: center; padding: 48px; color: var(--muted); }
    pre { background: #F9FAFB; border: 1px solid var(--border); padding: 12px; border-radius: 6px; font-size: 12px; overflow-x: auto; }
    .header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 24px; }
    .brand { font-weight: 700; }
  </style>
  <link rel="preconnect" href="https://rsms.me/">
  <link rel="stylesheet" href="https://rsms.me/inter/inter.css">`;
}

const CLIENT_JS = `
fetch('/api/reports').then(r => r.json()).then(items => {
  const list = document.getElementById('list');
  list.textContent = '';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No reports yet. Upload one to start.';
    list.appendChild(empty);
    return;
  }
  list.className = '';
  for (const r of items) {
    const a = document.createElement('a');
    a.className = 'row';
    a.style.color = 'inherit';
    a.href = '/r/' + r.id;
    const badge = document.createElement('span');
    badge.className = 'badge ' + (r.passed ? 'badge-pass' : 'badge-fail');
    badge.textContent = r.passed ? 'pass' : 'fail';
    const mid = document.createElement('div');
    const urlDiv = document.createElement('div');
    urlDiv.className = 'url';
    urlDiv.textContent = r.url;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = new Date(r.startedAt).toLocaleString() + ' \u00b7 ' + (r.durationMs / 1000).toFixed(1) + 's';
    mid.appendChild(urlDiv);
    mid.appendChild(meta);
    const stats = document.createElement('div');
    stats.className = 'stats';
    const flowSpan = document.createElement('span');
    flowSpan.textContent = r.flows + ' flows';
    if (r.flowFails) {
      const fail = document.createElement('span');
      fail.className = 'stat-fail';
      fail.textContent = ' (' + r.flowFails + ' fail)';
      flowSpan.appendChild(fail);
    }
    const a11ySpan = document.createElement('span');
    a11ySpan.textContent = r.a11yIssues + ' a11y';
    const visSpan = document.createElement('span');
    visSpan.textContent = r.visualFails + ' visual';
    stats.appendChild(flowSpan);
    stats.appendChild(a11ySpan);
    stats.appendChild(visSpan);
    a.appendChild(badge);
    a.appendChild(mid);
    a.appendChild(stats);
    list.appendChild(a);
  }
});
`;

function indexPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>uxinspect dashboard</title>${shellCss()}</head>
<body>
  <div class="header">
    <h1><span class="brand">uxinspect</span> dashboard</h1>
    <span class="meta">cloud reports \u00b7 last 50</span>
  </div>
  <div id="list" class="empty">Loading\u2026</div>
  <h2>Upload a report</h2>
  <pre>curl -X POST $UXINSPECT_DASHBOARD/upload \\
  -H 'authorization: Bearer $TOKEN' \\
  -H 'content-type: application/json' \\
  --data @uxinspect-report/report.json</pre>
<script>${CLIENT_JS}</script>
</body></html>`;
}

function reportPage(r: ReportSummary): string {
  const a11yCount = (r.a11y ?? []).reduce((a, p) => a + p.violations.length, 0);
  const visualFails = (r.visual ?? []).filter((v) => !v.passed).length;
  const perfAvg = r.perf?.length
    ? Math.round(r.perf.reduce((a, p) => a + p.scores.performance, 0) / r.perf.length)
    : null;
  const flowFails = r.flows.filter((f) => !f.passed).length;
  const flowRows = r.flows
    .map(
      (f) =>
        `<div class="row"><span class="badge ${f.passed ? 'badge-pass' : 'badge-fail'}">${f.passed ? 'pass' : 'fail'}</span><div>${escape(f.name)}</div><div></div></div>`,
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>uxinspect report</title>${shellCss()}</head>
<body>
  <div class="header">
    <div>
      <h1>${escape(r.url)}</h1>
      <div class="meta">${new Date(r.startedAt).toLocaleString()} \u00b7 ${(r.durationMs / 1000).toFixed(1)}s</div>
    </div>
    <span class="badge ${r.passed ? 'badge-pass' : 'badge-fail'}">${r.passed ? 'PASS' : 'FAIL'}</span>
  </div>
  <h2>Summary</h2>
  <div class="row">
    <div></div>
    <div class="stats">
      <span>${r.flows.length - flowFails}/${r.flows.length} flows</span>
      <span>${a11yCount} a11y</span>
      <span>${visualFails} visual fails</span>
      ${perfAvg !== null ? `<span>perf ${perfAvg}</span>` : ''}
    </div>
    <div></div>
  </div>
  <h2>Flows</h2>
  ${flowRows}
  <p style="margin-top:32px"><a href="/">\u2190 all reports</a></p>
</body></html>`;
}

function escape(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}
