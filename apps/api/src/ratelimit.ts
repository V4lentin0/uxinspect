// KV-backed sliding-hour rate limiter. One counter per (team_id, hour-bucket).
//
// Quotas (requests per rolling hour):
//   free        100
//   pro       1,000
//   team     10,000
//   enterprise 100,000
//
// KV is eventually consistent across PoPs, so this gives a soft ceiling suitable
// for fair-use protection rather than exact billing accounting.

import type { Env, Plan } from './types.js';

export const PLAN_LIMITS: Record<Plan, number> = {
  free: 100,
  pro: 1_000,
  team: 10_000,
  enterprise: 100_000,
};

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number; // epoch seconds when the current bucket rolls over
  used: number;
}

export async function checkAndConsume(env: Env, teamId: string, plan: Plan): Promise<RateLimitResult> {
  const limit = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
  const bucket = Math.floor(Date.now() / 3_600_000); // hour bucket
  const resetAt = (bucket + 1) * 3600;
  const key = `rl:${teamId}:${bucket}`;

  const raw = await env.UXINSPECT_CACHE.get(key);
  const used = raw ? Math.max(0, parseInt(raw, 10) || 0) : 0;
  if (used >= limit) {
    return { allowed: false, limit, remaining: 0, resetAt, used };
  }
  const next = used + 1;
  // KV TTL is seconds; expire the counter a bit past the bucket boundary.
  const ttl = Math.max(60, resetAt - Math.floor(Date.now() / 1000) + 60);
  await env.UXINSPECT_CACHE.put(key, String(next), { expirationTtl: ttl }).catch(() => {});
  return { allowed: true, limit, remaining: Math.max(0, limit - next), resetAt, used: next };
}

export function rateLimitHeaders(r: RateLimitResult): Record<string, string> {
  return {
    'x-ratelimit-limit': String(r.limit),
    'x-ratelimit-remaining': String(r.remaining),
    'x-ratelimit-reset': String(r.resetAt),
  };
}
