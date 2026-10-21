import { useEffect, useState } from 'react';
import { api } from './api';
import { Audit } from './pages/Audit';
import { Dashboard } from './pages/Dashboard';
import { Login } from './pages/Login';
import { Emergency, ForgotPassword, ResetPassword } from './pages/Recovery';
import { Settings } from './pages/Settings';
import { UserDetail } from './pages/UserDetail';
import { Users } from './pages/Users';
import { navigate, useLocation } from './router';
import { Link } from './ui';

export function App() {
  const { path, search } = useLocation();
  const [me, setMe] = useState<{ email: string } | null | undefined>(undefined);
  const refresh = () => api.get<{ email: string }>('/me').then(setMe, () => setMe(null));
  useEffect(() => {
    refresh();
    const out = () => setMe(null);
    window.addEventListener('admin:signed-out', out);
    return () => window.removeEventListener('admin:signed-out', out);
  }, []);

  // Public pages reached from links.
  if (path === '/forgot') return <ForgotPassword />;
  if (path === '/reset') return <ResetPassword />;
  if (path === '/emergency') return <Emergency />;

  if (me === undefined) return <p className="muted center">Loading…</p>;
  if (me === null) return <Login onSignedIn={refresh} />;

  const userMatch = path.match(/^\/users\/([0-9a-f-]{36})$/);
  let page;
  if (userMatch) page = <UserDetail id={userMatch[1]!} />;
  else if (path === '/users') page = <Users search={search} />;
  else if (path === '/audit') page = <Audit />;
  else if (path === '/settings') page = <Settings />;
  else page = <Dashboard />;

  const nav = (to: string, label: string) => (
    <Link to={to} className={path === to || (to !== '/' && path.startsWith(to)) ? 'nav active' : 'nav'}>{label}</Link>
  );

  return (
    <div className="layout">
      <header className="topbar">
        <strong className="brand">Email Platform · Admin</strong>
        <nav>{nav('/', 'Dashboard')}{nav('/users', 'Users')}{nav('/audit', 'Audit log')}{nav('/settings', 'Settings')}</nav>
        <span className="who">{me.email}
          <button className="linklike" onClick={async () => { await api.post('/auth/logout').catch(() => undefined); setMe(null); navigate('/'); }}>Sign out</button>
        </span>
      </header>
      <main className="content">{page}</main>
    </div>
  );
}
