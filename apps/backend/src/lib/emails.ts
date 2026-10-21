import type { OutgoingMail } from './mailer.js';

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function wrap(to: string, subject: string, paragraphs: string[], link?: { url: string; label: string }): OutgoingMail {
  const text = [...paragraphs, ...(link ? [`${link.label}: ${link.url}`] : []), '', '— Email Platform'].join('\n\n');
  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1f2933;line-height:1.5">
${paragraphs.map((p) => `<p>${escape(p)}</p>`).join('\n')}
${link ? `<p><a href="${escape(link.url)}" style="display:inline-block;padding:10px 18px;background:#1d4ed8;color:#fff;text-decoration:none;border-radius:6px">${escape(link.label)}</a></p><p style="font-size:12px;color:#52606d">Or paste this link into your browser: ${escape(link.url)}</p>` : ''}
<p style="font-size:12px;color:#52606d">— Email Platform</p></body></html>`;
  return { to, subject, text, html };
}

export function formatInZone(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  }).format(d);
}

export const emails = {
  verify: (to: string, url: string) =>
    wrap(to, 'Confirm your email address', [
      'Thanks for registering. Please confirm that this Gmail address belongs to you.',
      'This link expires in 24 hours. If you did not register, you can ignore this email.',
    ], { url, label: 'Confirm email address' }),

  alreadyRegistered: (to: string, resetUrl: string) =>
    wrap(to, 'You already have an account', [
      'Someone (hopefully you) tried to register with this Gmail address, but an account already exists.',
      'If you forgot your password, you can reset it.',
    ], { url: resetUrl, label: 'Reset password' }),

  passwordReset: (to: string, url: string) =>
    wrap(to, 'Reset your password', [
      'We received a request to reset your password. This link expires in 30 minutes and can be used once.',
      'If you did not request this, you can ignore this email; your password will not change.',
    ], { url, label: 'Choose a new password' }),

  passwordChanged: (to: string) =>
    wrap(to, 'Your password was changed', [
      'The password for your account was just changed and all other sessions were signed out.',
      'If you did not do this, reset your password immediately and contact the administrator.',
    ]),

  adminNewRegistration: (to: string, userEmail: string, adminUrl: string) =>
    wrap(to, `New registration pending approval: ${userEmail}`, [
      `${userEmail} has verified their email address and is waiting for approval.`,
    ], { url: adminUrl, label: 'Open admin dashboard' }),

  approved: (to: string, expiresAt: Date, tz: string) =>
    wrap(to, 'Your account has been approved', [
      'Your account is now active. You can sign in to the app.',
      `Your current access period ends on ${formatInZone(expiresAt, tz)}.`,
    ]),

  renewed: (to: string, expiresAt: Date, tz: string) =>
    wrap(to, 'Your access has been renewed', [
      `Your access period now ends on ${formatInZone(expiresAt, tz)}.`,
      'Any scheduled messages that were paused stay paused until you review them in the app.',
    ]),

  rejected: (to: string) =>
    wrap(to, 'Your registration was not approved', [
      'Your registration was not approved. If you think this is a mistake, contact the administrator.',
    ]),

  suspended: (to: string) =>
    wrap(to, 'Your account has been suspended', [
      'Your account has been suspended by the administrator. Your stored data has not been deleted.',
      'Contact the administrator to restore access.',
    ]),

  expiringSoon: (to: string, expiresAt: Date, tz: string) =>
    wrap(to, 'Your access period ends soon', [
      `Your access period ends on ${formatInZone(expiresAt, tz)}.`,
      'Contact the administrator to renew before then. Your data is kept if access lapses.',
    ]),

  expired: (to: string) =>
    wrap(to, 'Your access period has ended', [
      'Your access period has ended and your account is now suspended. Your stored data has not been deleted.',
      'Contact the administrator to renew your access.',
    ]),

  adminExpired: (to: string, userEmails: string[]) =>
    wrap(to, `${userEmails.length} account(s) expired`, [
      `These accounts reached the end of their access period and were suspended: ${userEmails.join(', ')}.`,
    ]),

  adminPasswordReset: (to: string, url: string) =>
    wrap(to, 'Administrator password reset', [
      'A password reset was requested for the administrator account. The link expires in 30 minutes.',
      'You will also need your authenticator code or a recovery code.',
      'If you did not request this, someone may be trying to access the admin account.',
    ], { url, label: 'Reset administrator password' }),
};
