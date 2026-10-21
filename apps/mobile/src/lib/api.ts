import type { Account, ApiErrorBody, LoginResponse, SessionInfo } from '@app/shared';
import * as Device from 'expo-device';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { API_URL, APP_VERSION } from './config';

const REFRESH_KEY = 'refresh_token';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

// The access token lives only in memory; the refresh token is kept in the
// Android Keystore / iOS Keychain via SecureStore.
let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
let onSignedOut: (() => void) | null = null;

export function setSignedOutHandler(fn: () => void) {
  onSignedOut = fn;
}

async function raw<T>(method: string, path: string, body?: unknown, token?: string | null): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network_error', 'Cannot reach the server. Check your internet connection.');
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as Partial<ApiErrorBody> & T;
  if (!res.ok) {
    throw new ApiError(res.status, data.error?.code ?? 'error', data.error?.message ?? `Request failed (${res.status})`);
  }
  return data;
}

async function storeSession(r: LoginResponse) {
  accessToken = r.accessToken;
  await SecureStore.setItemAsync(REFRESH_KEY, r.refreshToken);
}

/** Single-flight refresh: concurrent callers share one request so a rotated token is never replayed. */
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const token = await SecureStore.getItemAsync(REFRESH_KEY);
      if (!token) return false;
      const r = await raw<LoginResponse>('POST', '/v1/auth/refresh', { refreshToken: token });
      await storeSession(r);
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        await clearSession();
        return false;
      }
      throw err;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function clearSession() {
  accessToken = null;
  await SecureStore.deleteItemAsync(REFRESH_KEY);
}

async function authed<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!accessToken && !(await refreshSession())) {
    onSignedOut?.();
    throw new ApiError(401, 'unauthorized', 'Please sign in.');
  }
  try {
    return await raw<T>(method, path, body, accessToken);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      if (await refreshSession()) return raw<T>(method, path, body, accessToken);
      onSignedOut?.();
    }
    throw err;
  }
}

export const api = {
  register: (email: string, password: string, timezone: string) =>
    raw<{ message: string }>('POST', '/v1/auth/register', { email, password, timezone }),
  resendVerification: (email: string) => raw<{ message: string }>('POST', '/v1/auth/resend-verification', { email }),
  requestPasswordReset: (email: string) => raw<{ message: string }>('POST', '/v1/auth/password-reset/request', { email }),
  async login(email: string, password: string): Promise<Account> {
    const r = await raw<LoginResponse>('POST', '/v1/auth/login', {
      email,
      password,
      device: {
        platform: Platform.OS === 'ios' ? 'ios' : 'android',
        name: (Device.deviceName ?? Device.modelName ?? undefined)?.slice(0, 100),
        appVersion: APP_VERSION,
      },
    });
    await storeSession(r);
    return r.account;
  },
  async logout() {
    try {
      if (accessToken) await raw('POST', '/v1/auth/logout', undefined, accessToken);
    } finally {
      await clearSession();
    }
  },
  hasStoredSession: async () => (await SecureStore.getItemAsync(REFRESH_KEY)) !== null,
  me: () => authed<{ account: Account; accessPeriods: Array<{ kind: string; startsAt: string; endsAt: string }> }>('GET', '/v1/me'),
  updateTimezone: (timezone: string) => authed<{ account: Account }>('PATCH', '/v1/me', { timezone }),
  changePassword: (currentPassword: string, newPassword: string) =>
    authed<{ message: string }>('POST', '/v1/me/password', { currentPassword, newPassword }),
  sessions: () => authed<{ sessions: SessionInfo[] }>('GET', '/v1/me/sessions'),
  revokeSession: (id: string) => authed<void>('DELETE', `/v1/me/sessions/${id}`),
  config: () => raw<{ minimumSupportedAppVersion: string }>('GET', '/v1/config'),
};
