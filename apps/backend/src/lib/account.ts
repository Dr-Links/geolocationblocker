import { displayStatus, type Account, type SuspensionReason, type UserStatus } from '@app/shared';

export interface UserRow {
  id: string;
  email_display: string;
  email_normalized: string;
  role: 'user' | 'admin';
  status: UserStatus;
  suspension_reason: SuspensionReason;
  timezone: string;
  email_verified_at: Date | null;
  approved_at: Date | null;
  access_expires_at: Date | null;
  created_at: Date;
  password_hash: string;
  failed_login_count: number;
  locked_until: Date | null;
}

export const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toAccount(u: UserRow, now = new Date()): Account {
  return {
    id: u.id,
    email: u.email_display,
    status: u.status,
    displayStatus: displayStatus(u.status, u.suspension_reason, u.access_expires_at, now),
    emailVerified: u.email_verified_at !== null,
    accessExpiresAt: iso(u.access_expires_at),
    approvedAt: iso(u.approved_at),
    timezone: u.timezone,
    createdAt: u.created_at.toISOString(),
  };
}
