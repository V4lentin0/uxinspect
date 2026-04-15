/**
 * Ed25519 + HMAC helpers built only on Web Crypto — no Node crypto,
 * no third-party libs. Runs unmodified in Cloudflare Workers.
 */

export interface SignedJwt {
  /** Base64url header.payload.signature triplet */
  token: string;
}

export interface JwtHeader {
  alg: 'EdDSA';
  typ: 'JWT';
}

export interface LicensePayload {
  /** Subject — the license key itself */
  sub: string;
  /** Machine ID bound to this verification */
  machineId: string;
  /** Plan tier (pro | team | enterprise) */
  plan: string;
  /** Customer identifier from billing provider */
  customer?: string;
  /** Expiry (seconds since epoch) of this signed response */
  exp: number;
  /** Issued-at (seconds since epoch) */
  iat: number;
  /** Issuer — normally https://keys.uxinspect.com */
  iss: string;
  /** Subscription expiry on the billing side (seconds since epoch). Optional. */
  subscriptionExpiresAt?: number;
}

function b64urlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlEncodeString(s: string): string {
  return b64urlEncode(new TextEncoder().encode(s));
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function stripPem(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  return b64urlDecode(body.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
}

/** Parse a PKCS#8 Ed25519 PEM into a CryptoKey usable for signing. */
export async function importPrivateKeyPem(pem: string): Promise<CryptoKey> {
  const der = stripPem(pem);
  return crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'Ed25519' } as any,
    false,
    ['sign'],
  );
}

/** Parse a SPKI Ed25519 PEM into a CryptoKey usable for verification. */
export async function importPublicKeyPem(pem: string): Promise<CryptoKey> {
  const der = stripPem(pem);
  return crypto.subtle.importKey(
    'spki',
    der,
    { name: 'Ed25519' } as any,
    true,
    ['verify'],
  );
}

/** Sign a payload with Ed25519 and return a compact JWT. */
export async function signJwt(
  payload: LicensePayload,
  privateKey: CryptoKey,
): Promise<SignedJwt> {
  const header: JwtHeader = { alg: 'EdDSA', typ: 'JWT' };
  const headerB64 = b64urlEncodeString(JSON.stringify(header));
  const payloadB64 = b64urlEncodeString(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = await crypto.subtle.sign(
    { name: 'Ed25519' } as any,
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return { token: `${signingInput}.${b64urlEncode(sig)}` };
}

/** Verify a JWT signature using the given Ed25519 public key. */
export async function verifyJwt(
  token: string,
  publicKey: CryptoKey,
): Promise<LicensePayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const signingInput = `${h}.${p}`;
  const sig = b64urlDecode(s);
  const ok = await crypto.subtle.verify(
    { name: 'Ed25519' } as any,
    publicKey,
    sig,
    new TextEncoder().encode(signingInput),
  );
  if (!ok) return null;
  try {
    const payloadJson = new TextDecoder().decode(b64urlDecode(p));
    return JSON.parse(payloadJson) as LicensePayload;
  } catch {
    return null;
  }
}

/** Constant-time comparison on two same-length Uint8Arrays. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Verify a Polar.sh webhook signature. Polar signs the raw body with
 * HMAC-SHA256 and puts a hex digest in `polar-signature` header.
 * We accept both `sha256=<hex>` and plain hex.
 */
export async function verifyPolarSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader || !secret) return false;
  const provided = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice(7)
    : signatureHeader;
  // Expect hex
  if (!/^[0-9a-fA-F]+$/.test(provided)) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(rawBody),
  );
  const digestBytes = new Uint8Array(digest);
  const providedBytes = new Uint8Array(provided.length / 2);
  for (let i = 0; i < provided.length; i += 2) {
    providedBytes[i / 2] = parseInt(provided.slice(i, i + 2), 16);
  }
  return timingSafeEqual(digestBytes, providedBytes);
}

/** Export helpers for tests. */
export const __internals = { b64urlEncode, b64urlDecode, b64urlEncodeString };
