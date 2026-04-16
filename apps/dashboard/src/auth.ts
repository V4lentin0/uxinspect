/**
 * auth.ts — JWT storage + session helpers.
 *
 * Preferred flow: the API worker issues an httpOnly cookie on magic-link
 * confirm, so the browser never touches the token. We treat cookies as the
 * source of truth when possible — this module only keeps a non-sensitive
 * local record (email, team id, expiry) so the SPA can render the shell
 * without blocking on a network round-trip.
 *
 * Fallback: if the API replies with a bearer token in the JSON body (CI /
 * embed flows, or cross-site where cookies are blocked), we cache it in
 * localStorage behind an explicit opt-in flag. Production should stay on
 * cookies; localStorage exists so demo/preview environments still work.
 */

const STORAGE_KEY = 'uxinspect.session.v1';
const TOKEN_KEY = 'uxinspect.token.v1';

export interface Session {
  email: string;
  teamId: string;
  teamName: string;
  userId: string;
  expiresAt: number; // epoch ms
}

export interface StoredSession extends Session {
  /** True when backed by a readable bearer token (fallback path). */
  hasBearer: boolean;
}

/** Load the current session from localStorage. Returns null if missing/expired. */
export function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as StoredSession;
    if (!s.expiresAt || s.expiresAt < Date.now()) {
      clearSession();
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

export function saveSession(session: Session, bearer?: string): void {
  const stored: StoredSession = { ...session, hasBearer: Boolean(bearer) };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  if (bearer) localStorage.setItem(TOKEN_KEY, bearer);
  else localStorage.removeItem(TOKEN_KEY);
}

/** Returns the bearer token if we saved one (fallback flow). */
export function getBearerToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(TOKEN_KEY);
}

/** Switch the active team on an existing session (does not re-auth). */
export function setActiveTeam(teamId: string, teamName: string): void {
  const s = loadSession();
  if (!s) return;
  const bearer = s.hasBearer ? (getBearerToken() ?? undefined) : undefined;
  saveSession({ ...s, teamId, teamName }, bearer);
}

/** Convenience: is the viewer authenticated right now? */
export function isAuthenticated(): boolean {
  return loadSession() !== null;
}
