import type { Account, ApiErrorBody, ComposeSuggestion, FolderDto, OutboundDto, LoginResponse, MailboxDto, MessageAction, MessageDetail, MessageSummary, ServerSettingsDto, SessionInfo } from '@app/shared';
import * as Device from 'expo-device';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { API_URL, APP_VERSION } from './config';

const REFRESH_KEY = 'refresh_token';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export interface CertificatePin {
  sha256: string;
  pem: string;
}

export interface ConnectInput {
  email: string;
  password: string;
  smtpPassword?: string;
  displayName?: string;
  manual?: { imap: ServerSettingsDto; smtp: ServerSettingsDto };
  trustCertificate?: { imap?: CertificatePin; smtp?: CertificatePin };
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
    throw new ApiError(res.status, data.error?.code ?? 'error', data.error?.message ?? `Request failed (${res.status})`, data.error?.details);
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

/** Headers for requests made outside fetch (file downloads). Refreshes the session if needed. */
export async function authHeaders(): Promise<Record<string, string>> {
  if (!accessToken && !(await refreshSession())) throw new ApiError(401, 'unauthorized', 'Please sign in.');
  return { authorization: `Bearer ${accessToken}` };
}

export interface MessageListQuery {
  view: 'inbox' | 'sent' | 'folder' | 'stored_only' | 'flagged';
  mailboxId?: string;
  folderId?: string;
  unread?: boolean;
  before?: string | null;
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
  mailboxes: () => authed<{ mailboxes: MailboxDto[] }>('GET', '/v1/mailboxes'),
  mailbox: (id: string) => authed<{ mailbox: MailboxDto; events: Array<{ category: string; severity: string; code: string; detail: string | null; occurredAt: string; resolvedAt: string | null }> }>('GET', `/v1/mailboxes/${id}`),
  connectMailbox: (input: ConnectInput) => authed<{ mailbox: MailboxDto }>('POST', '/v1/mailboxes', input),
  updateMailboxConnection: (id: string, input: Omit<ConnectInput, 'email' | 'displayName'>) =>
    authed<{ mailbox: MailboxDto }>('PUT', `/v1/mailboxes/${id}/connection`, input),
  renameMailbox: (id: string, displayName: string | null) => authed<{ mailbox: MailboxDto }>('PATCH', `/v1/mailboxes/${id}`, { displayName }),
  testMailbox: (id: string) => authed<{ mailbox: MailboxDto }>('POST', `/v1/mailboxes/${id}/test`, {}),
  folders: (mailboxId: string) => authed<{ folders: FolderDto[] }>('GET', `/v1/mailboxes/${mailboxId}/folders`),
  messages: (q: MessageListQuery) => {
    const p = new URLSearchParams({ view: q.view });
    if (q.mailboxId) p.set('mailboxId', q.mailboxId);
    if (q.folderId) p.set('folderId', q.folderId);
    if (q.unread) p.set('unread', '1');
    if (q.before) p.set('before', q.before);
    return authed<{ messages: MessageSummary[]; nextCursor: string | null }>('GET', `/v1/messages?${p}`);
  },
  message: (id: string, remoteImages = false) => authed<{ message: MessageDetail }>('GET', `/v1/messages/${id}${remoteImages ? '?remoteImages=1' : ''}`),
  messageAction: (id: string, action: MessageAction, extra: { folderId?: string; confirm?: boolean; clientOpId?: string } = {}) =>
    authed<{ message: MessageSummary | null; appliedOnServer: boolean; note: string | null }>('POST', `/v1/messages/${id}/actions`, { action, ...extra }),
  composeSuggestion: (messageId: string, mode: 'reply' | 'reply_all' | 'forward') =>
    authed<ComposeSuggestion>('GET', `/v1/messages/${messageId}/compose?mode=${mode}`),
  send: (input: {
    mailboxId: string; mode: 'new' | 'reply' | 'reply_all' | 'forward'; sourceMessageId?: string; to: string[]; cc: string[]; bcc: string[];
    subject: string; text: string; idempotencyKey: string; confirmVisibleRecipients?: boolean; allowDifferentSender?: boolean;
  }) => authed<{ outbound: OutboundDto }>('POST', '/v1/outbound', input),
  undoSend: (id: string) => authed<{ outbound: OutboundDto }>('POST', `/v1/outbound/${id}/undo`, {}),
  retrySend: (id: string, confirmPossibleDuplicate = false) => authed<{ outbound: OutboundDto }>('POST', `/v1/outbound/${id}/retry`, { confirmPossibleDuplicate }),
  discardSend: (id: string) => authed<{ outbound: OutboundDto }>('POST', `/v1/outbound/${id}/discard`, {}),
  outbox: (filter: 'outbox' | 'problems' | 'all' = 'outbox') => authed<{ outbound: OutboundDto[] }>('GET', `/v1/outbound?filter=${filter}`),
  attachmentUrl: (messageId: string, attachmentId: string) => `${API_URL}/v1/messages/${messageId}/attachments/${attachmentId}`,
  disconnectMailbox: (id: string, mode: 'keep' | 'delete', confirmEmail: string) =>
    authed<{ ok: true }>('POST', `/v1/mailboxes/${id}/disconnect`, { mode, confirmEmail }),
};
