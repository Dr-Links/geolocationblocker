export type Security = 'tls' | 'starttls';

export interface ServerSettings {
  host: string;
  port: number;
  security: Security;
  username: string;
}

export interface MailboxSettings {
  imap: ServerSettings;
  smtp: ServerSettings;
}

export interface Pins {
  imap?: { sha256: string; pem: string } | null;
  smtp?: { sha256: string; pem: string } | null;
}

export interface Secrets {
  imapPassword: string;
  /** Defaults to the IMAP password. */
  smtpPassword?: string | null;
}
