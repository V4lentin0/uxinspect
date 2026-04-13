import { AwsClient } from 'aws4fetch';

export interface BaselineStore {
  read(key: string): Promise<Buffer | null>;
  write(key: string, bytes: Buffer): Promise<void>;
}

export interface R2StoreOptions {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix?: string;
}

export function r2Store(opts: R2StoreOptions): BaselineStore {
  const endpoint = `https://${opts.accountId}.r2.cloudflarestorage.com/${opts.bucket}`;
  const aws = new AwsClient({
    accessKeyId: opts.accessKeyId,
    secretAccessKey: opts.secretAccessKey,
    service: 's3',
    region: 'auto',
  });
  const prefix = opts.prefix ? opts.prefix.replace(/\/+$/, '') + '/' : '';

  return {
    async read(key: string): Promise<Buffer | null> {
      const res = await aws.fetch(`${endpoint}/${prefix}${encodeURI(key)}`, { method: 'GET' });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`R2 read ${key} failed: ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
    async write(key: string, bytes: Buffer): Promise<void> {
      const body = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const res = await aws.fetch(`${endpoint}/${prefix}${encodeURI(key)}`, {
        method: 'PUT',
        body: body as any,
        headers: { 'content-type': 'image/png' },
      });
      if (!res.ok) throw new Error(`R2 write ${key} failed: ${res.status}`);
    },
  };
}

export function r2StoreFromEnv(env: NodeJS.ProcessEnv = process.env): BaselineStore | null {
  const accountId = env.UXINSPECT_R2_ACCOUNT_ID;
  const bucket = env.UXINSPECT_R2_BUCKET;
  const accessKeyId = env.UXINSPECT_R2_ACCESS_KEY_ID;
  const secretAccessKey = env.UXINSPECT_R2_SECRET_ACCESS_KEY;
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) return null;
  return r2Store({
    accountId,
    bucket,
    accessKeyId,
    secretAccessKey,
    prefix: env.UXINSPECT_R2_PREFIX,
  });
}
