import { logger } from "@/lib/logger";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  readonly name: string;
  send(msg: MailMessage): Promise<void>;
}

/**
 * Default mailer: logs instead of sending. Keeps the last 50 messages in memory
 * (handy for tests). In production it logs only metadata, never the body, since
 * bodies contain secret links.
 */
export class ConsoleMailer implements Mailer {
  readonly name = "console";
  static outbox: (MailMessage & { sentAt: Date })[] = [];

  async send(msg: MailMessage) {
    ConsoleMailer.outbox.push({ ...msg, sentAt: new Date() });
    if (ConsoleMailer.outbox.length > 50) ConsoleMailer.outbox.shift();
    if (process.env.NODE_ENV === "production") {
      logger.warn({ to: msg.to, subject: msg.subject }, "email not sent: no email provider configured (ConsoleMailer)");
    } else {
      logger.info({ to: msg.to, subject: msg.subject, body: msg.text }, "email (ConsoleMailer)");
    }
  }
}

let mailer: Mailer | undefined;

/** Real providers (Resend/Postmark/SES) plug in here once chosen. */
export function getMailer(): Mailer {
  return (mailer ??= new ConsoleMailer());
}
