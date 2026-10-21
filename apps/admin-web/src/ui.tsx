import { useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from './api';
import { navigate } from './router';

export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return (
    <a href={to} className={className} onClick={(e) => { e.preventDefault(); navigate(to); }}>
      {children}
    </a>
  );
}

export function StatusBadge({ status, verified = true }: { status: string; verified?: boolean }) {
  const label = status === 'pending' && !verified ? 'unverified' : status;
  return <span className={`badge badge-${label}`}>{label}</span>;
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof ApiError || error instanceof Error ? error.message : String(error);
  return <p className="error" role="alert">{msg}</p>;
}

/** Form wrapper that handles submitting/error state. */
export function useSubmit<T>(fn: () => Promise<T>, onDone?: (r: T) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      onDone?.(r);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function MfaFields({ value, onChange }: { value: { code: string; recoveryCode: string; useRecovery: boolean }; onChange: (v: { code: string; recoveryCode: string; useRecovery: boolean }) => void }) {
  return value.useRecovery ? (
    <label>
      Recovery code
      <input value={value.recoveryCode} onChange={(e) => onChange({ ...value, recoveryCode: e.target.value })} autoComplete="off" required />
      <button type="button" className="linklike" onClick={() => onChange({ ...value, useRecovery: false })}>Use authenticator code instead</button>
    </label>
  ) : (
    <label>
      Authenticator code
      <input value={value.code} onChange={(e) => onChange({ ...value, code: e.target.value })} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required />
      <button type="button" className="linklike" onClick={() => onChange({ ...value, useRecovery: true })}>Use a recovery code</button>
    </label>
  );
}

export const mfaPayload = (v: { code: string; recoveryCode: string; useRecovery: boolean }) =>
  v.useRecovery ? { recoveryCode: v.recoveryCode } : { code: v.code };

export const emptyMfa = { code: '', recoveryCode: '', useRecovery: false };
