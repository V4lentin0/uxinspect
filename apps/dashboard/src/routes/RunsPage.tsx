import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { runs, type RunSummary } from '../api';
import { loadSession } from '../auth';
import { EmptyState } from '../components/EmptyState';
import { Loading, ErrorBlock } from '../components/Loading';
import { StatusBadge } from '../components/Badge';
import { formatDuration, formatRelative } from '../format';

export function RunsPage() {
  const session = loadSession()!;
  const [items, setItems] = useState<RunSummary[] | null>(null);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let aborted = false;
    runs
      .list(session.teamId, { limit: 50 })
      .then((res) => {
        if (aborted) return;
        setItems(res.items);
        setCursor(res.cursor);
      })
      .catch((err) => !aborted && setError(err));
    return () => {
      aborted = true;
    };
  }, [session.teamId]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await runs.list(session.teamId, { limit: 50, cursor });
      setItems((prev) => (prev ? [...prev, ...res.items] : res.items));
      setCursor(res.cursor);
    } catch (err) {
      setError(err);
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, session.teamId]);

  if (error) return <ErrorBlock error={error} />;
  if (!items) return <Loading />;

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-title">Runs</h2>
          <p className="page-subtitle">Every run uploaded to this workspace</p>
        </div>
      </div>

      {items.length === 0 ? (
        <EmptyState title="No runs yet">
          Run <code>npx uxinspect run</code> to create your first report.
        </EmptyState>
      ) : (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">URL</th>
                <th scope="col">Branch</th>
                <th scope="col">Started</th>
                <th scope="col">Duration</th>
                <th scope="col">Flows</th>
                <th scope="col">A11y</th>
                <th scope="col">Visual</th>
                <th scope="col">Perf</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id}>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                  <td>
                    <Link to={`/runs/${r.id}`}>{r.url}</Link>
                  </td>
                  <td className="mono text-sm text-muted">
                    {r.branch ?? '—'}
                    {r.commit ? ` @ ${r.commit.slice(0, 7)}` : ''}
                  </td>
                  <td>{formatRelative(r.startedAt)}</td>
                  <td>{formatDuration(r.durationMs)}</td>
                  <td>
                    {r.flowsTotal - r.flowsFailed}/{r.flowsTotal}
                  </td>
                  <td>{r.a11yViolations}</td>
                  <td>{r.visualFails}</td>
                  <td>{r.perfScore ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {cursor && (
        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <button type="button" className="btn" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}
