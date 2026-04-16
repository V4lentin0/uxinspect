import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { replays, type ReplayListItem } from '../api';
import { loadSession } from '../auth';
import { EmptyState } from '../components/EmptyState';
import { Loading, ErrorBlock } from '../components/Loading';
import { formatDuration, formatRelative } from '../format';

export function ReplaysPage() {
  const session = loadSession()!;
  const [searchParams, setSearchParams] = useSearchParams();
  const activeId = searchParams.get('replay');
  const [items, setItems] = useState<ReplayListItem[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let aborted = false;
    replays
      .list(session.teamId, { limit: 50 })
      .then((res) => !aborted && setItems(res.items))
      .catch((err) => !aborted && setError(err));
    return () => {
      aborted = true;
    };
  }, [session.teamId]);

  const active = useMemo(
    () => (activeId && items ? items.find((x) => x.id === activeId) ?? null : null),
    [activeId, items],
  );

  if (error) return <ErrorBlock error={error} />;
  if (!items) return <Loading />;

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-title">Replays</h2>
          <p className="page-subtitle">Recorded user sessions captured during runs</p>
        </div>
      </div>

      {items.length === 0 ? (
        <EmptyState title="No replays captured">
          Run <code>npx uxinspect run --record</code> to capture session replays.
        </EmptyState>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: '320px 1fr', gap: 20 }}>
          <aside className="card" aria-label="Replay list">
            <ul style={{ listStyle: 'none', margin: 0, padding: 8 }}>
              {items.map((it) => {
                const isActive = active?.id === it.id;
                return (
                  <li key={it.id}>
                    <button
                      type="button"
                      className="nav-link"
                      style={{
                        width: '100%',
                        background: isActive ? 'var(--green-bg)' : 'transparent',
                        color: isActive ? 'var(--green)' : 'var(--text)',
                        border: 'none',
                        textAlign: 'left',
                      }}
                      onClick={() => setSearchParams({ replay: it.id })}
                      aria-current={isActive ? 'true' : undefined}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div
                          style={{
                            fontWeight: 500,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {it.url}
                        </div>
                        <div className="text-sm text-muted">
                          {formatRelative(it.recordedAt)} · {formatDuration(it.durationMs)}
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>

          <section className="card" aria-label="Replay viewer">
            {active ? (
              <>
                <div className="card-header">
                  <div>
                    <h3 className="card-title">{active.url}</h3>
                    <p className="card-subtitle">
                      {formatRelative(active.recordedAt)} ·{' '}
                      {formatDuration(active.durationMs)}
                    </p>
                  </div>
                </div>
                <div className="card-body" style={{ padding: 0 }}>
                  <iframe
                    title={`Replay ${active.id}`}
                    src={active.embedUrl}
                    className="replay-frame"
                    sandbox="allow-scripts allow-same-origin"
                    referrerPolicy="no-referrer"
                  />
                </div>
              </>
            ) : (
              <div className="card-body">
                <EmptyState title="Select a replay">
                  Pick a session from the list to embed the replay viewer here.
                </EmptyState>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
