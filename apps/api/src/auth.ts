// JWT (Ed25519 / EdDSA) verifier for tokens signed by the keys-worker.
// Tokens are issued by keys.uxinspect.com via POST /verify and carry plan + team claims.
//
// Auth sources (in order of precedence):
//   1. Authorization: Bearer <jwt>           -- dashboard + end-user sessions
//   2. x-uxinspect-key: <license-jwt>        -- CLI / CI runs (same JWT format)
//   3. x-api-key: <machine-token>            -- long-lived ingest tokens (D1-backed)

import type { Env, Plan } from './types.js';

export interface JwtPayload {
  iss: string;
  sub: string;
  plan: Plan;
  status: string;
  email: string;
  iat: number;
  exp: number;
  nbf?: number;
  team_id?: string;
  team_slug?: string;
  [k: string]: unknown;
}

export interface AuthContext {
  via: 'jwt' | 'api_key';
  plan: Plan;
  teamId: string;
  teamSlug?: string;
  email?: string;
  apiKeyId?: string;
  jwt?: JwtPayload;
}

export class AuthError extends Error {
  constructor(public code: string, public status: number = 401) {
    super(code);
  }
}

const JWT_CACHE_TTL = 60; // seconds; KV cache for hot-path JWT verification

export async function authenticate(req: Request, env: Env): Promise<AuthContext> {
  const bearer = extractBearer(req);
  if (bearer) return verifyJwtAndBuildContext(bearer, env);

  const licenseJwt = req.headers.get('x-uxinspect-key')?.trim();
  if (licenseJwt && licenseJwt.split('.').length === 3) {
    return verifyJwtAndBuildContext(licenseJwt, env);
  }

  const apiKey = req.headers.get('x-api-key')?.trim();
  if (apiKey) return verifyApiKeyAndBuildContext(apiKey, env);

  throw new AuthError('missing_credentials', 401);
}

function extractBearer(req: Request): string | null {
  const h = req.headers.get('authorization');
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

async function verifyJwtAndBuildContext(jwt: string, env: Env): Promise<AuthContext> {
  const payload = await verifyJwt(jwt, env);
  if (payload.status !== 'active') {
    throw new AuthError('subscription_inactive', 403);
  }
  const teamId = payload.team_id ?? derivedTeamId(payload.sub);
  return {
    via: 'jwt',
    plan: payload.plan,
    teamId,
    teamSlug: payload.team_slug,
    email: payload.email,
    jwt: payload,
  };
}

async function verifyApiKeyAndBuildContext(rawKey: string, env: Env): Promise<AuthContext> {
  const keyHash = await sha256Hex(rawKey);
  const row = await env.UXINSPECT_DB.prepare(
    `SELECT k.id AS api_key_id, k.team_id, k.revoked_at, t.plan, t.slug, t.status
       FROM api_keys k
       JOIN teams t ON t.id = k.team_id
      WHERE k.key_hash = ?1
      LIMIT 1`,
  )
    .bind(keyHash)
    .first<{
      api_key_id: string;
      team_id: string;
      revoked_at: number | null;
      plan: Plan;
      slug: string;
      status: string;
    }>();

  if (!row) throw new AuthError('invalid_api_key', 401);
  if (row.revoked_at) throw new AuthError('api_key_revoked', 403);
  if (row.status !== 'active') throw new AuthError('subscription_inactive', 403);

  // Best-effort last-used bookkeeping. Fire and forget.
  env.UXINSPECT_DB.prepare(`UPDATE api_keys SET last_used_at = ?1 WHERE id = ?2`)
    .bind(Math.floor(Date.now() / 1000), row.api_key_id)
    .run()
    .catch(() => {});

  return {
    via: 'api_key',
    plan: row.plan,
    teamId: row.team_id,
    teamSlug: row.slug,
    apiKeyId: row.api_key_id,
  };
}

// Verify an Ed25519 / EdDSA JWS compact token using the public key from env.
// Cached verdicts stored in KV for JWT_CACHE_TTL seconds keyed by SHA-256(jwt).
async function verifyJwt(jwt: string, env: Env): Promise<JwtPayload> {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new AuthError('malformed_jwt', 401);
  const [headerB64, payloadB64, sigB64] = parts;

  const cacheKey = `jwt:${await sha256Hex(jwt)}`;
  const cached = await env.UXINSPECT_CACHE.get(cacheKey, 'json').catch(() => null);
  if (cached && typeof cached === 'object') {
    const p = cached as JwtPayload;
    if (p.exp * 1000 > Date.now()) return p;
  }

  let header: { alg?: string; typ?: string; kid?: string };
  let payload: JwtPayload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64uDecode(headerB64)));
    payload = JSON.parse(new TextDecoder().decode(b64uDecode(payloadB64))) as JwtPayload;
  } catch {
    throw new AuthError('malformed_jwt', 401);
  }

  if (header.alg !== 'EdDSA') throw new AuthError('unsupported_alg', 401);
  if (!env.JWT_PUBLIC_KEY) throw new AuthError('server_misconfigured', 500);
  if (payload.iss !== env.JWT_ISSUER) throw new AuthError('bad_issuer', 401);

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) throw new AuthError('expired', 401);
  if (typeof payload.nbf === 'number' && payload.nbf > now + 60) throw new AuthError('not_yet_valid', 401);

  const pubRaw = decodeKeyMaterial(env.JWT_PUBLIC_KEY);
  const pubKey = await importEd25519Public(pubRaw);
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sigBytes = b64uDecode(sigB64);
  const ok = await crypto.subtle.verify('Ed25519', pubKey, sigBytes, signingInput);
  if (!ok) throw new AuthError('bad_signature', 401);

  // Cache positive verdicts. Keep TTL short and never longer than the JWT exp.
  const ttl = Math.min(JWT_CACHE_TTL, Math.max(1, payload.exp - now));
  env.UXINSPECT_CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: ttl }).catch(() => {});

  return payload;
}

async function importEd25519Public(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new AuthError('bad_public_key', 500);
  // SPKI wrapper for raw Ed25519 public key (RFC 8410):
  //   30 2a 30 05 06 03 2b 65 70 03 21 00 [32-byte pubkey]
  const header = new Uint8Array([
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
  ]);
  const spki = new Uint8Array(header.length + raw.length);
  spki.set(header, 0);
  spki.set(raw, header.length);
  return crypto.subtle.importKey('spki', spki as BufferSource, { name: 'Ed25519' }, false, ['verify']);
}

function decodeKeyMaterial(s: string): Uint8Array {
  const trimmed = s.trim();
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    const out = new Uint8Array(trimmed.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  return b64uDecode(trimmed);
}

function b64uDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

// When the JWT doesn't embed a team_id, derive a stable internal id from the
// license subject hash. Teams are provisioned lazily on first ingest.
function derivedTeamId(sub: string): string {
  return `team_${sub}`;
}
