/**
 * uxinspect license client.
 *
 * Free MIT CLI never touches this file. Pro features call
 * {@link verifyLicense} to decide whether to unlock. The function talks
 * to `https://keys.uxinspect.com/verify`, caches the signed JWT to
 * `~/.uxinspect/license.jwt` for 30 days, and falls back to that cache
 * (within a 14-day grace window) when the network is unavailable.
 *
 * The bundled Ed25519 public key pins the Worker — clients verify the
 * JWT signature locally, so a compromised CDN or DNS cannot issue a
 * fake license.
 */

import { createHash, webcrypto } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/** Bundled public key in SPKI PEM. Update during key rotation. */
export const BUNDLED_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAMTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU=
-----END PUBLIC KEY-----
`;

/** Accepted plans. */
export type LicensePlan = 'pro' | 'team' | 'enterprise';

export interface License {
  /** Plan unlocked by this license. */
  plan: LicensePlan;
  /** License key the user activated. */
  key: string;
  /** Machine id bound to this JWT. */
  machineId: string;
  /** Unix seconds when this JWT expires. */
  expiresAt: number;
  /** Unix seconds when this JWT was issued. */
  issuedAt: number;
  /** Issuer claim. */
  issuer: string;
  /** True when the result came from the offline cache (grace period). */
  offline: boolean;
  /** The raw JWT string. */
  jwt: string;
  /** Optional subscription-level expiry from billing. */
  subscriptionExpiresAt?: number;
}

export interface VerifyOptions {
  /**
   * Endpoint to verify against. Defaults to
   * `https://keys.uxinspect.com/verify`.
   */
  endpoint?: string;
  /** Override for the cache file path. Defaults to `~/.uxinspect/license.jwt`. */
  cachePath?: string;
  /** Override for the machine id (stable hash of hostname+platform by default). */
  machineId?: string;
  /** Override for the bundled public key PEM (used during key rotation). */
  publicKeyPem?: string;
  /** Abort fetch after this many ms. Default 5000. */
  timeoutMs?: number;
  /** Offline grace period in seconds. Default 14 days. */
  offlineGraceSeconds?: number;
  /** Cache lifetime in seconds. Default 30 days. */
  cacheLifetimeSeconds?: number;
  /** Injectable fetch (for testing). */
  fetchImpl?: typeof fetch;
  /** Skip network entirely and only consult cache (for testing). */
  offlineOnly?: boolean;
  /** Injectable clock (for testing). */
  now?: () => number;
}

const DEFAULT_ENDPOINT = 'https://keys.uxinspect.com/verify';
const DEFAULT_OFFLINE_GRACE_SECONDS = 14 * 86400;
const DEFAULT_CACHE_LIFETIME_SECONDS = 30 * 86400;
const DEFAULT_TIMEOUT_MS = 5000;

interface CacheFile {
  version: 1;
  key: string;
  machineId: string;
  jwt: string;
  cachedAt: number;
  responseExpiresAt: number;
}

interface JwtPayload {
  sub: string;
  machineId: string;
  plan: string;
  customer?: string;
  exp: number;
  iat: number;
  iss: string;
  subscriptionExpiresAt?: number;
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = Buffer.from(b64, 'base64');
  return new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength);
}

function stripPem(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const buf = Buffer.from(body, 'base64');
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(u.byteLength);
  new Uint8Array(ab).set(u);
  return ab;
}

async function importPublicKey(pem: string): Promise<CryptoKey> {
  return (webcrypto.subtle as unknown as SubtleCrypto).importKey(
    'spki',
    stripPem(pem),
    { name: 'Ed25519' } as AlgorithmIdentifier,
    true,
    ['verify'],
  );
}

async function verifyJwtSignature(token: string, publicKey: CryptoKey): Promise<JwtPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  try {
    const ok = await (webcrypto.subtle as unknown as SubtleCrypto).verify(
      { name: 'Ed25519' } as AlgorithmIdentifier,
      publicKey,
      toArrayBuffer(b64urlDecode(s)),
      new TextEncoder().encode(`${h}.${p}`),
    );
    if (!ok) return null;
    const payload = JSON.parse(Buffer.from(b64urlDecode(p)).toString('utf8')) as JwtPayload;
    return payload;
  } catch {
    return null;
  }
}

function defaultMachineId(): string {
  const material = `${os.hostname()}|${os.platform()}|${os.arch()}|${os.userInfo().username}`;
  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

function defaultCachePath(): string {
  return path.join(os.homedir(), '.uxinspect', 'license.jwt');
}

async function readCache(p: string): Promise<CacheFile | null> {
  try {
    const raw = await readFile(p, 'utf8');
    const parsed = JSON.parse(raw) as CacheFile;
    if (parsed.version !== 1 || typeof parsed.jwt !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(p: string, cache: CacheFile): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(cache), 'utf8');
}

function normalizePlan(plan: string | undefined): LicensePlan {
  return plan === 'team' || plan === 'enterprise' ? plan : 'pro';
}

function toLicense(
  payload: JwtPayload,
  jwt: string,
  key: string,
  machineId: string,
  offline: boolean,
): License {
  return {
    plan: normalizePlan(payload.plan),
    key,
    machineId,
    expiresAt: payload.exp,
    issuedAt: payload.iat,
    issuer: payload.iss,
    offline,
    jwt,
    subscriptionExpiresAt: payload.subscriptionExpiresAt,
  };
}

/**
 * Verify a license key.
 *
 * Behavior:
 *   1. POST to `/verify`. If the response is valid, cache + return.
 *   2. On network failure, fall back to the on-disk cache iff it was
 *      signed for this key+machine, is signature-valid against the
 *      bundled public key, and is ≤ 14 days old.
 *   3. Return `null` for unknown keys, expired JWTs, tampered JWTs,
 *      or stale caches.
 */
export async function verifyLicense(
  key: string,
  options: VerifyOptions = {},
): Promise<License | null> {
  const trimmedKey = (key ?? '').trim();
  if (!trimmedKey) return null;

  const now = options.now ? options.now() : Math.floor(Date.now() / 1000);
  const machineId = options.machineId ?? defaultMachineId();
  const cachePath = options.cachePath ?? defaultCachePath();
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const offlineGrace = options.offlineGraceSeconds ?? DEFAULT_OFFLINE_GRACE_SECONDS;
  const cacheLifetime = options.cacheLifetimeSeconds ?? DEFAULT_CACHE_LIFETIME_SECONDS;
  const fetchFn = options.fetchImpl ?? fetch;
  const publicKey = await importPublicKey(options.publicKeyPem ?? BUNDLED_PUBLIC_KEY_PEM);

  const networkAttempt = async (): Promise<License | null> => {
    if (options.offlineOnly) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchFn(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: trimmedKey, machineId }),
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        valid?: boolean;
        jwt?: string;
        expiresAt?: number;
      };
      if (!body.valid || typeof body.jwt !== 'string') return null;
      const payload = await verifyJwtSignature(body.jwt, publicKey);
      if (!payload) return null;
      if (payload.sub !== trimmedKey) return null;
      if (payload.machineId !== machineId) return null;
      if (payload.exp < now) return null;
      await writeCache(cachePath, {
        version: 1,
        key: trimmedKey,
        machineId,
        jwt: body.jwt,
        cachedAt: now,
        responseExpiresAt: payload.exp,
      }).catch(() => undefined);
      return toLicense(payload, body.jwt, trimmedKey, machineId, false);
    } finally {
      clearTimeout(timer);
    }
  };

  const cacheAttempt = async (networkFailed: boolean): Promise<License | null> => {
    const cache = await readCache(cachePath);
    if (!cache) return null;
    if (cache.key !== trimmedKey) return null;
    if (cache.machineId !== machineId) return null;
    const payload = await verifyJwtSignature(cache.jwt, publicKey);
    if (!payload) return null;
    if (payload.sub !== trimmedKey || payload.machineId !== machineId) return null;
    if (payload.exp < now) return null;
    const age = now - (cache.cachedAt || payload.iat);
    // When online succeeds we already returned. This path runs when:
    //   - network failed (use 14d offline-grace window), or
    //   - offlineOnly was set (use 30d cache-lifetime window).
    const maxAge = networkFailed ? offlineGrace : cacheLifetime;
    if (age > maxAge) return null;
    return toLicense(payload, cache.jwt, trimmedKey, machineId, true);
  };

  if (options.offlineOnly) {
    return cacheAttempt(false);
  }

  try {
    const fresh = await networkAttempt();
    if (fresh) return fresh;
    // Valid network response that said "not valid" → do NOT fall back to cache.
    // Only fall back on network failures (caught below).
    return null;
  } catch {
    return cacheAttempt(true);
  }
}

export const __testing = { defaultMachineId, defaultCachePath, verifyJwtSignature };
