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
  'mfa_required', 'invalid_mfa_code', 'csrf_failed', 'conflict', 'internal_error', 'mailbox_connect_failed',
  'limit_reached',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// Mailboxes
// ---------------------------------------------------------------------------

export type MailboxStatus = 'active' | 'auth_failed' | 'error' | 'paused_account' | 'disconnected';
export type Security = 'tls' | 'starttls';

export interface ServerSettingsDto {
  host: string;
  port: number;
  security: Security;
  username: string;
}

export interface MailboxDto {
  id: string;
  email: string;
  displayName: string | null;
  labelColor: string | null;
  provider: string;
  status: MailboxStatus;
  statusDetail: string | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  nextRetryAt: string | null;
  lastVerifiedAt: string | null;
  lastIncomingAt: string | null;
  createdAt: string;
  disconnectedAt: string | null;
  maxMessageBytes: number | null;
  settings: (({ imap: ServerSettingsDto; smtp: ServerSettingsDto }) & {
    discoveredVia: string;
    trustedCertificate: { imap: boolean; smtp: boolean };
  }) | null;
}

export interface CertificateDto {
  subject: string | null;
  altNames: string[];
  issuer: string | null;
  validTo: string | null;
  fingerprint256: string;
  pem: string;
}

/** `error.details` of a 422 mailbox_connect_failed response. */
export interface ConnectFailureDetails {
  stage: 'imap' | 'smtp';
  reason: string;
  certificate?: CertificateDto;
  provider?: { name: string; requiresAppPassword: boolean; requiresOAuth: boolean; helpUrl?: string };
  triedAutomatic: boolean;
}

export const MAILBOX_STATUS_TEXT: Record<MailboxStatus, string> = {
  active: 'Connected',
  auth_failed: 'Password needed',
  error: 'Connection problem — retrying',
  paused_account: 'Paused (account inactive)',
  disconnected: 'Disconnected',
};

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface MessageSummary {
  id: string;
  mailbox: { id: string; email: string; displayName: string | null; labelColor: string | null; status: MailboxStatus };
  threadId: string;
  subject: string | null;
  from: { address: string; name: string | null } | null;
  toSummary: string | null;
  receivedAt: string;
  snippet: string | null;
  isSeen: boolean;
  isFlagged: boolean;
  isAnswered: boolean;
  hasAttachments: boolean;
  priority: 'high' | 'normal' | 'low';
  /** A user action has not been confirmed by the mail server yet. */
  pendingSync: boolean;
  /** False when the message was deleted on the server and only the platform copy remains. */
  onServer: boolean;
}

export interface AddressDto { address: string; name: string | null }

export interface MessageDetail extends MessageSummary {
  messageIdHeader: string | null;
  sentAt: string | null;
  sizeBytes: number | null;
  to: AddressDto[];
  cc: AddressDto[];
  bcc: AddressDto[];
  replyTo: AddressDto[];
  fromList: AddressDto[];
  authResults: { spf?: string; dkim?: string; dmarc?: string } | null;
  folders: Array<{ id: string; name: string; specialUse: string | null }>;
  body: { text: string | null; html: string | null; hasRemoteContent: boolean; remoteContentShown: boolean } | null;
  bodyError: string | null;
  attachments: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number; isInline: boolean; risk: 'unknown' | 'low' | 'elevated' | 'dangerous'; contentId: string | null }>;
}

export interface FolderDto {
  id: string;
  path: string;
  name: string;
  specialUse: string | null;
  serverCount: number;
  unread: number;
  stored: number;
  lastSyncedAt: string | null;
  syncComplete: boolean;
  selectable: boolean;
}

export type MessageAction = 'mark_read' | 'mark_unread' | 'flag' | 'unflag' | 'archive' | 'trash' | 'spam' | 'not_spam' | 'move' | 'delete_forever';

// ---------------------------------------------------------------------------
// Outgoing mail
// ---------------------------------------------------------------------------

export type OutboundStatus = 'pending_undo' | 'scheduled' | 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled' | 'uncertain' | 'paused_suspended';

export interface OutboundDto {
  id: string;
  mailbox: { id: string; email: string };
  status: OutboundStatus;
  kind: 'new' | 'reply' | 'reply_all' | 'forward';
  subject: string | null;
  toSummary: string | null;
  recipientCount: number;
  releaseAt: string | null;
  scheduledAt: string | null;
  sentAt: string | null;
  attemptCount: number;
  nextAttemptAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  sentCopy: 'pending' | 'not_needed' | 'appended' | 'failed';
  canUndo: boolean;
  createdAt: string;
}

export const OUTBOUND_STATUS_TEXT: Record<OutboundStatus, string> = {
  pending_undo: 'Sending soon (can be undone)',
  scheduled: 'Scheduled',
  queued: 'Waiting to send',
  sending: 'Sending…',
  sent: 'Sent to the mail server',
  failed: 'Not sent',
  cancelled: 'Cancelled',
  uncertain: 'Delivery uncertain',
  paused_suspended: 'Paused while the account was inactive',
};

export interface ComposeSuggestion {
  mailboxId: string;
  mode: 'reply' | 'reply_all' | 'forward';
  to: AddressDto[];
  cc: AddressDto[];
  subject: string;
  quoteAttribution: string;
}

// ---------------------------------------------------------------------------
// Conversations and search
// ---------------------------------------------------------------------------

export interface ThreadSummary {
  id: string;
  latest: MessageSummary;
  messageCount: number;
  unreadCount: number;
  isFlagged: boolean;
  hasAttachments: boolean;
  mailboxes: string[];
  participants: string[];
}

export interface SearchFilters {
  q?: string;
  from?: string;
  to?: string;
  subject?: string;
  mailboxId?: string;
  in?: 'any' | 'inbox' | 'sent' | 'archive' | 'trash' | 'junk' | 'drafts';
  unread?: '1' | '0';
  flagged?: '1' | '0';
  hasAttachments?: '1' | '0';
  dateFrom?: string;
  dateTo?: string;
}

export interface SavedSearch {
  id: string;
  name: string;
  query: SearchFilters;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Composer: uploads, signatures, templates, drafts
// ---------------------------------------------------------------------------

export interface UploadDto { id: string; filename: string; mimeType: string; sizeBytes: number; risk: 'low' | 'elevated' | 'dangerous' }
export interface SignatureDto { id: string; name: string; text: string; html: string | null; defaultFor: string[] }
export interface TemplateDto { id: string; kind: 'template' | 'quick_reply'; name: string; subject: string | null; text: string; html: string | null }
export interface DraftDto {
  id: string; mailboxId: string; mode: 'new' | 'reply' | 'reply_all' | 'forward'; sourceMessageId: string | null;
  to: string[]; cc: string[]; bcc: string[]; subject: string; text: string; html: string | null; signatureId: string | null;
  uploadIds: string[]; version: number; updatedByDevice: string | null; updatedAt: string; createdAt: string;
}
