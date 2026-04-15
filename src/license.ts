// CLI-side license verification.
//
// Talks to the keys-worker at https://keys.uxinspect.com/verify, verifies the
// returned Ed25519-signed JWT locally, and caches the result on disk for
// `CACHE_TTL_MS` (30 days). If the network is unreachable, a cached license is
// honored for an extra `OFFLINE_GRACE_MS` (14 days) past its hard expiry.
//
// All file I/O lives under `.uxinspect/license.json` in the project's working
// directory (already gitignored). No analytics, no remote logging.

import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto, { webcrypto } from 'node:crypto';

const ENDPOINT = process.env.UXINSPECT_KEYS_URL ?? 'https://keys.uxinspect.com';
const CACHE_FILE = '.uxinspect/license.json';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const OFFLINE_GRACE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const NETWORK_TIMEOUT_MS = 10_000;

// Pinned issuer + public key. The Worker also exposes /pubkey for first-time
// bootstrap, but for production CLI builds the public key is baked in here so a
// compromised keys.uxinspect.com can't forge tokens by serving a fresh key.
//
// Override via `UXINSPECT_TRUSTED_PUBKEY` (32 raw bytes, hex or base64url) for
// staging / self-hosted deployments.
const PINNED_ISSUER = 'keys.uxinspect.com';
const PINNED_PUBLIC_KEY_B64U = process.env.UXINSPECT_TRUSTED_PUBKEY ?? '';

export type Plan = 'free' | 'pro' | 'team' | 'enterprise';

export interface LicenseStatus {
  /** True when the cached or freshly-verified license is currently honored. */
  ok: boolean;
  /** Plan level. `free` when no key is configured or verification failed. */
  plan: Plan;
  /** Where the result came from. */
  source: 'fresh' | 'cache' | 'offline-grace' | 'none';
  /** Reason the license is not honored, if `ok` is false. */
  reason?: string;
  /** Customer email (from JWT). */
  email?: string;
  /** When the cached JWT was issued. */
  issuedAt?: string;
  /** Hard expiry of the cached JWT. */
  expiresAt?: string;
  /** Grace expiry: cached JWT may still be honored offline up to this point. */
  graceUntil?: string;
}

interface SignedJwtPayload {
  iss: string;
  sub: string;
  iat: number;
  exp: number;
  nbf?: number;
  plan: 'pro' | 'team' | 'enterprise';
  status: 'active' | 'cancelled' | 'past_due' | 'revoked';
  email: string;
}

interface CacheFile {
  jwt: string;
  payload: SignedJwtPayload;
  cachedAt: number; // ms epoch
  /** SHA-256 of the license key, used to detect when the user swaps keys. */
  keyHash: string;
}

export interface VerifyOptions {
  /** Override the project root used for cache reads/writes. */
  cwd?: string;
  /** Force a network call even if a fresh cache exists. */
  forceRefresh?: boolean;
  /** Override the keys-worker base URL. */
  endpoint?: string;
}

const FREE_STATUS: LicenseStatus = { ok: true, plan: 'free', source: 'none' };

export async function verifyLicense(opts: VerifyOptions = {}): Promise<LicenseStatus> {
  const cwd = opts.cwd ?? process.cwd();
  const endpoint = opts.endpoint ?? ENDPOINT;

  const key = readKeyFromEnvOrFile(cwd);
  if (!key) return FREE_STATUS;

  const cachePath = path.join(cwd, CACHE_FILE);
  const cache = await readCache(cachePath);
  const keyHash = sha256Hex(key);
  const now = Date.now();

  // Use fresh cache when valid and the cached entry matches the configured key.
  if (!opts.forceRefresh && cache && cache.keyHash === keyHash) {
    const ageMs = now - cache.cachedAt;
    const expMs = cache.payload.exp * 1000;
    if (ageMs < CACHE_TTL_MS && now < expMs) {
      return cacheToStatus(cache, 'cache');
    }
  }

  // Network refresh.
  try {
    const fingerprint = await machineFingerprint();
    const fresh = await fetchAndVerify(endpoint, key, fingerprint);
    const newCache: CacheFile = {
      jwt: fresh.jwt,
      payload: fresh.payload,
      cachedAt: now,
      keyHash,
    };
    await writeCache(cachePath, newCache);
    return cacheToStatus(newCache, 'fresh');
  } catch (err) {
    // Network or worker failure -- fall back to cache (if any) within offline grace.
    if (cache && cache.keyHash === keyHash) {
      const expMs = cache.payload.exp * 1000;
      const graceUntil = expMs + OFFLINE_GRACE_MS;
      if (now < graceUntil) {
        return {
          ...cacheToStatus(cache, 'offline-grace'),
          reason: `network unavailable: ${describeError(err)}`,
        };
      }
      return {
        ok: false,
        plan: 'free',
        source: 'cache',
        reason: `cache expired and offline grace exhausted (${describeError(err)})`,
        issuedAt: new Date(cache.payload.iat * 1000).toISOString(),
        expiresAt: new Date(expMs).toISOString(),
        graceUntil: new Date(graceUntil).toISOString(),
      };
    }
    return {
      ok: false,
      plan: 'free',
      source: 'none',
      reason: `verification failed: ${describeError(err)}`,
    };
  }
}

/** True when the verified license includes the requested plan or higher. */
export function hasPlan(status: LicenseStatus, required: Plan): boolean {
  if (!status.ok) return required === 'free';
  const order: Plan[] = ['free', 'pro', 'team', 'enterprise'];
  return order.indexOf(status.plan) >= order.indexOf(required);
}

/** Throw a descriptive error if the required plan is not active. */
export function requirePlan(status: LicenseStatus, required: Plan, feature: string): void {
  if (hasPlan(status, required)) return;
  const reason = status.reason ? ` (${status.reason})` : '';
  throw new Error(
    `${feature} requires the ${required} plan. Current: ${status.plan}${reason}.\n` +
      `Set UXINSPECT_LICENSE_KEY or run: uxinspect license activate <key>`,
  );
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function readKeyFromEnvOrFile(cwd: string): string | null {
  const env = (process.env.UXINSPECT_LICENSE_KEY ?? '').trim();
  if (env) return env;
  // Optional persisted key at .uxinspect/key (one line). Avoid throwing on missing files.
  const candidates = [
    path.join(cwd, '.uxinspect', 'key'),
    path.join(os.homedir(), '.uxinspect', 'key'),
  ];
  for (const p of candidates) {
    try {
      const v = readFileSync(p, 'utf8').trim();
      if (v) return v;
    } catch {
      /* not present, try next */
    }
  }
  return null;
}

async function readCache(file: string): Promise<CacheFile | null> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as CacheFile;
    if (typeof parsed.jwt !== 'string' || !parsed.payload || typeof parsed.cachedAt !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(file: string, data: CacheFile): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

function cacheToStatus(cache: CacheFile, source: LicenseStatus['source']): LicenseStatus {
  const expMs = cache.payload.exp * 1000;
  return {
    ok: cache.payload.status === 'active',
    plan: cache.payload.plan,
    source,
    email: cache.payload.email,
    issuedAt: new Date(cache.payload.iat * 1000).toISOString(),
    expiresAt: new Date(expMs).toISOString(),
    graceUntil: new Date(expMs + OFFLINE_GRACE_MS).toISOString(),
    reason: cache.payload.status === 'active' ? undefined : `subscription ${cache.payload.status}`,
  };
}

interface FetchResult {
  jwt: string;
  payload: SignedJwtPayload;
}

async function fetchAndVerify(endpoint: string, key: string, fingerprint: string): Promise<FetchResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), NETWORK_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(endpoint.replace(/\/+$/, '') + '/verify', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'user-agent': 'uxinspect-cli' },
      body: JSON.stringify({ key, fingerprint }),
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let body = '';
    try {
      body = await res.text();
    } catch {
      /* ignore */
    }
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { jwt?: string; ok?: boolean; error?: string };
  if (!data.ok || !data.jwt) throw new Error(`server rejected key: ${data.error ?? 'unknown'}`);

  const payload = await verifyJwt(data.jwt);
  return { jwt: data.jwt, payload };
}

async function verifyJwt(jwt: string): Promise<SignedJwtPayload> {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('malformed JWT');
  const [headerB64, payloadB64, sigB64] = parts;

  const header = JSON.parse(b64uDecodeString(headerB64)) as { alg?: string; typ?: string; kid?: string };
  if (header.alg !== 'EdDSA') throw new Error(`unsupported alg: ${header.alg}`);

  const payload = JSON.parse(b64uDecodeString(payloadB64)) as SignedJwtPayload;
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) throw new Error('JWT expired');
  if (payload.nbf && payload.nbf > now + 60) throw new Error('JWT not yet valid');
  if (payload.iss !== PINNED_ISSUER) throw new Error(`unexpected issuer: ${payload.iss}`);

  if (!PINNED_PUBLIC_KEY_B64U) {
    // Without a pinned key we can still verify shape, but cannot cryptographically
    // trust the signature. The CLI build pipeline must inject UXINSPECT_TRUSTED_PUBKEY
    // at release time. In dev / staging, accept the unsigned-trust path.
    if (process.env.UXINSPECT_ALLOW_UNVERIFIED_LICENSE !== '1') {
      throw new Error(
        'UXINSPECT_TRUSTED_PUBKEY is not set; refusing to trust unsigned license. ' +
          'Set the env var or build with the pinned key inlined.',
      );
    }
    return payload;
  }

  const pubRaw = b64uDecode(PINNED_PUBLIC_KEY_B64U);
  if (pubRaw.length !== 32) throw new Error(`pinned public key must be 32 bytes, got ${pubRaw.length}`);
  const spki = wrapEd25519PublicAsSpki(pubRaw);
  const pubKey = await webcrypto.subtle.importKey('spki', spki, { name: 'Ed25519' }, false, ['verify']);
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = b64uDecode(sigB64);
  const ok = await webcrypto.subtle.verify('Ed25519', pubKey, sig, signingInput);
  if (!ok) throw new Error('invalid JWT signature');
  return payload;
}

function wrapEd25519PublicAsSpki(pub: Uint8Array): Uint8Array {
  const header = new Uint8Array([
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
  ]);
  const out = new Uint8Array(header.length + pub.length);
  out.set(header, 0);
  out.set(pub, header.length);
  return out;
}

async function machineFingerprint(): Promise<string> {
  // Stable per-machine identifier without leaking PII. Hash hostname + first MAC.
  const ifs = os.networkInterfaces();
  let mac = '';
  for (const list of Object.values(ifs)) {
    for (const it of list ?? []) {
      if (it.mac && it.mac !== '00:00:00:00:00:00') {
        mac = it.mac;
        break;
      }
    }
    if (mac) break;
  }
  const seed = `${os.hostname()}|${os.platform()}|${os.arch()}|${mac}`;
  return sha256Hex(seed).slice(0, 32);
}

function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function b64uDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  return new Uint8Array(Buffer.from(padded, 'base64'));
}

function b64uDecodeString(s: string): string {
  return Buffer.from(b64uDecode(s)).toString('utf8');
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
