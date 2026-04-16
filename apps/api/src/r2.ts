// R2 helpers for replay blob storage.
//
// Object key layout:
//   replays/<team_id>/<yyyy>/<mm>/<dd>/<replay_id>.<ext>
// This keeps per-team pruning and TTL policies trivial (prefix delete by team).

import type { Env } from './types.js';

export interface PutReplayResult {
  r2Key: string;
  byteSize: number;
  sha256: string;
  contentType: string;
}

export async function putReplayBlob(
  env: Env,
  opts: { teamId: string; replayId: string; body: ArrayBuffer; contentType: string },
): Promise<PutReplayResult> {
  const key = buildReplayKey(opts.teamId, opts.replayId, opts.contentType);
  const digest = await crypto.subtle.digest('SHA-256', opts.body);
  const hex = toHex(new Uint8Array(digest));
  await env.UXINSPECT_REPLAYS.put(key, opts.body, {
    httpMetadata: { contentType: opts.contentType },
    customMetadata: {
      team_id: opts.teamId,
      replay_id: opts.replayId,
      sha256: hex,
    },
  });
  return {
    r2Key: key,
    byteSize: opts.body.byteLength,
    sha256: hex,
    contentType: opts.contentType,
  };
}

export async function getReplayBlob(env: Env, r2Key: string): Promise<R2ObjectBody | null> {
  return env.UXINSPECT_REPLAYS.get(r2Key);
}

function buildReplayKey(teamId: string, replayId: string, contentType: string): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const ext = contentType.includes('json') ? 'json' : 'bin';
  return `replays/${teamId}/${yyyy}/${mm}/${dd}/${replayId}.${ext}`;
}

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}
