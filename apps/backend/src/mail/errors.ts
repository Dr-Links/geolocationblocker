/** Classified connection problems, with wording a non-technical user can act on. */
export type MailErrorCode =
  | 'AUTH_FAILED' | 'HOST_NOT_FOUND' | 'BLOCKED_ADDRESS' | 'PORT_NOT_ALLOWED' | 'CONNECT_TIMEOUT'
  | 'CONNECT_REFUSED' | 'TLS_UNTRUSTED' | 'TLS_HOSTNAME_MISMATCH' | 'TLS_FAILED' | 'STARTTLS_UNAVAILABLE'
  | 'PROTOCOL_ERROR' | 'SEND_REJECTED' | 'UNKNOWN';

export interface CertificateInfo {
  subject: string | null;
  altNames: string[];
  issuer: string | null;
  validTo: string | null;
  fingerprint256: string;
  pem: string;
}

export class MailError extends Error {
  constructor(
    public readonly code: MailErrorCode,
    message: string,
    public readonly stage: 'imap' | 'smtp',
    public readonly certificate?: CertificateInfo,
    /** Temporary problems are retried with backoff; permanent ones need the user. */
    public readonly temporary = false,
  ) {
    super(message);
  }
}

const TEXT: Record<MailErrorCode, (host: string, port: number) => string> = {
  AUTH_FAILED: () => 'The server rejected the username or password. If you changed the mailbox password at your email provider, enter the new one. Some providers (e.g. Gmail, Yahoo) require an app password.',
  HOST_NOT_FOUND: (h) => `The server name "${h}" could not be found. Check the spelling.`,
  BLOCKED_ADDRESS: (h) => `"${h}" points to a private network address, which is not allowed.`,
  PORT_NOT_ALLOWED: (_h, p) => `Port ${p} is not a mail port. Use 993 or 143 for incoming, 465 or 587 for outgoing mail.`,
  CONNECT_TIMEOUT: (h, p) => `No answer from ${h} on port ${p}. The server may be down, or the port may be wrong or blocked.`,
  CONNECT_REFUSED: (h, p) => `${h} refused the connection on port ${p}. The port is probably wrong.`,
  TLS_UNTRUSTED: (h) => `The security certificate of ${h} is not from a trusted authority.`,
  TLS_HOSTNAME_MISMATCH: (h) => `The security certificate presented by ${h} is issued for a different name.`,
  TLS_FAILED: (h, p) => `A secure connection to ${h}:${p} could not be established. Try the other encryption setting (SSL/TLS or STARTTLS).`,
  STARTTLS_UNAVAILABLE: (h) => `${h} does not offer STARTTLS encryption on this port. Try SSL/TLS on port 993 (incoming) or 465 (outgoing).`,
  PROTOCOL_ERROR: (h, p) => `${h}:${p} answered, but not like a mail server. Check the port and encryption settings.`,
  SEND_REJECTED: (h) => `${h} rejected the message.`,
  UNKNOWN: (h, p) => `Could not connect to ${h}:${p}.`,
};

export function mailError(code: MailErrorCode, stage: 'imap' | 'smtp', host: string, port: number, cert?: CertificateInfo): MailError {
  const temporary = code === 'CONNECT_TIMEOUT' || code === 'CONNECT_REFUSED' || code === 'UNKNOWN' || code === 'PROTOCOL_ERROR';
  return new MailError(code, TEXT[code](host, port), stage, cert, temporary);
}

/** Maps errors thrown by Node, ImapFlow and Nodemailer to a MailErrorCode. */
export function classify(err: unknown): MailErrorCode {
  const e = err as { code?: string; authenticationFailed?: boolean; responseCode?: number; message?: string; reason?: string };
  const code = e?.code ?? '';
  const msg = `${e?.message ?? ''} ${e?.reason ?? ''}`;
  if (e?.authenticationFailed || code === 'EAUTH' || e?.responseCode === 535 || /AUTHENTICATIONFAILED|Invalid credentials|authentication failed/i.test(msg)) return 'AUTH_FAILED';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ENODATA') return 'HOST_NOT_FOUND';
  if (code === 'ECONNREFUSED') return 'CONNECT_REFUSED';
  if (code === 'ETIMEDOUT' || code === 'ETIMEOUT' || code === 'CONNECT_TIMEOUT' || /timed? ?out/i.test(msg)) return 'CONNECT_TIMEOUT';
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID' || /Hostname\/IP does not match/i.test(msg)) return 'TLS_HOSTNAME_MISMATCH';
  if (['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(code)) return 'TLS_UNTRUSTED';
  if (/STARTTLS/i.test(msg) && /not|unavailable|support/i.test(msg)) return 'STARTTLS_UNAVAILABLE';
  if (code === 'ESOCKET' || code === 'ECONNRESET' || /wrong version number|SSL routines|EPROTO/i.test(msg) || code === 'EPROTO') return 'TLS_FAILED';
  if (code === 'EPROTOCOL' || code === 'ProtocolError' || /Unexpected|greeting/i.test(msg)) return 'PROTOCOL_ERROR';
  return 'UNKNOWN';
}
