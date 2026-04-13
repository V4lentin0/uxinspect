import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { InspectResult } from './types.js';

export async function writeReport(result: InspectResult, outDir: string): Promise<string> {
  await fs.mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, 'report.json');
  const htmlPath = path.join(outDir, 'report.html');
  await fs.writeFile(jsonPath, JSON.stringify(result, null, 2));
  await fs.writeFile(htmlPath, renderHTML(result));
  return htmlPath;
}

function renderHTML(r: InspectResult): string {
  const a11yViolations = (r.a11y ?? []).flatMap((p) => p.violations);
  const a11yCritical = a11yViolations.filter((v) => v.impact === 'critical' || v.impact === 'serious').length;
  const visualFails = (r.visual ?? []).filter((v) => !v.passed).length;
  const flowFails = r.flows.filter((f) => !f.passed).length;
  const perfAvg = r.perf?.length
    ? Math.round(r.perf.reduce((a, p) => a + p.scores.performance, 0) / r.perf.length)
    : null;

  const status = r.passed ? 'PASS' : 'FAIL';
  const statusColor = r.passed ? '#10B981' : '#EF4444';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>uxinspect report — ${escape(r.url)}</title>
<link rel="preconnect" href="https://rsms.me/">
<link rel="stylesheet" href="https://rsms.me/inter/inter.css">
<style>
  :root { --bg:#FAFAFA; --card:#FFFFFF; --border:#E5E7EB; --text:#1D1D1F; --muted:#6B7280;
          --green:#10B981; --green-bg:#ECFDF5; --blue:#3B82F6; --blue-bg:#EFF6FF; --red:#EF4444; }
  * { box-sizing: border-box; }
  body { font-family: 'Inter', system-ui, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 32px; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 32px 0 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .url { color: var(--muted); margin-bottom: 24px; }
  .badge { display: inline-block; padding: 4px 12px; border-radius: 6px; font-weight: 600; color: white; background: ${statusColor}; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .stat { font-size: 28px; font-weight: 700; }
  .label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .section { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border); }
  .row:last-child { border-bottom: none; }
  .pass { color: var(--green); }
  .fail { color: var(--red); }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .pill-critical { background: #FEF2F2; color: #991B1B; }
  .pill-serious { background: #FFF7ED; color: #9A3412; }
  .pill-moderate { background: #FFFBEB; color: #92400E; }
  .pill-minor { background: var(--blue-bg); color: var(--blue); }
  pre { background: #F9FAFB; border: 1px solid var(--border); padding: 8px; border-radius: 4px; overflow-x: auto; font-size: 12px; }
  img { max-width: 100%; border: 1px solid var(--border); border-radius: 4px; }
</style>
</head>
<body>
  <h1>UI/UX Inspection Report <span class="badge">${status}</span></h1>
  <div class="url">${escape(r.url)} · ${new Date(r.startedAt).toLocaleString()} · ${(r.durationMs / 1000).toFixed(1)}s</div>

  <div class="grid">
    <div class="card"><div class="label">Flows</div><div class="stat">${r.flows.length - flowFails}/${r.flows.length}</div></div>
    <div class="card"><div class="label">A11y violations</div><div class="stat ${a11yCritical > 0 ? 'fail' : 'pass'}">${a11yViolations.length}</div></div>
    <div class="card"><div class="label">Visual diffs</div><div class="stat ${visualFails > 0 ? 'fail' : 'pass'}">${visualFails}</div></div>
    ${perfAvg !== null ? `<div class="card"><div class="label">Perf score</div><div class="stat">${perfAvg}</div></div>` : ''}
    ${r.explore ? `<div class="card"><div class="label">Pages explored</div><div class="stat">${r.explore.pagesVisited}</div></div>` : ''}
  </div>

  ${r.flows.length ? `<h2>Flows</h2>${r.flows.map(renderFlow).join('')}` : ''}
  ${r.a11y?.length ? `<h2>Accessibility</h2>${r.a11y.map(renderA11y).join('')}` : ''}
  ${r.perf?.length ? `<h2>Performance</h2>${r.perf.map(renderPerf).join('')}` : ''}
  ${r.visual?.length ? `<h2>Visual</h2>${r.visual.map(renderVisual).join('')}` : ''}
  ${r.explore ? `<h2>Exploration</h2>${renderExplore(r.explore)}` : ''}
</body>
</html>`;
}

function renderFlow(f: { name: string; passed: boolean; steps: any[]; error?: string }): string {
  return `<div class="section">
    <div class="row"><strong>${escape(f.name)}</strong> <span class="${f.passed ? 'pass' : 'fail'}">${f.passed ? 'PASS' : 'FAIL'}</span></div>
    ${f.error ? `<pre>${escape(f.error)}</pre>` : ''}
    <div class="label">${f.steps.length} steps</div>
  </div>`;
}

function renderA11y(a: any): string {
  if (a.violations.length === 0) {
    return `<div class="section"><div class="row">${escape(a.page)} <span class="pass">No violations</span></div></div>`;
  }
  return `<div class="section">
    <div class="row"><strong>${escape(a.page)}</strong> <span class="fail">${a.violations.length} violations</span></div>
    ${a.violations.map((v: any) => `
      <div class="row">
        <div><span class="pill pill-${v.impact}">${v.impact}</span> <strong>${escape(v.id)}</strong> ${escape(v.description)}</div>
        <a href="${v.helpUrl}" target="_blank">docs</a>
      </div>
    `).join('')}
  </div>`;
}

function renderPerf(p: any): string {
  return `<div class="section">
    <div class="row"><strong>${escape(p.page)}</strong></div>
    <div class="grid">
      <div><div class="label">Performance</div><div class="stat">${p.scores.performance}</div></div>
      <div><div class="label">Accessibility</div><div class="stat">${p.scores.accessibility}</div></div>
      <div><div class="label">Best Practices</div><div class="stat">${p.scores.bestPractices}</div></div>
      <div><div class="label">SEO</div><div class="stat">${p.scores.seo}</div></div>
    </div>
    <div class="label">LCP ${(p.metrics.lcp / 1000).toFixed(2)}s · CLS ${p.metrics.cls.toFixed(3)} · TBT ${p.metrics.tbt.toFixed(0)}ms</div>
  </div>`;
}

function renderVisual(v: any): string {
  return `<div class="section">
    <div class="row">
      <strong>${escape(v.page)} (${escape(v.viewport)})</strong>
      <span class="${v.passed ? 'pass' : 'fail'}">${v.passed ? 'PASS' : 'FAIL'} — ${(v.diffRatio * 100).toFixed(2)}% diff</span>
    </div>
  </div>`;
}

function renderExplore(e: any): string {
  return `<div class="section">
    <div class="grid">
      <div><div class="label">Pages</div><div class="stat">${e.pagesVisited}</div></div>
      <div><div class="label">Buttons clicked</div><div class="stat">${e.buttonsClicked}</div></div>
      <div><div class="label">Console errors</div><div class="stat ${e.consoleErrors.length ? 'fail' : 'pass'}">${e.consoleErrors.length}</div></div>
      <div><div class="label">Network errors</div><div class="stat ${e.networkErrors.length ? 'fail' : 'pass'}">${e.networkErrors.length}</div></div>
    </div>
    ${e.consoleErrors.length ? `<h3>Console errors</h3><pre>${e.consoleErrors.map((s: string) => escape(s)).join('\n')}</pre>` : ''}
    ${e.networkErrors.length ? `<h3>Network errors</h3><pre>${e.networkErrors.map((s: string) => escape(s)).join('\n')}</pre>` : ''}
  </div>`;
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
