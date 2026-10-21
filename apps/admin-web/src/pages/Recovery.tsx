import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { api, type Enrollment } from '../api';
import { emptyMfa, ErrorText, Link, MfaFields, mfaPayload, useSubmit } from '../ui';

function useToken() {
  return new URLSearchParams(window.location.search).get('token') ?? '';
}

function PasswordPair({ a, b, setA, setB }: { a: string; b: string; setA: (v: string) => void; setB: (v: string) => void }) {
  return (
    <>
      <label>New password (at least 14 characters)<input type="password" value={a} onChange={(e) => setA(e.target.value)} autoComplete="new-password" minLength={14} required /></label>
      <label>Repeat new password<input type="password" value={b} onChange={(e) => setB(e.target.value)} autoComplete="new-password" minLength={14} required /></label>
    </>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const s = useSubmit(() => api.post('/auth/password-reset/request', { email }), () => setDone(true));
  return (
    <div className="auth-page">
      <form className="card auth-card" onSubmit={s.submit}>
        <h1>Reset administrator password</h1>
        {done ? (
          <p>If that is the administrator address, a reset link has been sent to the designated recovery email. You will also need your authenticator or a recovery code.</p>
        ) : (
          <>
            <label>Administrator email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
            <ErrorText error={s.error} />
            <button className="primary" disabled={s.busy}>Send reset link</button>
          </>
        )}
        <p className="muted"><Link to="/">Back to sign-in</Link></p>
      </form>
    </div>
  );
}

export function ResetPassword() {
  const token = useToken();
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [mfa, setMfa] = useState(emptyMfa);
  const [done, setDone] = useState(false);
  const s = useSubmit(async () => {
    if (a !== b) throw new Error('The two passwords do not match.');
    await api.post('/auth/password-reset/confirm', { token, newPassword: a, ...mfaPayload(mfa) });
  }, () => setDone(true));
  return (
    <div className="auth-page">
      <form className="card auth-card" onSubmit={s.submit}>
        <h1>Choose a new password</h1>
        {done ? <p>Password changed. <Link to="/">Sign in</Link></p> : (
          <>
            <PasswordPair a={a} b={b} setA={setA} setB={setB} />
            <MfaFields value={mfa} onChange={setMfa} />
            <ErrorText error={s.error} />
            <button className="primary" disabled={s.busy || !token}>Change password</button>
          </>
        )}
      </form>
    </div>
  );
}

export function EnrollmentView({ e }: { e: Enrollment }) {
  const [qr, setQr] = useState('');
  useEffect(() => { QRCode.toDataURL(e.otpauthUri, { margin: 1, width: 220 }).then(setQr).catch(() => setQr('')); }, [e.otpauthUri]);
  return (
    <div className="enroll">
      <p><strong>1. Scan this with your authenticator app</strong>, or enter the key manually.</p>
      {qr && <img src={qr} alt="Authenticator QR code" width={220} height={220} />}
      <p className="mono">{e.secret}</p>
      <p><strong>2. Save these recovery codes offline.</strong> Each works once. They will not be shown again.</p>
      <ul className="codes">{e.recoveryCodes.map((c) => <li key={c} className="mono">{c}</li>)}</ul>
    </div>
  );
}

export function Emergency() {
  const token = useToken();
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const s = useSubmit(async () => {
    if (a !== b) throw new Error('The two passwords do not match.');
    return api.post<Enrollment>('/auth/emergency', { token, newPassword: a });
  }, setEnrollment);
  return (
    <div className="auth-page">
      <form className="card auth-card" onSubmit={s.submit}>
        <h1>Emergency administrator recovery</h1>
        {enrollment ? (
          <>
            <EnrollmentView e={enrollment} />
            <p><Link to="/">I have saved them — sign in</Link></p>
          </>
        ) : (
          <>
            <p className="muted">This replaces the administrator password and authenticator. All admin sessions will be signed out.</p>
            <PasswordPair a={a} b={b} setA={setA} setB={setB} />
            <ErrorText error={s.error} />
            <button className="primary" disabled={s.busy || !token}>Reset access</button>
          </>
        )}
      </form>
    </div>
  );
}
