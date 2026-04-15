// Polar.sh subscription webhook handler.
//
// Polar signs webhooks with HMAC-SHA256 using the configured webhook secret.
// Header: webhook-signature (Standard Webhooks spec, comma-separated `v1,<b64>`).
// Reference: https://docs.polar.sh/integrate/webhooks/endpoints
//
// Events handled:
//   subscription.created   -> issue new license key, store record, return 200
//   subscription.updated   -> update plan / status / renewsAt
//   subscription.cancelled -> mark status = cancelled
//   subscription.revoked   -> mark status = revoked
//   order.created          -> ignored (we key off subscription events)

import type { Env, LicenseRecord } from './index.js';

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

export async function handlePolarWebhook(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.POLAR_WEBHOOK_SECRET) return new Response('webhook secret not configured', { status: 500 });

  const raw = await req.text();
  const sigHeader = req.headers.get('webhook-signature') ?? req.headers.get('polar-signature') ?? '';
  const tsHeader = req.headers.get('webhook-timestamp') ?? '';
  const idHeader = req.headers.get('webhook-id') ?? '';

  const ok = await verifyPolarSignature(raw, sigHeader, tsHeader, idHeader, env.POLAR_WEBHOOK_SECRET);
  if (!ok) return new Response('invalid signature', { status: 401 });

  let event: PolarWebhookEvent;
  try {
    event = JSON.parse(raw) as PolarWebhookEvent;
  } catch {
    return new Response('invalid json', { status: 400 });
  }

  const data = event.data ?? {};
  const subId = data.id;
  if (!subId) return new Response('missing subscription id', { status: 400 });

  const email = data.customer?.email ?? '';
  const productName = data.product?.name?.toLowerCase() ?? '';
  const plan = mapProductToPlan(productName, data.product_id);

  // Look up existing license bound to this subscription.
  const existingKey = await findKeyForSubscription(env, subId);

  switch (event.type) {
    case 'subscription.created':
    case 'subscription.active': {
      if (existingKey) {
        const rec = await readRecord(env, existingKey);
        if (rec) {
          rec.status = 'active';
          rec.plan = plan;
          rec.renewsAt = data.current_period_end;
          await env.KEYS.put(existingKey, JSON.stringify(rec));
        }
        return Response.json({ ok: true, key: existingKey, action: 'reactivated' });
      }
      const newKey = generateLicenseKey(plan);
      const rec: LicenseRecord = {
        plan,
        status: 'active',
        email,
        polarSubscriptionId: subId,
        polarCustomerId: data.customer_id ?? data.customer?.id,
        createdAt: new Date().toISOString(),
        renewsAt: data.current_period_end,
        fingerprints: [],
      };
      await env.KEYS.put(newKey, JSON.stringify(rec));
      await env.KEYS.put(`sub:${subId}`, newKey);
      // ctx.waitUntil keeps the response fast while delivery happens in background.
      ctx.waitUntil(deliverNewKeyToCustomer(env, email, newKey, plan));
      return Response.json({ ok: true, key: newKey, action: 'created' });
    }
    case 'subscription.updated': {
      if (!existingKey) return Response.json({ ok: true, action: 'noop_unknown' });
      const rec = await readRecord(env, existingKey);
      if (!rec) return Response.json({ ok: true, action: 'noop_missing' });
      rec.plan = plan;
      rec.status = data.status === 'active' ? 'active' : (data.status as LicenseRecord['status']) ?? rec.status;
      rec.renewsAt = data.current_period_end ?? rec.renewsAt;
      await env.KEYS.put(existingKey, JSON.stringify(rec));
      return Response.json({ ok: true, key: existingKey, action: 'updated' });
    }
    case 'subscription.cancelled':
    case 'subscription.canceled': {
      if (!existingKey) return Response.json({ ok: true, action: 'noop_unknown' });
      const rec = await readRecord(env, existingKey);
      if (!rec) return Response.json({ ok: true, action: 'noop_missing' });
      rec.status = 'cancelled';
      await env.KEYS.put(existingKey, JSON.stringify(rec));
      return Response.json({ ok: true, key: existingKey, action: 'cancelled' });
    }
    case 'subscription.revoked': {
      if (!existingKey) return Response.json({ ok: true, action: 'noop_unknown' });
      const rec = await readRecord(env, existingKey);
      if (!rec) return Response.json({ ok: true, action: 'noop_missing' });
      rec.status = 'revoked';
      rec.revokedAt = new Date().toISOString();
      await env.KEYS.put(existingKey, JSON.stringify(rec));
      return Response.json({ ok: true, key: existingKey, action: 'revoked' });
    }
    default:
      return Response.json({ ok: true, action: 'ignored', type: event.type });
  }
}

async function readRecord(env: Env, key: string): Promise<LicenseRecord | null> {
  const raw = await env.KEYS.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LicenseRecord;
  } catch {
    return null;
  }
}

async function findKeyForSubscription(env: Env, subId: string): Promise<string | null> {
  return env.KEYS.get(`sub:${subId}`);
}

function mapProductToPlan(name: string, _productId: string | undefined): LicenseRecord['plan'] {
  if (name.includes('enterprise')) return 'enterprise';
  if (name.includes('team')) return 'team';
  if (name.includes('pro')) return 'pro';
  // Fallback: assume Pro tier when unknown.
  return 'pro';
}

// Generate a license key in the form ux_<plan>_<24-char-base32>.
function generateLicenseKey(plan: LicenseRecord['plan']): string {
  const bytes = new Uint8Array(15);
  crypto.getRandomValues(bytes);
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // base32 (no I/O/0/1)
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return `ux_${plan}_${out.slice(0, 24)}`;
}

// Polar / Standard Webhooks: sign(timestamp + '.' + id + '.' + body) with HMAC-SHA256.
async function verifyPolarSignature(
  body: string,
  sigHeader: string,
  ts: string,
  id: string,
  secret: string,
): Promise<boolean> {
  if (!sigHeader || !ts || !id) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const toSign = `${id}.${ts}.${body}`;
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(toSign));
  const expected = b64encode(new Uint8Array(sig));

  // Header may contain multiple comma-separated `v1,<sig>` entries.
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

// Email delivery hook. In production this would call Resend / Cloudflare Email Routing.
// For now we POST to Polar's API to attach the key as customer metadata so the user can
// retrieve it from the Polar customer portal. This is best-effort and never blocks the webhook ack.
async function deliverNewKeyToCustomer(
  env: Env,
  email: string,
  key: string,
  plan: LicenseRecord['plan'],
): Promise<void> {
  if (!env.POLAR_API_TOKEN) return;
  try {
    // Polar customer-meta endpoint. If the token is missing or call fails, swallow silently.
    await fetch('https://api.polar.sh/v1/customers/upsert', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.POLAR_API_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        email,
        metadata: { uxinspect_license_key: key, uxinspect_plan: plan },
      }),
    });
  } catch {
    // best effort
  }
}
