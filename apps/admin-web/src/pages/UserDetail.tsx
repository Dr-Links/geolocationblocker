import { useCallback, useEffect, useState } from 'react';
import { api, fmt, GB, type UserDetail as Detail } from '../api';
import { navigate } from '../router';
import { Card, emptyMfa, ErrorText, MfaFields, mfaPayload, StatusBadge, useSubmit } from '../ui';

export function UserDetail({ id }: { id: string }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const reload = useCallback(() => api.get<Detail>(`/users/${id}`).then(setD, setError), [id]);
  useEffect(() => { reload(); }, [reload]);

  if (error) return <ErrorText error={error} />;
  if (!d) return <p className="muted">Loading…</p>;
  const u = d.user;
  const done = (msg: string) => () => { setNotice(msg); reload(); };

  return (
    <>
      <p><a href="/users" onClick={(e) => { e.preventDefault(); history.back(); }}>← Back</a></p>
      <h1>{u.email} <StatusBadge status={u.displayStatus} verified={u.emailVerified} /></h1>
      {notice && <p className="notice" role="status">{notice}</p>}

      <div className="grid2">
        <Card title="Account">
          <dl>
            <dt>Status</dt><dd>{u.displayStatus}{u.suspensionReason ? ` (${u.suspensionReason === 'expired' ? 'access period ended' : 'suspended by you'})` : ''}</dd>
            <dt>Email confirmed</dt><dd>{u.emailVerified ? 'Yes' : 'No — cannot be approved yet'}</dd>
            <dt>User time zone</dt><dd>{u.timezone}</dd>
            <dt>Access ends</dt><dd>{fmt(u.accessExpiresAt)}<br /><span className="muted">{fmt(u.accessExpiresAt, u.timezone)} user time</span></dd>
            <dt>Registered</dt><dd>{fmt(u.createdAt)}</dd>
            <dt>Last sign-in</dt><dd>{fmt(u.lastLoginAt)}</dd>
            <dt>Storage quota</dt><dd>{u.effectiveQuotaBytes ? `${(u.effectiveQuotaBytes / GB).toFixed(1)} GB` : '—'}{u.storageQuotaBytes === null ? ' (default)' : ''}</dd>
          </dl>
        </Card>
        <Actions d={d} onDone={done} />
      </div>

      <Card title="Access periods">
        {d.accessPeriods.length === 0 ? <p className="muted">None yet.</p> : (
          <div className="table-wrap"><table><thead><tr><th>Type</th><th>Starts</th><th>Ends</th><th>Zone</th><th>Payment note</th></tr></thead><tbody>
            {d.accessPeriods.map((p) => <tr key={p.createdAt + p.kind}><td>{p.kind}</td><td>{fmt(p.startsAt)}</td><td>{fmt(p.endsAt)}</td><td>{p.timezone}</td><td>{p.paymentNote ?? '—'}</td></tr>)}
          </tbody></table></div>
        )}
      </Card>

      <Card title="Mailboxes">
        <p className="muted">Mailbox connections and their health appear here from Milestone 2. Email content is never shown to the administrator.</p>
      </Card>

      <Card title={`Active sessions (${d.sessions.length})`}>
        {d.sessions.length === 0 ? <p className="muted">None.</p> : (
          <div className="table-wrap"><table><thead><tr><th>Device</th><th>Signed in</th><th>Last used</th><th>IP</th></tr></thead><tbody>
            {d.sessions.map((s) => <tr key={s.id}><td>{s.deviceName ?? s.platform ?? s.kind}</td><td>{fmt(s.createdAt)}</td><td>{fmt(s.lastUsedAt)}</td><td>{s.ip ?? '—'}</td></tr>)}
          </tbody></table></div>
        )}
      </Card>

      <Card title="Activity">
        <ul className="activity">{d.activity.map((a, i) => <li key={i}><span className="muted">{fmt(a.occurredAt)}</span> {a.action} <span className="muted">by {a.actorType}</span></li>)}</ul>
      </Card>

      <DangerZone email={u.email} id={u.id} />
    </>
  );
}

function Actions({ d, onDone }: { d: Detail; onDone: (msg: string) => () => void }) {
  const u = d.user;
  const [note, setNote] = useState('');
  const [mode, setMode] = useState<'from_now' | 'from_current_expiry'>(u.status === 'approved' ? 'from_current_expiry' : 'from_now');
  const [quotaGb, setQuotaGb] = useState(u.storageQuotaBytes === null ? '' : String(u.storageQuotaBytes / GB));

  const approve = useSubmit(() => api.post(`/users/${u.id}/approve`, { paymentNote: note }), onDone('Approved. The user has been emailed.'));
  const renew = useSubmit(() => api.post(`/users/${u.id}/renew`, { mode, paymentNote: note }), onDone('Access renewed. The user has been emailed.'));
  const reject = useSubmit(async () => { if (confirm(`Reject ${u.email}?`)) await api.post(`/users/${u.id}/reject`); }, onDone('Registration rejected.'));
  const suspend = useSubmit(async () => { if (confirm(`Suspend ${u.email}? They are signed out immediately. Data is kept.`)) await api.post(`/users/${u.id}/suspend`); }, onDone('Account suspended. Data is kept.'));
  const reset = useSubmit(() => api.post(`/users/${u.id}/password-reset`), onDone('Password reset link sent to the user\'s Gmail address.'));
  const revoke = useSubmit(() => api.post(`/users/${u.id}/revoke-sessions`), onDone('All sessions signed out.'));
  const quota = useSubmit(() => api.patch(`/users/${u.id}/quota`, { quotaBytes: quotaGb === '' ? null : Math.round(Number(quotaGb) * GB) }), onDone('Quota updated.'));
  const anyError = approve.error || renew.error || reject.error || suspend.error || reset.error || revoke.error || quota.error;

  return (
    <Card title="Actions">
      <ErrorText error={anyError} />
      {(u.status === 'pending' || u.status === 'approved' || u.status === 'suspended') && (
        <label>Payment note (optional, for your records)<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="e.g. Bank transfer ref 1234" /></label>
      )}
      {u.status === 'pending' && (
        <div className="row">
          <button className="primary" onClick={() => approve.submit()} disabled={!u.emailVerified || approve.busy}>Approve — start 1 month</button>
          <button onClick={() => reject.submit()} disabled={reject.busy}>Reject</button>
        </div>
      )}
      {(u.status === 'approved' || u.status === 'suspended') && (
        <>
          <label>Renewal
            <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
              <option value="from_now">1 month starting now</option>
              <option value="from_current_expiry">1 month added to the current end date</option>
            </select>
          </label>
          <div className="row">
            <button className="primary" onClick={() => renew.submit()} disabled={renew.busy}>{u.status === 'suspended' ? 'Reactivate' : 'Renew'}</button>
            {u.status === 'approved' && <button onClick={() => suspend.submit()} disabled={suspend.busy}>Suspend</button>}
          </div>
        </>
      )}
      <div className="row">
        <button onClick={() => reset.submit()} disabled={reset.busy || !u.emailVerified}>Send password reset email</button>
        <button onClick={() => revoke.submit()} disabled={revoke.busy || d.sessions.length === 0}>Sign out all devices</button>
      </div>
      <form className="row" onSubmit={quota.submit}>
        <label className="grow">Storage quota in GB (empty = platform default)<input type="number" min="0" step="0.5" value={quotaGb} onChange={(e) => setQuotaGb(e.target.value)} /></label>
        <button disabled={quota.busy}>Save quota</button>
      </form>
    </Card>
  );
}

function DangerZone({ email, id }: { email: string; id: string }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [mfa, setMfa] = useState(emptyMfa);
  const del = useSubmit(() => api.post(`/users/${id}/delete`, { confirmEmail: typed, ...mfaPayload(mfa) }), () => navigate('/users?status=all'));
  return (
    <Card title="Danger zone">
      {!open ? (
        <button className="danger" onClick={() => setOpen(true)}>Permanently delete this user…</button>
      ) : (
        <form onSubmit={del.submit}>
          <p>This permanently deletes <strong>{email}</strong> and all platform data stored for them. It cannot be undone. Their original mailboxes on their mail servers are <strong>not</strong> affected.</p>
          <label>Type the user's email to confirm<input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" required /></label>
          <MfaFields value={mfa} onChange={setMfa} />
          <ErrorText error={del.error} />
          <div className="row">
            <button className="danger" disabled={del.busy || typed.trim().toLowerCase() !== email.toLowerCase()}>Delete permanently</button>
            <button type="button" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      )}
    </Card>
  );
}
