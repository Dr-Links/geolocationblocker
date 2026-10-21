import { useState } from 'react';
import { api } from '../api';
import { emptyMfa, ErrorText, Link, MfaFields, mfaPayload, useSubmit } from '../ui';

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [step, setStep] = useState<'password' | 'mfa'>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfa, setMfa] = useState(emptyMfa);

  const pw = useSubmit(() => api.post('/auth/login', { email, password }), () => { setPassword(''); setStep('mfa'); });
  const second = useSubmit(() => api.post('/auth/mfa', mfaPayload(mfa)), onSignedIn);

  return (
    <div className="auth-page">
      <form className="card auth-card" onSubmit={step === 'password' ? pw.submit : second.submit}>
        <h1>Administrator sign-in</h1>
        {step === 'password' ? (
          <>
            <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required autoFocus /></label>
            <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></label>
            <ErrorText error={pw.error} />
            <button className="primary" disabled={pw.busy}>{pw.busy ? 'Checking…' : 'Continue'}</button>
            <p className="muted"><Link to="/forgot">Forgot password?</Link></p>
          </>
        ) : (
          <>
            <p className="muted">Enter the 6-digit code from your authenticator app.</p>
            <MfaFields value={mfa} onChange={setMfa} />
            <ErrorText error={second.error} />
            <button className="primary" disabled={second.busy}>{second.busy ? 'Verifying…' : 'Sign in'}</button>
            <button type="button" className="linklike" onClick={() => { setStep('password'); setMfa(emptyMfa); }}>Start again</button>
          </>
        )}
      </form>
    </div>
  );
}
