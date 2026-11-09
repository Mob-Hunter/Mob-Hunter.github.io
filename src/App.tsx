import { HashRouter, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useState, type ReactNode } from 'react';
import { useMe, useRuntime } from './ui/kit';
import { ROLE_LABEL, can, type Permission } from './core/rbac';
import { LoginPage } from './pages/Login';
import { SetupPage } from './pages/Setup';
import { OverviewPage } from './pages/Overview';
import { DevicesPage } from './pages/Devices';
import { DeviceDetailPage } from './pages/DeviceDetail';
import { CompliancePage } from './pages/Compliance';
import { EnrolPage } from './pages/Enrol';
import { InstallPage } from './pages/Install';
import { LocationsPage } from './pages/Locations';
import { IncidentDetailPage, IncidentsPage, ReportIncidentPage } from './pages/Incidents';
import { EmployeesPage } from './pages/Employees';
import { UsersPage } from './pages/Users';
import { AuditPage } from './pages/Audit';
import { RolesPage } from './pages/Roles';
import { SettingsPage } from './pages/Settings';
import { SimulatorPage } from './pages/Simulator';
import { TransparencyPage } from './pages/Transparency';
import { PrivacyPage } from './pages/Privacy';
import { DownloadPage, AppsPage } from './pages/Download';
import { HelpPage } from './pages/Help';
import { CommandPalette, type PaletteEntry } from './ui/palette';
import { getTheme, setTheme, type Theme } from './ui/theme';

type NavItem = { to: string; label: string; icon: string; group: string; perm?: Permission; anyOf?: Permission[]; keywords?: string };
/** Grouped by what an administrator is trying to do. */
const NAV: NavItem[] = [
  { group: 'Fleet', to: '/', label: 'Overview', icon: '◎', keywords: 'home dashboard' },
  { group: 'Fleet', to: '/devices', label: 'Devices', icon: '▤', keywords: 'phones fleet list' },
  { group: 'Fleet', to: '/enrol', label: 'Add devices', icon: '＋', perm: 'enrollment.create', keywords: 'enrol enroll qr new phone' },
  { group: 'Fleet', to: '/compliance', label: 'Compliance', icon: '✓', keywords: 'health patch battery issues' },
  { group: 'Find & recover', to: '/incidents', label: 'Lost & stolen', icon: '⚑', keywords: 'incident tracking lost mode' },
  { group: 'Find & recover', to: '/locations', label: 'Locations', icon: '⌖', anyOf: ['location.read', 'location.purge'], keywords: 'map locate where ticket' },
  { group: 'People & access', to: '/employees', label: 'Employees', icon: '☺', keywords: 'staff hr import csv' },
  { group: 'People & access', to: '/users', label: 'Users & access', icon: '⚿', anyOf: ['users.manage', 'sessions.manage'], keywords: 'admins invite mfa sessions' },
  { group: 'People & access', to: '/roles', label: 'Roles', icon: '▦', keywords: 'permissions rbac' },
  { group: 'Governance', to: '/audit', label: 'Audit log', icon: '⛓', perm: 'audit.read', keywords: 'history export verify' },
  { group: 'Governance', to: '/privacy', label: 'Privacy & governance', icon: '§', keywords: 'gdpr dpia notice' },
  { group: 'Setup & help', to: '/apps', label: 'Android apps', icon: '⬇', keywords: 'apk download qr install' },
  { group: 'Setup & help', to: '/settings', label: 'Settings', icon: '⚙', keywords: 'organisation dpo siem password catalogue' },
  { group: 'Setup & help', to: '/simulator', label: 'Device simulator', icon: '▯', keywords: 'test phone' },
  { group: 'Setup & help', to: '/help', label: 'Help & guides', icon: '?', keywords: 'how to guide faq support' },
];

type ActionItem = { to: string; label: string; icon: string; perm?: Permission; keywords?: string };
const ACTIONS: ActionItem[] = [
  { to: '/enrol', label: 'Add a device', icon: '＋', perm: 'enrollment.create', keywords: 'enrol qr' },
  { to: '/devices?unnamed=1', label: 'Name new devices', icon: '✎', perm: 'device.update', keywords: 'unnamed rename assign' },
  { to: '/incidents/new', label: 'Report a phone lost or stolen', icon: '⚑', perm: 'command.LOST_MODE_ON', keywords: 'incident tracking stolen lost mode' },
  { to: '/locations', label: 'Find a phone’s location', icon: '⌖', perm: 'location.read', keywords: 'locate map' },
  { to: '/users', label: 'Invite a console user', icon: '⚿', perm: 'users.manage', keywords: 'admin add user' },
  { to: '/employees', label: 'Import employees (CSV)', icon: '☺', perm: 'employee.manage', keywords: 'hr' },
  { to: '/audit', label: 'Verify the audit log', icon: '⛓', perm: 'audit.read', keywords: 'hash chain' },
  { to: '/settings', label: 'Change my password', icon: '⚙', keywords: 'account' },
];

function Shell({ children }: { children: ReactNode }) {
  const rt = useRuntime();
  const me = useMe();
  const nav = useNavigate();
  const from = useLocation().pathname;
  const [menuOpen, setMenuOpen] = useState(false);
  // Phone menu: close on navigation and on Escape; stop the page scrolling behind it.
  useEffect(() => setMenuOpen(false), [from]);
  const [searchOpen, setSearchOpen] = useState(false);
  // Ctrl/⌘ K anywhere, or "/" outside a text field, opens console search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    document.addEventListener('keydown', onKey);
    document.body.classList.add('menu-open');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('menu-open');
    };
  }, [menuOpen]);
  if (rt.mode === 'server' && rt.health.needsBootstrap) return <Navigate to="/setup" replace />;
  if (!me) return <Navigate to="/login" replace state={{ from }} />;
  const signOut = async () => {
    await rt.signOut();
    nav('/login');
  };
  const visible = NAV.filter(
    (n) =>
      (!n.perm || can(me.role, n.perm)) &&
      (!n.anyOf || n.anyOf.some((p) => can(me.role, p))) &&
      // On a live server the simulator enrols test phones, so only people who can enrol devices see it.
      !(n.to === '/simulator' && rt.mode === 'server' && !can(me.role, 'enrollment.create')),
  );
  const groups = [...new Set(visible.map((n) => n.group))];
  const paletteEntries: PaletteEntry[] = [
    ...ACTIONS.filter((a) => !a.perm || can(me.role, a.perm)).map((a) => ({ id: `act-${a.label}`, group: 'Actions', icon: a.icon, label: a.label, to: a.to, keywords: a.keywords })),
    ...visible.map((n) => ({ id: `nav-${n.to}`, group: 'Go to', icon: n.icon, label: n.label, hint: n.group, to: n.to, keywords: n.keywords })),
  ];
  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <button
          type="button"
          className="btn btn-ghost btn-sm menu-btn"
          aria-expanded={menuOpen}
          aria-controls="mainnav"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          onClick={() => setMenuOpen((o) => !o)}
        >
          <span aria-hidden>{menuOpen ? '✕' : '☰'}</span>
        </button>
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            ◈
          </span>
          <span>Mob Hunter</span>
          {rt.mode === 'demo' ? (
            <span className="env-pill" title="Runs entirely in your browser; no data leaves this device">
              Demo
            </span>
          ) : (
            <span className="env-pill env-live" title={`Connected to the Mob Hunter server v${rt.health.version}`}>
              Live
            </span>
          )}
        </div>
        <button type="button" className="search-btn" onClick={() => setSearchOpen(true)} aria-label="Search the console (Ctrl+K)">
          <span aria-hidden>⌕</span>
          <span className="search-btn-label">Search devices, people, pages…</span>
          <kbd className="search-btn-kbd">Ctrl K</kbd>
        </button>
        <ThemeToggle />
        <div className="userchip">
          <span className="userchip-name">{me.name}</span>
          <span className="userchip-role">{ROLE_LABEL[me.role]}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>
      <nav id="mainnav" className={`sidenav${menuOpen ? ' open' : ''}`} aria-label="Main">
        <div className="nav-user">
          <strong>{me.name}</strong>
          <span className="muted small">{ROLE_LABEL[me.role]}</span>
        </div>
        {groups.map((g) => (
          <div className="navgroup" key={g} role="group" aria-label={g}>
            <span className="navgroup-label" aria-hidden>
              {g}
            </span>
            {visible
              .filter((n) => n.group === g)
              .map((n) => (
                <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `navlink${isActive ? ' active' : ''}`}>
                  <span className="navicon" aria-hidden>
                    {n.icon}
                  </span>
                  {n.label}
                </NavLink>
              ))}
          </div>
        ))}
        {rt.mode === 'demo' && (
          <button
            className="navlink btn-ghost reset-demo"
            onClick={() => {
              if (confirm('Delete all demo data in this browser and start again?')) {
                rt.resetDemo();
                location.replace(location.pathname);
              }
            }}
          >
            <span className="navicon" aria-hidden>
              ↺
            </span>
            Reset demo data
          </button>
        )}
      </nav>
      <main className="content" id="main" tabIndex={-1}>
        {children}
      </main>
      {searchOpen && <CommandPalette open onClose={() => setSearchOpen(false)} pages={paletteEntries} />}
    </div>
  );
}

const guarded = (el: ReactNode) => <Shell>{el}</Shell>;

export function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/e/:token" element={<InstallPage />} />
        <Route path="/transparency/:deviceId/:key" element={<TransparencyPage />} />
        <Route path="/privacy" element={<PrivacyGate />} />
        <Route path="/download" element={<DownloadPage />} />
        <Route path="/" element={guarded(<OverviewPage />)} />
        <Route path="/devices" element={guarded(<DevicesPage />)} />
        <Route path="/devices/:id" element={guarded(<DeviceDetailPage />)} />
        <Route path="/compliance" element={guarded(<CompliancePage />)} />
        <Route path="/enrol" element={guarded(<EnrolPage />)} />
        <Route path="/locations" element={guarded(<LocationsPage />)} />
        <Route path="/incidents" element={guarded(<IncidentsPage />)} />
        <Route path="/incidents/new" element={guarded(<ReportIncidentPage />)} />
        <Route path="/incidents/:id" element={guarded(<IncidentDetailPage />)} />
        <Route path="/employees" element={guarded(<EmployeesPage />)} />
        <Route path="/users" element={guarded(<UsersPage />)} />
        <Route path="/audit" element={guarded(<AuditPage />)} />
        <Route path="/roles" element={guarded(<RolesPage />)} />
        <Route path="/settings" element={guarded(<SettingsPage />)} />
        <Route path="/simulator" element={guarded(<SimulatorPage />)} />
        <Route path="/apps" element={guarded(<AppsPage />)} />
        <Route path="/help" element={guarded(<HelpPage />)} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
}

/** Privacy page is public (employees can read it) but shows the console chrome when signed in. */
function PrivacyGate() {
  const me = useMe();
  return me ? (
    <Shell>
      <PrivacyPage />
    </Shell>
  ) : (
    <div className="public-page">
      <PrivacyPage />
    </div>
  );
}

function ThemeToggle() {
  const [theme, set] = useState<Theme>(getTheme);
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm theme-btn"
      onClick={() => {
        setTheme(next);
        set(next);
      }}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
    >
      <span aria-hidden>{theme === 'dark' ? '☀' : '☾'}</span>
    </button>
  );
}
