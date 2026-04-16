import { useEffect, useState, useCallback, type ReactNode } from 'react';
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { auth, teams as teamsApi, type Team } from '../api';
import { clearSession, loadSession, setActiveTeam } from '../auth';

interface LayoutProps {
  /** Optional children; if omitted, renders <Outlet/> from react-router. */
  children?: ReactNode;
}

function pageTitleFromPath(pathname: string): string {
  if (pathname === '/' || pathname === '') return 'Overview';
  if (pathname.startsWith('/runs')) return 'Runs';
  if (pathname.startsWith('/history')) return 'History';
  if (pathname.startsWith('/replays')) return 'Replays';
  if (pathname.startsWith('/settings')) return 'Settings';
  if (pathname.startsWith('/billing')) return 'Billing';
  return 'uxinspect';
}

export function Layout({ children }: LayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [session, setSession] = useState(() => loadSession());
  const [teamList, setTeamList] = useState<Team[] | null>(null);

  // Refresh team list once per mount; used for the team switcher.
  useEffect(() => {
    if (!session) return;
    let aborted = false;
    teamsApi
      .list()
      .then((list) => {
        if (!aborted) setTeamList(list);
      })
      .catch(() => {
        // silent — topbar still shows the stored team name.
      });
    return () => {
      aborted = true;
    };
  }, [session?.userId]);

  // Keep the local session fresh if another tab changed it.
  useEffect(() => {
    const onStorage = () => {
      const next = loadSession();
      if (!next) {
        setSession(null);
        navigate('/login', { replace: true });
      } else {
        setSession(next);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [navigate]);

  const onSignOut = useCallback(async () => {
    try {
      await auth.signOut();
    } catch {
      // ignore; we clear locally regardless.
    }
    clearSession();
    setSession(null);
    navigate('/login', { replace: true });
  }, [navigate]);

  const onTeamChange = useCallback(
    (teamId: string) => {
      const t = teamList?.find((x) => x.id === teamId);
      if (!t || !session) return;
      setActiveTeam(t.id, t.name);
      const next = loadSession();
      setSession(next);
      // Force a route re-render so pages reload data for the new team.
      navigate(location.pathname, { replace: true });
    },
    [teamList, session, navigate, location.pathname],
  );

  if (!session) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return (
    <div className="shell">
      <Sidebar session={session} onSignOut={onSignOut} />
      <div className="main">
        <header className="topbar">
          <h1 className="topbar-title">{pageTitleFromPath(location.pathname)}</h1>
          <div className="topbar-right">
            {teamList && teamList.length > 1 ? (
              <label className="sr-only" htmlFor="team-switch">
                Active team
              </label>
            ) : null}
            {teamList && teamList.length > 1 ? (
              <select
                id="team-switch"
                className="team-select"
                value={session.teamId}
                onChange={(e) => onTeamChange(e.target.value)}
                aria-label="Switch team"
              >
                {teamList.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        </header>
        <main className="content" role="main" id="main-content">
          {children ?? <Outlet />}
        </main>
      </div>
    </div>
  );
}
