import type { ImapFlow } from 'imapflow';
import type { Config } from '../lib/config.js';
import { withUser, type Db } from '../lib/db.js';
import { createImapClient, toMailError } from '../mail/imap.js';
import { MailError } from '../mail/errors.js';
import { getMailbox, loadSecrets, pinsOf, recordFailure, settingsOf, type MailboxRow } from '../mailboxes/repo.js';
import { AppError } from '../lib/errors.js';

/**
 * Opens a short IMAP session for a request (open a body that is not stored yet, download an attachment,
 * apply an action right away). Connection problems are recorded on the mailbox like in the background sync.
 */
export async function withImap<T>(cfg: Config, db: Db, userId: string, mailboxId: string, fn: (client: ImapFlow, m: MailboxRow) => Promise<T>): Promise<T> {
  const loaded = await withUser(db, userId, async (c) => {
    const m = await getMailbox(c, mailboxId);
    return m ? { m, secrets: m.status === 'disconnected' ? null : await loadSecrets(c, cfg, mailboxId) } : null;
  });
  if (!loaded) throw new AppError(404, 'not_found', 'Mailbox not found.');
  if (!loaded.secrets || loaded.m.status === 'disconnected') {
    throw new AppError(409, 'conflict', 'This mailbox is disconnected, so the mail server cannot be reached.');
  }
  if (loaded.m.status === 'auth_failed') {
    throw new AppError(409, 'conflict', 'This mailbox needs its new password before the mail server can be reached.');
  }
  const client = await createImapClient(cfg, settingsOf(loaded.m).imap, loaded.secrets.imapPassword, pinsOf(loaded.m).imap);
  client.on('error', () => undefined);
  try {
    await client.connect();
  } catch (err) {
    const e = await toMailError(cfg, err, 'imap', settingsOf(loaded.m).imap);
    await withUser(db, userId, (c) => recordFailure(c, loaded.m, e));
    throw new AppError(503, 'mailbox_connect_failed', `Could not reach the mail server: ${e.message}`, { reason: e.code });
  }
  try {
    return await fn(client, loaded.m);
  } catch (err) {
    if (err instanceof MailError) throw new AppError(503, 'mailbox_connect_failed', err.message, { reason: err.code });
    throw err;
  } finally {
    await client.logout().catch(() => client.close());
  }
}
