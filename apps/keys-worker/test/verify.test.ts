import { describe, expect, it, beforeAll } from 'vitest';
import worker from '../src/index.js';
import { verifyJwt, importPublicKeyPem } from '../src/crypto.js';
import { FakeKV, generateTestKeyPair, hmacHex, type TestKeyPair } from './helpers.js';

let keys: TestKeyPair;

function buildEnv(kv: FakeKV, overrides: Partial<Record<string, string>> = {}) {
  return {
    LICENSES: kv as unknown as KVNamespace,
    PRIVATE_KEY: overrides.PRIVATE_KEY ?? keys.privatePem,
    PUBLIC_KEY: overrides.PUBLIC_KEY ?? keys.publicPem,
    POLAR_SECRET: overrides.POLAR_SECRET ?? 'test-polar-secret',
    JWT_ISSUER: overrides.JWT_ISSUER ?? 'https://keys.uxinspect.test',
    JWT_TTL_SECONDS: overrides.JWT_TTL_SECONDS ?? '2592000',
  } as any;
}

function req(path: string, init?: RequestInit): Request {
  return new Request(`https://keys.uxinspect.test${path}`, init);
}

beforeAll(async () => {
  keys = await generateTestKeyPair();
});

describe('POST /verify', () => {
  it('rejects malformed JSON', async () => {
    const kv = new FakeKV();
    const res = await worker.fetch(
      req('/verify', { method: 'POST', body: 'not-json', headers: { 'content-type': 'application/json' } }),
      buildEnv(kv),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.valid).toBe(false);
    expect(body.reason).toBe('invalid_json');
  });

  it('rejects missing key/machineId', async () => {
    const kv = new FakeKV();
    const res = await worker.fetch(
      req('/verify', { method: 'POST', body: JSON.stringify({}) }),
      buildEnv(kv),
    );
    const body = (await res.json()) as any;
    expect(body.valid).toBe(false);
    expect(body.reason).toBe('missing_key');
  });

  it('returns unknown_key for licenses not in KV', async () => {
    const kv = new FakeKV();
    const res = await worker.fetch(
      req('/verify', {
        method: 'POST',
        body: JSON.stringify({ key: 'UX-ABC', machineId: 'm1' }),
      }),
      buildEnv(kv),
    );
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.valid).toBe(false);
    expect(body.reason).toBe('unknown_key');
  });

  it('returns expired for a license past its expiry', async () => {
    const kv = new FakeKV();
    await kv.put('UX-EXP', JSON.stringify({
      plan: 'pro',
      customer: 'cust_1',
      expiresAt: Math.floor(Date.now() / 1000) - 60,
      status: 'active',
      polarSubId: 'sub_1',
      createdAt: 0,
      updatedAt: 0,
    }));
    const res = await worker.fetch(
      req('/verify', {
        method: 'POST',
        body: JSON.stringify({ key: 'UX-EXP', machineId: 'm1' }),
      }),
      buildEnv(kv),
    );
    const body = (await res.json()) as any;
    expect(body.valid).toBe(false);
    expect(body.reason).toBe('expired');
  });

  it('returns status reason for cancelled licenses', async () => {
    const kv = new FakeKV();
    await kv.put('UX-CAN', JSON.stringify({
      plan: 'pro',
      customer: 'cust_2',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      status: 'cancelled',
      polarSubId: 'sub_2',
      createdAt: 0,
      updatedAt: 0,
    }));
    const res = await worker.fetch(
      req('/verify', {
        method: 'POST',
        body: JSON.stringify({ key: 'UX-CAN', machineId: 'm1' }),
      }),
      buildEnv(kv),
    );
    const body = (await res.json()) as any;
    expect(body.valid).toBe(false);
    expect(body.reason).toBe('status_cancelled');
  });

  it('signs a JWT that the bundled public key can verify', async () => {
    const kv = new FakeKV();
    const expiresAt = Math.floor(Date.now() / 1000) + 86400 * 30;
    await kv.put('UX-OK', JSON.stringify({
      plan: 'pro',
      customer: 'cust_3',
      expiresAt,
      status: 'active',
      polarSubId: 'sub_3',
      createdAt: 0,
      updatedAt: 0,
    }));
    const res = await worker.fetch(
      req('/verify', {
        method: 'POST',
        body: JSON.stringify({ key: 'UX-OK', machineId: 'mach-xyz' }),
      }),
      buildEnv(kv),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.valid).toBe(true);
    expect(body.plan).toBe('pro');
    expect(body.machineId).toBe('mach-xyz');
    expect(typeof body.jwt).toBe('string');
    expect(body.jwt.split('.').length).toBe(3);

    const pub = await importPublicKeyPem(keys.publicPem);
    const payload = await verifyJwt(body.jwt, pub);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe('UX-OK');
    expect(payload!.machineId).toBe('mach-xyz');
    expect(payload!.plan).toBe('pro');
    expect(payload!.iss).toBe('https://keys.uxinspect.test');
  });

  it('rejects tampered JWTs', async () => {
    const kv = new FakeKV();
    await kv.put('UX-T', JSON.stringify({
      plan: 'pro',
      customer: 'c',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      status: 'active',
      polarSubId: 's',
      createdAt: 0,
      updatedAt: 0,
    }));
    const res = await worker.fetch(
      req('/verify', {
        method: 'POST',
        body: JSON.stringify({ key: 'UX-T', machineId: 'm' }),
      }),
      buildEnv(kv),
    );
    const body = (await res.json()) as any;
    const parts = (body.jwt as string).split('.');
    parts[2] = parts[2].slice(0, -2) + 'AA';
    const pub = await importPublicKeyPem(keys.publicPem);
    const payload = await verifyJwt(parts.join('.'), pub);
    expect(payload).toBeNull();
  });
});

describe('GET /pubkey', () => {
  it('returns the configured PEM', async () => {
    const kv = new FakeKV();
    const res = await worker.fetch(req('/pubkey'), buildEnv(kv));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('BEGIN PUBLIC KEY');
    expect(res.headers.get('content-type')).toContain('pem');
  });
});

describe('POST /polar/webhook', () => {
  it('rejects bad signatures', async () => {
    const kv = new FakeKV();
    const body = JSON.stringify({ type: 'subscription.created', data: {} });
    const res = await worker.fetch(
      req('/polar/webhook', {
        method: 'POST',
        body,
        headers: { 'polar-signature': 'sha256=deadbeef' },
      }),
      buildEnv(kv),
    );
    expect(res.status).toBe(401);
  });

  it('upserts KV on subscription.created', async () => {
    const kv = new FakeKV();
    const env = buildEnv(kv);
    const payload = {
      type: 'subscription.created',
      data: {
        id: 'sub_polar_1',
        status: 'active',
        current_period_end: new Date(Date.now() + 30 * 86400_000).toISOString(),
        customer: { id: 'cust_polar_1', email: 'user@example.com' },
        product: { id: 'prod_pro', name: 'uxinspect Pro' },
        metadata: { license_key: 'UX-FROM-POLAR' },
      },
    };
    const bodyStr = JSON.stringify(payload);
    const sig = await hmacHex(bodyStr, env.POLAR_SECRET);
    const res = await worker.fetch(
      req('/polar/webhook', {
        method: 'POST',
        body: bodyStr,
        headers: { 'polar-signature': `sha256=${sig}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const stored = await kv.get('UX-FROM-POLAR');
    expect(stored).not.toBeNull();
    const record = JSON.parse(stored!);
    expect(record.plan).toBe('pro');
    expect(record.status).toBe('active');
    expect(record.polarSubId).toBe('sub_polar_1');
  });

  it('marks status=cancelled on subscription.cancelled', async () => {
    const kv = new FakeKV();
    const env = buildEnv(kv);
    await kv.put('UX-CANCEL', JSON.stringify({
      plan: 'pro',
      customer: 'c',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      status: 'active',
      polarSubId: 'sub_cancel',
      createdAt: 0,
      updatedAt: 0,
    }));
    const payload = {
      type: 'subscription.cancelled',
      data: {
        id: 'sub_cancel',
        status: 'cancelled',
        ended_at: new Date().toISOString(),
        metadata: { license_key: 'UX-CANCEL' },
      },
    };
    const bodyStr = JSON.stringify(payload);
    const sig = await hmacHex(bodyStr, env.POLAR_SECRET);
    const res = await worker.fetch(
      req('/polar/webhook', {
        method: 'POST',
        body: bodyStr,
        headers: { 'polar-signature': sig },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const record = JSON.parse((await kv.get('UX-CANCEL'))!);
    expect(record.status).toBe('cancelled');
  });

  it('ignores events without a license key', async () => {
    const kv = new FakeKV();
    const env = buildEnv(kv);
    const payload = { type: 'subscription.created', data: { id: 's', status: 'active' } };
    const bodyStr = JSON.stringify(payload);
    const sig = await hmacHex(bodyStr, env.POLAR_SECRET);
    const res = await worker.fetch(
      req('/polar/webhook', {
        method: 'POST',
        body: bodyStr,
        headers: { 'polar-signature': sig },
      }),
      env,
    );
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.applied).toBe(false);
    expect(kv.size()).toBe(0);
  });
});

describe('router fallbacks', () => {
  it('404s unknown paths', async () => {
    const kv = new FakeKV();
    const res = await worker.fetch(req('/does-not-exist'), buildEnv(kv));
    expect(res.status).toBe(404);
  });

  it('handles OPTIONS preflight', async () => {
    const kv = new FakeKV();
    const res = await worker.fetch(
      req('/verify', { method: 'OPTIONS' }),
      buildEnv(kv),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
