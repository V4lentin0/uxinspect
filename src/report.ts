import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { InspectResult } from './types.js';

const _pathRef = path;

export async function writeReport(
  result: InspectResult,
  outDir: string,
  reporters: ('html' | 'json' | 'junit' | 'sarif')[] = ['html', 'json'],
): Promise<string> {
  await fs.mkdir(outDir, { recursive: true });
  const htmlPath = path.join(outDir, 'report.html');
  if (reporters.includes('json')) {
    await fs.writeFile(path.join(outDir, 'report.json'), JSON.stringify(result, null, 2));
  }
  if (reporters.includes('html')) {
    await fs.writeFile(htmlPath, renderHTML(result));
  }
  if (reporters.includes('junit')) {
    await fs.writeFile(path.join(outDir, 'junit.xml'), renderJUnit(result));
  }
  if (reporters.includes('sarif')) {
    await fs.writeFile(path.join(outDir, 'sarif.json'), JSON.stringify(renderSARIF(result), null, 2));
  }
  return htmlPath;
}

function renderJUnit(r: InspectResult): string {
  const tests = r.flows.length;
  const failures = r.flows.filter((f) => !f.passed).length;
  const time = (r.durationMs / 1000).toFixed(3);
  const cases = r.flows
    .map((f) => {
      const t = (f.steps.reduce((a, s) => a + s.durationMs, 0) / 1000).toFixed(3);
      const fail = f.passed
        ? ''
        : `<failure message="${escAttr(f.error ?? 'flow failed')}">${escXml(f.error ?? '')}</failure>`;
      return `    <testcase name="${escAttr(f.name)}" time="${t}">${fail}</testcase>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="uxinspect" tests="${tests}" failures="${failures}" time="${time}">
  <testsuite name="${escAttr(r.url)}" tests="${tests}" failures="${failures}" time="${time}">
${cases}
  </testsuite>
</testsuites>`;
}

function renderSARIF(r: InspectResult): unknown {
  const a11y = (r.a11y ?? []).flatMap((p) =>
    p.violations.map((v) => ({
      ruleId: v.id,
      level:
        v.impact === 'critical' || v.impact === 'serious' ? 'error' : v.impact === 'moderate' ? 'warning' : 'note',
      message: { text: v.help },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: p.page },
            region: { snippet: { text: v.nodes[0]?.html?.slice(0, 200) ?? '' } },
          },
        },
      ],
    })),
  );
  const flowFails = r.flows
    .filter((f) => !f.passed)
    .map((f) => ({
      ruleId: 'flow-failure',
      level: 'error',
      message: { text: f.error ?? `flow ${f.name} failed` },
      locations: [{ physicalLocation: { artifactLocation: { uri: r.url } } }],
    }));
  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [
      {
        tool: { driver: { name: 'uxinspect', version: '0.1.0', informationUri: 'https://uxinspect.com' } },
        results: [...a11y, ...flowFails],
      },
    ],
  };
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
  .visual-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-top: 12px; }
  ul { margin: 8px 0; padding-left: 20px; font-size: 13px; }
  code { background: #F3F4F6; padding: 1px 6px; border-radius: 3px; font-size: 12px; }
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

  ${r.budget?.length ? `<h2>Budget violations</h2>${renderBudget(r.budget)}` : ''}
  ${r.flows.length ? `<h2>Flows</h2>${r.flows.map(renderFlow).join('')}` : ''}
  ${r.a11y?.length ? `<h2>Accessibility</h2>${r.a11y.map(renderA11y).join('')}` : ''}
  ${r.perf?.length ? `<h2>Performance</h2>${r.perf.map(renderPerf).join('')}` : ''}
  ${r.visual?.length ? `<h2>Visual</h2>${r.visual.map(renderVisual).join('')}` : ''}
  ${r.seo?.length ? `<h2>SEO</h2>${r.seo.map(renderSeo).join('')}` : ''}
  ${r.links?.length ? `<h2>Broken links</h2>${r.links.map(renderLinks).join('')}` : ''}
  ${r.pwa?.length ? `<h2>PWA</h2>${r.pwa.map(renderPwa).join('')}` : ''}
  ${r.security ? `<h2>Security headers</h2>${renderSecurity(r.security)}` : ''}
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
  const imgs = v.baseline && v.current
    ? `<div class="visual-grid">
        <div><div class="label">Baseline</div><img src="${escape(path.relative('.', v.baseline))}" alt="baseline"></div>
        <div><div class="label">Current</div><img src="${escape(path.relative('.', v.current))}" alt="current"></div>
        ${v.diff ? `<div><div class="label">Diff</div><img src="${escape(path.relative('.', v.diff))}" alt="diff"></div>` : ''}
      </div>`
    : '';
  return `<div class="section">
    <div class="row">
      <strong>${escape(v.page)} (${escape(v.viewport)})</strong>
      <span class="${v.passed ? 'pass' : 'fail'}">${v.passed ? 'PASS' : 'FAIL'} — ${(v.diffRatio * 100).toFixed(2)}% diff</span>
    </div>
    ${imgs}
  </div>`;
}

function renderSeo(s: any): string {
  return `<div class="section">
    <div class="row"><strong>${escape(s.page)}</strong> <span class="${s.passed ? 'pass' : 'fail'}">${s.issues.length} issue${s.issues.length === 1 ? '' : 's'}</span></div>
    <div class="label">title: ${escape(s.title ?? '—')}</div>
    <div class="label">description: ${escape(s.description ?? '—')}</div>
    ${s.issues.length ? `<ul>${s.issues.map((i: string) => `<li>${escape(i)}</li>`).join('')}</ul>` : ''}
  </div>`;
}

function renderLinks(l: any): string {
  return `<div class="section">
    <div class="row"><strong>${escape(l.page)}</strong> <span class="${l.passed ? 'pass' : 'fail'}">${l.broken.length} broken / ${l.total} links</span></div>
    ${l.broken.length ? `<ul>${l.broken.map((b: any) => `<li><code>${b.status || 'ERR'}</code> ${escape(b.url)}${b.text ? ` — ${escape(b.text)}` : ''}</li>`).join('')}</ul>` : ''}
  </div>`;
}

function renderPwa(p: any): string {
  return `<div class="section">
    <div class="row"><strong>${escape(p.page)}</strong> <span class="${p.passed ? 'pass' : 'fail'}">${p.passed ? 'PASS' : p.issues.length + ' issues'}</span></div>
    <div class="label">Manifest: ${p.manifest ? (p.manifest.valid ? 'valid' : 'invalid') : 'missing'} · SW: ${p.serviceWorker ? 'yes' : 'no'} · Installable: ${p.installable ? 'yes' : 'no'}</div>
    ${p.issues.length ? `<ul>${p.issues.map((i: string) => `<li>${escape(i)}</li>`).join('')}</ul>` : ''}
  </div>`;
}

function renderSecurity(s: any): string {
  return `<div class="section">
    <div class="row"><strong>${escape(s.page)}</strong> <span class="${s.passed ? 'pass' : 'fail'}">${s.issues.length} issues</span></div>
    ${s.issues.length ? `<ul>${s.issues.map((i: string) => `<li>${escape(i)}</li>`).join('')}</ul>` : ''}
  </div>`;
}

function renderBudget(v: any[]): string {
  return `<div class="section">
    <ul>${v.map((b) => `<li><strong>${escape(b.category)}</strong> — ${escape(b.message)}</li>`).join('')}</ul>
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
