import { useEffect, useState } from 'react';
import { billing, type Invoice, type Subscription } from '../api';
import { loadSession } from '../auth';
import { Loading, ErrorBlock } from '../components/Loading';
import { Badge } from '../components/Badge';
import { EmptyState } from '../components/EmptyState';
import { formatMoney, formatRelative } from '../format';

const PLAN_ORDER: Subscription['plan'][] = ['free', 'pro', 'team', 'enterprise'];
const PLAN_LABEL: Record<Subscription['plan'], string> = {
  free: 'Free',
  pro: 'Pro',
  team: 'Team',
  enterprise: 'Enterprise',
};

export function BillingPage() {
  const session = loadSession()!;
  const [sub, setSub] = useState<Subscription | null>(null);
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [portalLoading, setPortalLoading] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState<Subscription['plan'] | null>(null);

  useEffect(() => {
    let aborted = false;
    Promise.all([
      billing.subscription(session.teamId),
      billing.invoices(session.teamId),
    ])
      .then(([s, inv]) => {
        if (aborted) return;
        setSub(s);
        setInvoices(inv);
      })
      .catch((err) => !aborted && setError(err));
    return () => {
      aborted = true;
    };
  }, [session.teamId]);

  async function openPortal() {
    setPortalLoading(true);
    try {
      const { url } = await billing.portal(session.teamId);
      window.location.href = url;
    } catch (err) {
      setError(err);
    } finally {
      setPortalLoading(false);
    }
  }

  async function upgrade(plan: Subscription['plan']) {
    setCheckoutLoading(plan);
    try {
      const { url } = await billing.checkout(session.teamId, plan);
      window.location.href = url;
    } catch (err) {
      setError(err);
    } finally {
      setCheckoutLoading(null);
    }
  }

  if (error) return <ErrorBlock error={error} />;
  if (!sub || !invoices) return <Loading />;

  const currentIdx = PLAN_ORDER.indexOf(sub.plan);
  const upgradeOptions = PLAN_ORDER.slice(currentIdx + 1);

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-title">Billing</h2>
          <p className="page-subtitle">Subscription, seats, invoices</p>
        </div>
      </div>

      <section className="card" style={{ marginBottom: 20 }} aria-labelledby="plan-h">
        <div className="card-header">
          <h3 id="plan-h" className="card-title">
            Current plan
          </h3>
          <Badge tone={sub.status === 'active' ? 'green' : sub.status === 'past_due' ? 'red' : 'muted'}>
            {sub.status}
          </Badge>
        </div>
        <div className="card-body grid grid-3">
          <div>
            <div className="stat-label">Plan</div>
            <div className="stat-value">{PLAN_LABEL[sub.plan]}</div>
            <div className="stat-sub">
              {formatMoney(sub.amountCents, sub.currency)} / month
            </div>
          </div>
          <div>
            <div className="stat-label">Seats</div>
            <div className="stat-value">
              {sub.seatsUsed}
              <span className="text-muted text-sm"> / {sub.seats}</span>
            </div>
            <div className="stat-sub">
              {sub.seatsUsed >= sub.seats ? 'At limit' : `${sub.seats - sub.seatsUsed} remaining`}
            </div>
          </div>
          <div>
            <div className="stat-label">Renews</div>
            <div className="stat-value" style={{ fontSize: 16 }}>
              {sub.renewsAt ? formatRelative(sub.renewsAt) : '—'}
            </div>
            {sub.canceledAt ? (
              <div className="stat-sub stat-trend-down">
                Canceled {formatRelative(sub.canceledAt)}
              </div>
            ) : null}
          </div>
        </div>
        <div className="card-body" style={{ borderTop: '1px solid var(--border)', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn" onClick={openPortal} disabled={portalLoading}>
            {portalLoading ? 'Opening…' : 'Manage subscription'}
          </button>
          {upgradeOptions.map((p) => (
            <button
              key={p}
              type="button"
              className="btn btn-primary"
              onClick={() => upgrade(p)}
              disabled={checkoutLoading === p}
            >
              {checkoutLoading === p ? 'Redirecting…' : `Upgrade to ${PLAN_LABEL[p]}`}
            </button>
          ))}
        </div>
      </section>

      <section className="card" aria-labelledby="inv-h">
        <div className="card-header">
          <h3 id="inv-h" className="card-title">
            Invoices
          </h3>
          <p className="card-subtitle">{invoices.length} total</p>
        </div>
        {invoices.length === 0 ? (
          <div className="card-body">
            <EmptyState title="No invoices yet">
              Your first invoice will appear here once your plan renews.
            </EmptyState>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Number</th>
                <th scope="col">Issued</th>
                <th scope="col">Amount</th>
                <th scope="col">Status</th>
                <th scope="col" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id}>
                  <td className="mono">{inv.number}</td>
                  <td>{formatRelative(inv.issuedAt)}</td>
                  <td>{formatMoney(inv.amountCents, inv.currency)}</td>
                  <td>
                    {inv.status === 'paid' ? (
                      <Badge tone="green">Paid</Badge>
                    ) : inv.status === 'open' ? (
                      <Badge tone="amber">Open</Badge>
                    ) : (
                      <Badge tone="muted">Void</Badge>
                    )}
                  </td>
                  <td>
                    {inv.downloadUrl ? (
                      <a
                        href={inv.downloadUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn btn-ghost"
                      >
                        Download
                      </a>
                    ) : (
                      <span className="text-muted text-sm">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
