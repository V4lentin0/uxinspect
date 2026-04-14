// Smoke test: runs every supported check against a URL and prints a summary.
// Usage: npx tsx examples/smoke-all.ts [url] [--heavy]
//   --heavy  also runs perf, visual, explore, and crawl (requires baselines / long runs).
import { inspect } from '../src/index.js';
import type { InspectConfig, InspectResult } from '../src/index.js';

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--')) ?? 'https://example.com';
const heavy = args.includes('--heavy');

const checks: InspectConfig['checks'] = {
  a11y: true,
  perf: heavy,
  visual: heavy,
  explore: heavy,
  seo: true,
  links: true,
  pwa: true,
  security: true,
  retire: true,
  deadClicks: true,
  touchTargets: true,
  keyboard: true,
  longTasks: true,
  clsTimeline: true,
  forms: true,
  structuredData: true,
  passiveSecurity: true,
  consoleErrors: true,
  sitemap: true,
  redirects: true,
  exposedPaths: true,
  tls: true,
  crawl: heavy,
  contentQuality: true,
};

// Extra checks wired via CLI (not in ChecksConfig type yet). Included for completeness.
const extraChecks = {
  resourceHints: true,
  mixedContent: true,
  compression: true,
  cacheHeaders: true,
  cookieBanner: true,
  thirdParty: true,
  bundleSize: true,
  openGraph: true,
  robotsAudit: true,
  imageAudit: true,
  webfonts: true,
  motionPrefs: true,
};

const config: InspectConfig = {
  url,
  viewports: [{ name: 'desktop', width: 1280, height: 800 }],
  checks: { ...checks, ...(extraChecks as any) },
  output: { dir: './uxinspect-smoke-report', baselineDir: './uxinspect-smoke-baselines' },
};

console.log(`[smoke] target: ${url}`);
console.log(`[smoke] heavy:  ${heavy}`);
console.log(`[smoke] starting...\n`);

const started = Date.now();
const result: InspectResult = await inspect(config);
const elapsedMs = Date.now() - started;

type Line = { name: string; passed: boolean; count: number; note: string };

const allPassed = <T extends { passed?: boolean } | undefined>(arr: T[] | undefined): boolean =>
  !arr || arr.length === 0 || arr.every((r) => !r || (r as any).passed !== false);

const countIssues = (arr: unknown): number => {
  if (!arr) return 0;
  if (Array.isArray(arr)) return arr.reduce((sum, r: any) => sum + (r?.issues?.length ?? r?.violations?.length ?? r?.errors?.length ?? 0), 0);
  const anyArr: any = arr;
  return anyArr?.issues?.length ?? anyArr?.violations?.length ?? anyArr?.errors?.length ?? 0;
};

const line = (name: string, enabled: boolean, data: any, noteFn?: (d: any) => string): Line => {
  if (!enabled) return { name, passed: true, count: 0, note: 'skipped' };
  if (data === undefined) return { name, passed: false, count: 0, note: 'no result (error or disabled)' };
  const passed = Array.isArray(data) ? allPassed(data) : (data as any).passed !== false;
  const count = countIssues(data);
  const note = noteFn ? noteFn(data) : `${count} issue(s)`;
  return { name, passed, count, note };
};

const a11yCount = result.a11y?.flatMap((a) => a.violations).filter((v) => v.impact === 'critical' || v.impact === 'serious').length ?? 0;

const lines: Line[] = [
  { name: 'flows', passed: result.flows.every((f) => f.passed), count: result.flows.filter((f) => !f.passed).length, note: `${result.flows.length} flow(s)` },
  { name: 'a11y', passed: a11yCount === 0, count: a11yCount, note: `${a11yCount} serious/critical violation(s)` },
  line('perf', !!checks.perf, result.perf, (d) => `${d?.length ?? 0} report(s)`),
  line('visual', !!checks.visual, result.visual, (d) => `${d?.filter((x: any) => !x.passed).length ?? 0} diff(s)`),
  line('explore', !!checks.explore, result.explore, (d) => `${d?.pagesVisited ?? 0} page(s), ${d?.errors?.length ?? 0} error(s)`),
  line('seo', !!checks.seo, result.seo),
  line('links', !!checks.links, result.links),
  line('pwa', !!checks.pwa, result.pwa),
  line('security', !!checks.security, result.security),
  line('retire', !!checks.retire, result.retire),
  line('deadClicks', !!checks.deadClicks, result.deadClicks),
  line('touchTargets', !!checks.touchTargets, result.touchTargets),
  line('keyboard', !!checks.keyboard, result.keyboard),
  line('longTasks', !!checks.longTasks, result.longTasks),
  line('clsTimeline', !!checks.clsTimeline, result.clsTimeline),
  line('forms', !!checks.forms, result.forms),
  line('structuredData', !!checks.structuredData, result.structuredData),
  line('passiveSecurity', !!checks.passiveSecurity, result.passiveSecurity),
  line('consoleErrors', !!checks.consoleErrors, result.consoleErrors),
  line('sitemap', !!checks.sitemap, result.sitemap),
  line('redirects', !!checks.redirects, result.redirects),
  line('exposedPaths', !!checks.exposedPaths, result.exposedPaths),
  line('tls', !!checks.tls, result.tls),
  line('crawl', !!checks.crawl, result.crawl),
  line('contentQuality', !!checks.contentQuality, result.contentQuality),
];

console.log('\n====================== smoke summary ======================');
console.log(`url       : ${result.url}`);
console.log(`duration  : ${(elapsedMs / 1000).toFixed(1)}s`);
console.log(`started   : ${result.startedAt}`);
console.log(`finished  : ${result.finishedAt}`);
console.log('-----------------------------------------------------------');
for (const l of lines) {
  const tag = l.note === 'skipped' ? '[SKIP]' : l.passed ? '[PASS]' : '[FAIL]';
  console.log(`${tag} ${l.name.padEnd(18)} ${l.note}`);
}
console.log('-----------------------------------------------------------');

const failed = lines.filter((l) => l.note !== 'skipped' && !l.passed);
const overall = result.passed && failed.length === 0;
console.log(`overall   : ${overall ? 'PASS' : 'FAIL'}  (${failed.length} failing check(s))`);
console.log('===========================================================\n');

// Exit 0 when the smoke completes without crashes — individual check findings are expected.
process.exit(0);
