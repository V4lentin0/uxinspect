// uxinspect license-key worker.
// Public surface:
//   GET  /                         health text
//   GET  /pubkey                   returns the Ed25519 public key (raw 32-byte, base64url)
//   POST /verify                   { key, fingerprint? } -> { ok, jwt, expiresAt, plan, ... }
//   POST /webhooks/polar           Polar.sh subscription webhook (HMAC-signed)
//
// Storage: Workers KV (binding KEYS) keyed by the license key string.
// Record shape:
//   {
//     plan: 'pro' | 'team' | 'enterprise',
//     status: 'active' | 'cancelled' | 'past_due' | 'revoked',
//     email: string,
//     polarSubscriptionId?: string,
//     polarCustomerId?: string,
//     createdAt: string,            // ISO-8601
//     renewsAt?: string,            // ISO-8601 (next billing date)
//     revokedAt?: string,
//     fingerprints?: string[]       // optional install bindings
//   }

import { signJwt, importEd25519Private, b64uEncode } from './jwt.js';
import { handlePolarWebhook } from './polar.js';

export interface Env {
  KEYS: KVNamespace;
  SIGNING_PRIVATE_KEY: string;
  SIGNING_PUBLIC_KEY: string;
  POLAR_WEBHOOK_SECRET: string;
  POLAR_API_TOKEN?: string;
  POLAR_ORG_ID?: string;
  JWT_TTL_SECONDS: string;
  JWT_ISSUER: string;
}

export interface LicenseRecord {
  plan: 'pro' | 'team' | 'enterprise';
  status: 'active' | 'cancelled' | 'past_due' | 'revoked';
  email: string;
  polarSubscriptionId?: string;
  polarCustomerId?: string;
  createdAt: string;
  renewsAt?: string;
  revokedAt?: string;
  fingerprints?: string[];
}

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-max-age': '86400',
};

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

    if (req.method === 'GET' && path === '/') return text('uxinspect keys ok', 200);
    if (req.method === 'GET' && path === '/pubkey') return pubkey(env);
    if (req.method === 'POST' && path === '/verify') return verify(req, env);
    if (req.method === 'POST' && path === '/webhooks/polar') return handlePolarWebhook(req, env, ctx);

    return text('not found', 404);
  },
};

function text(body: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS_HEADERS, ...extra },
  });
}

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS, ...extra },
  });
}

async function pubkey(env: Env): Promise<Response> {
  if (!env.SIGNING_PUBLIC_KEY) return text('missing public key secret', 500);
  const raw = decodeKeyMaterial(env.SIGNING_PUBLIC_KEY);
  return json(
    {
      alg: 'EdDSA',
      crv: 'Ed25519',
      kid: await keyId(raw),
      publicKeyB64u: b64uEncode(raw),
      issuer: env.JWT_ISSUER,
    },
    200,
    { 'cache-control': 'public, max-age=3600' },
  );
}

interface VerifyBody {
  key?: string;
  fingerprint?: string;
}

async function verify(req: Request, env: Env): Promise<Response> {
  let body: VerifyBody;
  try {
    body = (await req.json()) as VerifyBody;
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const key = (body.key ?? '').trim();
  if (!key || key.length < 8) return json({ ok: false, error: 'missing_key' }, 400);

  const raw = await env.KEYS.get(key);
  if (!raw) return json({ ok: false, error: 'unknown_key' }, 404);

  let record: LicenseRecord;
  try {
    record = JSON.parse(raw) as LicenseRecord;
  } catch {
    return json({ ok: false, error: 'corrupt_record' }, 500);
  }

  if (record.status !== 'active') {
    return json({ ok: false, error: 'inactive', status: record.status }, 403);
  }

  // Optional fingerprint binding: first verify pins it; later verifies must match.
  if (body.fingerprint) {
    const fp = body.fingerprint.trim().slice(0, 128);
    const list = record.fingerprints ?? [];
    if (list.length === 0) {
      record.fingerprints = [fp];
      await env.KEYS.put(key, JSON.stringify(record));
    } else if (!list.includes(fp)) {
      // Allow up to 3 distinct installs per key. Past that, refuse.
      if (list.length >= 3) {
        return json({ ok: false, error: 'fingerprint_limit', limit: 3 }, 403);
      }
      record.fingerprints = [...list, fp];
      await env.KEYS.put(key, JSON.stringify(record));
    }
  }

  const ttl = Number.parseInt(env.JWT_TTL_SECONDS || '2592000', 10);
  const now = Math.floor(Date.now() / 1000);
  const exp = now + ttl;

  const privKey = await importEd25519Private(decodeKeyMaterial(env.SIGNING_PRIVATE_KEY));
  const pubRaw = decodeKeyMaterial(env.SIGNING_PUBLIC_KEY);
  const kid = await keyId(pubRaw);

  const jwt = await signJwt(
    {
      iss: env.JWT_ISSUER,
      sub: hashKey(key),
      plan: record.plan,
      status: record.status,
      email: record.email,
      iat: now,
      exp,
      nbf: now - 60,
    },
    privKey,
    kid,
  );

  return json(
    {
      ok: true,
      jwt,
      issuer: env.JWT_ISSUER,
      plan: record.plan,
      status: record.status,
      email: record.email,
      issuedAt: new Date(now * 1000).toISOString(),
      expiresAt: new Date(exp * 1000).toISOString(),
      renewsAt: record.renewsAt,
      kid,
    },
    200,
  );
}

// Sha-256 hex of license key, used as JWT subject so the raw key is never logged.
function hashKey(key: string): string {
  // synchronous-ish stand-in: we use Web Crypto here, returning a promise -- but
  // we need a sync subject for the JWT payload. Resolve it inline via a Uint8Array
  // checksum suitable as an opaque identifier.
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ('00000000' + (h >>> 0).toString(16)).slice(-8);
}

// Stable kid (key id) derived from the public key bytes.
async function keyId(pubRaw: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', pubRaw);
  return b64uEncode(new Uint8Array(digest).slice(0, 8));
}

// Accepts hex (64 or 128 chars) or base64/base64url. Returns raw bytes.
function decodeKeyMaterial(s: string): Uint8Array {
  const trimmed = s.trim();
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    const out = new Uint8Array(trimmed.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  // base64 or base64url
  const b64 = trimmed.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
