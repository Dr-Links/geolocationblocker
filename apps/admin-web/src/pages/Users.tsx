import { useEffect, useState } from 'react';
import { api, fmt, type UserSummary } from '../api';
import { navigate } from '../router';
import { ErrorText, Link, StatusBadge } from '../ui';

const TABS = ['pending', 'approved', 'expired', 'suspended', 'rejected', 'all'] as const;

export function Users({ search }: { search: string }) {
  const params = new URLSearchParams(search);
  const status = (params.get('status') as (typeof TABS)[number]) ?? 'pending';
  const [q, setQ] = useState('');
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = (offset = 0) => {
    const p = new URLSearchParams({ status, offset: String(offset) });
    if (q) p.set('search', q);
    api.get<{ users: UserSummary[]; nextOffset: number | null }>(`/users?${p}`).then((r) => {
      setUsers((prev) => (offset ? [...(prev ?? []), ...r.users] : r.users));
      setNext(r.nextOffset);
    }, setError);
  };
  useEffect(() => { setUsers(null); load(0); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <h1>Users</h1>
      <div className="tabs">
        {TABS.map((t) => <button key={t} className={t === status ? 'tab active' : 'tab'} onClick={() => navigate(`/users?status=${t}`)}>{t}</button>)}
      </div>
      <form className="search" onSubmit={(e) => { e.preventDefault(); load(0); }}>
        <input placeholder="Search by email" value={q} onChange={(e) => setQ(e.target.value)} />
        <button>Search</button>
      </form>
      <ErrorText error={error} />
      {!users ? <p className="muted">Loading…</p> : users.length === 0 ? <p className="muted">No users here.</p> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Email</th><th>Status</th><th>Access ends</th><th>Registered</th><th>Last sign-in</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td><Link to={`/users/${u.id}`}>{u.email}</Link></td>
                <td><StatusBadge status={u.displayStatus} verified={u.emailVerified} /></td>
                <td>{fmt(u.accessExpiresAt)}</td>
                <td>{fmt(u.createdAt)}</td>
                <td>{fmt(u.lastLoginAt)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {next !== null && <button onClick={() => load(next)}>Load more</button>}
    </>
  );
}
