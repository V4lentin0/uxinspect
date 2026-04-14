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
    if (req.method === 'GET' && path === '/api/trends') return trends(url, env);
    if (req.method === 'GET' && path === '/api/compare') return compare(url, env);
    if (req.method === 'GET' && path.startsWith('/r/')) return getReport(path.slice(3), env);
    if (req.method === 'GET' && path === '/compare') return new Response(comparePage(url), { headers: html() });
    if (req.method === 'GET' && path === '/trends') return new Response(trendsPage(url), { headers: html() });
    if (req.method === 'GET' && path === '/') return new Response(indexPage(), { headers: html() });
    if (req.method === 'DELETE' && path.startsWith('/r/')) return deleteReport(path.slice(3), req, env);
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
  return new Response(reportPage(r, id), { headers: html() });
}

async function deleteReport(id: string, req: Request, env: Env): Promise<Response> {
  if (env.UPLOAD_TOKEN) {
    const auth = req.headers.get('authorization') ?? '';
    if (auth !== `Bearer ${env.UPLOAD_TOKEN}`) return new Response('unauthorized', { status: 401 });
  }
  await env.REPORTS.delete(`${id}.json`);
  return new Response(null, { status: 204 });
}

async function trends(url: URL, env: Env): Promise<Response> {
  const target = url.searchParams.get('url');
  if (!target) return new Response('missing url', { status: 400 });
  const list = await env.REPORTS.list({ limit: 1000 });
  const items = await Promise.all(
    list.objects
      .filter((o) => o.key.endsWith('.json'))
      .sort((a, b) => a.uploaded.getTime() - b.uploaded.getTime())
      .map(async (o) => {
        const obj = await env.REPORTS.get(o.key);
        if (!obj) return null;
        const r = await obj.json<ReportSummary>();
        if (r.url !== target) return null;
        const a11yIssues = (r.a11y ?? []).reduce((a, p) => a + p.violations.length, 0);
        const perf = r.perf?.length
          ? r.perf.reduce((a, p) => a + p.scores.performance, 0) / r.perf.length
          : null;
        return {
          id: o.key.replace('.json', ''),
          startedAt: r.startedAt,
          passed: r.passed,
          durationMs: r.durationMs,
          a11y: a11yIssues,
          visualFails: (r.visual ?? []).filter((v) => !v.passed).length,
          perf,
        };
      }),
  );
  return Response.json(items.filter(Boolean));
}

async function compare(url: URL, env: Env): Promise<Response> {
  const a = url.searchParams.get('a');
  const b = url.searchParams.get('b');
  if (!a || !b) return new Response('missing a or b', { status: 400 });
  const [ra, rb] = await Promise.all([env.REPORTS.get(`${a}.json`), env.REPORTS.get(`${b}.json`)]);
  if (!ra || !rb) return new Response('not found', { status: 404 });
  const [ja, jb] = await Promise.all([ra.json<ReportSummary>(), rb.json<ReportSummary>()]);
  const sum = (r: ReportSummary) => ({
    passed: r.passed,
    startedAt: r.startedAt,
    durationMs: r.durationMs,
    flowFails: r.flows.filter((f) => !f.passed).length,
    flows: r.flows.length,
    a11y: (r.a11y ?? []).reduce((x, p) => x + p.violations.length, 0),
    visualFails: (r.visual ?? []).filter((v) => !v.passed).length,
    perf: r.perf?.length
      ? Math.round(r.perf.reduce((x, p) => x + p.scores.performance, 0) / r.perf.length)
      : null,
  });
  return Response.json({ a: { id: a, ...sum(ja) }, b: { id: b, ...sum(jb) } });
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

function reportPage(r: ReportSummary, id: string): string {
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
  <p style="margin-top:32px">
    <a href="/">\u2190 all reports</a> \u00b7
    <a href="/trends?url=${encodeURIComponent(r.url)}">trends for this URL</a> \u00b7
    <a href="/compare?a=${encodeURIComponent(id)}">compare</a>
  </p>
</body></html>`;
}

function comparePage(url: URL): string {
  const a = url.searchParams.get('a') ?? '';
  const b = url.searchParams.get('b') ?? '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>compare</title>${shellCss()}</head>
<body>
  <h1>Compare runs</h1>
  <p class="meta">Enter two run IDs to diff.</p>
  <form id="f" style="display:flex;gap:8px;margin-bottom:16px">
    <input id="a" placeholder="run id A" value="${escapeAttr(a)}" style="flex:1;padding:8px;border:1px solid #E5E7EB;border-radius:6px"/>
    <input id="b" placeholder="run id B" value="${escapeAttr(b)}" style="flex:1;padding:8px;border:1px solid #E5E7EB;border-radius:6px"/>
    <button style="padding:8px 16px;background:#10B981;color:white;border:none;border-radius:6px;cursor:pointer">Compare</button>
  </form>
  <div id="out"></div>
  <p><a href="/">\u2190 all reports</a></p>
<script>
const f = document.getElementById('f');
const out = document.getElementById('out');
async function run() {
  const a = document.getElementById('a').value.trim();
  const b = document.getElementById('b').value.trim();
  if (!a || !b) return;
  const res = await fetch('/api/compare?a=' + encodeURIComponent(a) + '&b=' + encodeURIComponent(b));
  if (!res.ok) { out.textContent = 'error ' + res.status; return; }
  const { a: A, b: B } = await res.json();
  out.textContent = '';
  const table = document.createElement('table');
  table.style.width = '100%';
  table.style.borderCollapse = 'collapse';
  const rows = [
    ['Status', A.passed ? 'PASS' : 'FAIL', B.passed ? 'PASS' : 'FAIL'],
    ['Started', new Date(A.startedAt).toLocaleString(), new Date(B.startedAt).toLocaleString()],
    ['Duration', (A.durationMs/1000).toFixed(1)+'s', (B.durationMs/1000).toFixed(1)+'s'],
    ['Flows', A.flows - A.flowFails + '/' + A.flows, B.flows - B.flowFails + '/' + B.flows],
    ['A11y', A.a11y, B.a11y],
    ['Visual fails', A.visualFails, B.visualFails],
    ['Perf', A.perf ?? '\u2014', B.perf ?? '\u2014'],
  ];
  const header = document.createElement('tr');
  for (const h of ['', 'A: ' + A.id, 'B: ' + B.id]) {
    const th = document.createElement('th');
    th.textContent = h;
    th.style.textAlign = 'left';
    th.style.padding = '8px';
    th.style.fontSize = '12px';
    th.style.color = '#6B7280';
    th.style.textTransform = 'uppercase';
    header.appendChild(th);
  }
  table.appendChild(header);
  for (const [k, av, bv] of rows) {
    const tr = document.createElement('tr');
    tr.style.borderTop = '1px solid #E5E7EB';
    for (const val of [k, av, bv]) {
      const td = document.createElement('td');
      td.textContent = String(val);
      td.style.padding = '8px';
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  out.appendChild(table);
}
f.addEventListener('submit', e => { e.preventDefault(); run(); });
if (document.getElementById('a').value && document.getElementById('b').value) run();
</script>
</body></html>`;
}

function trendsPage(url: URL): string {
  const target = url.searchParams.get('url') ?? '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>trends</title>${shellCss()}</head>
<body>
  <h1>Trends</h1>
  <p class="meta">${escape(target)}</p>
  <div id="chart"></div>
  <div id="list"></div>
  <p><a href="/">\u2190 all reports</a></p>
<script>
const target = ${JSON.stringify(target)};
fetch('/api/trends?url=' + encodeURIComponent(target)).then(r => r.json()).then(items => {
  const chart = document.getElementById('chart');
  const list = document.getElementById('list');
  if (!items.length) { chart.textContent = 'No runs yet.'; return; }
  const W = 800, H = 120, pad = 20;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  svg.style.background = '#fff';
  svg.style.border = '1px solid #E5E7EB';
  svg.style.borderRadius = '8px';
  const max = Math.max(...items.map(i => i.a11y), 1);
  items.forEach((it, i) => {
    const x = pad + (i * (W - 2*pad) / Math.max(items.length-1, 1));
    const y = H - pad - (it.a11y / max) * (H - 2*pad);
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', String(x));
    c.setAttribute('cy', String(y));
    c.setAttribute('r', '4');
    c.setAttribute('fill', it.passed ? '#10B981' : '#EF4444');
    svg.appendChild(c);
    if (i > 0) {
      const prev = items[i-1];
      const px = pad + ((i-1) * (W - 2*pad) / Math.max(items.length-1, 1));
      const py = H - pad - (prev.a11y / max) * (H - 2*pad);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(px));
      line.setAttribute('y1', String(py));
      line.setAttribute('x2', String(x));
      line.setAttribute('y2', String(y));
      line.setAttribute('stroke', '#3B82F6');
      line.setAttribute('stroke-width', '2');
      svg.appendChild(line);
    }
  });
  chart.appendChild(svg);
  const lbl = document.createElement('div');
  lbl.className = 'meta';
  lbl.textContent = 'A11y violations over ' + items.length + ' runs (dot color = pass/fail)';
  chart.appendChild(lbl);
  for (const it of items.slice().reverse()) {
    const a = document.createElement('a');
    a.className = 'row';
    a.href = '/r/' + it.id;
    a.style.color = 'inherit';
    const badge = document.createElement('span');
    badge.className = 'badge ' + (it.passed ? 'badge-pass' : 'badge-fail');
    badge.textContent = it.passed ? 'pass' : 'fail';
    const mid = document.createElement('div');
    mid.textContent = new Date(it.startedAt).toLocaleString();
    const stats = document.createElement('div');
    stats.className = 'stats';
    stats.textContent = it.a11y + ' a11y \u00b7 ' + it.visualFails + ' visual \u00b7 ' + (it.perf ?? '\u2014') + ' perf';
    a.appendChild(badge);
    a.appendChild(mid);
    a.appendChild(stats);
    list.appendChild(a);
  }
});
</script>
</body></html>`;
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function escape(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}
