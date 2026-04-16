import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { runs, type RunDetail, type Heatmap } from '../api';
import { loadSession } from '../auth';
import { Loading, ErrorBlock } from '../components/Loading';
import { StatusBadge, Badge } from '../components/Badge';
import { formatDuration, formatRelative } from '../format';
import { ExternalIcon } from '../components/Icons';

export function RunDetailPage() {
  const session = loadSession()!;
  const { runId } = useParams<{ runId: string }>();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!runId) return;
    let aborted = false;
    runs
      .get(session.teamId, runId)
      .then((r) => !aborted && setRun(r))
      .catch((err) => !aborted && setError(err));
    return () => {
      aborted = true;
    };
  }, [runId, session.teamId]);

  if (error) return <ErrorBlock error={error} />;
  if (!run) return <Loading />;

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-title">{run.url}</h2>
          <p className="page-subtitle">
            <StatusBadge status={run.status} /> · {formatRelative(run.startedAt)} ·{' '}
            {formatDuration(run.durationMs)}
            {run.branch ? ` · ${run.branch}` : ''}
            {run.commit ? ` @ ${run.commit.slice(0, 7)}` : ''}
            {run.actor ? ` · by ${run.actor}` : ''}
          </p>
        </div>
        <div className="flex gap-sm">
          <Link to="/runs" className="btn btn-ghost">
            ← Back
          </Link>
        </div>
      </div>

      {run.anomalies.length > 0 && (
        <section aria-label="Anomalies" style={{ marginBottom: 20 }}>
          {run.anomalies.map((a) => (
            <div
              key={a.id}
              className={`callout callout-${
                a.severity === 'fail' ? 'red' : a.severity === 'warn' ? 'amber' : 'blue'
              }`}
            >
              <div>
                <p className="callout-title">
                  {a.metric} · {a.severity}
                </p>
                <p className="callout-body">
                  {a.message} (baseline {a.baseline}, now {a.current}, {a.delta >= 0 ? '+' : ''}
                  {a.delta})
                </p>
              </div>
            </div>
          ))}
        </section>
      )}

      <section className="grid grid-4" aria-label="Run stats">
        <Stat label="Flows passed" value={`${run.flowsTotal - run.flowsFailed}/${run.flowsTotal}`} />
        <Stat label="A11y violations" value={String(run.a11yViolations)} />
        <Stat label="Visual fails" value={String(run.visualFails)} />
        <Stat label="Perf" value={run.perfScore !== undefined ? String(run.perfScore) : '—'} />
      </section>

      <section style={{ marginTop: 24 }} aria-label="Flows">
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Flows</h3>
            <p className="card-subtitle">{run.flows.length} flows</p>
          </div>
          {run.flows.length === 0 ? (
            <div className="card-body text-muted">No flows recorded.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Status</th>
                  <th scope="col">Flow</th>
                  <th scope="col">Steps</th>
                  <th scope="col">Duration</th>
                </tr>
              </thead>
              <tbody>
                {run.flows.map((f) => (
                  <tr key={f.id}>
                    <td>
                      <StatusBadge status={f.status} />
                    </td>
                    <td>{f.name}</td>
                    <td>{f.steps.length}</td>
                    <td>{formatDuration(f.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section style={{ marginTop: 24 }} aria-label="Audits">
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Audits</h3>
            <p className="card-subtitle">Accessibility, visual, performance</p>
          </div>
          {run.audits.length === 0 ? (
            <div className="card-body text-muted">No audits ran for this build.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Type</th>
                  <th scope="col">URL</th>
                  <th scope="col">Score</th>
                  <th scope="col">Violations</th>
                </tr>
              </thead>
              <tbody>
                {run.audits.map((a, i) => (
                  <tr key={`${a.type}-${i}`}>
                    <td>
                      <Badge tone="blue">{a.type}</Badge>
                    </td>
                    <td>{a.url}</td>
                    <td>{a.score ?? '—'}</td>
                    <td>{a.violations.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {run.heatmaps.length > 0 && (
        <section style={{ marginTop: 24 }} aria-label="Click heatmap">
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Click heatmap</h3>
              <p className="card-subtitle">Aggregated from recorded sessions</p>
            </div>
            <div className="card-body">
              {run.heatmaps.map((h) => (
                <HeatmapView key={h.url} heatmap={h} />
              ))}
            </div>
          </div>
        </section>
      )}

      <section style={{ marginTop: 24 }} aria-label="Replays">
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Replays</h3>
            <p className="card-subtitle">Session recordings for this run</p>
          </div>
          {run.replays.length === 0 ? (
            <div className="card-body text-muted">No replays captured.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Flow</th>
                  <th scope="col">Duration</th>
                  <th scope="col">Open</th>
                </tr>
              </thead>
              <tbody>
                {run.replays.map((rp) => (
                  <tr key={rp.id}>
                    <td>{rp.flowName ?? rp.id}</td>
                    <td>{formatDuration(rp.durationMs)}</td>
                    <td>
                      <Link to={`/replays?replay=${rp.id}`} className="btn btn-ghost">
                        Open <ExternalIcon />
                      </Link>
                    </td>
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

function HeatmapView({ heatmap }: { heatmap: Heatmap }) {
  if (!heatmap.clicks.length) {
    return <p className="text-muted text-sm">No click data for {heatmap.url}.</p>;
  }
  const max = Math.max(...heatmap.clicks.map((c) => c.n), 1);
  const aspect = heatmap.height / heatmap.width;
  return (
    <div>
      <p className="text-sm text-muted" style={{ marginTop: 0 }}>
        {heatmap.url} · {heatmap.clicks.length} unique positions
      </p>
      <div
        style={{
          position: 'relative',
          width: '100%',
          paddingTop: `${aspect * 100}%`,
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          background: heatmap.screenshot
            ? `url(${heatmap.screenshot}) center/cover no-repeat`
            : 'var(--surface-alt)',
          overflow: 'hidden',
        }}
        role="img"
        aria-label={`Click heatmap for ${heatmap.url}`}
      >
        <svg
          viewBox={`0 0 ${heatmap.width} ${heatmap.height}`}
          preserveAspectRatio="none"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
        >
          {heatmap.clicks.map((c, i) => {
            const intensity = c.n / max;
            return (
              <circle
                key={i}
                cx={c.x}
                cy={c.y}
                r={16 + intensity * 20}
                fill="#EF4444"
                fillOpacity={0.15 + intensity * 0.35}
              />
            );
          })}
        </svg>
      </div>
    </div>
  );
}
