import { useEffect, useState } from 'react';
import { api, GB, type Enrollment } from '../api';
import { Card, emptyMfa, ErrorText, MfaFields, mfaPayload, useSubmit } from '../ui';
import { EnrollmentView } from './Recovery';

interface S { defaultTimezone: string; defaultQuotaBytes: number; adminNotifyEmail: string | null }

export function Settings() {
  const [s, setS] = useState<S | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { api.get<S>('/settings').then(setS, setError); }, []);
  const save = useSubmit(() => api.patch('/settings', {
    defaultTimezone: s!.defaultTimezone, defaultQuotaBytes: s!.defaultQuotaBytes, adminNotifyEmail: s!.adminNotifyEmail || null,
  }), () => setSaved(true));
  if (error) return <ErrorText error={error} />;
  if (!s) return <p className="muted">Loading…</p>;
  return (
    <>
      <h1>Settings</h1>
      <Card title="Platform">
        <form onSubmit={save.submit}>
          <label>Administrator notification &amp; recovery email
            <input type="email" value={s.adminNotifyEmail ?? ''} onChange={(e) => setS({ ...s, adminNotifyEmail: e.target.value })} placeholder="Defaults to your admin sign-in email" />
            <span className="hint">Receives new-registration and expiry notices, and administrator password-reset links. Prefer an address not hosted on this server.</span>
          </label>
          <label>Default storage quota per user (GB)
            <input type="number" min="0.5" step="0.5" value={s.defaultQuotaBytes / GB} onChange={(e) => setS({ ...s, defaultQuotaBytes: Math.round(Number(e.target.value) * GB) })} />
          </label>
          <label>Fallback time zone
            <input value={s.defaultTimezone} onChange={(e) => setS({ ...s, defaultTimezone: e.target.value })} />
            <span className="hint">Each user's month is calculated in their own time zone (taken from their phone). This is only used when it is unknown.</span>
          </label>
          <ErrorText error={save.error} />
          {saved && <p className="notice">Saved.</p>}
          <button className="primary" disabled={save.busy}>Save</button>
        </form>
      </Card>
      <AccountSecurity />
    </>
  );
}

function AccountSecurity() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [mfa, setMfa] = useState(emptyMfa);
  const [mfa2, setMfa2] = useState(emptyMfa);
  const [done, setDone] = useState(false);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  useEffect(() => { api.get<{ recoveryCodesRemaining: number }>('/me').then((r) => setRemaining(r.recoveryCodesRemaining), () => undefined); }, [enrollment]);
  const pw = useSubmit(() => api.post('/me/password', { currentPassword: current, newPassword: next, ...mfaPayload(mfa) }), () => { setDone(true); setCurrent(''); setNext(''); });
  const re = useSubmit(() => api.post<Enrollment>('/me/recovery-codes', mfaPayload(mfa2)), setEnrollment);
  return (
    <>
      <Card title="Change administrator password">
        <form onSubmit={pw.submit}>
          <label>Current password<input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required /></label>
          <label>New password (at least 14 characters)<input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={14} required /></label>
          <MfaFields value={mfa} onChange={setMfa} />
          <ErrorText error={pw.error} />
          {done && <p className="notice">Password changed. Other admin sessions were signed out.</p>}
          <button className="primary" disabled={pw.busy}>Change password</button>
        </form>
      </Card>
      <Card title="Authenticator and recovery codes">
        <p>Unused recovery codes: <strong>{remaining ?? '…'}</strong></p>
        {enrollment ? <EnrollmentView e={enrollment} /> : (
          <form onSubmit={re.submit}>
            <p className="muted">Replace your authenticator key and all recovery codes (e.g. new phone, or codes running low).</p>
            <MfaFields value={mfa2} onChange={setMfa2} />
            <ErrorText error={re.error} />
            <button disabled={re.busy}>Generate new key and codes</button>
          </form>
        )}
      </Card>
    </>
  );
}
