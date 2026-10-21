import { useEffect, useState } from 'react';
import { api, fmt } from '../api';
import { ErrorText, Link } from '../ui';

interface Entry { id: number; occurredAt: string; actorType: string; action: string; targetUserId: string | null; targetEmail: string | null; ip: string | null }

export function Audit() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = (before?: number) =>
    api.get<{ entries: Entry[]; nextBefore: number | null }>(`/audit${before ? `?before=${before}` : ''}`).then((r) => {
      setEntries((p) => (before ? [...p, ...r.entries] : r.entries));
      setNext(r.nextBefore);
    }, setError);
  useEffect(() => { load(); }, []);
  return (
    <>
      <h1>Audit log</h1>
      <p className="muted">Important account and administrator actions. Email content and passwords are never recorded.</p>
      <ErrorText error={error} />
      <div className="table-wrap"><table>
        <thead><tr><th>When</th><th>Action</th><th>By</th><th>User</th><th>IP</th></tr></thead>
        <tbody>{entries.map((e) => (
          <tr key={e.id}><td>{fmt(e.occurredAt)}</td><td className="mono">{e.action}</td><td>{e.actorType}</td>
            <td>{e.targetUserId ? (e.targetEmail ? <Link to={`/users/${e.targetUserId}`}>{e.targetEmail}</Link> : <span className="muted">deleted user</span>) : '—'}</td><td>{e.ip ?? '—'}</td></tr>
        ))}</tbody>
      </table></div>
      {next && <button onClick={() => load(next)}>Load older</button>}
    </>
  );
}
