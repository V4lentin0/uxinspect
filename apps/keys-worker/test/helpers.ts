import { webcrypto } from 'node:crypto';

// Make Cloudflare-style globals available in Node test env.
if (!(globalThis as any).crypto) {
  (globalThis as any).crypto = webcrypto;
}

/** Minimal in-memory KV implementation compatible with the subset we use. */
export class FakeKV {
  private store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  async list(): Promise<{ keys: { name: string }[] }> {
    return { keys: [...this.store.keys()].map((name) => ({ name })) };
  }
  size(): number {
    return this.store.size;
  }
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.store);
  }
}

function derToPem(der: ArrayBuffer, label: string): string {
  const b64 = Buffer.from(new Uint8Array(der)).toString('base64');
  const wrapped = b64.match(/.{1,64}/g)?.join('\n') ?? b64;
  return `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----\n`;
}

export interface TestKeyPair {
  privatePem: string;
  publicPem: string;
  publicKey: CryptoKey;
}

/** Generate a fresh Ed25519 keypair + PEM serializations for tests. */
export async function generateTestKeyPair(): Promise<TestKeyPair> {
  const kp = (await (globalThis.crypto.subtle as any).generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const pkcs8 = await globalThis.crypto.subtle.exportKey('pkcs8', kp.privateKey);
  const spki = await globalThis.crypto.subtle.exportKey('spki', kp.publicKey);
  return {
    privatePem: derToPem(pkcs8, 'PRIVATE KEY'),
    publicPem: derToPem(spki, 'PUBLIC KEY'),
    publicKey: kp.publicKey,
  };
}

/** Compute an HMAC-SHA256 hex signature identical to Polar.sh. */
export async function hmacHex(body: string, secret: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await globalThis.crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(body),
  );
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
