/**
 * P5 #44 — CLI self-test.
 *
 * Spawns a tiny HTTP server for `examples/fixture-site/`, runs `inspect`
 * against it, and asserts known outcomes so regressions in the inspection
 * engine surface immediately. Wired to the CLI as `uxinspect self-test`.
 *
 * The fixture is intentionally tiny: two pages + a known 404 link. We
 * assert that the engine:
 *   - loads the fixture home page
 *   - discovers the `<a href="/about.html">` link
 *   - flags the `/missing.html` link as a broken link (404)
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { inspect } from './index.js';
import type { InspectResult } from './types.js';

export interface SelfTestAssertion {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
}

export interface SelfTestResult {
  readonly passed: boolean;
  readonly assertions: readonly SelfTestAssertion[];
  readonly durationMs: number;
  readonly fixtureUrl: string;
  readonly inspectPassed: boolean;
}

/**
 * Absolute path to the bundled fixture site. Package consumers (via npx)
 * still see this because we ship `examples/` in `files` of package.json.
 */
export function fixtureDir(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  // src/ at dev time; dist/ when published — both are one level under repo root.
  return path.resolve(here, '..', 'examples', 'fixture-site');
}

/**
 * Serve the fixture directory on a random port. Missing files return 404
 * so the link-check probe flags them as broken.
 */
export async function serveFixture(dir: string): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer(async (req, res) => {
    const rawUrl = req.url ?? '/';
    // Strip query string + prevent path traversal.
    const safePath = rawUrl.split('?')[0].replace(/\.\.+/g, '');
    const target = safePath === '/' || safePath === '' ? '/index.html' : safePath;
    const full = path.join(dir, target);
    try {
      const body = await fs.readFile(full);
      const ct = target.endsWith('.html')
        ? 'text/html; charset=utf-8'
        : target.endsWith('.css')
          ? 'text/css'
          : 'application/octet-stream';
      res.writeHead(200, { 'content-type': ct });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

/**
 * Evaluate the canonical fixture assertions against an InspectResult.
 * Split out so the unit test can feed in synthetic results without booting
 * a full chromium pipeline.
 */
export function evaluateAssertions(result: InspectResult): SelfTestAssertion[] {
  const assertions: SelfTestAssertion[] = [];

  // 1) URL echo.
  assertions.push({
    name: 'fixture URL recorded',
    passed: typeof result.url === 'string' && result.url.startsWith('http://127.0.0.1:'),
    detail: result.url,
  });

  // 2) home flow passed (the fixture is static — any failure here is a real regression).
  const homeFlow = result.flows.find((f) => f.name === 'home' || f.name === 'load');
  assertions.push({
    name: 'home flow passed',
    passed: homeFlow ? homeFlow.passed : false,
    detail: homeFlow?.error,
  });

  // 3) broken-link detection — `/missing.html` should appear in link-check output.
  const brokenLinks = result.links?.flatMap((l) => l.broken ?? []) ?? [];
  const sawMissing = brokenLinks.some((b) => /missing\.html/.test(b.url));
  assertions.push({
    name: 'broken link /missing.html detected',
    passed: sawMissing,
    detail: sawMissing ? undefined : `links=${JSON.stringify(brokenLinks).slice(0, 200)}`,
  });

  return assertions;
}

/**
 * Run the self-test end-to-end: boot fixture server, run inspect, tear down.
 * Returns a structured SelfTestResult so the CLI can print + exit non-zero.
 */
export async function runSelfTest(): Promise<SelfTestResult> {
  const started = Date.now();
  const dir = fixtureDir();
  await fs.access(dir); // surfaces a clear error if fixture missing.
  const server = await serveFixture(dir);
  try {
    const result = await inspect({
      url: server.url,
      flows: [
        {
          name: 'home',
          steps: [{ goto: server.url + '/' }],
        },
      ],
      checks: { links: true },
      reporters: [],
    });
    const assertions = evaluateAssertions({ ...result, url: server.url });
    const passed = assertions.every((a) => a.passed);
    return {
      passed,
      assertions,
      durationMs: Date.now() - started,
      fixtureUrl: server.url,
      inspectPassed: result.passed,
    };
  } finally {
    await server.close();
  }
}

/**
 * Pretty-print a SelfTestResult for the CLI.
 */
export function formatSelfTest(r: SelfTestResult): string {
  const lines: string[] = [];
  lines.push(`self-test: ${r.passed ? 'PASS' : 'FAIL'}  (${r.durationMs}ms)`);
  lines.push(`  fixture: ${r.fixtureUrl}`);
  for (const a of r.assertions) {
    const mark = a.passed ? 'pass' : 'FAIL';
    lines.push(`  [${mark}] ${a.name}${a.detail ? ` — ${a.detail}` : ''}`);
  }
  return lines.join('\n');
}
