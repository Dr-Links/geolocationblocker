import nodemailer from 'nodemailer';
import type { Config } from './config.js';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Sends the platform's own account emails (verification, password reset, notices). Never mailbox content. */
export interface Mailer {
  send(mail: OutgoingMail): Promise<void>;
}

export class SmtpMailer implements Mailer {
  private readonly transport;
  constructor(private readonly smtp: NonNullable<Config['smtp']>) {
    this.transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.password ?? '' } : undefined,
      requireTLS: !smtp.secure,
    });
  }
  async send(mail: OutgoingMail): Promise<void> {
    await this.transport.sendMail({ from: this.smtp.from, ...mail });
  }
}

/** Development fallback: prints emails to the console instead of sending them. */
export class ConsoleMailer implements Mailer {
  async send(mail: OutgoingMail): Promise<void> {
    console.log(`\n--- email to ${mail.to} ---\nSubject: ${mail.subject}\n\n${mail.text}\n--- end email ---\n`);
  }
}

export class MemoryMailer implements Mailer {
  readonly sent: OutgoingMail[] = [];
  async send(mail: OutgoingMail): Promise<void> {
    this.sent.push(mail);
  }
  lastTo(to: string): OutgoingMail | undefined {
    return [...this.sent].reverse().find((m) => m.to === to);
  }
}

export function createMailer(cfg: Config): Mailer {
  if (cfg.smtp) return new SmtpMailer(cfg.smtp);
  return new ConsoleMailer();
}

/** Never let an email failure break the request that triggered it; log it instead. */
export async function sendSafely(mailer: Mailer, mail: OutgoingMail, log: (msg: string) => void): Promise<boolean> {
  try {
    await mailer.send(mail);
    return true;
  } catch (err) {
    log(`email to ${mail.to} failed: ${(err as Error).message}`);
    return false;
  }
}
