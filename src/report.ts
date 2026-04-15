import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { InspectResult } from './types.js';
import { renderCrossBrowserHtml } from './cross-browser.js';

const _pathRef = path;

export async function writeReport(
  result: InspectResult,
  outDir: string,
  reporters: ('html' | 'json' | 'junit' | 'sarif' | 'allure' | 'tap')[] = ['html', 'json'],
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
  if (reporters.includes('allure')) {
    await writeAllure(result, outDir);
  }
  if (reporters.includes('tap')) {
    await fs.writeFile(path.join(outDir, 'report.tap'), renderTAP(result));
  }
  return htmlPath;
}

async function writeAllure(r: InspectResult, outDir: string): Promise<void> {
  const allureDir = path.join(outDir, 'allure-results');
  await fs.mkdir(allureDir, { recursive: true });
  const startBase = new Date(r.startedAt).getTime();
  const stopBase = new Date(r.finishedAt).getTime();
  const safeUrl = r.url.replace(/[^a-zA-Z0-9]+/g, '_');

  const hashId = (s: string): string => crypto.createHash('md5').update(s).digest('hex');

  const writeResult = async (obj: Record<string, unknown>): Promise<void> => {
    const uuid = (obj.uuid as string) ?? crypto.randomUUID();
    obj.uuid = uuid;
    await fs.writeFile(path.join(allureDir, `${uuid}-result.json`), JSON.stringify(obj, null, 2));
  };

  for (const flow of r.flows) {
    const flowStart = startBase;
    let cursor = flowStart;
    const steps = flow.steps.map((s) => {
      const stepStart = cursor;
      const stepStop = cursor + (s.durationMs || 0);
      cursor = stepStop;
      return {
        name: describeStep(s.step),
        status: s.passed ? 'passed' : 'failed',
        stage: 'finished',
        start: stepStart,
        stop: stepStop,
        ...(s.error ? { statusDetails: { message: s.error } } : {}),
      };
    });
    const flowStop = cursor > flowStart ? cursor : stopBase;
    const status: 'passed' | 'failed' | 'broken' = flow.passed ? 'passed' : flow.error ? 'broken' : 'failed';
    await writeResult({
      uuid: crypto.randomUUID(),
      historyId: hashId(`flow:${flow.name}`),
      name: flow.name,
      fullName: `uxinspect.${safeUrl}.${flow.name}`,
      status,
      stage: 'finished',
      start: flowStart,
      stop: flowStop,
      labels: [
        { name: 'suite', value: r.url },
        { name: 'severity', value: 'normal' },
        { name: 'feature', value: 'flow' },
      ],
      steps,
      ...(flow.error ? { statusDetails: { message: flow.error } } : {}),
    });
  }

  for (const a of r.a11y ?? []) {
    const critical = a.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    const failed = critical.length > 0;
    const name = `a11y: ${a.page}`;
    await writeResult({
      uuid: crypto.randomUUID(),
      historyId: hashId(`a11y:${a.page}`),
      name,
      fullName: `uxinspect.${safeUrl}.a11y.${a.page}`,
      status: failed ? 'failed' : 'passed',
      stage: 'finished',
      start: startBase,
      stop: stopBase,
      labels: [
        { name: 'suite', value: r.url },
        { name: 'severity', value: failed ? 'critical' : 'normal' },
        { name: 'feature', value: 'a11y' },
      ],
      steps: a.violations.map((v) => ({
        name: `${v.id}: ${v.help}`,
        status: v.impact === 'critical' || v.impact === 'serious' ? 'failed' : 'passed',
        stage: 'finished',
        start: startBase,
        stop: stopBase,
      })),
      ...(failed
        ? { statusDetails: { message: `${critical.length} critical/serious a11y violations` } }
        : {}),
    });
  }
}

function renderTAP(r: InspectResult): string {
  const points: { ok: boolean; desc: string; message?: string }[] = [];

  for (const f of r.flows) {
    points.push({
      ok: f.passed,
      desc: `flow: ${f.name}`,
      message: f.error,
    });
  }

  for (const a of r.a11y ?? []) {
    const crit = a.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    points.push({
      ok: crit.length === 0,
      desc: `a11y: ${a.page}`,
      message: crit.length > 0 ? `${crit.length} critical/serious violations` : undefined,
    });
  }

  for (const v of r.visual ?? []) {
    points.push({
      ok: v.passed,
      desc: `visual: ${v.page} [${v.viewport}]`,
      message: v.passed ? undefined : `diff ${v.diffPixels}px (${(v.diffRatio * 100).toFixed(2)}%)`,
    });
  }

  for (const p of r.perf ?? []) {
    const score = p.scores.performance;
    points.push({
      ok: score >= 50,
      desc: `perf: ${p.page} (score=${score})`,
      message: score < 50 ? `performance score ${score} below threshold 50` : undefined,
    });
  }

  for (const s of r.seo ?? []) {
    const issues = (s as { issues?: unknown[] }).issues ?? [];
    points.push({
      ok: issues.length === 0,
      desc: `seo: ${(s as { page?: string }).page ?? 'page'}`,
      message: issues.length > 0 ? `${issues.length} seo issues` : undefined,
    });
  }

  for (const l of r.links ?? []) {
    const broken = (l as { broken?: unknown[] }).broken ?? [];
    points.push({
      ok: broken.length === 0,
      desc: `links: ${(l as { page?: string }).page ?? 'page'}`,
      message: broken.length > 0 ? `${broken.length} broken links` : undefined,
    });
  }

  for (const p of r.pwa ?? []) {
    const passed = (p as { passed?: boolean }).passed ?? true;
    points.push({
      ok: passed,
      desc: `pwa: ${(p as { page?: string }).page ?? 'page'}`,
    });
  }

  if (r.security) {
    const missing = (r.security as { missing?: unknown[] }).missing ?? [];
    points.push({
      ok: missing.length === 0,
      desc: 'security: headers',
      message: missing.length > 0 ? `${missing.length} missing headers` : undefined,
    });
  }

  for (const v of r.retire ?? []) {
    const vulns = (v as { vulnerabilities?: unknown[] }).vulnerabilities ?? [];
    points.push({
      ok: vulns.length === 0,
      desc: `retire: ${(v as { url?: string }).url ?? 'script'}`,
      message: vulns.length > 0 ? `${vulns.length} vulnerabilities` : undefined,
    });
  }

  for (const f of r.apiFlows ?? []) {
    points.push({ ok: f.passed, desc: `api: ${f.name}`, message: f.error });
  }

  for (const b of r.budget ?? []) {
    const msg = (b as { message?: string; metric?: string }).message
      ?? (b as { metric?: string }).metric
      ?? 'budget violation';
    points.push({ ok: false, desc: `budget: ${msg}`, message: msg });
  }

  for (const d of r.deadClicks ?? []) {
    const found = (d as { deadClicks?: unknown[] }).deadClicks ?? [];
    points.push({
      ok: found.length === 0,
      desc: `deadClicks: ${(d as { page?: string }).page ?? 'page'}`,
      message: found.length > 0 ? `${found.length} dead clicks` : undefined,
    });
  }

  for (const t of r.touchTargets ?? []) {
    const small = (t as { tooSmall?: unknown[] }).tooSmall ?? [];
    points.push({
      ok: small.length === 0,
      desc: `touchTargets: ${(t as { page?: string }).page ?? 'page'}`,
      message: small.length > 0 ? `${small.length} small targets` : undefined,
    });
  }

  for (const k of r.keyboard ?? []) {
    const issues = (k as { issues?: unknown[] }).issues ?? [];
    points.push({
      ok: issues.length === 0,
      desc: `keyboard: ${(k as { page?: string }).page ?? 'page'}`,
      message: issues.length > 0 ? `${issues.length} keyboard issues` : undefined,
    });
  }

  for (const ce of r.consoleErrors ?? []) {
    const errs = (ce as { errors?: unknown[] }).errors ?? [];
    points.push({
      ok: errs.length === 0,
      desc: `consoleErrors: ${(ce as { page?: string }).page ?? 'page'}`,
      message: errs.length > 0 ? `${errs.length} console errors` : undefined,
    });
  }

  for (const mc of r.mixedContent ?? []) {
    const items = (mc as { items?: unknown[] }).items ?? [];
    points.push({
      ok: items.length === 0,
      desc: `mixedContent: ${(mc as { page?: string }).page ?? 'page'}`,
      message: items.length > 0 ? `${items.length} mixed content items` : undefined,
    });
  }

  const total = points.length;
  const lines: string[] = ['TAP version 14', `1..${total}`];
  points.forEach((p, i) => {
    const n = i + 1;
    const prefix = p.ok ? 'ok' : 'not ok';
    lines.push(`${prefix} ${n} - ${escapeTapDesc(p.desc)}`);
    if (!p.ok && p.message) {
      lines.push('  ---');
      lines.push(`  message: '${escapeTapMsg(p.message)}'`);
      lines.push('  ---');
    }
  });
  return lines.join('\n') + '\n';
}

function escapeTapDesc(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').replace(/#/g, '\\#');
}

function escapeTapMsg(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[\r\n]+/g, ' ');
}

function describeStep(step: unknown): string {
  if (!step || typeof step !== 'object') return 'step';
  const keys = Object.keys(step as Record<string, unknown>);
  if (keys.length === 0) return 'step';
  const key = keys[0];
  const val = (step as Record<string, unknown>)[key];
  if (typeof val === 'string') return `${key}: ${val}`;
  if (typeof val === 'number' || typeof val === 'boolean') return `${key}: ${String(val)}`;
  return key;
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
  details { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; margin-bottom: 12px; }
  details[open] { padding-bottom: 16px; }
  summary { cursor: pointer; font-weight: 600; display: flex; justify-content: space-between; align-items: center; gap: 12px; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  summary::before { content: '\\25B8'; display: inline-block; transition: transform 0.15s ease; color: var(--muted); font-size: 10px; margin-right: 6px; }
  details[open] > summary::before { transform: rotate(90deg); }
  .summary-meta { display: flex; align-items: center; gap: 8px; font-weight: 400; color: var(--muted); font-size: 13px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; background: #F9FAFB; }
  tbody tr:last-child td { border-bottom: none; }
  .pill-warn { background: #FFFBEB; color: #92400E; }
  .pill-error { background: #FEF2F2; color: #991B1B; }
  .pill-info { background: var(--blue-bg); color: var(--blue); }
  .pill-high { background: #FEF2F2; color: #991B1B; }
  .pill-medium { background: #FFFBEB; color: #92400E; }
  .pill-low { background: var(--blue-bg); color: var(--blue); }
  .kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; font-size: 13px; margin-top: 8px; }
  .kv dt { color: var(--muted); }
  .kv dd { margin: 0; color: var(--text); word-break: break-word; }
  .empty { color: var(--muted); font-style: italic; font-size: 13px; }
  .mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
  .trunc { max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; vertical-align: middle; }
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
  ${r.retire?.length ? `<h2>Vulnerable libraries</h2>${r.retire.map(renderRetire).join('')}` : ''}
  ${r.deadClicks?.length ? `<h2>Dead clicks</h2>${r.deadClicks.map(renderDeadClicks).join('')}` : ''}
  ${r.touchTargets?.length ? `<h2>Touch targets</h2>${r.touchTargets.map(renderTouchTargets).join('')}` : ''}
  ${r.keyboard?.length ? `<h2>Keyboard</h2>${r.keyboard.map(renderKeyboard).join('')}` : ''}
  ${r.longTasks?.length ? `<h2>Long tasks & INP</h2>${r.longTasks.map(renderLongTasks).join('')}` : ''}
  ${r.clsTimeline?.length ? `<h2>Layout shifts</h2>${r.clsTimeline.map(renderClsTimeline).join('')}` : ''}
  ${r.forms?.length ? `<h2>Forms</h2>${r.forms.map(renderForms).join('')}` : ''}
  ${r.structuredData?.length ? `<h2>Structured data</h2>${r.structuredData.map(renderStructuredData).join('')}` : ''}
  ${r.passiveSecurity?.length ? `<h2>Passive security</h2>${r.passiveSecurity.map(renderPassiveSecurity).join('')}` : ''}
  ${r.consoleErrors?.length ? `<h2>Console errors</h2>${r.consoleErrors.map(renderConsoleErrors).join('')}` : ''}
  ${r.sitemap ? `<h2>Sitemap</h2>${renderSitemap(r.sitemap)}` : ''}
  ${r.redirects ? `<h2>Redirects</h2>${renderRedirects(r.redirects)}` : ''}
  ${r.exposedPaths ? `<h2>Exposed paths</h2>${renderExposedPaths(r.exposedPaths)}` : ''}
  ${r.tls ? `<h2>TLS</h2>${renderTls(r.tls)}` : ''}
  ${r.crawl ? `<h2>Crawl</h2>${renderCrawl(r.crawl)}` : ''}
  ${r.contentQuality ? `<h2>Content quality</h2>${renderContentQuality(r.contentQuality)}` : ''}
  ${(r as any).resourceHints?.length ? `<h2>Resource hints</h2>${(r as any).resourceHints.map(renderResourceHints).join('')}` : ''}
  ${(r as any).mixedContent?.length ? `<h2>Mixed content</h2>${(r as any).mixedContent.map(renderMixedContent).join('')}` : ''}
  ${(r as any).compression ? `<h2>Compression</h2>${renderCompression((r as any).compression)}` : ''}
  ${(r as any).cacheHeaders?.length ? `<h2>Cache headers</h2>${(r as any).cacheHeaders.map(renderCacheHeaders).join('')}` : ''}
  ${(r as any).cookieBanner?.length ? `<h2>Cookie banner</h2>${(r as any).cookieBanner.map(renderCookieBanner).join('')}` : ''}
  ${(r as any).thirdParty?.length ? `<h2>Third-party resources</h2>${(r as any).thirdParty.map(renderThirdParty).join('')}` : ''}
  ${(r as any).bundleSize?.length ? `<h2>Bundle size</h2>${(r as any).bundleSize.map(renderBundleSize).join('')}` : ''}
  ${(r as any).openGraph?.length ? `<h2>Open Graph</h2>${(r as any).openGraph.map(renderOpenGraph).join('')}` : ''}
  ${(r as any).robotsAudit ? `<h2>robots.txt</h2>${renderRobotsAudit((r as any).robotsAudit)}` : ''}
  ${(r as any).imageAudit?.length ? `<h2>Images</h2>${(r as any).imageAudit.map(renderImageAudit).join('')}` : ''}
  ${(r as any).webfonts?.length ? `<h2>Webfonts</h2>${(r as any).webfonts.map(renderWebfonts).join('')}` : ''}
  ${(r as any).motionPrefs?.length ? `<h2>Motion preferences</h2>${(r as any).motionPrefs.map(renderMotionPrefs).join('')}` : ''}
  ${r.explore ? `<h2>Exploration</h2>${renderExplore(r.explore)}` : ''}
  ${r.crossBrowser ? `<h2>Cross-browser</h2>${renderCrossBrowserHtml(r.crossBrowser, r.crossBrowser.outDir)}` : ''}
  ${renderUnknownSections(r)}
</body>
</html>`;
}

const KNOWN_RESULT_KEYS = new Set([
  'url', 'startedAt', 'finishedAt', 'durationMs', 'flows', 'budget',
  'a11y', 'perf', 'visual', 'seo', 'links', 'pwa', 'security', 'retire',
  'deadClicks', 'touchTargets', 'keyboard', 'longTasks', 'clsTimeline', 'forms',
  'structuredData', 'passiveSecurity', 'consoleErrors', 'sitemap', 'redirects',
  'exposedPaths', 'tls', 'crawl', 'contentQuality', 'resourceHints', 'mixedContent',
  'compression', 'cacheHeaders', 'cookieBanner', 'thirdParty', 'bundleSize',
  'openGraph', 'robotsAudit', 'imageAudit', 'webfonts', 'motionPrefs', 'explore',
  'apiFlows', 'crossBrowser', 'passed',
]);

function renderUnknownSections(r: any): string {
  const out: string[] = [];
  for (const key of Object.keys(r)) {
    if (KNOWN_RESULT_KEYS.has(key)) continue;
    const val = r[key];
    if (val === undefined || val === null) continue;
    if (Array.isArray(val) && val.length === 0) continue;
    const title = escape(key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()));
    out.push(`<h2>${title}</h2><div class="section"><pre>${escape(JSON.stringify(val, null, 2))}</pre></div>`);
  }
  return out.join('');
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
  return (s ?? '').toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function statusBadge(passed: boolean, label?: string): string {
  return `<span class="${passed ? 'pass' : 'fail'}">${label ?? (passed ? 'PASS' : 'FAIL')}</span>`;
}

function summaryRow(title: string, passed: boolean, meta: string): string {
  return `<summary><span>${escape(title)}</span><span class="summary-meta">${meta} ${statusBadge(passed)}</span></summary>`;
}

function plural(n: number, one: string, many?: string): string {
  return `${n} ${n === 1 ? one : many ?? one + 's'}`;
}

function bytes(n: number | undefined): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function renderRetire(r: any): string {
  const pageUrl = r.findings[0]?.url ?? '';
  const vulnCount = r.findings.reduce((n: number, f: any) => n + f.vulnerabilities.length, 0);
  const meta = `${plural(r.findings.length, 'library', 'libraries')} · ${plural(vulnCount, 'vulnerability', 'vulnerabilities')} · ${r.librariesScanned} scanned`;
  const body = r.findings.length === 0
    ? `<div class="empty">No vulnerable libraries detected.</div>`
    : `<table><thead><tr><th>Library</th><th>Version</th><th>Severity</th><th>Summary</th><th>CVE</th></tr></thead><tbody>${
        r.findings.map((f: any) => f.vulnerabilities.map((v: any) => `
          <tr>
            <td><strong>${escape(f.library)}</strong><div class="mono trunc">${escape(f.url)}</div></td>
            <td><code>${escape(f.version)}</code></td>
            <td><span class="pill pill-${v.severity === 'critical' ? 'critical' : v.severity === 'high' ? 'serious' : v.severity === 'medium' ? 'moderate' : 'minor'}">${escape(v.severity)}</span></td>
            <td>${escape(v.summary)}</td>
            <td class="mono">${(v.identifiers?.CVE ?? []).map((c: string) => escape(c)).join(', ') || '—'}</td>
          </tr>`).join('')).join('')
      }</tbody></table>`;
  return `<details${r.passed ? '' : ' open'}>${summaryRow(pageUrl || 'Retire.js', r.passed, meta)}${body}</details>`;
}

function renderDeadClicks(r: any): string {
  const meta = `${plural(r.clicked, 'click')} · ${plural(r.findings.length, 'dead click')}`;
  const body = r.findings.length === 0
    ? `<div class="empty">All interactive elements responded.</div>`
    : `<table><thead><tr><th>Selector</th><th>Reason</th><th>Feedback</th><th>HTML</th></tr></thead><tbody>${
        r.findings.map((f: any) => `
          <tr>
            <td class="mono trunc">${escape(f.selector)}</td>
            <td><span class="pill pill-warn">${escape(f.reason)}</span></td>
            <td>${f.feedbackMs !== undefined ? `${f.feedbackMs}ms` : '—'}</td>
            <td class="mono trunc">${escape(f.html)}</td>
          </tr>`).join('')
      }</tbody></table>`;
  return `<details${r.passed ? '' : ' open'}>${summaryRow(r.page, r.passed, meta)}${body}</details>`;
}

function renderTouchTargets(r: any): string {
  const meta = `${r.scanned} scanned · ${plural(r.tooSmall.length, 'too small')} · ${plural(r.overlapping.length, 'overlap')}`;
  const rows = (arr: any[], kind: string) => arr.map((f: any) => `
    <tr>
      <td class="mono trunc">${escape(f.selector)}</td>
      <td><span class="pill pill-warn">${kind}</span></td>
      <td>${Math.round(f.width)}×${Math.round(f.height)}px</td>
      <td class="mono trunc">${escape(f.overlapsWith ?? '')}</td>
    </tr>`).join('');
  const body = r.tooSmall.length === 0 && r.overlapping.length === 0
    ? `<div class="empty">All touch targets meet minimum size.</div>`
    : `<table><thead><tr><th>Selector</th><th>Issue</th><th>Size</th><th>Overlaps with</th></tr></thead><tbody>${rows(r.tooSmall, 'too-small')}${rows(r.overlapping, 'overlapping')}</tbody></table>`;
  return `<details${r.passed ? '' : ' open'}>${summaryRow(r.page, r.passed, meta)}${body}</details>`;
}

function renderKeyboard(r: any): string {
  const meta = `${r.focusableCount} focusable · ${r.tabsTaken} tabs · ${plural(r.issues.length, 'issue')}`;
  const body = r.issues.length === 0
    ? `<div class="empty">Keyboard navigation is healthy.</div>`
    : `<table><thead><tr><th>Level</th><th>Type</th><th>Selector</th><th>Message</th></tr></thead><tbody>${
        r.issues.map((i: any) => `
          <tr>
            <td><span class="pill pill-${i.level === 'error' ? 'error' : 'warn'}">${escape(i.level)}</span></td>
            <td><code>${escape(i.type)}</code></td>
            <td class="mono trunc">${escape(i.selector ?? '—')}</td>
            <td>${escape(i.message)}</td>
          </tr>`).join('')
      }</tbody></table>`;
  return `<details${r.passed ? '' : ' open'}>${summaryRow(r.page, r.passed, meta)}${body}</details>`;
}

function renderLongTasks(r: any): string {
  const meta = `TBT ${Math.round(r.totalBlockingMs)}ms · INP ${r.inpMs !== undefined ? `${Math.round(r.inpMs)}ms` : '—'} · ${plural(r.longTasks.length, 'long task')}`;
  const body = `
    <dl class="kv">
      <dt>Total blocking</dt><dd>${Math.round(r.totalBlockingMs)}ms</dd>
      <dt>INP</dt><dd>${r.inpMs !== undefined ? `${Math.round(r.inpMs)}ms${r.inpTarget ? ` on <code>${escape(r.inpTarget)}</code>` : ''}` : '—'}</dd>
      <dt>Long tasks</dt><dd>${r.longTasks.length}</dd>
      <dt>LoAF frames</dt><dd>${r.longAnimationFrames.length}</dd>
    </dl>
    ${r.longTasks.length ? `<table><thead><tr><th>Start</th><th>Duration</th><th>Attribution</th></tr></thead><tbody>${
      r.longTasks.slice(0, 20).map((t: any) => `
        <tr>
          <td>${Math.round(t.startTime)}ms</td>
          <td>${Math.round(t.duration)}ms</td>
          <td class="mono trunc">${(t.attribution ?? []).map((a: any) => escape([a.containerType, a.containerName, a.containerSrc].filter(Boolean).join(' '))).join(', ') || '—'}</td>
        </tr>`).join('')
    }</tbody></table>` : ''}`;
  return `<details${r.passed ? '' : ' open'}>${summaryRow(r.page, r.passed, meta)}${body}</details>`;
}

function renderClsTimeline(r: any): string {
  const meta = `CLS ${r.cls.toFixed(3)} · ${plural(r.timeline.length, 'shift')}`;
  const body = r.worstElements.length === 0
    ? `<div class="empty">No layout shifts recorded.</div>`
    : `<table><thead><tr><th>Selector</th><th>Total shift</th><th>Occurrences</th></tr></thead><tbody>${
        r.worstElements.map((e: any) => `
          <tr>
            <td class="mono trunc">${escape(e.selector)}</td>
            <td>${e.totalShift.toFixed(4)}</td>
            <td>${e.occurrences}</td>
          </tr>`).join('')
      }</tbody></table>`;
  return `<details${r.passed ? '' : ' open'}>${summaryRow(r.page, r.passed, meta)}${body}</details>`;
}

function renderForms(r: any): string {
  const meta = `${plural(r.forms.length, 'form')} · ${plural(r.totalIssues, 'issue')}`;
  const body = r.forms.length === 0
    ? `<div class="empty">No forms on this page.</div>`
    : r.forms.map((f: any) => `
        <div style="margin-top:12px">
          <div><strong class="mono">${escape(f.selector)}</strong> <span class="label">${escape(f.method)} · ${f.fields} fields</span></div>
          ${f.issues.length ? `<table><thead><tr><th>Level</th><th>Type</th><th>Selector</th><th>Message</th></tr></thead><tbody>${
            f.issues.map((i: any) => `
              <tr>
                <td><span class="pill pill-${i.level === 'error' ? 'error' : 'warn'}">${escape(i.level)}</span></td>
                <td><code>${escape(i.type)}</code></td>
                <td class="mono trunc">${escape(i.selector)}</td>
                <td>${escape(i.message)}</td>
              </tr>`).join('')
          }</tbody></table>` : '<div class="empty">No issues.</div>'}
        </div>`).join('');
  return `<details${r.passed ? '' : ' open'}>${summaryRow(r.page, r.passed, meta)}${body}</details>`;
}

function renderStructuredData(r: any): string {
  const meta = `${plural(r.items.length, 'item')} · ${plural(r.hreflangTags.length, 'hreflang')} · ${plural(r.issues.length, 'issue')}`;
  const items = r.items.length
    ? `<table><thead><tr><th>Format</th><th>Type</th></tr></thead><tbody>${
        r.items.map((i: any) => `<tr><td><code>${escape(i.format)}</code></td><td>${escape(i.type)}</td></tr>`).join('')
      }</tbody></table>` : '';
  const issues = r.issues.length
    ? `<table><thead><tr><th>Level</th><th>Type</th><th>Message</th></tr></thead><tbody>${
        r.issues.map((i: any) => `
          <tr>
            <td><span class="pill pill-${i.level === 'error' ? 'error' : 'warn'}">${escape(i.level)}</span></td>
            <td><code>${escape(i.type)}</code></td>
            <td>${escape(i.message)}${i.snippet ? `<div class="mono trunc">${escape(i.snippet)}</div>` : ''}</td>
          </tr>`).join('')
      }</tbody></table>` : '';
  const body = r.items.length === 0 && r.issues.length === 0
    ? `<div class="empty">No structured data found.</div>`
    : items + issues;
  return `<details${r.passed ? '' : ' open'}>${summaryRow(r.page, r.passed, meta)}${body}</details>`;
}

function renderPassiveSecurity(r: any): string {
  const meta = `${plural(r.issues.length, 'issue')} · ${r.scannedScripts} scripts · ${r.scannedLinks} links · ${r.cookiesChecked} cookies`;
  const body = r.issues.length === 0
    ? `<div class="empty">No passive security smells.</div>`
    : `<table><thead><tr><th>Level</th><th>Type</th><th>Target</th><th>Message</th></tr></thead><tbody>${
        r.issues.map((i: any) => `
          <tr>
            <td><span class="pill pill-${i.level === 'error' ? 'error' : 'warn'}">${escape(i.level)}</span></td>
            <td><code>${escape(i.type)}</code></td>
            <td class="mono trunc">${escape(i.selector ?? i.url ?? i.cookieName ?? '—')}</td>
            <td>${escape(i.message)}</td>
          </tr>`).join('')
      }</tbody></table>`;
  return `<details${r.passed ? '' : ' open'}>${summaryRow(r.page, r.passed, meta)}${body}</details>`;
}

function renderConsoleErrors(r: any): string {
  const meta = `${r.errorCount} errors · ${r.warningCount} warnings · ${plural(r.issues.length, 'unique issue')}`;
  const body = r.issues.length === 0
    ? `<div class="empty">No console messages captured.</div>`
    : `<table><thead><tr><th>Type</th><th>Count</th><th>Message</th><th>Source</th></tr></thead><tbody>${
        r.issues.map((i: any) => `
          <tr>
            <td><span class="pill pill-${i.type === 'warning' ? 'warn' : 'error'}">${escape(i.type)}</span></td>
            <td>${i.occurrences}</td>
            <td class="mono trunc">${escape(i.message)}</td>
            <td class="mono trunc">${escape([i.url, i.lineNumber, i.columnNumber].filter((v) => v !== undefined).join(':'))}</td>
          </tr>`).join('')
      }</tbody></table>`;
  return `<details${r.passed ? '' : ' open'}>${summaryRow(r.page, r.passed, meta)}${body}</details>`;
}

function renderSitemap(r: any): string {
  const meta = `${r.sitemapFound ? 'found' : 'missing'} · ${r.urlsInSitemap} urls · ${plural(r.brokenUrls.length, 'broken')} · ${plural(r.issues.length, 'issue')}`;
  const body = `
    <dl class="kv">
      <dt>Sitemap URL</dt><dd>${r.sitemapUrl ? `<code>${escape(r.sitemapUrl)}</code>` : '—'}</dd>
      <dt>robots.txt</dt><dd>${r.robotsTxtFound ? 'found' : 'missing'}</dd>
      <dt>URLs checked</dt><dd>${r.urlsChecked}</dd>
      <dt>Blocked critical</dt><dd>${r.robotsBlockedCritical.length ? r.robotsBlockedCritical.map((u: string) => `<code>${escape(u)}</code>`).join(' ') : '—'}</dd>
    </dl>
    ${r.brokenUrls.length ? `<table><thead><tr><th>Status</th><th>URL</th></tr></thead><tbody>${
      r.brokenUrls.map((b: any) => `<tr><td><code>${b.status}</code></td><td class="mono trunc">${escape(b.url)}</td></tr>`).join('')
    }</tbody></table>` : ''}
    ${r.issues.length ? `<ul>${r.issues.map((i: any) => `<li><span class="pill pill-${i.level === 'error' ? 'error' : i.level === 'warn' ? 'warn' : 'info'}">${escape(i.level)}</span> ${escape(i.message)}${i.url ? ` — <code>${escape(i.url)}</code>` : ''}</li>`).join('')}</ul>` : ''}`;
  return `<details${r.passed ? '' : ' open'}>${summaryRow(r.baseUrl, r.passed, meta)}${body}</details>`;
}

function renderRedirects(r: any): string {
  const meta = `${r.hopCount} hops${r.loop ? ' · loop' : ''}${r.mixedScheme ? ' · mixed scheme' : ''}${r.metaRefresh ? ' · meta-refresh' : ''}`;
  const body = `
    <dl class="kv">
      <dt>Start</dt><dd class="mono trunc">${escape(r.start)}</dd>
      <dt>Final</dt><dd class="mono trunc">${escape(r.final)}</dd>
    </dl>
    ${r.hops.length ? `<table><thead><tr><th>#</th><th>Status</th><th>Method</th><th>URL</th><th>Location</th><th>Time</th></tr></thead><tbody>${
      r.hops.map((h: any, idx: number) => `
        <tr>
          <td>${idx + 1}</td>
          <td><code>${h.status}</code></td>
          <td>${escape(h.method)}</td>
          <td class="mono trunc">${escape(h.url)}</td>
          <td class="mono trunc">${escape(h.location ?? '—')}</td>
          <td>${Math.round(h.durationMs)}ms</td>
        </tr>`).join('')
    }</tbody></table>` : ''}`;
  return `<details${r.passed ? '' : ' open'}>${summaryRow(r.start, r.passed, meta)}${body}</details>`;
}

function renderExposedPaths(r: any): string {
  const meta = `${r.scanned} scanned · ${plural(r.findings.length, 'finding')}${r.securityTxtPresent ? ' · security.txt' : ''}`;
  const body = r.findings.length === 0
    ? `<div class="empty">No exposed paths detected.</div>`
    : `<table><thead><tr><th>Severity</th><th>Path</th><th>Status</th><th>Snippet</th></tr></thead><tbody>${
        r.findings.map((f: any) => `
          <tr>
            <td><span class="pill pill-${f.severity}">${escape(f.severity)}</span></td>
            <td class="mono trunc">${escape(f.path)}</td>
            <td><code>${f.status}</code></td>
            <td class="mono trunc">${escape(f.contentSnippet ?? '')}</td>
          </tr>`).join('')
      }</tbody></table>`;
  return `<details${r.passed ? '' : ' open'}>${summaryRow(r.baseUrl, r.passed, meta)}${body}</details>`;
}

function renderTls(r: any): string {
  const meta = `${r.protocol ?? '—'}${r.cert ? ` · expires in ${r.cert.daysUntilExpiry}d` : ''} · ${plural(r.issues.length, 'issue')}`;
  const body = `
    <dl class="kv">
      <dt>Host</dt><dd>${escape(r.host)}:${r.port}</dd>
      <dt>Protocol</dt><dd>${escape(r.protocol ?? '—')}</dd>
      <dt>Cipher</dt><dd>${r.cipher ? `${escape(r.cipher.name)} (${escape(r.cipher.version)})` : '—'}</dd>
      ${r.cert ? `
        <dt>Subject</dt><dd class="mono trunc">${escape(r.cert.subject)}</dd>
        <dt>Issuer</dt><dd class="mono trunc">${escape(r.cert.issuer)}</dd>
        <dt>Valid</dt><dd>${escape(r.cert.validFrom)} → ${escape(r.cert.validTo)} (${r.cert.daysUntilExpiry}d)</dd>
        <dt>Key length</dt><dd>${r.cert.keyLength ?? '—'}${r.cert.selfSigned ? ' · self-signed' : ''}</dd>
      ` : ''}
      <dt>Chain</dt><dd>${r.chainComplete ? 'complete' : 'incomplete'}</dd>
      <dt>HSTS</dt><dd class="mono trunc">${escape(r.hstsHeader ?? '—')}${r.hstsPreloadEligible ? ' · preload-eligible' : ''}</dd>
    </dl>
    ${r.issues.length ? `<ul>${r.issues.map((i: any) => `<li><span class="pill pill-${i.level === 'error' ? 'error' : i.level === 'warn' ? 'warn' : 'info'}">${escape(i.level)}</span> ${escape(i.message)}</li>`).join('')}</ul>` : ''}`;
  return `<details${r.passed ? '' : ' open'}>${summaryRow(r.host, r.passed, meta)}${body}</details>`;
}

function renderCrawl(r: any): string {
  const errors = r.pages.filter((p: any) => p.error || (p.status >= 400 && p.status !== 0)).length;
  const passed = errors === 0;
  const meta = `${r.pagesVisited} pages · ${plural(errors, 'error')} · ${(r.durationMs / 1000).toFixed(1)}s`;
  const body = `
    <dl class="kv">
      <dt>Seed</dt><dd class="mono trunc">${escape(r.seed)}</dd>
      <dt>Pages visited</dt><dd>${r.pagesVisited}</dd>
      <dt>Duration</dt><dd>${(r.durationMs / 1000).toFixed(1)}s</dd>
    </dl>
    <table><thead><tr><th>Depth</th><th>Status</th><th>URL</th><th>Title</th><th>Load</th></tr></thead><tbody>${
      r.pages.slice(0, 100).map((p: any) => `
        <tr>
          <td>${p.depth}</td>
          <td><code class="${p.status >= 400 || p.error ? 'fail' : 'pass'}">${p.error ? 'ERR' : p.status}</code></td>
          <td class="mono trunc">${escape(p.url)}</td>
          <td class="trunc">${escape(p.title ?? '')}</td>
          <td>${Math.round(p.loadTimeMs)}ms</td>
        </tr>`).join('')
    }</tbody></table>`;
  return `<details${passed ? '' : ' open'}>${summaryRow(r.seed, passed, meta)}${body}</details>`;
}

function renderContentQuality(r: any): string {
  const meta = `${r.pages.length} pages · ${plural(r.thinContent.length, 'thin')} · ${plural(r.duplicates.length, 'duplicate')} · ${plural(r.issues.length, 'issue')}`;
  const body = `
    <table><thead><tr><th>URL</th><th>Words</th><th>H1s</th><th>Flesch</th><th>Grade</th></tr></thead><tbody>${
      r.pages.slice(0, 50).map((p: any) => `
        <tr>
          <td class="mono trunc">${escape(p.url)}</td>
          <td>${p.wordCount}</td>
          <td class="${p.h1Count === 1 ? 'pass' : 'fail'}">${p.h1Count}</td>
          <td>${p.fleschReadingEase}</td>
          <td>${p.fleschKincaidGrade}</td>
        </tr>`).join('')
    }</tbody></table>
    ${r.duplicates.length ? `<h3 style="font-size:13px;margin-top:12px">Duplicates</h3><ul>${r.duplicates.map((d: any) => `<li><code>${escape(d.kind)}</code> (${d.similarity.toFixed(2)}): ${d.urls.map((u: string) => `<span class="mono">${escape(u)}</span>`).join(', ')}</li>`).join('')}</ul>` : ''}
    ${r.issues.length ? `<ul>${r.issues.map((i: any) => `<li><span class="pill pill-${i.level === 'error' ? 'error' : 'warn'}">${escape(i.level)}</span> ${escape(i.message)}${i.url ? ` — <code>${escape(i.url)}</code>` : ''}</li>`).join('')}</ul>` : ''}`;
  return `<details${r.passed ? '' : ' open'}>${summaryRow('Content quality', r.passed, meta)}${body}</details>`;
}

function renderIssueTable(issues: any[], targetKey = 'target'): string {
  if (!issues?.length) return '<div class="empty">No issues.</div>';
  return `<table><thead><tr><th>Type</th><th>Target</th><th>Detail</th></tr></thead><tbody>${
    issues.map((i: any) => `
      <tr>
        <td><code>${escape(i.type)}</code></td>
        <td class="mono trunc">${escape(i[targetKey] ?? '')}</td>
        <td>${escape(i.detail ?? i.message ?? '')}</td>
      </tr>`).join('')
  }</tbody></table>`;
}

function renderResourceHints(r: any): string {
  const meta = `${plural(r.hints.length, 'hint')} · score ${r.score} · ${plural(r.issues.length, 'issue')}`;
  return `<details${r.passed ? '' : ' open'}>${summaryRow(r.page, r.passed, meta)}${renderIssueTable(r.issues)}</details>`;
}

function renderMixedContent(r: any): string {
  const meta = `${r.httpsPage ? 'HTTPS' : 'HTTP'} · ${plural(r.insecureResources.length, 'insecure resource')}`;
  const body = `
    <dl class="kv">
      <dt>CSP present</dt><dd>${r.cspPresent ? 'yes' : 'no'}</dd>
      <dt>upgrade-insecure-requests</dt><dd>${r.cspUpgradeInsecure ? 'yes' : 'no'}</dd>
      <dt>block-all-mixed-content</dt><dd>${r.cspBlockAllMixed ? 'yes' : 'no'}</dd>
      <dt>Referrer-Policy</dt><dd>${escape(r.referrerPolicy ?? '—')}</dd>
    </dl>
    ${r.insecureResources.length ? `<table><thead><tr><th>Type</th><th>URL</th></tr></thead><tbody>${
      r.insecureResources.map((i: any) => `<tr><td>${escape(i.type ?? i.tag ?? '')}</td><td class="mono trunc">${escape(i.url)}</td></tr>`).join('')
    }</tbody></table>` : ''}`;
  return `<details${r.passed ? '' : ' open'}>${summaryRow(r.page, r.passed, meta)}${body}</details>`;
}

function renderCompression(r: any): string {
  const meta = `${escape(r.contentEncoding ?? 'identity')} · ${escape(r.httpVersion ?? '—')} · ${plural(r.issues.length, 'issue')}`;
  const body = `
    <dl class="kv">
      <dt>HTTP version</dt><dd>${escape(r.httpVersion ?? '—')}</dd>
      <dt>Content-Encoding</dt><dd>${escape(r.contentEncoding ?? '—')}</dd>
      <dt>Content-Length</dt><dd>${bytes(r.contentLength)}</dd>
      <dt>Transfer size</dt><dd>${bytes(r.transferLength)}</dd>
      <dt>Ratio</dt><dd>${r.compressionRatio !== undefined ? r.compressionRatio.toFixed(2) : '—'}</dd>
      <dt>Brotli supported</dt><dd>${r.supportsBrotli ? 'yes' : 'no'}</dd>
      <dt>Alt-Svc has h3</dt><dd>${r.altSvcHasH3 ? 'yes' : 'no'}</dd>
    </dl>
    ${r.issues.length ? `<ul>${r.issues.map((i: string) => `<li>${escape(i)}</li>`).join('')}</ul>` : ''}`;
  return `<details${r.passed ? '' : ' open'}>${summaryRow(r.url, r.passed, meta)}${body}</details>`;
}

function renderCacheHeaders(r: any): string {
  const meta = `${r.resources.length} resources · ${plural(r.issues.length, 'issue')}`;
  return `<details${r.passed ? '' : ' open'}>${summaryRow(r.page, r.passed, meta)}${renderIssueTable(r.issues)}</details>`;
}

function renderCookieBanner(r: any): string {
  const meta = `${r.bannerDetected ? 'banner detected' : 'no banner'} · ${plural(r.issues.length, 'issue')}`;
  const body = `
    <dl class="kv">
      <dt>Accept button</dt><dd>${r.hasAcceptButton ? 'yes' : 'no'}</dd>
      <dt>Reject button</dt><dd>${r.hasRejectButton ? 'yes' : 'no'}</dd>
      <dt>Settings button</dt><dd>${r.hasSettingsButton ? 'yes' : 'no'}</dd>
      <dt>Cookies before consent</dt><dd>${r.beforeConsentCookies.length}</dd>
      <dt>Trackers before consent</dt><dd>${r.beforeConsentTrackers.length ? r.beforeConsentTrackers.map((t: string) => `<code>${escape(t)}</code>`).join(' ') : '—'}</dd>
    </dl>
    ${r.issues.length ? `<ul>${r.issues.map((i: any) => `<li><code>${escape(i.type)}</code> — ${escape(i.detail)}</li>`).join('')}</ul>` : ''}`;
  return `<details${r.passed ? '' : ' open'}>${summaryRow(r.page, r.passed, meta)}${body}</details>`;
}

function renderThirdParty(r: any): string {
  const meta = `${r.thirdPartyResources}/${r.totalResources} resources · ${bytes(r.thirdPartyBytes)} · ${Math.round(r.thirdPartyBlockingMs)}ms blocking`;
  const body = `
    <dl class="kv">
      <dt>First-party origin</dt><dd class="mono trunc">${escape(r.firstPartyOrigin)}</dd>
      <dt>Third-party bytes</dt><dd>${bytes(r.thirdPartyBytes)}</dd>
      <dt>Blocking time</dt><dd>${Math.round(r.thirdPartyBlockingMs)}ms</dd>
    </dl>
    ${r.topEntities?.length ? `<table><thead><tr><th>Entity</th><th>Requests</th><th>Bytes</th></tr></thead><tbody>${
      r.topEntities.slice(0, 20).map((e: any) => `<tr><td>${escape(e.name ?? e.entity ?? '—')}</td><td>${e.requests ?? e.count ?? '—'}</td><td>${bytes(e.bytes)}</td></tr>`).join('')
    }</tbody></table>` : ''}
    ${r.issues?.length ? renderIssueTable(r.issues) : ''}`;
  return `<details${r.passed ? '' : ' open'}>${summaryRow(r.page, r.passed, meta)}${body}</details>`;
}

function renderBundleSize(r: any): string {
  const meta = `JS ${bytes(r.totalJsBytes)} · CSS ${bytes(r.totalCssBytes)} · ${plural(r.bundles.length, 'bundle')}`;
  const body = `
    <dl class="kv">
      <dt>JS</dt><dd>${bytes(r.totalJsBytes)} (transfer ${bytes(r.totalJsTransferBytes)})</dd>
      <dt>CSS</dt><dd>${bytes(r.totalCssBytes)} (transfer ${bytes(r.totalCssTransferBytes)})</dd>
      <dt>Duplicate packages</dt><dd>${r.duplicatePackages?.length ?? 0}</dd>
    </dl>
    ${r.bundles?.length ? `<table><thead><tr><th>Type</th><th>URL</th><th>Size</th><th>Transfer</th><th>Framework</th></tr></thead><tbody>${
      r.bundles.slice(0, 30).map((b: any) => `
        <tr>
          <td><code>${escape(b.type)}</code></td>
          <td class="mono trunc">${escape(b.url)}</td>
          <td>${bytes(b.bytes)}</td>
          <td>${bytes(b.transferBytes)}</td>
          <td>${escape(b.framework ?? '—')}</td>
        </tr>`).join('')
    }</tbody></table>` : ''}
    ${r.issues?.length ? renderIssueTable(r.issues) : ''}`;
  return `<details${r.passed ? '' : ' open'}>${summaryRow(r.page, r.passed, meta)}${body}</details>`;
}

function renderOpenGraph(r: any): string {
  const og = r.openGraph ?? {};
  const tw = r.twitter ?? {};
  const meta = `og:${og.type ?? '—'} · twitter:${tw.card ?? '—'} · ${plural(r.issues.length, 'issue')}`;
  const body = `
    <dl class="kv">
      <dt>og:title</dt><dd>${escape(og.title ?? '—')}</dd>
      <dt>og:description</dt><dd>${escape(og.description ?? '—')}</dd>
      <dt>og:image</dt><dd class="mono trunc">${escape(og.image ?? '—')}</dd>
      <dt>og:url</dt><dd class="mono trunc">${escape(og.url ?? '—')}</dd>
      <dt>image reachable</dt><dd>${r.imageReachable ? 'yes' : 'no'}</dd>
      <dt>image size</dt><dd>${r.imageActualWidth ?? '—'}×${r.imageActualHeight ?? '—'}</dd>
      <dt>twitter:card</dt><dd>${escape(tw.card ?? '—')}</dd>
      <dt>twitter:site</dt><dd>${escape(tw.site ?? '—')}</dd>
    </dl>
    ${r.issues?.length ? `<ul>${r.issues.map((i: any) => `<li><code>${escape(i.type)}</code>${i.detail ? ` — ${escape(i.detail)}` : ''}</li>`).join('')}</ul>` : ''}`;
  return `<details${r.passed ? '' : ' open'}>${summaryRow(r.page, r.passed, meta)}${body}</details>`;
}

function renderRobotsAudit(r: any): string {
  const meta = `${r.present ? 'present' : 'missing'}${r.status !== undefined ? ` · ${r.status}` : ''} · ${r.disallowRules?.length ?? 0} disallow · ${plural(r.issues.length, 'issue')}`;
  const body = `
    <dl class="kv">
      <dt>URL</dt><dd class="mono trunc">${escape(r.url)}</dd>
      <dt>Size</dt><dd>${bytes(r.size)}</dd>
      <dt>User agents</dt><dd>${(r.userAgents ?? []).map((u: string) => `<code>${escape(u)}</code>`).join(' ') || '—'}</dd>
      <dt>Sitemap URLs</dt><dd>${(r.sitemapUrls ?? []).map((u: string) => `<div class="mono trunc">${escape(u)}</div>`).join('') || '—'}</dd>
      <dt>Crawl-delay</dt><dd>${r.crawlDelay ?? '—'}</dd>
      <dt>Wildcard disallow</dt><dd>${r.hasWildcardDisallow ? 'yes' : 'no'}</dd>
    </dl>
    ${r.issues?.length ? `<ul>${r.issues.map((i: any) => `<li><code>${escape(i.type)}</code> — ${escape(i.detail)}</li>`).join('')}</ul>` : ''}`;
  return `<details${r.passed ? '' : ' open'}>${summaryRow(r.url, r.passed, meta)}${body}</details>`;
}

function renderImageAudit(r: any): string {
  const meta = `${r.images?.length ?? 0} images · ${plural(r.issues.length, 'issue')}`;
  const body = `
    ${r.stats ? `<dl class="kv">${Object.entries(r.stats).map(([k, v]) => `<dt>${escape(k)}</dt><dd>${typeof v === 'number' ? (k.toLowerCase().includes('byte') ? bytes(v as number) : v) : escape(String(v))}</dd>`).join('')}</dl>` : ''}
    ${r.issues?.length ? renderIssueTable(r.issues) : '<div class="empty">No issues.</div>'}`;
  return `<details${r.passed ? '' : ' open'}>${summaryRow(r.page, r.passed, meta)}${body}</details>`;
}

function renderWebfonts(r: any): string {
  const meta = `${r.totalFontsLoaded ?? r.fonts?.length ?? 0} fonts · ${bytes(r.totalFontBytes)} · ${plural(r.issues.length, 'issue')}`;
  const body = `
    ${r.fonts?.length ? `<table><thead><tr><th>Family</th><th>Source</th><th>Format</th><th>Size</th><th>Display</th><th>Preloaded</th></tr></thead><tbody>${
      r.fonts.slice(0, 30).map((f: any) => `
        <tr>
          <td>${escape(f.family)}</td>
          <td><code>${escape(f.source)}</code></td>
          <td>${escape(f.format ?? '—')}</td>
          <td>${bytes(f.size)}</td>
          <td>${escape(f.fontDisplay ?? '—')}</td>
          <td>${f.preloaded ? 'yes' : 'no'}</td>
        </tr>`).join('')
    }</tbody></table>` : ''}
    ${r.issues?.length ? renderIssueTable(r.issues) : ''}`;
  return `<details${r.passed ? '' : ' open'}>${summaryRow(r.page, r.passed, meta)}${body}</details>`;
}

function renderMotionPrefs(r: any): string {
  const meta = `${r.animationsCount ?? 0} animations · ${r.autoplayVideos ?? 0} autoplay · ${plural(r.issues.length, 'issue')}`;
  const body = `
    <dl class="kv">
      <dt>Respects reduced motion</dt><dd>${r.respectsReducedMotion ? 'yes' : 'no'}</dd>
      <dt>Respects dark mode</dt><dd>${r.respectsDarkMode ? 'yes' : 'no'}</dd>
      <dt>Respects print</dt><dd>${r.respectsPrint ? 'yes' : 'no'}</dd>
      <dt>Respects forced colors</dt><dd>${r.respectsForcedColors ? 'yes' : 'no'}</dd>
      <dt>Animations</dt><dd>${r.animationsCount}</dd>
      <dt>Autoplay videos</dt><dd>${r.autoplayVideos}</dd>
      <dt>Infinite animations</dt><dd>${r.infiniteAnimations}</dd>
    </dl>
    ${r.issues?.length ? renderIssueTable(r.issues) : ''}`;
  return `<details${r.passed ? '' : ' open'}>${summaryRow(r.page, r.passed, meta)}${body}</details>`;
}
