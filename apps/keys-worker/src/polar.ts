/**
 * Polar.sh webhook → KV translator.
 *
 * Polar sends one JSON body per event. We only care about three types,
 * all tied to the customer's license key (stored in order metadata):
 *   - subscription.created   → upsert LICENSES[key] active
 *   - subscription.updated   → update expiry / plan / status
 *   - subscription.cancelled → mark status=cancelled, keep expiresAt
 */

export interface LicenseRecord {
  plan: string;
  customer: string;
  expiresAt: number; // seconds since epoch
  status: 'active' | 'cancelled' | 'expired' | 'past_due';
  polarSubId: string;
  createdAt: number;
  updatedAt: number;
}

export interface PolarEvent {
  type: string;
  data: {
    id?: string;
    status?: string;
    current_period_end?: string | number;
    current_period_start?: string | number;
    cancel_at_period_end?: boolean;
    ended_at?: string | number | null;
    customer?: { id?: string; email?: string };
    product?: { id?: string; name?: string };
    metadata?: Record<string, string>;
  };
}

function toEpochSeconds(v: string | number | null | undefined): number {
  if (v == null) return 0;
  if (typeof v === 'number') return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

/** Extract the uxinspect license key from Polar event metadata. */
export function extractKey(event: PolarEvent): string | null {
  const meta = event.data.metadata ?? {};
  const k = meta.license_key ?? meta.licenseKey ?? meta.key;
  return typeof k === 'string' && k.length > 0 ? k : null;
}

function planFromProduct(event: PolarEvent): string {
  const name = event.data.product?.name?.toLowerCase() ?? '';
  if (name.includes('enterprise')) return 'enterprise';
  if (name.includes('team')) return 'team';
  return 'pro';
}

function statusFrom(event: PolarEvent, fallback: LicenseRecord['status']): LicenseRecord['status'] {
  const s = event.data.status?.toLowerCase();
  if (s === 'active' || s === 'trialing') return 'active';
  if (s === 'cancelled' || s === 'canceled') return 'cancelled';
  if (s === 'past_due' || s === 'unpaid') return 'past_due';
  if (s === 'expired' || s === 'ended') return 'expired';
  return fallback;
}

/**
 * Apply a Polar event to the KV namespace.
 * Returns the resulting record, or null if the event was ignored.
 */
export async function applyPolarEvent(
  event: PolarEvent,
  kv: KVNamespace,
): Promise<LicenseRecord | null> {
  const key = extractKey(event);
  if (!key) return null;

  const now = Math.floor(Date.now() / 1000);
  const previousRaw = await kv.get(key);
  const previous: LicenseRecord | null = previousRaw ? JSON.parse(previousRaw) : null;

  const expiresAt = toEpochSeconds(event.data.current_period_end) || previous?.expiresAt || 0;
  const customer = event.data.customer?.id ?? event.data.customer?.email ?? previous?.customer ?? '';
  const polarSubId = event.data.id ?? previous?.polarSubId ?? '';

  let record: LicenseRecord;
  switch (event.type) {
    case 'subscription.created':
      record = {
        plan: planFromProduct(event),
        customer,
        expiresAt,
        status: statusFrom(event, 'active'),
        polarSubId,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
      break;
    case 'subscription.updated':
      if (!previous) {
        record = {
          plan: planFromProduct(event),
          customer,
          expiresAt,
          status: statusFrom(event, 'active'),
          polarSubId,
          createdAt: now,
          updatedAt: now,
        };
      } else {
        record = {
          ...previous,
          plan: planFromProduct(event) || previous.plan,
          customer,
          expiresAt: expiresAt || previous.expiresAt,
          status: statusFrom(event, previous.status),
          polarSubId,
          updatedAt: now,
        };
      }
      break;
    case 'subscription.cancelled':
    case 'subscription.canceled':
      if (!previous) return null;
      record = {
        ...previous,
        status: 'cancelled',
        expiresAt: toEpochSeconds(event.data.ended_at) || previous.expiresAt,
        updatedAt: now,
      };
      break;
    default:
      return null;
  }

  await kv.put(key, JSON.stringify(record));
  return record;
}
