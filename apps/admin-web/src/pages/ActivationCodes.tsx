import { useEffect, useState } from 'react';
import { api, fmt } from '../api';
import { Card, ErrorText, Link, useSubmit } from '../ui';

const PERIODS: Array<[number, string]> = [[1, '1 month'], [6, '6 months'], [12, '1 year']];
export const periodLabel = (m: number) => (m === 12 ? '1 year' : m === 24 ? '2 years' : m % 12 === 0 ? `${m / 12} years` : `${m} month${m === 1 ? '' : 's'}`);

interface Code {
  id: string; hint: string; months: number; note: string | null; forEmail: string | null; expiresAt: string | null; createdAt: string;
  usedAt: string | null; usedBy: string | null; usedByEmail: string | null; revokedAt: string | null; status: 'unused' | 'used' | 'revoked' | 'expired';
}

export function ActivationCodes() {
  const [filter, setFilter] = useState<'all' | 'unused' | 'used' | 'revoked'>('unused');
  const [list, setList] = useState<Code[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [count, setCount] = useState(1);
  const [months, setMonths] = useState(1);
  const [note, setNote] = useState('');
  const [forEmail, setForEmail] = useState('');
  const [expires, setExpires] = useState('');
  const [fresh, setFresh] = useState<string[] | null>(null);
  const [freshPeriod, setFreshPeriod] = useState<number | null>(null);
  const load = () => api.get<{ codes: Code[] }>(`/activation-codes?status=${filter}`).then((r) => setList(r.codes), setError);
  useEffect(() => { load(); }, [filter]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = useSubmit(() => api.post<{ codes: Array<{ code: string }> }>('/activation-codes', {
    count, months, note: note || undefined, forEmail: forEmail || undefined,
    expiresAt: expires ? new Date(`${expires}T23:59:59`).toISOString() : undefined,
  }), (r) => { setFresh(r.codes.map((c) => c.code)); setFreshPeriod(months); setNote(''); setForEmail(''); load(); });

  const revoke = async (c: Code) => {
    if (!window.confirm(`Cancel code …${c.hint}? It will no longer work.`)) return;
    await api.post(`/activation-codes/${c.id}/revoke`).catch(setError);
    load();
  };

  return (
    <>
      <h1>Activation codes</h1>
      <Card title="Create codes">
        <p className="muted">Give one code to each customer after payment: 1 month, 6 months or 1 year. When the period ends, the customer needs a new code to continue (they are reminded 3 days and 1 day before, and they lose no days if they renew early). They enter it in the app (after confirming their Gmail) and their account is activated at once for the chosen period. Each code works for one account, one time.</p>
        <form onSubmit={create.submit}>
          <div className="row">
            <label>How many<input type="number" min={1} max={50} value={count} onChange={(e) => setCount(Number(e.target.value))} disabled={!!forEmail} /></label>
            <label>Access period
              <span className="segmented">
                {PERIODS.map(([m, label]) => (
                  <button type="button" key={m} className={months === m ? 'primary' : ''} aria-pressed={months === m} onClick={() => setMonths(m)}>{label}</button>
                ))}
              </span>
            </label>
            <label>Code valid until (optional)<input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></label>
          </div>
          <label>Note, e.g. payment reference (optional)<input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></label>
          <label>Only for this Gmail address (optional)<input type="email" value={forEmail} onChange={(e) => { setForEmail(e.target.value); if (e.target.value) setCount(1); }} placeholder="customer@gmail.com" /></label>
          <ErrorText error={create.error} />
          <button className="primary" disabled={create.busy}>Create {forEmail ? 'code' : `${count} code${count === 1 ? '' : 's'}`} for {periodLabel(months)}</button>
        </form>
        {fresh ? (
          <div className="notice">
            <p><strong>{freshPeriod ? `${periodLabel(freshPeriod)} — ` : ''}Copy {fresh.length === 1 ? 'this code' : 'these codes'} now — {fresh.length === 1 ? 'it is' : 'they are'} shown only once.</strong> Send each code privately to its customer.</p>
            <pre className="codes">{fresh.join('\n')}</pre>
            <button onClick={() => { navigator.clipboard?.writeText(fresh.join('\n')).catch(() => undefined); }}>Copy</button>{' '}
            <button className="linklike" onClick={() => setFresh(null)}>Done</button>
          </div>
        ) : null}
      </Card>
      <Card title="Codes" actions={
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="unused">Not used yet</option><option value="used">Used</option><option value="revoked">Cancelled</option><option value="all">All</option>
        </select>}>
        <ErrorText error={error} />
        {!list ? <p className="muted">Loading…</p> : list.length === 0 ? <p className="muted">No codes.</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Code</th><th>Access</th><th>Note</th><th>Status</th><th>Created</th><th></th></tr></thead>
            <tbody>{list.map((c) => (
              <tr key={c.id}>
                <td>…{c.hint}{c.forEmail ? <div className="muted small">for {c.forEmail}</div> : null}</td>
                <td>{periodLabel(c.months)}</td>
                <td className="wrap">{c.note ?? '—'}</td>
                <td>{c.status === 'used' ? <>Used by {c.usedBy ? <Link to={`/users/${c.usedBy}`}>{c.usedByEmail}</Link> : c.usedByEmail}<div className="muted small">{fmt(c.usedAt)}</div></>
                  : c.status === 'revoked' ? 'Cancelled' : c.status === 'expired' ? 'Expired' : <>Not used{c.expiresAt ? <div className="muted small">valid until {fmt(c.expiresAt)}</div> : null}</>}</td>
                <td>{fmt(c.createdAt)}</td>
                <td>{c.status === 'unused' ? <button className="linklike" onClick={() => revoke(c)}>Cancel</button> : null}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}
