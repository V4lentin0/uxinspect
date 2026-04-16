import { NavLink } from 'react-router-dom';
import {
  HomeIcon,
  RunsIcon,
  HistoryIcon,
  ReplayIcon,
  SettingsIcon,
  BillingIcon,
  LogoMark,
} from './Icons';
import type { StoredSession } from '../auth';

interface SidebarProps {
  session: StoredSession;
  onSignOut: () => void;
}

const NAV = [
  { to: '/', label: 'Overview', icon: HomeIcon, end: true },
  { to: '/runs', label: 'Runs', icon: RunsIcon, end: false },
  { to: '/history', label: 'History', icon: HistoryIcon, end: false },
  { to: '/replays', label: 'Replays', icon: ReplayIcon, end: false },
];

const SETTINGS_NAV = [
  { to: '/settings', label: 'Settings', icon: SettingsIcon, end: false },
  { to: '/billing', label: 'Billing', icon: BillingIcon, end: false },
];

export function Sidebar({ session, onSignOut }: SidebarProps) {
  return (
    <nav className="sidebar" aria-label="Primary">
      <div className="sidebar-brand">
        <span className="sidebar-brand-mark" aria-hidden>
          <LogoMark />
        </span>
        <span>uxinspect</span>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-label">Workspace</div>
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className="nav-link">
            <Icon />
            <span>{label}</span>
          </NavLink>
        ))}
      </div>

      <div className="sidebar-section">
        <div className="sidebar-label">Admin</div>
        {SETTINGS_NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className="nav-link">
            <Icon />
            <span>{label}</span>
          </NavLink>
        ))}
      </div>

      <div className="sidebar-footer">
        <div className="email">{session.email}</div>
        <div className="text-sm text-muted">{session.teamName}</div>
        <button type="button" className="signout" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </nav>
  );
}
