import { useEffect, useState } from 'react';
import { teams as teamsApi, type Member, type ApiKey, type Team } from '../api';
import { loadSession } from '../auth';
import { EmptyState } from '../components/EmptyState';
import { Loading, ErrorBlock } from '../components/Loading';
import { Badge } from '../components/Badge';
import { formatRelative } from '../format';

type Role = Team['role'];

export function SettingsPage() {
  const session = loadSession()!;
  const [team, setTeam] = useState<Team | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const [teamName, setTeamName] = useState('');
  const [savingTeam, setSavingTeam] = useState(false);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('member');
  const [inviting, setInviting] = useState(false);

  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [creatingKey, setCreatingKey] = useState(false);
  const [newKeySecret, setNewKeySecret] = useState<string | null>(null);

  useEffect(() => {
    let aborted = false;
    Promise.all([
      teamsApi.get(session.teamId),
      teamsApi.members(session.teamId),
      teamsApi.apiKeys(session.teamId),
    ])
      .then(([t, m, k]) => {
        if (aborted) return;
        setTeam(t);
        setMembers(m);
        setKeys(k);
        setTeamName(t.name);
      })
      .catch((err) => !aborted && setError(err));
    return () => {
      aborted = true;
    };
  }, [session.teamId]);

  async function onSaveTeam(e: React.FormEvent) {
    e.preventDefault();
    if (!team) return;
    setSavingTeam(true);
    try {
      const updated = await teamsApi.update(team.id, { name: teamName });
      setTeam(updated);
    } catch (err) {
      setError(err);
    } finally {
      setSavingTeam(false);
    }
  }

  async function onInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!inviteEmail) return;
    setInviting(true);
    try {
      const m = await teamsApi.invite(session.teamId, inviteEmail.trim(), inviteRole);
      setMembers((prev) => (prev ? [...prev, m] : [m]));
      setInviteEmail('');
    } catch (err) {
      setError(err);
    } finally {
      setInviting(false);
    }
  }

  async function onRemoveMember(memberId: string) {
    try {
      await teamsApi.removeMember(session.teamId, memberId);
      setMembers((prev) => prev?.filter((m) => m.id !== memberId) ?? null);
    } catch (err) {
      setError(err);
    }
  }

  async function onCreateKey(e: React.FormEvent) {
    e.preventDefault();
    if (!newKeyLabel) return;
    setCreatingKey(true);
    try {
      const k = await teamsApi.createApiKey(session.teamId, newKeyLabel.trim());
      setKeys((prev) => (prev ? [k, ...prev] : [k]));
      setNewKeySecret(k.secret ?? null);
      setNewKeyLabel('');
    } catch (err) {
      setError(err);
    } finally {
      setCreatingKey(false);
    }
  }

  async function onRevokeKey(keyId: string) {
    try {
      await teamsApi.revokeApiKey(session.teamId, keyId);
      setKeys((prev) => prev?.filter((k) => k.id !== keyId) ?? null);
    } catch (err) {
      setError(err);
    }
  }

  if (error) return <ErrorBlock error={error} />;
  if (!team || !members || !keys) return <Loading />;

  const isAdmin = team.role === 'owner' || team.role === 'admin';

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-title">Settings</h2>
          <p className="page-subtitle">Team, members, API keys</p>
        </div>
      </div>

      <section className="card" style={{ marginBottom: 20 }} aria-labelledby="team-h">
        <div className="card-header">
          <h3 id="team-h" className="card-title">
            Team
          </h3>
          <Badge tone="blue">{team.plan}</Badge>
        </div>
        <form onSubmit={onSaveTeam} className="card-body">
          <div className="form-group">
            <label className="form-label" htmlFor="team-name">
              Name
            </label>
            <input
              id="team-name"
              className="input"
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
              disabled={!isAdmin}
            />
            <span className="form-help">Shown in the sidebar and reports.</span>
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="team-slug">
              Slug
            </label>
            <input id="team-slug" className="input" value={team.slug} readOnly disabled />
            <span className="form-help">Used in invite links and API routes.</span>
          </div>
          {isAdmin && (
            <button type="submit" className="btn btn-primary" disabled={savingTeam}>
              {savingTeam ? 'Saving…' : 'Save changes'}
            </button>
          )}
        </form>
      </section>

      <section className="card" style={{ marginBottom: 20 }} aria-labelledby="members-h">
        <div className="card-header">
          <h3 id="members-h" className="card-title">
            Members
          </h3>
          <p className="card-subtitle">{members.length} total</p>
        </div>

        {isAdmin && (
          <form onSubmit={onInvite} className="card-body" style={{ borderBottom: '1px solid var(--border)' }}>
            <div className="flex gap-sm" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div className="form-group" style={{ flex: '1 1 240px', marginBottom: 0 }}>
                <label className="form-label" htmlFor="invite-email">
                  Invite email
                </label>
                <input
                  id="invite-email"
                  className="input"
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="teammate@company.com"
                />
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label" htmlFor="invite-role">
                  Role
                </label>
                <select
                  id="invite-role"
                  className="team-select"
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as Role)}
                >
                  <option value="admin">Admin</option>
                  <option value="member">Member</option>
                  <option value="viewer">Viewer</option>
                </select>
              </div>
              <button type="submit" className="btn btn-primary" disabled={inviting}>
                {inviting ? 'Sending…' : 'Send invite'}
              </button>
            </div>
          </form>
        )}

        {members.length === 0 ? (
          <div className="card-body">
            <EmptyState title="No members yet">Invite a teammate above.</EmptyState>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">Joined</th>
                {isAdmin && <th scope="col" aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id}>
                  <td>{m.email}</td>
                  <td>
                    <Badge tone="muted">{m.role}</Badge>
                  </td>
                  <td>
                    {m.status === 'active' ? (
                      <Badge tone="green">Active</Badge>
                    ) : m.status === 'invited' ? (
                      <Badge tone="blue">Invited</Badge>
                    ) : (
                      <Badge tone="red">Suspended</Badge>
                    )}
                  </td>
                  <td>{m.joinedAt ? formatRelative(m.joinedAt) : '—'}</td>
                  {isAdmin && (
                    <td>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => onRemoveMember(m.id)}
                        aria-label={`Remove ${m.email}`}
                      >
                        Remove
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card" aria-labelledby="keys-h">
        <div className="card-header">
          <h3 id="keys-h" className="card-title">
            API keys
          </h3>
          <p className="card-subtitle">Used by the CLI and CI to upload runs</p>
        </div>

        {newKeySecret && (
          <div className="card-body" style={{ borderBottom: '1px solid var(--border)' }}>
            <div className="callout callout-amber">
              <div>
                <p className="callout-title">Copy this key now — it won’t be shown again</p>
                <p className="callout-body mono" style={{ wordBreak: 'break-all' }}>
                  {newKeySecret}
                </p>
              </div>
            </div>
            <button
              type="button"
              className="btn"
              onClick={() => setNewKeySecret(null)}
              style={{ marginTop: 8 }}
            >
              Dismiss
            </button>
          </div>
        )}

        {isAdmin && (
          <form
            onSubmit={onCreateKey}
            className="card-body"
            style={{ borderBottom: '1px solid var(--border)' }}
          >
            <div className="flex gap-sm" style={{ alignItems: 'flex-end' }}>
              <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                <label className="form-label" htmlFor="key-label">
                  New key label
                </label>
                <input
                  id="key-label"
                  className="input"
                  value={newKeyLabel}
                  onChange={(e) => setNewKeyLabel(e.target.value)}
                  placeholder="e.g. ci-github"
                />
              </div>
              <button type="submit" className="btn btn-primary" disabled={creatingKey}>
                {creatingKey ? 'Creating…' : 'Create key'}
              </button>
            </div>
          </form>
        )}

        {keys.length === 0 ? (
          <div className="card-body">
            <EmptyState title="No API keys">
              Create a key above and set it in your CI as <code>UXINSPECT_TOKEN</code>.
            </EmptyState>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Label</th>
                <th scope="col">Prefix</th>
                <th scope="col">Created</th>
                <th scope="col">Last used</th>
                {isAdmin && <th scope="col" aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td>{k.label}</td>
                  <td className="mono text-sm">{k.prefix}…</td>
                  <td>{formatRelative(k.createdAt)}</td>
                  <td>{k.lastUsedAt ? formatRelative(k.lastUsedAt) : 'never'}</td>
                  {isAdmin && (
                    <td>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => onRevokeKey(k.id)}
                        aria-label={`Revoke ${k.label}`}
                      >
                        Revoke
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
