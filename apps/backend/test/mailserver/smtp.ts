import { readFileSync } from 'node:fs';
import { SMTPServer } from 'smtp-server';

export const MAIL_DIR = process.env.MAILTEST_DIR ?? '/var/tmp/mailtest';
export const MAIL_PASSWORD = 'mailpass-123';

export interface CapturedMail {
  from: string;
  to: string[];
  raw: string;
}

/** In-process SMTP servers for tests: implicit TLS on 19465 and STARTTLS on 19587, same users as Dovecot. */
export async function startSmtp(passwords: () => Record<string, string>) {
  const key = readFileSync(`${MAIL_DIR}/key.pem`);
  const cert = readFileSync(`${MAIL_DIR}/ca.pem`);
  const captured: CapturedMail[] = [];
  const failedOnce = new Set<string>();
  const make = (secure: boolean) =>
    new SMTPServer({
      secure,
      key,
      cert,
      authMethods: ['PLAIN', 'LOGIN'],
      size: 25 * 1024 * 1024,
      logger: false,
      onAuth(auth, _session, cb) {
        if (passwords()[auth.username ?? ''] === auth.password) cb(null, { user: auth.username });
        else cb(Object.assign(new Error('Invalid credentials'), { responseCode: 535 }));
      },
      // Test hooks: tempfail…@ → 451 (temporary), tempfail-once…@ → 451 only the first time, permfail…@ → 550.
      onRcptTo(addr, _session, cb) {
        const a = addr.address.toLowerCase();
        if (a.startsWith('permfail')) return cb(Object.assign(new Error('5.1.1 No such user'), { responseCode: 550 }));
        if (a.startsWith('tempfail-once') && !failedOnce.has(a)) {
          failedOnce.add(a);
          return cb(Object.assign(new Error('4.7.1 Try again later'), { responseCode: 451 }));
        }
        if (a.startsWith('tempfail') && !a.startsWith('tempfail-once')) return cb(Object.assign(new Error('4.7.1 Try again later'), { responseCode: 451 }));
        cb();
      },
      onData(stream, session, cb) {
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => {
          captured.push({
            from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
            to: session.envelope.rcptTo.map((r) => r.address),
            raw: Buffer.concat(chunks).toString('utf8'),
          });
          cb();
        });
      },
    });
  const tls = make(true);
  const starttls = make(false);
  await new Promise<void>((r) => tls.listen(19465, '127.0.0.1', r));
  await new Promise<void>((r) => starttls.listen(19587, '127.0.0.1', r));
  return {
    captured,
    async close() {
      await new Promise<void>((r) => tls.close(() => r()));
      await new Promise<void>((r) => starttls.close(() => r()));
    },
  };
}
