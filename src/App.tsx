import { HashRouter, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useMe, useRuntime } from './ui/kit';
import { ROLE_LABEL, can, type Permission } from './core/rbac';
import { LoginPage } from './pages/Login';
import { OverviewPage } from './pages/Overview';
import { DevicesPage } from './pages/Devices';
import { DeviceDetailPage } from './pages/DeviceDetail';
import { EnrolPage } from './pages/Enrol';
import { InstallPage } from './pages/Install';
import { LocationsPage } from './pages/Locations';
import { AuditPage } from './pages/Audit';
import { RolesPage } from './pages/Roles';
import { SimulatorPage } from './pages/Simulator';
import { TransparencyPage } from './pages/Transparency';
import { PrivacyPage } from './pages/Privacy';

const NAV: { to: string; label: string; icon: string; perm?: Permission }[] = [
  { to: '/', label: 'Overview', icon: '◎' },
  { to: '/devices', label: 'Devices', icon: '▤' },
  { to: '/enrol', label: 'Add devices', icon: '＋', perm: 'enrollment.create' },
  { to: '/locations', label: 'Locations', icon: '⌖', perm: 'location.read' },
  { to: '/audit', label: 'Audit log', icon: '⛓', perm: 'audit.read' },
  { to: '/roles', label: 'Roles', icon: '⚿' },
  { to: '/simulator', label: 'Device simulator', icon: '▯' },
  { to: '/privacy', label: 'Privacy & governance', icon: '§' },
];

function Shell({ children }: { children: ReactNode }) {
  const rt = useRuntime();
  const me = useMe();
  const nav = useNavigate();
  if (!me) return <Navigate to="/login" replace state={{ from: useLocation().pathname }} />;
  const signOut = async () => {
    const sid = rt.sessionId;
    rt.sessionId = null;
    if (sid) await rt.backend.logout(sid);
    nav('/login');
  };
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            ◈
          </span>
          <span>FleetGuard</span>
          <span className="env-pill" title="Runs entirely in your browser on GitHub Pages">
            Demo
          </span>
        </div>
        <div className="userchip">
          <span className="userchip-name">{me.name}</span>
          <span className="userchip-role">{ROLE_LABEL[me.role]}</span>
          <button className="btn btn-ghost btn-sm" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>
      <nav className="sidenav" aria-label="Main">
        {NAV.filter((n) => !n.perm || can(me.role, n.perm)).map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `navlink${isActive ? ' active' : ''}`}>
            <span className="navicon" aria-hidden>
              {n.icon}
            </span>
            {n.label}
          </NavLink>
        ))}
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
      </nav>
      <main className="content" id="main">
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
        <Route path="/e/:token" element={<InstallPage />} />
        <Route path="/transparency/:deviceId/:key" element={<TransparencyPage />} />
        <Route path="/privacy" element={<PrivacyGate />} />
        <Route path="/" element={guarded(<OverviewPage />)} />
        <Route path="/devices" element={guarded(<DevicesPage />)} />
        <Route path="/devices/:id" element={guarded(<DeviceDetailPage />)} />
        <Route path="/enrol" element={guarded(<EnrolPage />)} />
        <Route path="/locations" element={guarded(<LocationsPage />)} />
        <Route path="/audit" element={guarded(<AuditPage />)} />
        <Route path="/roles" element={guarded(<RolesPage />)} />
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
