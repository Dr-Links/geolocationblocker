import { useEffect, useState } from 'react';
import { api, fmt } from '../api';
import { Card, ErrorText, Link } from '../ui';

interface Dash {
  counts: { pendingVerified: number; pendingUnverified: number; approved: number; suspended: number; rejected: number };
  expiringSoon: Array<{ id: string; email: string; accessExpiresAt: string }>;
  failedLogins24h: number;
}

export function Dashboard() {
  const [d, setD] = useState<Dash | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { api.get<Dash>('/dashboard').then(setD, setError); }, []);
  if (error) return <ErrorText error={error} />;
  if (!d) return <p className="muted">Loading…</p>;
  const tiles: Array<[string, number, string]> = [
    ['Waiting for approval', d.counts.pendingVerified, '/users?status=pending'],
    ['Active', d.counts.approved, '/users?status=approved'],
    ['Suspended / expired', d.counts.suspended, '/users?status=suspended'],
    ['Unconfirmed sign-ups', d.counts.pendingUnverified, '/users?status=pending'],
  ];
  return (
    <>
      <h1>Dashboard</h1>
      <div className="tiles">
        {tiles.map(([label, n, to]) => (
          <Link key={label} to={to} className="tile"><span className="tile-n">{n}</span><span>{label}</span></Link>
        ))}
      </div>
      <Card title="Access ending in the next 7 days">
        {d.expiringSoon.length === 0 ? <p className="muted">None.</p> : (
          <table><thead><tr><th>User</th><th>Ends</th></tr></thead><tbody>
            {d.expiringSoon.map((u) => <tr key={u.id}><td><Link to={`/users/${u.id}`}>{u.email}</Link></td><td>{fmt(u.accessExpiresAt)}</td></tr>)}
          </tbody></table>
        )}
      </Card>
      <Card title="Security">
        <p>Failed sign-in attempts in the last 24 hours: <strong>{d.failedLogins24h}</strong></p>
        <p className="muted">Mailbox health and sending errors appear here from Milestone 2.</p>
      </Card>
    </>
  );
}
