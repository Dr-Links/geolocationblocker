// Thin fetch wrapper for the admin API: same-origin cookies + CSRF header on writes.

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

function csrfToken(): string {
  const m = document.cookie.match(/(?:^|;\s*)(?:__Host-)?adm_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]!) : '';
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = csrfToken();
  const res = await fetch(`/admin/api${path}`, {
    method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } }).error;
    if (res.status === 401 && path !== '/auth/login' && path !== '/auth/mfa') window.dispatchEvent(new Event('admin:signed-out'));
    throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown = {}) => request<T>('PATCH', path, body),
};

export interface UserSummary {
  id: string;
  email: string;
  status: string;
  displayStatus: string;
  emailVerified: boolean;
  accessExpiresAt: string | null;
  approvedAt: string | null;
  timezone: string;
  createdAt: string;
  suspensionReason: string | null;
  lastLoginAt: string | null;
}

export interface UserDetail {
  user: UserSummary & { suspendedAt: string | null; rejectedAt: string | null; storageQuotaBytes: number | null; effectiveQuotaBytes: number | null };
  accessPeriods: Array<{ kind: string; startsAt: string; endsAt: string; timezone: string; paymentNote: string | null; createdAt: string }>;
  sessions: Array<{ id: string; kind: string; createdAt: string; lastUsedAt: string; ip: string | null; deviceName: string | null; platform: string | null }>;
  mailboxes: unknown[];
  activity: Array<{ occurredAt: string; actorType: string; action: string; details: unknown }>;
}

export interface Enrollment {
  secret: string;
  otpauthUri: string;
  recoveryCodes: string[];
}

export const fmt = (iso: string | null | undefined, timeZone?: string) =>
  iso
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', ...(timeZone ? { timeZone } : {}) }).format(new Date(iso))
    : '—';

export const GB = 1024 ** 3;
