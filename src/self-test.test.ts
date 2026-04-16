/**
 * P5 #44 — unit tests for the self-test assertion evaluator + HTTP fixture
 * server. The full Playwright pipeline is covered separately by the rest of
 * the suite; here we only verify that:
 *   - the bundled fixture site exists on disk where runSelfTest expects it
 *   - serveFixture serves `index.html` at `/` and returns 404 for missing paths
 *   - evaluateAssertions correctly classifies known-good + known-bad results
 *   - formatSelfTest produces human-readable output
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  evaluateAssertions,
  fixtureDir,
  formatSelfTest,
  serveFixture,
  type SelfTestResult,
} from './self-test.js';
import type { InspectResult } from './types.js';

test('bundled fixture site ships with required files', async () => {
  const dir = fixtureDir();
  await fs.access(path.join(dir, 'index.html'));
  await fs.access(path.join(dir, 'about.html'));
  const index = await fs.readFile(path.join(dir, 'index.html'), 'utf8');
  assert.match(index, /missing\.html/, 'index must link to the known-404 page');
  assert.match(index, /about\.html/, 'index must link to the about page');
});

test('serveFixture serves index.html at / and 404s missing files', async () => {
  const server = await serveFixture(fixtureDir());
  try {
    const home = await fetch(server.url + '/');
    assert.equal(home.status, 200);
    assert.match(await home.text(), /uxinspect self-test fixture/);

    const missing = await fetch(server.url + '/missing.html');
    assert.equal(missing.status, 404);

    const about = await fetch(server.url + '/about.html');
    assert.equal(about.status, 200);
    assert.match(await about.text(), /About/);
  } finally {
    await server.close();
  }
});

test('serveFixture blocks path-traversal attempts', async () => {
  const server = await serveFixture(fixtureDir());
  try {
    const bad = await fetch(server.url + '/../../etc/passwd');
    // Either 404 (traversal stripped to a non-existent path) or 200 of a fixture
    // file — both are acceptable; what we forbid is leaking outside the dir.
    assert.ok([200, 404].includes(bad.status));
    const body = await bad.text();
    assert.doesNotMatch(body, /root:x:/, 'must not return /etc/passwd');
  } finally {
    await server.close();
  }
});

function baseResult(): InspectResult {
  return {
    url: 'http://127.0.0.1:12345',
    startedAt: '2026-04-17T00:00:00.000Z',
    finishedAt: '2026-04-17T00:00:01.000Z',
    durationMs: 1000,
    flows: [{ name: 'home', passed: true, steps: [], screenshots: [] }],
    passed: true,
  };
}

test('evaluateAssertions passes when home flow clean and broken link detected', () => {
  const r: InspectResult = {
    ...baseResult(),
    links: [
      {
        page: 'http://127.0.0.1:12345/',
        total: 2,
        broken: [{ url: 'http://127.0.0.1:12345/missing.html', status: 404 }],
        issues: ['404 http://127.0.0.1:12345/missing.html'],
        passed: false,
      },
    ],
  };
  const results = evaluateAssertions(r);
  assert.equal(results.length, 3);
  assert.ok(results.every((a) => a.passed), JSON.stringify(results, null, 2));
});

test('evaluateAssertions fails when home flow is broken', () => {
  const r: InspectResult = {
    ...baseResult(),
    flows: [{ name: 'home', passed: false, steps: [], screenshots: [], error: 'boom' }],
    links: [
      {
        page: 'http://127.0.0.1:12345/',
        total: 1,
        broken: [{ url: 'http://127.0.0.1:12345/missing.html', status: 404 }],
        issues: [],
        passed: false,
      },
    ],
  };
  const results = evaluateAssertions(r);
  const home = results.find((a) => a.name === 'home flow passed');
  assert.ok(home && !home.passed);
  assert.equal(home.detail, 'boom');
});

test('evaluateAssertions fails when broken link was not detected', () => {
  const r: InspectResult = {
    ...baseResult(),
    links: [
      {
        page: 'http://127.0.0.1:12345/',
        total: 2,
        broken: [],
        issues: [],
        passed: true,
      },
    ],
  };
  const results = evaluateAssertions(r);
  const broken = results.find((a) => a.name === 'broken link /missing.html detected');
  assert.ok(broken && !broken.passed);
});

test('evaluateAssertions fails when url is not loopback', () => {
  const r: InspectResult = { ...baseResult(), url: 'https://example.com' };
  const url = evaluateAssertions(r).find((a) => a.name === 'fixture URL recorded');
  assert.ok(url && !url.passed);
});

test('formatSelfTest renders PASS/FAIL summary + assertion list', () => {
  const r: SelfTestResult = {
    passed: false,
    durationMs: 1234,
    fixtureUrl: 'http://127.0.0.1:9999',
    inspectPassed: true,
    assertions: [
      { name: 'one', passed: true },
      { name: 'two', passed: false, detail: 'nope' },
    ],
  };
  const out = formatSelfTest(r);
  assert.match(out, /self-test: FAIL/);
  assert.match(out, /1234ms/);
  assert.match(out, /127\.0\.0\.1:9999/);
  assert.match(out, /\[pass\] one/);
  assert.match(out, /\[FAIL\] two — nope/);
});
