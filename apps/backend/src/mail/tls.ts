import { X509Certificate } from 'node:crypto';
import { checkServerIdentity, connect, rootCertificates, type ConnectionOptions, type PeerCertificate } from 'node:tls';
import type { Config } from '../lib/config.js';
import type { CertificateInfo } from './errors.js';
import type { ResolvedTarget } from './net.js';

export interface Pin {
  sha256: string;
  pem: string;
}

/**
 * TLS options for a mail connection. Certificates are always verified. When the user has
 * explicitly trusted one certificate (after seeing a warning), only that exact certificate
 * is additionally accepted; verification is never simply switched off.
 */
export function tlsOptions(cfg: Config, target: ResolvedTarget, pin?: Pin | null): ConnectionOptions {
  const extra = [cfg.mail.extraCaPem, pin?.pem].filter((x): x is string => !!x);
  return {
    servername: target.host,
    minVersion: 'TLSv1.2',
    rejectUnauthorized: true,
    ...(extra.length ? { ca: [...rootCertificates, ...extra] } : {}),
    checkServerIdentity: (host, cert) => {
      if (pin && cert.fingerprint256 === pin.sha256) return undefined;
      return checkServerIdentity(host, cert);
    },
  };
}

function describe(cert: PeerCertificate): CertificateInfo | undefined {
  if (!cert?.raw) return undefined;
  const x = new X509Certificate(cert.raw);
  const alt = (cert.subjectaltname ?? '').split(',').map((s) => s.trim().replace(/^DNS:/, '')).filter(Boolean);
  return {
    subject: cert.subject?.CN ? String(cert.subject.CN) : null,
    altNames: alt,
    issuer: cert.issuer?.O ? String(cert.issuer.O) : cert.issuer?.CN ? String(cert.issuer.CN) : null,
    validTo: cert.valid_to ?? null,
    fingerprint256: cert.fingerprint256,
    pem: x.toString(),
  };
}

/** Reads the certificate an implicit-TLS server presents, without trusting it, to show the user. */
export function inspectCertificate(target: ResolvedTarget, timeoutMs = 8000): Promise<CertificateInfo | undefined> {
  return new Promise((resolve) => {
    const socket = connect({ host: target.address, port: target.port, servername: target.host, rejectUnauthorized: false, timeout: timeoutMs });
    const done = (v: CertificateInfo | undefined) => { socket.destroy(); resolve(v); };
    socket.once('secureConnect', () => done(describe(socket.getPeerCertificate())));
    socket.once('timeout', () => done(undefined));
    socket.once('error', () => done(undefined));
  });
}
