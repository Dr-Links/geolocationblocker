import { useEffect, useState } from 'react';
import { api, fmt } from '../api';
import { Card, ErrorText, Link } from '../ui';

interface Dash {
  counts: { pendingVerified: number; pendingUnverified: number; approved: number; suspended: number; rejected: number };
  expiringSoon: Array<{ id: string; email: string; accessExpiresAt: string }>;
  failedLogins24h: number;
  mailboxes: Record<string, number>;
  sendFailures24h: number;
  storage: { totalUsedBytes: number; warning: number; full: number; top: Array<{ id: string; email: string; usedBytes: number; quotaBytes: number; state: string }> };
  mailboxProblems: Array<{ id: string; userId: string; owner: string; email: string; status: string; statusDetail: string | null; lastErrorAt: string | null }>;
}

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(2)} GB`;

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
      <Card title="Mailbox health">
        <p>
          Connected: <strong>{d.mailboxes.active ?? 0}</strong> · Password needed: <strong>{d.mailboxes.auth_failed ?? 0}</strong> ·
          Connection problems: <strong>{d.mailboxes.error ?? 0}</strong> · Paused: <strong>{d.mailboxes.paused_account ?? 0}</strong>
        </p>
        {d.mailboxProblems.length === 0 ? <p className="muted">No mailbox problems.</p> : (
          <div className="table-wrap"><table><thead><tr><th>Mailbox</th><th>User</th><th>Status</th><th>Problem</th><th>Since</th></tr></thead><tbody>
            {d.mailboxProblems.map((p) => (
              <tr key={p.id}><td>{p.email}</td><td><Link to={`/users/${p.userId}`}>{p.owner}</Link></td><td>{p.status.replace('_', ' ')}</td><td className="wrap">{p.statusDetail ?? '—'}</td><td>{fmt(p.lastErrorAt)}</td></tr>
            ))}
          </tbody></table></div>
        )}
      </Card>
      <Card title="Storage">
        <p>Total stored: <strong>{gb(d.storage.totalUsedBytes)}</strong> · Users above 80 %: <strong>{d.storage.warning}</strong> · Full: <strong>{d.storage.full}</strong></p>
        {d.storage.top.length === 0 ? null : (
          <table><thead><tr><th>User</th><th>Used</th><th>Quota</th><th></th></tr></thead><tbody>
            {d.storage.top.map((u) => (
              <tr key={u.id}><td><Link to={`/users/${u.id}`}>{u.email}</Link></td><td>{gb(u.usedBytes)}</td><td>{gb(u.quotaBytes)}</td>
                <td>{u.state === 'full' ? 'Full' : u.state === 'warning' ? 'Above 80 %' : ''}</td></tr>
            ))}
          </tbody></table>
        )}
      </Card>
      <Card title="Security">
        <p>Failed sign-in attempts in the last 24 hours: <strong>{d.failedLogins24h}</strong></p>
        <p>Messages that could not be sent (last 24 hours): <strong>{d.sendFailures24h}</strong></p>
      </Card>
    </>
  );
}
