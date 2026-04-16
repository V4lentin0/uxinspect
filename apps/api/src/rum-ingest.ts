/**
 * P7 #63 — RUM ingest endpoint.
 * POST /v1/ingest/rum — receives batched events from collector snippet.
 */

import type { Env } from './types.js';

const PLAN_LIMITS: Record<string, number> = { free: 1000, pro: 10000, team: 100000, enterprise: 1000000 };
const MAX_BATCH_BYTES = 1_048_576; // 1MB

interface RumEvent {
  type: string;
  timestamp: number;
  sessionId: string;
  pageUrl?: string;
  data?: unknown;
}

export async function handleRumIngest(
  req: Request,
  env: Env,
): Promise<Response> {
  const siteId = req.headers.get('x-site-id');
  if (!siteId) return json({ ok: false, error: 'missing_site_id' }, 400);

  // Validate site token
  const site = await env.DB.prepare(
    'SELECT team_id, plan FROM site_tokens WHERE site_id = ?1',
  ).bind(siteId).first<{ team_id: string; plan: string }>();
  if (!site) return json({ ok: false, error: 'invalid_site_id' }, 401);

  // Size check
  const len = parseInt(req.headers.get('content-length') || '0', 10);
  if (len > MAX_BATCH_BYTES) return json({ ok: false, error: 'payload_too_large' }, 413);

  // Daily rate limit
  const today = new Date().toISOString().slice(0, 10);
  const usage = await env.DB.prepare(
    'SELECT count FROM rum_daily_usage WHERE site_id = ?1 AND day = ?2',
  ).bind(siteId, today).first<{ count: number }>();
  const currentCount = usage?.count ?? 0;
  const limit = PLAN_LIMITS[site.plan] ?? PLAN_LIMITS.free;
  if (currentCount >= limit) return json({ ok: false, error: 'daily_limit_exceeded', limit }, 429);

  const raw = await req.text();
  if (raw.length > MAX_BATCH_BYTES) return json({ ok: false, error: 'payload_too_large' }, 413);

  let events: RumEvent[];
  try {
    events = JSON.parse(raw);
    if (!Array.isArray(events)) return json({ ok: false, error: 'expected_array' }, 400);
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  // IP anonymization
  const ip = req.headers.get('cf-connecting-ip') || '';
  const ipAnon = anonymizeIp(ip);

  let inserted = 0;
  for (const evt of events.slice(0, 500)) {
    const id = crypto.randomUUID();
    const hash = await hashEvent(siteId, evt);
    const dataJson = evt.data ? JSON.stringify(evt.data) : null;

    try {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO rum_events (id, site_id, session_id, type, page_url, data_json, ip_anon, event_hash, timestamp)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      ).bind(id, siteId, evt.sessionId || '', evt.type, evt.pageUrl || '', dataJson, ipAnon, hash, evt.timestamp || Date.now()).run();
      inserted++;
    } catch {
      // Dedup or other error — skip
    }

    // Upsert session
    if (evt.sessionId) {
      await env.DB.prepare(
        `INSERT INTO rum_sessions (id, site_id, session_id, started_at, last_event_at, event_count)
         VALUES (?1, ?2, ?3, datetime('now'), datetime('now'), 1)
         ON CONFLICT(session_id) DO UPDATE SET last_event_at = datetime('now'), event_count = event_count + 1`,
      ).bind(crypto.randomUUID(), siteId, evt.sessionId).run();
    }

    // rrweb events → R2
    if (evt.type === 'rrweb' && evt.data && env.REPLAYS) {
      const key = `rum/${siteId}/${evt.sessionId}/replay.ndjson`;
      const existing = await env.REPLAYS.get(key);
      const prev = existing ? await existing.text() : '';
      await env.REPLAYS.put(key, prev + JSON.stringify(evt.data) + '\n');

      // Update session replay key
      await env.DB.prepare(
        'UPDATE rum_sessions SET replay_r2_key = ?1 WHERE session_id = ?2',
      ).bind(key, evt.sessionId).run();
    }
  }

  // Bump daily usage
  await env.DB.prepare(
    `INSERT INTO rum_daily_usage (site_id, day, count) VALUES (?1, ?2, ?3)
     ON CONFLICT(site_id, day) DO UPDATE SET count = count + ?3`,
  ).bind(siteId, today, inserted).run();

  return json({ ok: true, inserted, total: events.length }, 200);
}

function anonymizeIp(ip: string): string {
  if (ip.includes(':')) {
    // IPv6: zero last 80 bits (keep first 48)
    const parts = ip.split(':');
    return parts.slice(0, 3).join(':') + '::';
  }
  // IPv4: zero last octet
  const parts = ip.split('.');
  if (parts.length === 4) {
    parts[3] = '0';
    return parts.join('.');
  }
  return '';
}

async function hashEvent(siteId: string, evt: RumEvent): Promise<string> {
  const input = `${siteId}:${evt.sessionId}:${evt.type}:${evt.timestamp}:${JSON.stringify(evt.data || '')}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'x-site-id, content-type',
    },
  });
}
