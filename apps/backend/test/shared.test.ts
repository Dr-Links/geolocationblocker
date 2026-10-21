import { checkPassword, displayStatus, isValidTimeZone, normalizeGmail } from '@app/shared';
import { describe, expect, it } from 'vitest';

describe('normalizeGmail', () => {
  it('canonicalises dots, plus tags, case and googlemail.com', () => {
    for (const v of ['J.Doe@gmail.com', 'jdoe+work@gmail.com', ' j.d.o.e@GoogleMail.com ', 'JDOE@GMAIL.COM']) {
      const r = normalizeGmail(v);
      expect(r.ok && r.normalized).toBe('jdoe@gmail.com');
    }
  });
  it('rejects other domains and malformed input', () => {
    expect(normalizeGmail('a@yahoo.com')).toEqual({ ok: false, reason: 'not_gmail' });
    expect(normalizeGmail('a@gmail.com.evil.com')).toEqual({ ok: false, reason: 'not_gmail' });
    for (const v of ['', 'nobody', 'a@b@gmail.com', '+tag@gmail.com', '...@gmail.com', 'a b@gmail.com']) {
      expect(normalizeGmail(v).ok).toBe(false);
    }
  });
});

describe('checkPassword', () => {
  it('enforces length and blocklist', () => {
    expect(checkPassword('short')).toBe('too_short');
    expect(checkPassword('password123')).toBe('too_common');
    expect(checkPassword('aaaaaaaaaaaa')).toBe('too_common');
    expect(checkPassword('janedoe-secret-1', 'jane.doe@gmail.com')).toBe('contains_email');
    expect(checkPassword('correct horse battery')).toBeNull();
  });
});

describe('displayStatus', () => {
  const now = new Date('2027-01-01T00:00:00Z');
  it('derives what the user sees', () => {
    expect(displayStatus('approved', null, '2027-01-02T00:00:00Z', now)).toBe('active');
    expect(displayStatus('approved', null, '2027-01-01T00:00:00Z', now)).toBe('expired'); // boundary is exclusive
    expect(displayStatus('suspended', 'expired', null, now)).toBe('expired');
    expect(displayStatus('suspended', 'admin_action', null, now)).toBe('suspended');
    expect(displayStatus('pending', null, null, now)).toBe('pending');
  });
  it('validates IANA zones', () => {
    expect(isValidTimeZone('Africa/Lagos')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});
