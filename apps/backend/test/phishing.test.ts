import { describe, expect, it } from 'vitest';
import { analyseMessage, linkProblems, lookalikeOf, registrableDomain } from '../src/security/phishing.js';

const base = { fromAddress: 'news@shop.example', fromName: 'Shop', replyTo: [], authResults: null, attachmentRisks: [], html: null };

describe('phishing heuristics', () => {
  it('finds registrable domains', () => {
    expect(registrableDomain('mail.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('a.b.example.com')).toBe('example.com');
  });

  it('detects lookalike domains but not the real ones', () => {
    for (const d of ['paypa1.com', 'g00gle.net', 'rnicrosoft.com', 'xn--pypal-4ve.com', 'paypal-secure-login.com', 'microsofl.com', 'arnazon.com']) {
      expect(lookalikeOf(d), d).not.toBeNull();
    }
    for (const d of ['paypal.com', 'www.paypal.com', 'accounts.google.com', 'mail.example.org', 'mapple.org', 'goodlife.dev', 'appleton.edu', 'allwebmails.com']) {
      expect(lookalikeOf(d), d).toBeNull();
    }
  });

  it('flags links whose text shows another site', () => {
    expect(linkProblems('<a href="https://evil.example/login">https://www.paypal.com/login</a>').map((r) => r.code)).toEqual(['link_mismatch']);
    expect(linkProblems('<a href="https://www.paypal.com/x">www.paypal.com</a><a href="https://shop.example">Click here</a>')).toEqual([]);
    expect(linkProblems('<a href="http://192.0.2.7/a">Track parcel</a>').map((r) => r.code)).toEqual(['ip_link']);
    expect(linkProblems('<a href="https://paypa1.com/a">Log in</a>').map((r) => r.code)).toEqual(['lookalike_link']);
  });

  it('rates whole messages', () => {
    expect(analyseMessage(base)).toEqual({ level: 'none', reasons: [] });
    expect(analyseMessage({ ...base, fromName: 'support@paypal.com' }).level).toBe('danger');
    expect(analyseMessage({ ...base, authResults: { dmarc: 'fail' } }).reasons[0]!.code).toBe('dmarc_fail');
    expect(analyseMessage({ ...base, replyTo: ['collect@elsewhere.example'] })).toEqual({ level: 'caution', reasons: [{ code: 'reply_to_differs', detail: 'elsewhere.example' }] });
    expect(analyseMessage({ ...base, replyTo: ['help@shop.example'] }).level).toBe('none');
    expect(analyseMessage({ ...base, fromAddress: 'service@paypa1.com' }).level).toBe('danger');
    expect(analyseMessage({ ...base, attachmentRisks: ['dangerous'] }).level).toBe('danger');
  });
});
