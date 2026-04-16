import { useEffect, useState } from 'react';
import { history, type AnomalyRing, type TrendPoint } from '../api';
import { loadSession } from '../auth';
import { EmptyState } from '../components/EmptyState';
import { Loading, ErrorBlock } from '../components/Loading';
import { AnomalyRings } from '../components/AnomalyRings';
import { TrendChart } from '../components/TrendChart';

export function HistoryPage() {
  const session = loadSession()!;
  const [days, setDays] = useState(30);
  const [urlFilter, setUrlFilter] = useState('');
  const [appliedUrl, setAppliedUrl] = useState('');
  const [trend, setTrend] = useState<TrendPoint[] | null>(null);
  const [rings, setRings] = useState<AnomalyRing[]>([]);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let aborted = false;
    Promise.all([
      history.trend(session.teamId, { days, url: appliedUrl || undefined }),
      history.anomalies(session.teamId, { url: appliedUrl || undefined }),
    ])
      .then(([t, a]) => {
        if (aborted) return;
        setTrend(t);
        setRings(a);
      })
      .catch((err) => !aborted && setError(err));
    return () => {
      aborted = true;
    };
  }, [session.teamId, days, appliedUrl]);

  if (error) return <ErrorBlock error={error} />;

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-title">History</h2>
          <p className="page-subtitle">Trends and regressions over time</p>
        </div>
        <form
          className="flex gap-sm"
          onSubmit={(e) => {
            e.preventDefault();
            setAppliedUrl(urlFilter.trim());
          }}
          role="search"
          aria-label="Filter history"
        >
          <label className="sr-only" htmlFor="url-filter">
            Filter by URL
          </label>
          <input
            id="url-filter"
            className="input"
            type="text"
            placeholder="Filter by URL…"
            value={urlFilter}
            onChange={(e) => setUrlFilter(e.target.value)}
            style={{ width: 260 }}
          />
          <label className="sr-only" htmlFor="days">
            Window
          </label>
          <select
            id="days"
            className="team-select"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            aria-label="Window"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <button type="submit" className="btn btn-secondary">
            Apply
          </button>
        </form>
      </div>

      {rings.length > 0 && (
        <section style={{ marginBottom: 20 }} aria-label="Anomaly rings">
          <div className="card">
            <div className="card-header">
              <div>
                <h3 className="card-title">Anomalies vs baseline</h3>
                <p className="card-subtitle">Rings widen as a metric drifts</p>
              </div>
            </div>
            <div className="card-body">
              <AnomalyRings rings={rings} />
            </div>
          </div>
        </section>
      )}

      {!trend ? (
        <Loading />
      ) : trend.length === 0 ? (
        <EmptyState title="No history yet">
          Run <code>npx uxinspect run</code> a few times to build a trend line.
        </EmptyState>
      ) : (
        <div className="grid grid-2" style={{ gap: 20 }}>
          <div className="card card-body">
            <TrendChart points={trend} metric="durationMs" label="Duration (ms)" />
          </div>
          <div className="card card-body">
            <TrendChart points={trend} metric="a11y" label="A11y violations" />
          </div>
          <div className="card card-body">
            <TrendChart points={trend} metric="visualFails" label="Visual fails" />
          </div>
          <div className="card card-body">
            <TrendChart points={trend} metric="perf" label="Perf score" />
          </div>
        </div>
      )}
    </div>
  );
}
