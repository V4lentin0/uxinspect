import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runHumanPassBackend,
  type HumanPassBackendConfig,
} from './human-pass-backend.js';

// ─── Fake fetch helpers ─────────────────────────────────────────────────────

type FakeFetchImpl = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function makeResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Response {
  const h = new Headers({ 'content-type': 'text/plain', ...headers });
  return new Response(body, { status, statusText: statusTextFor(status), headers: h });
}

function statusTextFor(status: number): string {
  if (status === 200) return 'OK';
  if (status === 201) return 'Created';
  if (status === 204) return 'No Content';
  if (status === 400) return 'Bad Request';
  if (status === 404) return 'Not Found';
  if (status === 500) return 'Internal Server Error';
  return '';
}

async function withFakeFetch<T>(
  impl: FakeFetchImpl,
  fn: () => Promise<T>,
): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = impl as unknown as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

async function makeDumpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'uxi-hpbe-'));
}

async function cleanup(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('runHumanPassBackend', () => {
  test('returns empty result when no endpoints and autoDiscover=false', async () => {
    const dumpDir = await makeDumpDir();
    try {
      const noFetch: FakeFetchImpl = async () => {
        throw new Error('fetch should not be called');
      };
      const config: HumanPassBackendConfig = {
        baseUrl: 'https://example.test',
        autoDiscover: false,
        dumpDir,
      };
      const result = await withFakeFetch(noFetch, () =>
        runHumanPassBackend(undefined, config),
      );
      assert.equal(result.totalRequests, 0);
      assert.equal(result.dumps.length, 0);
      assert.equal(result.endpointsExercised, 0);
      assert.deepEqual(result.findings, []);
    } finally {
      await cleanup(dumpDir);
    }
  });

  test('exercises all 8 variants per explicit POST endpoint (+ baseline-retry for idempotency probe)', async () => {
    const dumpDir = await makeDumpDir();
    try {
      let calls = 0;
      const echoFetch: FakeFetchImpl = async (url, init) => {
        calls += 1;
        return makeResponse(200, `echo:${String(init?.method ?? 'GET')}:${String(url)}`);
      };
      const config: HumanPassBackendConfig = {
        baseUrl: 'https://example.test',
        autoDiscover: false,
        dumpDir,
        endpoints: [{ method: 'POST', path: '/api/widgets' }],
      };
      const result = await withFakeFetch(echoFetch, () =>
        runHumanPassBackend(undefined, config),
      );
      // POST with payloadVariants=true → 8 variants
      // (baseline, empty-body, invalid-shape, malformed-json, unicode,
      //  oversize, auth-strip, cors-probe)
      // PLUS baseline-retry (idempotency probe on first mutating endpoint) → 9.
      assert.equal(result.totalRequests, 9);
      assert.equal(calls, 9);
      assert.equal(result.endpointsExercised, 1);
      // 2 dump files (request + response) per request
      assert.equal(result.dumps.length, 18);
    } finally {
      await cleanup(dumpDir);
    }
  });

  test('records server-error-5xx finding when fetch returns 500', async () => {
    const dumpDir = await makeDumpDir();
    try {
      const errFetch: FakeFetchImpl = async () => makeResponse(500, 'kaboom');
      const config: HumanPassBackendConfig = {
        baseUrl: 'https://example.test',
        autoDiscover: false,
        dumpDir,
        endpoints: [{ method: 'GET', path: '/api/oops' }],
      };
      const result = await withFakeFetch(errFetch, () =>
        runHumanPassBackend(undefined, config),
      );
      const fivexx = result.findings.filter((f) => f.kind === 'server-error-5xx');
      assert.ok(fivexx.length > 0, 'expected at least one server-error-5xx finding');
      assert.equal(fivexx[0]?.kind, 'server-error-5xx');
    } finally {
      await cleanup(dumpDir);
    }
  });

  test('records unexpected-2xx-on-bad-input when malformed-json returns 200', async () => {
    const dumpDir = await makeDumpDir();
    try {
      const okFetch: FakeFetchImpl = async () => makeResponse(200, 'ok');
      const config: HumanPassBackendConfig = {
        baseUrl: 'https://example.test',
        autoDiscover: false,
        dumpDir,
        endpoints: [{ method: 'POST', path: '/api/create' }],
      };
      const result = await withFakeFetch(okFetch, () =>
        runHumanPassBackend(undefined, config),
      );
      const badInputFindings = result.findings.filter(
        (f) => f.kind === 'unexpected-2xx-on-bad-input',
      );
      assert.ok(
        badInputFindings.length >= 1,
        'expected unexpected-2xx-on-bad-input findings',
      );
      // Should cover malformed-json among the detail messages
      const hasMalformed = badInputFindings.some((f) =>
        f.detail.toLowerCase().includes('malformed'),
      );
      assert.ok(hasMalformed, 'expected malformed-json finding');
    } finally {
      await cleanup(dumpDir);
    }
  });

  test('records slow-response when elapsedMs > 1000', async () => {
    const dumpDir = await makeDumpDir();
    try {
      let called = 0;
      const slowFetch: FakeFetchImpl = async () => {
        called += 1;
        // Only slow the first (baseline) request; subsequent ones return fast
        // so the test stays snappy.
        if (called === 1) {
          await new Promise((r) => setTimeout(r, 1100));
        }
        return makeResponse(200, 'ok');
      };
      const config: HumanPassBackendConfig = {
        baseUrl: 'https://example.test',
        autoDiscover: false,
        dumpDir,
        // Use GET so the variant list is shorter (baseline, oversize,
        // auth-strip, cors-probe) — still gets the first-call slow hit.
        endpoints: [{ method: 'GET', path: '/api/slow' }],
        timeoutMs: 5_000,
      };
      const result = await withFakeFetch(slowFetch, () =>
        runHumanPassBackend(undefined, config),
      );
      const slow = result.findings.filter((f) => f.kind === 'slow-response');
      assert.ok(slow.length > 0, 'expected at least one slow-response finding');
    } finally {
      await cleanup(dumpDir);
    }
  });

  test('writes request + response dump files to dump dir', async () => {
    const dumpDir = await makeDumpDir();
    try {
      const okFetch: FakeFetchImpl = async () => makeResponse(200, 'ok');
      const config: HumanPassBackendConfig = {
        baseUrl: 'https://example.test',
        autoDiscover: false,
        dumpDir,
        endpoints: [{ method: 'GET', path: '/api/thing' }],
      };
      const result = await withFakeFetch(okFetch, () =>
        runHumanPassBackend(undefined, config),
      );
      const files = await readdir(dumpDir);
      // At least 2 files per variant (request + response). Variant count for GET
      // = 4 (baseline, oversize, auth-strip, cors-probe) → >= 8 files total.
      assert.ok(files.length >= 2, `expected >= 2 dump files, got ${files.length}`);
      assert.ok(
        files.some((f) => f.includes('request.txt')),
        'expected request dump files',
      );
      assert.ok(
        files.some((f) => f.includes('response.txt')),
        'expected response dump files',
      );
      // Result dumps must reference files that exist on disk
      assert.equal(result.dumps.length, files.length);
    } finally {
      await cleanup(dumpDir);
    }
  });

  test('caps endpoints at maxEndpoints', async () => {
    const dumpDir = await makeDumpDir();
    try {
      const okFetch: FakeFetchImpl = async () => makeResponse(200, 'ok');
      const endpoints = Array.from({ length: 100 }, (_, i) => ({
        method: 'GET' as const,
        path: `/api/item-${i}`,
      }));
      const config: HumanPassBackendConfig = {
        baseUrl: 'https://example.test',
        autoDiscover: false,
        dumpDir,
        endpoints,
        maxEndpoints: 5,
      };
      const result = await withFakeFetch(okFetch, () =>
        runHumanPassBackend(undefined, config),
      );
      assert.ok(
        result.endpointsExercised <= 5,
        `expected <= 5 endpoints, got ${result.endpointsExercised}`,
      );
      assert.equal(result.endpointsExercised, 5);
    } finally {
      await cleanup(dumpDir);
    }
  });

  test('never throws on fetch failure and records other finding with fetch failed detail', async () => {
    const dumpDir = await makeDumpDir();
    try {
      const throwingFetch: FakeFetchImpl = async () => {
        throw new Error('fetch failed: network down');
      };
      const config: HumanPassBackendConfig = {
        baseUrl: 'https://example.test',
        autoDiscover: false,
        dumpDir,
        endpoints: [{ method: 'GET', path: '/api/down' }],
      };
      let result: Awaited<ReturnType<typeof runHumanPassBackend>> | undefined;
      await withFakeFetch(throwingFetch, async () => {
        result = await runHumanPassBackend(undefined, config);
      });
      assert.ok(result, 'result should be returned even when fetch throws');
      const others = result!.findings.filter((f) => f.kind === 'other');
      assert.ok(others.length > 0, 'expected at least one "other" finding');
      const hasFetchFailed = others.some((f) =>
        f.detail.toLowerCase().includes('fetch failed'),
      );
      assert.ok(hasFetchFailed, 'expected a finding whose detail mentions "fetch failed"');
    } finally {
      await cleanup(dumpDir);
    }
  });
});
