import type { Account } from '@app/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setSignedOutHandler } from './api';
import { deviceTimeZone } from './format';

type AuthState =
  | { kind: 'loading' }
  | { kind: 'signedOut' }
  | { kind: 'error'; message: string }
  | { kind: 'signedIn'; account: Account };

interface AuthApi {
  state: AuthState;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  /** Re-reads account status from the server (e.g. "Check again" on the pending screen). */
  reload(): Promise<void>;
}

const Ctx = createContext<AuthApi | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ kind: 'loading' });

  const reload = useCallback(async () => {
    try {
      const { account } = await api.me();
      setState({ kind: 'signedIn', account });
      // Keep the account's time zone in line with the phone (used for the next access period).
      const tz = deviceTimeZone();
      if (tz && tz !== account.timezone) {
        api.updateTimezone(tz).then((r) => setState({ kind: 'signedIn', account: r.account })).catch(() => undefined);
      }
    } catch (err) {
      if (!(await api.hasStoredSession())) setState({ kind: 'signedOut' });
      else setState({ kind: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' });
    }
  }, []);

  useEffect(() => {
    setSignedOutHandler(() => setState({ kind: 'signedOut' }));
    (async () => {
      if (await api.hasStoredSession()) await reload();
      else setState({ kind: 'signedOut' });
    })();
  }, [reload]);

  const value = useMemo<AuthApi>(() => ({
    state,
    reload,
    async signIn(email, password) {
      const account = await api.login(email, password);
      setState({ kind: 'signedIn', account });
    },
    async signOut() {
      await api.logout().catch(() => undefined);
      setState({ kind: 'signedOut' });
    },
  }), [state, reload]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
