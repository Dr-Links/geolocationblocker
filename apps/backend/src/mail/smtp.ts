import nodemailer from 'nodemailer';
import type { Config } from '../lib/config.js';
import { toMailError } from './imap.js';
import { resolveMailHost } from './net.js';
import type { Pins, ServerSettings } from './settings.js';
import { tlsOptions } from './tls.js';

export async function createSmtpTransport(cfg: Config, s: ServerSettings, password: string, pin?: Pins['smtp']) {
  const target = await resolveMailHost(cfg, s.host, s.port, 'smtp');
  return nodemailer.createTransport({
    host: target.address,
    port: s.port,
    secure: s.security === 'tls',
    requireTLS: s.security === 'starttls',
    name: 'emailplatform',
    tls: tlsOptions(cfg, target, pin),
    auth: { user: s.username, pass: password },
    connectionTimeout: cfg.mail.connectTimeoutMs,
    greetingTimeout: cfg.mail.connectTimeoutMs,
    socketTimeout: 60_000,
    logger: false,
  });
}

export interface SmtpTestResult {
  maxMessageBytes: number | null;
}

/** Connects and authenticates (EHLO + AUTH) without sending any message. */
export async function testSmtp(cfg: Config, s: ServerSettings, password: string, pin?: Pins['smtp']): Promise<SmtpTestResult> {
  const transport = await createSmtpTransport(cfg, s, password, pin);
  try {
    await transport.verify();
    return { maxMessageBytes: null };
  } catch (err) {
    throw await toMailError(cfg, err, 'smtp', s);
  } finally {
    transport.close();
  }
}
