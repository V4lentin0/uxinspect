/**
 * uxinspect keys Worker
 *
 * Routes:
 *   POST /verify          — body {key, machineId} → signed JWT (Ed25519)
 *   POST /polar/webhook   — Polar.sh subscription events, HMAC-verified
 *   GET  /pubkey          — PEM of the current Ed25519 public key
 *
 * Secrets (wrangler secret put):
 *   PRIVATE_KEY      — PKCS#8 PEM, Ed25519 signing key
 *   POLAR_SECRET     — shared HMAC secret from Polar.sh webhook settings
 *
 * Vars (wrangler.toml):
 *   PUBLIC_KEY        — matching SPKI PEM (served at /pubkey)
 *   JWT_ISSUER        — issuer claim
 *   JWT_TTL_SECONDS   — signed JWT lifetime
 *
 * KV:
 *   LICENSES          — key → LicenseRecord JSON
 */

import {
  importPrivateKeyPem,
  signJwt,
  verifyPolarSignature,
  type LicensePayload,
} from './crypto.js';
import { applyPolarEvent, type PolarEvent } from './polar.js';

export interface Env {
  LICENSES: KVNamespace;
  PRIVATE_KEY: string;
  PUBLIC_KEY: string;
  POLAR_SECRET: string;
  JWT_ISSUER: string;
  JWT_TTL_SECONDS: string;
}

interface LicenseRecord {
  plan: string;
  customer: string;
  expiresAt: number;
  status: 'active' | 'cancelled' | 'expired' | 'past_due';
  polarSubId: string;
  createdAt: number;
  updatedAt: number;
}

interface VerifyRequestBody {
  key?: unknown;
  machineId?: unknown;
}

interface VerifyResponseBody {
  valid: boolean;
  reason?: string;
  expiresAt?: number;
  plan?: string;
  machineId?: string;
  jwt?: string;
  publicKey?: string;
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'access-control-max-age': '86400',
  };
}

function bad(reason: string, status = 400): Response {
  return json({ valid: false, reason }, status, corsHeaders());
}

async function handleVerify(req: Request, env: Env): Promise<Response> {
  let body: VerifyRequestBody;
  try {
    body = (await req.json()) as VerifyRequestBody;
  } catch {
    return bad('invalid_json');
  }
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  const machineId = typeof body.machineId === 'string' ? body.machineId.trim() : '';
  if (!key) return bad('missing_key');
  if (!machineId) return bad('missing_machine_id');
  if (key.length > 256 || machineId.length > 256) return bad('field_too_long');

  const raw = await env.LICENSES.get(key);
  if (!raw) {
    return json({ valid: false, reason: 'unknown_key' } satisfies VerifyResponseBody, 200, corsHeaders());
  }
  let record: LicenseRecord;
  try {
    record = JSON.parse(raw) as LicenseRecord;
  } catch {
    return json({ valid: false, reason: 'corrupt_record' } satisfies VerifyResponseBody, 200, corsHeaders());
  }

  const now = Math.floor(Date.now() / 1000);
  if (record.status !== 'active') {
    return json({ valid: false, reason: `status_${record.status}` } satisfies VerifyResponseBody, 200, corsHeaders());
  }
  if (record.expiresAt && record.expiresAt < now) {
    return json({ valid: false, reason: 'expired' } satisfies VerifyResponseBody, 200, corsHeaders());
  }

  if (!env.PRIVATE_KEY) return bad('signing_key_unavailable', 500);
  const privateKey = await importPrivateKeyPem(env.PRIVATE_KEY);
  const ttl = Number.parseInt(env.JWT_TTL_SECONDS || '2592000', 10) || 2592000;
  // Clamp signed-JWT expiry to the subscription's own expiry.
  const signedExp = record.expiresAt > 0 ? Math.min(now + ttl, record.expiresAt) : now + ttl;

  const payload: LicensePayload = {
    sub: key,
    machineId,
    plan: record.plan,
    customer: record.customer || undefined,
    exp: signedExp,
    iat: now,
    iss: env.JWT_ISSUER || 'https://keys.uxinspect.com',
    subscriptionExpiresAt: record.expiresAt || undefined,
  };
  const signed = await signJwt(payload, privateKey);

  const response: VerifyResponseBody = {
    valid: true,
    expiresAt: signedExp,
    plan: record.plan,
    machineId,
    jwt: signed.token,
    publicKey: env.PUBLIC_KEY || undefined,
  };
  return json(response, 200, corsHeaders());
}

async function handlePolarWebhook(req: Request, env: Env): Promise<Response> {
  const rawBody = await req.text();
  const sig = req.headers.get('polar-signature') ?? req.headers.get('x-polar-signature');
  const ok = await verifyPolarSignature(rawBody, sig, env.POLAR_SECRET);
  if (!ok) return bad('bad_signature', 401);

  let event: PolarEvent;
  try {
    event = JSON.parse(rawBody) as PolarEvent;
  } catch {
    return bad('invalid_json');
  }
  if (!event || typeof event.type !== 'string') return bad('invalid_event');

  const record = await applyPolarEvent(event, env.LICENSES);
  return json({ ok: true, applied: record !== null, event: event.type });
}

function handlePubkey(env: Env): Response {
  if (!env.PUBLIC_KEY) {
    return json({ error: 'public_key_unavailable' }, 500, corsHeaders());
  }
  return new Response(env.PUBLIC_KEY, {
    status: 200,
    headers: {
      'content-type': 'application/x-pem-file',
      'cache-control': 'public, max-age=3600',
      ...corsHeaders(),
    },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (req.method === 'POST' && url.pathname === '/verify') return handleVerify(req, env);
    if (req.method === 'POST' && url.pathname === '/polar/webhook') return handlePolarWebhook(req, env);
    if (req.method === 'GET' && url.pathname === '/pubkey') return handlePubkey(env);
    if (req.method === 'GET' && url.pathname === '/') {
      return json({ service: 'uxinspect-keys-worker', endpoints: ['/verify', '/polar/webhook', '/pubkey'] });
    }
    return json({ error: 'not_found' }, 404, corsHeaders());
  },
} satisfies ExportedHandler<Env>;
