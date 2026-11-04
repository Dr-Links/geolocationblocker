import { useEffect, useState } from 'react';
import { api, fmt } from '../api';
import { Card, ErrorText, useSubmit } from '../ui';

interface Entry { pattern: string; reason: string | null; createdAt: string }

export function Blocklist() {
  const [list, setList] = useState<Entry[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pattern, setPattern] = useState('');
  const [reason, setReason] = useState('');
  const load = () => api.get<{ blocklist: Entry[] }>('/blocklist').then((r) => setList(r.blocklist), setError);
  useEffect(() => { load(); }, []);
  const add = useSubmit(() => api.post('/blocklist', { pattern, reason: reason || null }), () => { setPattern(''); setReason(''); load(); });
  const remove = async (p: string) => {
    if (!window.confirm(`Remove ${p} from the blocklist?`)) return;
    await api.del(`/blocklist?pattern=${encodeURIComponent(p)}`).catch(setError);
    load();
  };
  return (
    <>
      <h1>Platform blocklist</h1>
      <Card>
        <p className="muted">New mail from these senders is moved to the Junk folder of every user's mailbox and marked as blocked. Nothing is deleted, and users can still open it. Users can also block senders themselves in the app.</p>
        <form className="row" onSubmit={add.submit}>
          <label className="grow">Address or domain<input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="scam@example.com or example.com" required /></label>
          <label className="grow">Reason (optional)<input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></label>
          <button className="primary" disabled={add.busy}>Block</button>
        </form>
        <ErrorText error={add.error ?? error} />
      </Card>
      <Card title={`Blocked (${list?.length ?? 0})`}>
        {!list ? <p className="muted">Loading…</p> : list.length === 0 ? <p className="muted">Nothing blocked.</p> : (
          <table><thead><tr><th>Sender</th><th>Reason</th><th>Added</th><th></th></tr></thead><tbody>
            {list.map((e) => (
              <tr key={e.pattern}><td>{e.pattern.startsWith('@') ? `Anyone at ${e.pattern.slice(1)}` : e.pattern}</td><td className="wrap">{e.reason ?? '—'}</td>
                <td>{fmt(e.createdAt)}</td><td><button className="linklike" onClick={() => remove(e.pattern)}>Remove</button></td></tr>
            ))}
          </tbody></table>
        )}
      </Card>
    </>
  );
}
