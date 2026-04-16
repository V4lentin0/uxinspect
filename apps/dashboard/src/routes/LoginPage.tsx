import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { auth, teams as teamsApi, ApiError, type Team } from '../api';
import { loadSession, saveSession } from '../auth';
import { LogoMark } from '../components/Icons';
import { ErrorBlock } from '../components/Loading';

type Stage = 'email' | 'sent' | 'confirming' | 'team-picker' | 'error';

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const confirmToken = searchParams.get('token');

  const [stage, setStage] = useState<Stage>(confirmToken ? 'confirming' : 'email');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [pendingUser, setPendingUser] = useState<{ id: string; email: string } | null>(null);
  const [pendingExpiresAt, setPendingExpiresAt] = useState<number | null>(null);

  // If already signed in, punt straight to the dashboard.
  useEffect(() => {
    if (!confirmToken && loadSession()) {
      const state = location.state as { from?: { pathname?: string } } | null;
      const from = state?.from?.pathname ?? '/';
      navigate(from, { replace: true });
    }
  }, [confirmToken, location.state, navigate]);

  // Magic-link confirm flow (user clicked link in email).
  useEffect(() => {
    if (!confirmToken) return;
    let aborted = false;
    auth
      .confirmMagicLink(confirmToken)
      .then((res) => {
        if (aborted) return;
        setPendingUser(res.user);
        setPendingExpiresAt(res.expiresAt);
        // If token arrived in body (fallback) remember it.
        if (res.token) {
          // We can't save a final session yet — team not chosen. Stash in memory.
          sessionStorage.setItem('uxinspect.pending.bearer', res.token);
        }
        if (res.teams.length === 1) {
          commitSession(res.user, res.teams[0], res.expiresAt);
        } else if (res.teams.length === 0) {
          setError('This account has no team yet. Ask your team owner for an invite.');
          setStage('error');
        } else {
          setTeams(res.teams);
          setStage('team-picker');
        }
      })
      .catch((err: unknown) => {
        if (aborted) return;
        const msg =
          err instanceof ApiError
            ? err.status === 410
              ? 'This magic link has expired. Request a new one.'
              : err.message
            : err instanceof Error
              ? err.message
              : 'Could not confirm sign-in.';
        setError(msg);
        setStage('error');
      });
    return () => {
      aborted = true;
    };
  }, [confirmToken]);

  async function onRequestLink(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await auth.requestMagicLink(email.trim().toLowerCase());
      setStage('sent');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not send magic link.');
    } finally {
      setSubmitting(false);
    }
  }

  function commitSession(
    user: { id: string; email: string },
    team: Team,
    expiresAt: number,
  ) {
    const bearer = sessionStorage.getItem('uxinspect.pending.bearer') ?? undefined;
    sessionStorage.removeItem('uxinspect.pending.bearer');
    saveSession(
      {
        email: user.email,
        userId: user.id,
        teamId: team.id,
        teamName: team.name,
        expiresAt,
      },
      bearer,
    );
    navigate('/', { replace: true });
  }

  async function onPickTeam(teamId: string) {
    if (!pendingUser || !pendingExpiresAt) return;
    const team = teams?.find((t) => t.id === teamId);
    if (!team) return;
    try {
      // Confirm the team picked (server records active team for this session).
      const fresh = await teamsApi.get(teamId).catch(() => team);
      commitSession(pendingUser, fresh, pendingExpiresAt);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not select team.');
    }
  }

  return (
    <div className="auth-wrap">
      <main className="auth-card" aria-labelledby="auth-title">
        <div className="auth-logo" aria-hidden>
          <LogoMark />
        </div>
        <h1 id="auth-title" className="auth-title">
          Sign in to uxinspect
        </h1>
        <p className="auth-sub">
          {stage === 'email' && 'We’ll email you a one-time sign-in link.'}
          {stage === 'sent' && 'Check your inbox for the sign-in link.'}
          {stage === 'confirming' && 'Confirming your sign-in…'}
          {stage === 'team-picker' && 'Choose the team to open.'}
          {stage === 'error' && 'We hit a problem.'}
        </p>

        {error ? <ErrorBlock error={error} /> : null}

        {stage === 'email' && (
          <form onSubmit={onRequestLink} noValidate>
            <div className="form-group">
              <label className="form-label" htmlFor="email">
                Work email
              </label>
              <input
                id="email"
                className="input"
                type="email"
                name="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                aria-describedby="email-help"
              />
              <span id="email-help" className="form-help">
                We never ask for a password.
              </span>
            </div>
            <button
              type="submit"
              className="btn btn-primary"
              style={{ width: '100%' }}
              disabled={submitting || !email}
            >
              {submitting ? 'Sending…' : 'Email me a sign-in link'}
            </button>
          </form>
        )}

        {stage === 'sent' && (
          <div>
            <p className="text-sm text-muted" style={{ textAlign: 'center' }}>
              A sign-in link was sent to <strong>{email}</strong>. The link expires in 15 minutes.
            </p>
            <button
              type="button"
              className="btn"
              style={{ width: '100%', marginTop: 12 }}
              onClick={() => setStage('email')}
            >
              Use a different email
            </button>
          </div>
        )}

        {stage === 'confirming' && (
          <div className="loading" aria-live="polite">
            Confirming…
          </div>
        )}

        {stage === 'team-picker' && teams && (
          <div className="form-group" role="radiogroup" aria-label="Choose a team">
            {teams.map((t) => (
              <button
                key={t.id}
                type="button"
                className="btn"
                style={{
                  justifyContent: 'space-between',
                  width: '100%',
                  marginBottom: 8,
                }}
                onClick={() => onPickTeam(t.id)}
              >
                <span>{t.name}</span>
                <span className="badge badge-muted">{t.plan}</span>
              </button>
            ))}
          </div>
        )}

        {stage === 'error' && (
          <Link to="/login" className="btn" style={{ width: '100%' }}>
            Start over
          </Link>
        )}
      </main>
    </div>
  );
}
