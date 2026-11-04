import * as SecureStore from 'expo-secure-store';

const REFRESH_KEY = 'refresh_token';

/** Phones: the refresh token is kept in the Android Keystore / iOS Keychain. */
export const tokenStore = {
  /** True when the server hands the token to the app (phones); false when it stays in an HttpOnly cookie (web). */
  holdsToken: true,
  get: () => SecureStore.getItemAsync(REFRESH_KEY),
  set: (token: string | null) => (token ? SecureStore.setItemAsync(REFRESH_KEY, token) : Promise.resolve()),
  clear: () => SecureStore.deleteItemAsync(REFRESH_KEY),
  hasSession: async () => (await SecureStore.getItemAsync(REFRESH_KEY)) !== null,
};
