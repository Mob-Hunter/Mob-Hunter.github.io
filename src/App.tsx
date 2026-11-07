import { HashRouter, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
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
import { EmployeesPage } from './pages/Employees';
import { UsersPage } from './pages/Users';
import { AuditPage } from './pages/Audit';
import { RolesPage } from './pages/Roles';
import { SettingsPage } from './pages/Settings';
import { SimulatorPage } from './pages/Simulator';
import { TransparencyPage } from './pages/Transparency';
import { PrivacyPage } from './pages/Privacy';

type NavItem = { to: string; label: string; icon: string; perm?: Permission; anyOf?: Permission[] };
const NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: '◎' },
  { to: '/devices', label: 'Devices', icon: '▤' },
  { to: '/compliance', label: 'Compliance', icon: '✓' },
  { to: '/enrol', label: 'Add devices', icon: '＋', perm: 'enrollment.create' },
  { to: '/locations', label: 'Locations', icon: '⌖', anyOf: ['location.read', 'location.purge'] },
  { to: '/employees', label: 'Employees', icon: '☺' },
  { to: '/users', label: 'Users & access', icon: '⚿', anyOf: ['users.manage', 'sessions.manage'] },
  { to: '/roles', label: 'Roles', icon: '▦' },
  { to: '/audit', label: 'Audit log', icon: '⛓', perm: 'audit.read' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
  { to: '/simulator', label: 'Device simulator', icon: '▯' },
  { to: '/privacy', label: 'Privacy & governance', icon: '§' },
];

function Shell({ children }: { children: ReactNode }) {
  const rt = useRuntime();
  const me = useMe();
  const nav = useNavigate();
  const from = useLocation().pathname;
  if (rt.mode === 'server' && rt.health.needsBootstrap) return <Navigate to="/setup" replace />;
  if (!me) return <Navigate to="/login" replace state={{ from }} />;
  const signOut = async () => {
    await rt.signOut();
    nav('/login');
  };
  const visible = NAV.filter((n) => (!n.perm || can(me.role, n.perm)) && (!n.anyOf || n.anyOf.some((p) => can(me.role, p))));
  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            ◈
          </span>
          <span>FleetGuard</span>
          {rt.mode === 'demo' ? (
            <span className="env-pill" title="Runs entirely in your browser; no data leaves this device">
              Demo
            </span>
          ) : (
            <span className="env-pill env-live" title={`Connected to the FleetGuard server v${rt.health.version}`}>
              Live
            </span>
          )}
        </div>
        <div className="userchip">
          <span className="userchip-name">{me.name}</span>
          <span className="userchip-role">{ROLE_LABEL[me.role]}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>
      <nav className="sidenav" aria-label="Main">
        {visible.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `navlink${isActive ? ' active' : ''}`}>
            <span className="navicon" aria-hidden>
              {n.icon}
            </span>
            {n.label}
          </NavLink>
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
        <Route path="/" element={guarded(<OverviewPage />)} />
        <Route path="/devices" element={guarded(<DevicesPage />)} />
        <Route path="/devices/:id" element={guarded(<DeviceDetailPage />)} />
        <Route path="/compliance" element={guarded(<CompliancePage />)} />
        <Route path="/enrol" element={guarded(<EnrolPage />)} />
        <Route path="/locations" element={guarded(<LocationsPage />)} />
        <Route path="/employees" element={guarded(<EmployeesPage />)} />
        <Route path="/users" element={guarded(<UsersPage />)} />
        <Route path="/audit" element={guarded(<AuditPage />)} />
        <Route path="/roles" element={guarded(<RolesPage />)} />
        <Route path="/settings" element={guarded(<SettingsPage />)} />
        <Route path="/simulator" element={guarded(<SimulatorPage />)} />
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
