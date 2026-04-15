// Minimal Ed25519 JWT (JWS compact, EdDSA) signer for Cloudflare Workers.
// Uses the runtime's Web Crypto Ed25519 support.

export interface JwtClaims {
  iss: string;
  sub: string;
  iat: number;
  exp: number;
  nbf?: number;
  plan: string;
  status: string;
  email: string;
  [k: string]: unknown;
}

export async function signJwt(claims: JwtClaims, privateKey: CryptoKey, kid: string): Promise<string> {
  const header = { alg: 'EdDSA', typ: 'JWT', kid };
  const headerB64 = b64uEncode(new TextEncoder().encode(JSON.stringify(header)));
  const claimsB64 = b64uEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${headerB64}.${claimsB64}`;
  const sig = await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(signingInput));
  const sigB64 = b64uEncode(new Uint8Array(sig));
  return `${signingInput}.${sigB64}`;
}

// Import a 32-byte raw Ed25519 private key as a CryptoKey.
// Workers Web Crypto wants either JWK or PKCS8; the simplest cross-runtime path
// is to wrap the raw 32-byte seed in PKCS8 ourselves.
export async function importEd25519Private(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length === 32) {
    const pkcs8 = wrapEd25519PrivateAsPkcs8(raw);
    return crypto.subtle.importKey('pkcs8', pkcs8 as BufferSource, { name: 'Ed25519' }, false, ['sign']);
  }
  if (raw.length === 64) {
    // libsodium-style 64-byte secret = seed(32) || pubkey(32). Take seed.
    const pkcs8 = wrapEd25519PrivateAsPkcs8(raw.slice(0, 32));
    return crypto.subtle.importKey('pkcs8', pkcs8 as BufferSource, { name: 'Ed25519' }, false, ['sign']);
  }
  throw new Error(`unexpected Ed25519 private key length: ${raw.length}`);
}

export async function importEd25519Public(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error(`unexpected Ed25519 public key length: ${raw.length}`);
  const spki = wrapEd25519PublicAsSpki(raw);
  return crypto.subtle.importKey('spki', spki as BufferSource, { name: 'Ed25519' }, true, ['verify']);
}

// PKCS8 wrapper for raw Ed25519 seed. RFC 8410 / RFC 5958.
// Header bytes are constant for Ed25519:
//   30 2e 02 01 00 30 05 06 03 2b 65 70 04 22 04 20 [32-byte seed]
function wrapEd25519PrivateAsPkcs8(seed: Uint8Array): Uint8Array {
  const header = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
  ]);
  const out = new Uint8Array(header.length + seed.length);
  out.set(header, 0);
  out.set(seed, header.length);
  return out;
}

// SPKI wrapper for raw Ed25519 public key. RFC 8410.
//   30 2a 30 05 06 03 2b 65 70 03 21 00 [32-byte pubkey]
function wrapEd25519PublicAsSpki(pub: Uint8Array): Uint8Array {
  const header = new Uint8Array([
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
  ]);
  const out = new Uint8Array(header.length + pub.length);
  out.set(header, 0);
  out.set(pub, header.length);
  return out;
}

export function b64uEncode(buf: Uint8Array): string {
  let s = '';
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
