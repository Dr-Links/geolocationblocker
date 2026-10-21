// Shared, dependency-free logic used by the backend, the admin web and the mobile app.
// Kept in a single file so every bundler (tsup, Vite, Metro) resolves it the same way.

// ---------------------------------------------------------------------------
// Gmail normalisation
// ---------------------------------------------------------------------------

export type GmailResult =
  | { ok: true; normalized: string; display: string }
  | { ok: false; reason: 'invalid_format' | 'not_gmail' };

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * Canonical form of a Gmail address so one mailbox maps to one platform account.
 * Gmail ignores dots in the local part and everything after "+", and treats
 * googlemail.com as gmail.com.
 */
export function normalizeGmail(input: string): GmailResult {
  const display = input.trim().toLowerCase();
  if (display.length > 254) return { ok: false, reason: 'invalid_format' };
  const at = display.lastIndexOf('@');
  if (at <= 0 || at !== display.indexOf('@')) return { ok: false, reason: 'invalid_format' };
  const local = display.slice(0, at);
  const domain = display.slice(at + 1);
  if (!/^[a-z0-9.+_-]+$/.test(local) || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    return { ok: false, reason: 'invalid_format' };
  }
  if (!GMAIL_DOMAINS.has(domain)) return { ok: false, reason: 'not_gmail' };
  const base = local.split('+')[0]!.replace(/\./g, '');
  if (!/^[a-z0-9]{1,64}$/.test(base)) return { ok: false, reason: 'invalid_format' };
  return { ok: true, normalized: `${base}@gmail.com`, display };
}

// ---------------------------------------------------------------------------
// Password policy (NIST 800-63B style: length + blocklist, no composition rules)
// ---------------------------------------------------------------------------

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 256;

const COMMON_PASSWORDS = new Set([
  '1234567890', '12345678910', '0123456789', '1111111111', '0000000000', 'qwertyuiop',
  'password12', 'password123', 'password1234', 'passw0rd123', 'iloveyou12', 'qwerty1234',
  'qwerty12345', 'abcdefghij', 'abc1234567', 'asdfghjkl1', 'letmein123', 'welcome123',
  'admin12345', 'administrator', 'football12', 'princess12', 'sunshine12', 'monkey1234',
  'dragon1234', 'baseball12', 'trustno1234', 'master1234', 'zaq12wsxcde', '1q2w3e4r5t',
  '1qaz2wsx3edc', 'q1w2e3r4t5', 'changeme123', 'superman12', 'starwars12', 'whatever12',
]);

export type PasswordProblem = 'too_short' | 'too_long' | 'too_common' | 'contains_email';

export function checkPassword(password: string, email?: string): PasswordProblem | null {
  if ([...password].length < PASSWORD_MIN_LENGTH) return 'too_short';
  if (password.length > PASSWORD_MAX_LENGTH) return 'too_long';
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower) || /^(.)\1+$/.test(lower)) return 'too_common';
  if (email) {
    const local = email.toLowerCase().split('@')[0] ?? '';
    if (local.length >= 4 && lower.includes(local.replace(/\./g, ''))) return 'contains_email';
  }
  return null;
}

export const PASSWORD_PROBLEM_TEXT: Record<PasswordProblem, string> = {
  too_short: `Use at least ${PASSWORD_MIN_LENGTH} characters.`,
  too_long: `Use at most ${PASSWORD_MAX_LENGTH} characters.`,
  too_common: 'This password is too common. Choose something harder to guess.',
  contains_email: 'Do not include your email address in your password.',
};

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Account status
// ---------------------------------------------------------------------------

export type UserStatus = 'pending' | 'approved' | 'suspended' | 'rejected' | 'deleting';
export type SuspensionReason = 'expired' | 'admin_action' | null;

/** What the user sees. "expired" = approved but past expiry, or suspended because it expired. */
export type DisplayStatus = 'pending' | 'active' | 'expired' | 'suspended' | 'rejected' | 'deleted';

export function displayStatus(
  status: UserStatus,
  suspensionReason: SuspensionReason,
  accessExpiresAt: string | Date | null,
  now: Date = new Date(),
): DisplayStatus {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'rejected':
      return 'rejected';
    case 'deleting':
      return 'deleted';
    case 'suspended':
      return suspensionReason === 'expired' ? 'expired' : 'suspended';
    case 'approved': {
      if (!accessExpiresAt) return 'expired';
      return new Date(accessExpiresAt).getTime() > now.getTime() ? 'active' : 'expired';
    }
  }
}

// ---------------------------------------------------------------------------
// API shapes
// ---------------------------------------------------------------------------

export interface Account {
  id: string;
  email: string;
  status: UserStatus;
  displayStatus: DisplayStatus;
  emailVerified: boolean;
  accessExpiresAt: string | null;
  approvedAt: string | null;
  timezone: string;
  createdAt: string;
}

export interface LoginResponse {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  account: Account;
}

export interface SessionInfo {
  id: string;
  current: boolean;
  deviceName: string | null;
  platform: string | null;
  createdAt: string;
  lastUsedAt: string;
  ip: string | null;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/** Stable error codes the clients switch on. */
export const ERROR_CODES = [
  'validation_failed', 'invalid_credentials', 'email_not_verified', 'account_rejected',
  'account_pending', 'account_suspended', 'account_expired', 'too_many_attempts',
  'unauthorized', 'session_revoked', 'not_found', 'invalid_token', 'weak_password',
  'mfa_required', 'invalid_mfa_code', 'csrf_failed', 'conflict', 'internal_error',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
