// Polar.sh webhook handler. Verifies Standard Webhooks HMAC-SHA256 signature and
// reconciles team plan/status on subscription lifecycle events.
//
// Expected headers (Standard Webhooks):
//   webhook-id
//   webhook-timestamp
//   webhook-signature   (one or more `v1,<b64sig>` entries, space/comma separated)

import type { Env, Plan, TeamStatus } from './types.js';
import { insertAudit, updateTeamFromPolar } from './db.js';

interface PolarWebhookEvent {
  type: string;
  data?: {
    id?: string;
    customer_id?: string;
    customer?: { id?: string; email?: string };
    product_id?: string;
    product?: { id?: string; name?: string };
    status?: string;
    current_period_end?: string;
    metadata?: Record<string, string>;
  };
}

export async function handlePolarWebhook(req: Request, env: Env): Promise<Response> {
  if (!env.POLAR_WEBHOOK_SECRET) {
    return jsonResp({ ok: false, error: 'webhook_not_configured' }, 500);
  }

  const body = await req.text();
  const id = req.headers.get('webhook-id') ?? '';
  const ts = req.headers.get('webhook-timestamp') ?? '';
  const sig = req.headers.get('webhook-signature') ?? req.headers.get('polar-signature') ?? '';

  const valid = await verifySignature(body, id, ts, sig, env.POLAR_WEBHOOK_SECRET);
  if (!valid) return jsonResp({ ok: false, error: 'invalid_signature' }, 401);

  // Reject replays: webhook-timestamp must be within 5 min of now.
  const tsNum = parseInt(ts, 10);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) {
    return jsonResp({ ok: false, error: 'stale_timestamp' }, 401);
  }

  let event: PolarWebhookEvent;
  try {
    event = JSON.parse(body) as PolarWebhookEvent;
  } catch {
    return jsonResp({ ok: false, error: 'invalid_json' }, 400);
  }

  const data = event.data ?? {};
  const subId = data.id;
  if (!subId) return jsonResp({ ok: false, error: 'missing_subscription_id' }, 400);

  const plan = mapProductToPlan(data.product?.name ?? '');
  const status = mapEventToStatus(event.type, data.status);
  const renewsAt = parseIso(data.current_period_end);
  const email = data.customer?.email;
  const customerId = data.customer_id ?? data.customer?.id;

  if (status) {
    await updateTeamFromPolar(env, {
      subscriptionId: subId,
      plan,
      status,
      renewsAt,
      email,
      customerId,
    });
  }

  // Best-effort audit. Don't block on failure.
  try {
    const ownerTeam = await env.UXINSPECT_DB.prepare(
      `SELECT id FROM teams WHERE polar_subscription_id = ?1 LIMIT 1`,
    )
      .bind(subId)
      .first<{ id: string }>();
    if (ownerTeam) {
      await insertAudit(env, {
        teamId: ownerTeam.id,
        action: `billing.${event.type}`,
        targetKind: 'subscription',
        targetId: subId,
        metadata: { plan, status, renewsAt },
      });
    }
  } catch {
    // swallow
  }

  return jsonResp({ ok: true, action: event.type });
}

function mapProductToPlan(name: string): Plan {
  const n = name.toLowerCase();
  if (n.includes('enterprise')) return 'enterprise';
  if (n.includes('team')) return 'team';
  if (n.includes('pro')) return 'pro';
  return 'pro';
}

function mapEventToStatus(type: string, rawStatus: string | undefined): TeamStatus | null {
  switch (type) {
    case 'subscription.created':
    case 'subscription.active':
      return 'active';
    case 'subscription.updated':
      if (rawStatus === 'active') return 'active';
      if (rawStatus === 'past_due') return 'past_due';
      if (rawStatus === 'cancelled' || rawStatus === 'canceled') return 'cancelled';
      return 'active';
    case 'subscription.cancelled':
    case 'subscription.canceled':
      return 'cancelled';
    case 'subscription.revoked':
      return 'revoked';
    default:
      return null;
  }
}

function parseIso(s: string | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

async function verifySignature(
  body: string,
  id: string,
  ts: string,
  sigHeader: string,
  secret: string,
): Promise<boolean> {
  if (!id || !ts || !sigHeader) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const toSign = `${id}.${ts}.${body}`;
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(toSign));
  const expected = b64encode(new Uint8Array(sig));

  const parts = sigHeader.split(/[ ,]+/).filter(Boolean);
  for (const p of parts) {
    const value = p.startsWith('v1,') || p.startsWith('v1=') ? p.slice(3) : p;
    if (timingSafeEqual(value, expected)) return true;
  }
  return false;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function b64encode(buf: Uint8Array): string {
  let s = '';
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
  return btoa(s);
}

function jsonResp(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
