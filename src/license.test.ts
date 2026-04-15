import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { verifyLicense } from './license.js';

interface KeyPair {
  privateKey: CryptoKey;
  publicPem: string;
}

function derToPem(der: ArrayBuffer, label: string): string {
  const b64 = Buffer.from(new Uint8Array(der)).toString('base64');
  const wrapped = b64.match(/.{1,64}/g)?.join('\n') ?? b64;
  return `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----\n`;
}

async function makeKeyPair(): Promise<KeyPair> {
  const kp = (await (webcrypto.subtle as any).generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const spki = await webcrypto.subtle.exportKey('spki', kp.publicKey);
  return { privateKey: kp.privateKey, publicPem: derToPem(spki, 'PUBLIC KEY') };
}

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

async function signJwt(
  privateKey: CryptoKey,
  payload: Record<string, unknown>,
): Promise<string> {
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })));
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await (webcrypto.subtle as any).sign(
    { name: 'Ed25519' },
    privateKey,
    new TextEncoder().encode(`${header}.${body}`),
  );
  return `${header}.${body}.${b64url(sig as ArrayBuffer)}`;
}

interface MockFetchSetup {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; body: string }>;
}

function mockFetchJson(response: unknown, opts: { ok?: boolean; throwErr?: Error } = {}): MockFetchSetup {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: typeof init?.body === 'string' ? init.body : '' });
    if (opts.throwErr) throw opts.throwErr;
    return {
      ok: opts.ok ?? true,
      status: opts.ok === false ? 500 : 200,
      json: async () => response,
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'uxinspect-license-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('verifyLicense returns null for empty key', async () => {
  const result = await verifyLicense('');
  assert.equal(result, null);
});

test('verifyLicense returns null for null-ish key', async () => {
  const result = await verifyLicense(undefined as unknown as string);
  assert.equal(result, null);
});

test('verifyLicense returns License on successful verification', async () => {
  await withTempDir(async (dir) => {
    const cachePath = path.join(dir, 'license.jwt');
    const keys = await makeKeyPair();
    const now = 1_700_000_000;
    const jwt = await signJwt(keys.privateKey, {
      sub: 'UX-KEY-1',
      machineId: 'machine-a',
      plan: 'pro',
      iat: now,
      exp: now + 86400 * 30,
      iss: 'https://keys.uxinspect.test',
      subscriptionExpiresAt: now + 86400 * 365,
    });
    const { fetchImpl, calls } = mockFetchJson({ valid: true, jwt, plan: 'pro' });

    const license = await verifyLicense('UX-KEY-1', {
      cachePath,
      machineId: 'machine-a',
      publicKeyPem: keys.publicPem,
      fetchImpl,
      now: () => now,
    });

    assert.ok(license);
    assert.equal(license!.plan, 'pro');
    assert.equal(license!.key, 'UX-KEY-1');
    assert.equal(license!.machineId, 'machine-a');
    assert.equal(license!.expiresAt, now + 86400 * 30);
    assert.equal(license!.offline, false);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /verify/);
    const parsedBody = JSON.parse(calls[0].body);
    assert.equal(parsedBody.key, 'UX-KEY-1');
    assert.equal(parsedBody.machineId, 'machine-a');

    const cached = JSON.parse(await readFile(cachePath, 'utf8'));
    assert.equal(cached.key, 'UX-KEY-1');
    assert.equal(cached.machineId, 'machine-a');
    assert.equal(cached.jwt, jwt);
  });
});

test('verifyLicense rejects JWT signed by a different key', async () => {
  await withTempDir(async (dir) => {
    const cachePath = path.join(dir, 'license.jwt');
    const bundled = await makeKeyPair();
    const attacker = await makeKeyPair();
    const now = 1_700_000_000;
    const jwt = await signJwt(attacker.privateKey, {
      sub: 'UX-KEY-1',
      machineId: 'machine-a',
      plan: 'pro',
      iat: now,
      exp: now + 3600,
      iss: 'evil',
    });
    const { fetchImpl } = mockFetchJson({ valid: true, jwt });

    const license = await verifyLicense('UX-KEY-1', {
      cachePath,
      machineId: 'machine-a',
      publicKeyPem: bundled.publicPem,
      fetchImpl,
      now: () => now,
    });

    assert.equal(license, null);
  });
});

test('verifyLicense rejects JWT whose sub does not match the key', async () => {
  await withTempDir(async (dir) => {
    const cachePath = path.join(dir, 'license.jwt');
    const keys = await makeKeyPair();
    const now = 1_700_000_000;
    const jwt = await signJwt(keys.privateKey, {
      sub: 'OTHER-KEY',
      machineId: 'machine-a',
      plan: 'pro',
      iat: now,
      exp: now + 3600,
      iss: 'i',
    });
    const { fetchImpl } = mockFetchJson({ valid: true, jwt });

    const license = await verifyLicense('UX-KEY-1', {
      cachePath,
      machineId: 'machine-a',
      publicKeyPem: keys.publicPem,
      fetchImpl,
      now: () => now,
    });

    assert.equal(license, null);
  });
});

test('verifyLicense rejects JWT whose machineId does not match', async () => {
  await withTempDir(async (dir) => {
    const cachePath = path.join(dir, 'license.jwt');
    const keys = await makeKeyPair();
    const now = 1_700_000_000;
    const jwt = await signJwt(keys.privateKey, {
      sub: 'UX-KEY-1',
      machineId: 'someone-elses-machine',
      plan: 'pro',
      iat: now,
      exp: now + 3600,
      iss: 'i',
    });
    const { fetchImpl } = mockFetchJson({ valid: true, jwt });

    const license = await verifyLicense('UX-KEY-1', {
      cachePath,
      machineId: 'machine-a',
      publicKeyPem: keys.publicPem,
      fetchImpl,
      now: () => now,
    });

    assert.equal(license, null);
  });
});

test('verifyLicense returns null when server says not valid', async () => {
  await withTempDir(async (dir) => {
    const cachePath = path.join(dir, 'license.jwt');
    const keys = await makeKeyPair();
    const { fetchImpl } = mockFetchJson({ valid: false, reason: 'unknown_key' });
    const license = await verifyLicense('UX-KEY-1', {
      cachePath,
      machineId: 'machine-a',
      publicKeyPem: keys.publicPem,
      fetchImpl,
      now: () => 1_700_000_000,
    });
    assert.equal(license, null);
  });
});

test('verifyLicense falls back to cache when network fails (within 14d grace)', async () => {
  await withTempDir(async (dir) => {
    const cachePath = path.join(dir, 'license.jwt');
    const keys = await makeKeyPair();
    const now = 1_700_000_000;
    // Cached JWT was issued 10 days ago, still fresh; network now fails.
    const cachedIat = now - 10 * 86400;
    const jwt = await signJwt(keys.privateKey, {
      sub: 'UX-KEY-1',
      machineId: 'machine-a',
      plan: 'pro',
      iat: cachedIat,
      exp: cachedIat + 30 * 86400,
      iss: 'https://keys.uxinspect.test',
    });
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(
      cachePath,
      JSON.stringify({
        version: 1,
        key: 'UX-KEY-1',
        machineId: 'machine-a',
        jwt,
        cachedAt: cachedIat,
        responseExpiresAt: cachedIat + 30 * 86400,
      }),
    );
    const { fetchImpl } = mockFetchJson(null, { throwErr: new Error('network down') });

    const license = await verifyLicense('UX-KEY-1', {
      cachePath,
      machineId: 'machine-a',
      publicKeyPem: keys.publicPem,
      fetchImpl,
      now: () => now,
    });

    assert.ok(license);
    assert.equal(license!.offline, true);
    assert.equal(license!.plan, 'pro');
  });
});

test('verifyLicense rejects cache older than 14d when network fails', async () => {
  await withTempDir(async (dir) => {
    const cachePath = path.join(dir, 'license.jwt');
    const keys = await makeKeyPair();
    const now = 1_700_000_000;
    const cachedIat = now - 20 * 86400; // 20 days old, exceeds grace window
    const jwt = await signJwt(keys.privateKey, {
      sub: 'UX-KEY-1',
      machineId: 'machine-a',
      plan: 'pro',
      iat: cachedIat,
      exp: cachedIat + 30 * 86400,
      iss: 'i',
    });
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(
      cachePath,
      JSON.stringify({
        version: 1,
        key: 'UX-KEY-1',
        machineId: 'machine-a',
        jwt,
        cachedAt: cachedIat,
        responseExpiresAt: cachedIat + 30 * 86400,
      }),
    );
    const { fetchImpl } = mockFetchJson(null, { throwErr: new Error('network down') });

    const license = await verifyLicense('UX-KEY-1', {
      cachePath,
      machineId: 'machine-a',
      publicKeyPem: keys.publicPem,
      fetchImpl,
      now: () => now,
    });

    assert.equal(license, null);
  });
});

test('verifyLicense rejects cache for a different machineId', async () => {
  await withTempDir(async (dir) => {
    const cachePath = path.join(dir, 'license.jwt');
    const keys = await makeKeyPair();
    const now = 1_700_000_000;
    const cachedIat = now - 86400;
    const jwt = await signJwt(keys.privateKey, {
      sub: 'UX-KEY-1',
      machineId: 'some-other-machine',
      plan: 'pro',
      iat: cachedIat,
      exp: cachedIat + 30 * 86400,
      iss: 'i',
    });
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(
      cachePath,
      JSON.stringify({
        version: 1,
        key: 'UX-KEY-1',
        machineId: 'some-other-machine',
        jwt,
        cachedAt: cachedIat,
        responseExpiresAt: cachedIat + 30 * 86400,
      }),
    );
    const { fetchImpl } = mockFetchJson(null, { throwErr: new Error('offline') });

    const license = await verifyLicense('UX-KEY-1', {
      cachePath,
      machineId: 'machine-a',
      publicKeyPem: keys.publicPem,
      fetchImpl,
      now: () => now,
    });

    assert.equal(license, null);
  });
});

test('verifyLicense offlineOnly mode uses 30d cache window', async () => {
  await withTempDir(async (dir) => {
    const cachePath = path.join(dir, 'license.jwt');
    const keys = await makeKeyPair();
    const now = 1_700_000_000;
    const cachedIat = now - 25 * 86400; // past 14d grace, within 30d cache
    const jwt = await signJwt(keys.privateKey, {
      sub: 'UX-KEY-1',
      machineId: 'machine-a',
      plan: 'pro',
      iat: cachedIat,
      exp: cachedIat + 30 * 86400,
      iss: 'i',
    });
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(
      cachePath,
      JSON.stringify({
        version: 1,
        key: 'UX-KEY-1',
        machineId: 'machine-a',
        jwt,
        cachedAt: cachedIat,
        responseExpiresAt: cachedIat + 30 * 86400,
      }),
    );

    // offlineOnly — no network call attempted
    let fetchCalled = false;
    const fetchImpl = (async () => {
      fetchCalled = true;
      throw new Error('should not be called');
    }) as unknown as typeof fetch;

    const license = await verifyLicense('UX-KEY-1', {
      cachePath,
      machineId: 'machine-a',
      publicKeyPem: keys.publicPem,
      fetchImpl,
      offlineOnly: true,
      now: () => now,
    });

    assert.equal(fetchCalled, false);
    assert.ok(license);
    assert.equal(license!.offline, true);
  });
});

test('verifyLicense handles non-200 responses gracefully', async () => {
  await withTempDir(async (dir) => {
    const cachePath = path.join(dir, 'license.jwt');
    const keys = await makeKeyPair();
    const { fetchImpl } = mockFetchJson({ error: 'server' }, { ok: false });

    const license = await verifyLicense('UX-KEY-1', {
      cachePath,
      machineId: 'machine-a',
      publicKeyPem: keys.publicPem,
      fetchImpl,
      now: () => 1_700_000_000,
    });

    assert.equal(license, null);
  });
});

test('verifyLicense rejects expired JWT even if signature is valid', async () => {
  await withTempDir(async (dir) => {
    const cachePath = path.join(dir, 'license.jwt');
    const keys = await makeKeyPair();
    const now = 1_700_000_000;
    const jwt = await signJwt(keys.privateKey, {
      sub: 'UX-KEY-1',
      machineId: 'machine-a',
      plan: 'pro',
      iat: now - 3600,
      exp: now - 60,
      iss: 'i',
    });
    const { fetchImpl } = mockFetchJson({ valid: true, jwt });

    const license = await verifyLicense('UX-KEY-1', {
      cachePath,
      machineId: 'machine-a',
      publicKeyPem: keys.publicPem,
      fetchImpl,
      now: () => now,
    });

    assert.equal(license, null);
  });
});
