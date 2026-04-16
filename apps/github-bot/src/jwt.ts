// GitHub App JWT signing (RS256) using Cloudflare Workers Web Crypto.
//
// GitHub App auth is a two-step flow:
//   1. Sign a short-lived (max 10 min) RS256 JWT with the App's private key.
//      Claims: { iat, exp, iss: <App ID> }.
//   2. Exchange that JWT at POST /app/installations/:installation_id/access_tokens
//      for an installation access token (<1h TTL) that is used as the bearer on
//      all REST/GraphQL calls.
//
// This file covers step 1 only. Step 2 lives in github-api.ts.
//
// PKCS#1 (BEGIN RSA PRIVATE KEY) and PKCS#8 (BEGIN PRIVATE KEY) PEMs are both
// accepted. GitHub historically hands out PKCS#1 .pem files; Workers' Web Crypto
// only imports PKCS#8, so we convert on the fly.

export interface GitHubAppJwtClaims {
  iat: number;
  exp: number;
  iss: string;
}

// Sign a short-lived RS256 JWT suitable for exchanging at /app/installations/:id/access_tokens.
export async function signGitHubAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  // GitHub rejects clock skew > 60s; subtract 30s from iat and cap exp at 10 min.
  const claims: GitHubAppJwtClaims = {
    iat: now - 30,
    exp: now + 9 * 60,
    iss: appId,
  };
  const header = { alg: 'RS256', typ: 'JWT' };
  const headerB64 = b64uEncode(new TextEncoder().encode(JSON.stringify(header)));
  const claimsB64 = b64uEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${headerB64}.${claimsB64}`;

  const key = await importRsaPrivateKey(privateKeyPem);
  const sig = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    new TextEncoder().encode(signingInput),
  );
  const sigB64 = b64uEncode(new Uint8Array(sig));
  return `${signingInput}.${sigB64}`;
}

async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
  const trimmed = pem.trim();
  let der: Uint8Array;
  if (trimmed.includes('BEGIN RSA PRIVATE KEY')) {
    const pkcs1 = pemToDer(trimmed, 'RSA PRIVATE KEY');
    der = pkcs1ToPkcs8(pkcs1);
  } else if (trimmed.includes('BEGIN PRIVATE KEY')) {
    der = pemToDer(trimmed, 'PRIVATE KEY');
  } else {
    throw new Error('unsupported private key format (need PKCS#1 or PKCS#8 PEM)');
  }
  return crypto.subtle.importKey(
    'pkcs8',
    der as BufferSource,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

function pemToDer(pem: string, label: string): Uint8Array {
  const begin = `-----BEGIN ${label}-----`;
  const end = `-----END ${label}-----`;
  const b = pem.indexOf(begin);
  const e = pem.indexOf(end);
  if (b < 0 || e < 0) throw new Error(`PEM label ${label} not found`);
  const body = pem.slice(b + begin.length, e).replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Wrap PKCS#1 RSAPrivateKey bytes in a PKCS#8 PrivateKeyInfo envelope so Web
// Crypto will import them. The envelope is:
//   SEQUENCE {
//     INTEGER 0,
//     AlgorithmIdentifier { rsaEncryption, NULL },
//     OCTET STRING <pkcs1-bytes>
//   }
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  // AlgorithmIdentifier for rsaEncryption (1.2.840.113549.1.1.1) with NULL params.
  const algId = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const octetString = derOctetString(pkcs1);
  const body = concat(version, algId, octetString);
  return derSequence(body);
}

function derSequence(body: Uint8Array): Uint8Array {
  return concat(new Uint8Array([0x30]), derLength(body.length), body);
}

function derOctetString(body: Uint8Array): Uint8Array {
  return concat(new Uint8Array([0x04]), derLength(body.length), body);
}

function derLength(len: number): Uint8Array {
  if (len < 0x80) return new Uint8Array([len]);
  if (len < 0x100) return new Uint8Array([0x81, len]);
  if (len < 0x10000) return new Uint8Array([0x82, (len >> 8) & 0xff, len & 0xff]);
  if (len < 0x1000000) return new Uint8Array([0x83, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
  return new Uint8Array([
    0x84,
    (len >>> 24) & 0xff,
    (len >> 16) & 0xff,
    (len >> 8) & 0xff,
    len & 0xff,
  ]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function b64uEncode(buf: Uint8Array): string {
  let s = '';
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
