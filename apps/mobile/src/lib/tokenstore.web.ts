// Web app: the refresh token lives in an HttpOnly, SameSite=Strict cookie set by the server, so page scripts
// (and anything injected into them) can never read it. Only a harmless "signed in" hint is kept locally.
const HINT = 'awm_signed_in';
const hint = {
  get: () => { try { return localStorage.getItem(HINT) === '1'; } catch { return false; } },
  set: (on: boolean) => { try { if (on) localStorage.setItem(HINT, '1'); else localStorage.removeItem(HINT); } catch { /* private mode */ } },
};

export const tokenStore = {
  holdsToken: false,
  get: async (): Promise<string | null> => null,
  set: async (_token: string | null) => { hint.set(true); },
  clear: async () => { hint.set(false); },
  hasSession: async () => hint.get(),
};
