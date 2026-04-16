import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { runs, history, type RunSummary, type AnomalyRing } from '../api';
import { loadSession } from '../auth';
import { EmptyState } from '../components/EmptyState';
import { Loading, ErrorBlock } from '../components/Loading';
import { StatusBadge } from '../components/Badge';
import { AnomalyRings } from '../components/AnomalyRings';
import { formatDuration, formatRelative } from '../format';

interface Summary {
  total: number;
  passed: number;
  failed: number;
  running: number;
  a11yTotal: number;
  perfAvg: number | null;
  anomalies: {
    id: string;
    metric: string;
    severity: 'info' | 'warn' | 'fail';
    message: string;
  }[];
}

export function DashboardPage() {
  const session = loadSession()!; // Layout guarantees auth.
  const [recent, setRecent] = useState<RunSummary[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [rings, setRings] = useState<AnomalyRing[]>([]);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let aborted = false;
    Promise.all([
      runs.list(session.teamId, { limit: 10 }),
      runs.summary(session.teamId),
      history.anomalies(session.teamId),
    ])
      .then(([list, sum, anomalyRings]) => {
        if (aborted) return;
        setRecent(list.items);
        setSummary(sum);
        setRings(anomalyRings);
      })
      .catch((err) => !aborted && setError(err));
    return () => {
      aborted = true;
    };
  }, [session.teamId]);

  if (error) return <ErrorBlock error={error} />;
  if (!recent || !summary) return <Loading />;

  const passRate = summary.total ? Math.round((summary.passed / summary.total) * 100) : null;

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-title">Overview</h2>
          <p className="page-subtitle">
            {session.teamName} · last {summary.total} runs
          </p>
        </div>
      </div>

      {summary.anomalies.length > 0 && (
        <div role="region" aria-label="Anomaly callouts" style={{ marginBottom: 20 }}>
          {summary.anomalies.slice(0, 3).map((a) => (
            <div
              key={a.id}
              className={`callout callout-${
                a.severity === 'fail' ? 'red' : a.severity === 'warn' ? 'amber' : 'blue'
              }`}
            >
              <div>
                <p className="callout-title">{a.metric} anomaly</p>
                <p className="callout-body">{a.message}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      <section className="grid grid-4" aria-label="Run summary">
        <StatTile label="Pass rate" value={passRate !== null ? `${passRate}%` : '—'} sub={`${summary.passed}/${summary.total} passed`} />
        <StatTile label="Failed" value={String(summary.failed)} sub="last 50 runs" tone={summary.failed ? 'down' : undefined} />
        <StatTile label="A11y violations" value={String(summary.a11yTotal)} sub="sum across runs" />
        <StatTile label="Perf (avg)" value={summary.perfAvg !== null ? String(summary.perfAvg) : '—'} sub="Lighthouse score" />
      </section>

      {rings.length > 0 && (
        <section style={{ marginTop: 24 }} aria-label="Anomaly rings">
          <div className="card">
            <div className="card-header">
              <div>
                <h3 className="card-title">Regressions vs baseline</h3>
                <p className="card-subtitle">Metrics drifting outside the acceptable band</p>
              </div>
            </div>
            <div className="card-body">
              <AnomalyRings rings={rings} />
            </div>
          </div>
        </section>
      )}

      <section style={{ marginTop: 24 }} aria-label="Recent runs">
        <div className="card">
          <div className="card-header">
            <div>
              <h3 className="card-title">Recent runs</h3>
              <p className="card-subtitle">Latest 10</p>
            </div>
            <Link to="/runs" className="btn btn-ghost">
              View all
            </Link>
          </div>
          {recent.length === 0 ? (
            <div className="card-body">
              <EmptyState title="No runs yet">
                Run <code>npx uxinspect run</code> to create your first report.
              </EmptyState>
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Status</th>
                  <th scope="col">URL</th>
                  <th scope="col">Started</th>
                  <th scope="col">Duration</th>
                  <th scope="col">Flows</th>
                  <th scope="col">A11y</th>
                  <th scope="col">Visual</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <StatusBadge status={r.status} />
                    </td>
                    <td>
                      <Link to={`/runs/${r.id}`} title={r.url}>
                        {truncate(r.url, 40)}
                      </Link>
                    </td>
                    <td>{formatRelative(r.startedAt)}</td>
                    <td>{formatDuration(r.durationMs)}</td>
                    <td>
                      {r.flowsTotal - r.flowsFailed}/{r.flowsTotal}
                    </td>
                    <td>{r.a11yViolations}</td>
                    <td>{r.visualFails}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}

function StatTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'up' | 'down';
}) {
  return (
    <div className="card stat">
      <div className="stat-label">{label}</div>
      <div
        className="stat-value"
        style={tone === 'down' ? { color: 'var(--red)' } : undefined}
      >
        {value}
      </div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  );
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
