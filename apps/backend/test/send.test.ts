import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, type Db } from '../src/lib/db.js';
import { classifySendError, runSendPass } from '../src/send/sender.js';
import { runSyncPass } from '../src/sync/runner.js';
import type { DiscoveryDeps } from '../src/mail/discovery.js';
import { adminLogin, bearer, createAdmin, login, makeCtx, registerVerified, resetData, type Ctx } from './helpers.js';
import { MAIL_DIR, MAIL_PASSWORD, startSmtp } from './mailserver/smtp.js';

const noDiscovery: DiscoveryDeps = { resolveMx: async () => [], resolveSrv: async () => [], fetchText: async () => null };
const MANUAL = {
  imap: { host: 'localhost', port: 19993, security: 'tls', username: 'alice@test.local' },
  smtp: { host: 'localhost', port: 19465, security: 'tls', username: 'alice@test.local' },
};

async function onServer<T>(fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = new ImapFlow({ host: '127.0.0.1', port: 19993, secure: true, auth: { user: 'alice@test.local', pass: MAIL_PASSWORD }, logger: false,
    tls: { ca: readFileSync(`${MAIL_DIR}/ca.pem`), servername: 'localhost' } });
  c.on('error', () => undefined);
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.logout();
  }
}

let ctx: Ctx;
let worker: Db;
let smtp: Awaited<ReturnType<typeof startSmtp>>;
let token: string;
let userId: string;
let mailboxId: string;

const api = (method: 'GET' | 'POST', url: string, payload?: object, t = token) => ctx.api.inject({ method, url, headers: bearer(t), payload });
const send = (payload: object) => api('POST', '/v1/outbound', { mailboxId, idempotencyKey: randomUUID(), ...payload });
const releaseNow = () => ctx.owner.query(`UPDATE app.outbound_messages SET release_at = now() - interval '1 second' WHERE status = 'pending_undo'`);
const dueNow = () => ctx.owner.query(`UPDATE app.outbound_messages SET next_attempt_at = now() WHERE status = 'queued'`);
const pass = () => runSendPass(ctx.cfg, worker, 20_000, () => undefined);
const status = async (id: string) => (await api('GET', `/v1/outbound/${id}`)).json();

beforeAll(async () => {
  ctx = await makeCtx({ env: { MAIL_EXTRA_CA_FILE: `${MAIL_DIR}/ca.pem` }, discovery: noDiscovery });
  worker = createPool(ctx.cfg, 'worker');
  smtp = await startSmtp(() => ({ 'alice@test.local': MAIL_PASSWORD }));
});
afterAll(async () => {
  await smtp.close();
  await worker.end();
  await ctx.close();
});
beforeEach(async () => {
  await resetData(ctx);
  smtp.captured.length = 0;
  await onServer(async (c) => {
    for (const f of await c.list()) {
      const lock = await c.getMailboxLock(f.path);
      try {
        if (c.mailbox && c.mailbox.exists) await c.messageDelete('1:*');
      } finally {
        lock.release();
      }
    }
  });
  userId = await registerVerified(ctx, 'sender@gmail.com');
  await ctx.owner.query(`UPDATE app.users SET status = 'approved', access_expires_at = now() + interval '1 month' WHERE id = $1`, [userId]);
  token = (await login(ctx, 'sender@gmail.com')).body.accessToken;
  const r = await api('POST', '/v1/mailboxes', { email: 'alice@test.local', password: MAIL_PASSWORD, displayName: 'Alice Sales', manual: MANUAL });
  mailboxId = r.json().mailbox.id;
  // Folders (incl. Sent) become known after the first sync.
  await runSyncPass(ctx.cfg, worker, { budgetMs: 20_000, log: () => undefined });
});

describe('sending', () => {
  it('waits for the undo window, then sends once with the right sender, headers and a Sent copy; Bcc stays hidden', async () => {
    const r = await send({ to: ['Bob <bob@example.org>'], cc: ['carol@example.org'], bcc: ['secret@example.org'], subject: 'Quote 1042', text: 'Hello Bob' });
    expect(r.statusCode).toBe(201);
    const o = r.json().outbound;
    expect(o).toMatchObject({ status: 'pending_undo', canUndo: true, recipientCount: 3 });
    expect(await pass()).toEqual([]); // still inside the undo window: nothing sent
    expect(smtp.captured).toHaveLength(0);

    await releaseNow();
    expect(await pass()).toEqual(['sent']);
    expect(await pass()).toEqual([]); // never twice
    expect(smtp.captured).toHaveLength(1);
    const mail = smtp.captured[0]!;
    expect(mail.from).toBe('alice@test.local');
    expect(mail.to.sort()).toEqual(['bob@example.org', 'carol@example.org', 'secret@example.org']);
    expect(mail.raw).toMatch(/^From: Alice Sales <alice@test\.local>/m);
    expect(mail.raw).toMatch(/^To: Bob <bob@example\.org>/m);
    expect(mail.raw).toMatch(/^Cc: carol@example\.org/m);
    expect(mail.raw).not.toMatch(/^Bcc:/mi);
    expect(mail.raw).not.toContain('secret@example.org');
    const s = await status(o.id);
    expect(s.outbound).toMatchObject({ status: 'sent', sentCopy: 'appended', canUndo: false });
    expect(s.attempts).toMatchObject([{ attemptNo: 1, outcome: 'accepted', smtpCode: 250 }]);
    // The Sent folder on the server has the exact message.
    const inSent = await onServer(async (c) => {
      const lock = await c.getMailboxLock('Sent');
      try {
        return (await c.search({ subject: 'Quote 1042' }, { uid: true })) || [];
      } finally {
        lock.release();
      }
    });
    expect(inSent).toHaveLength(1);
    // After the next sync it shows in the unified Sent view (one message, no duplicate).
    await ctx.owner.query(`UPDATE app.mailboxes SET next_sync_at = now(), sync_lease_until = NULL`);
    await ctx.owner.query(`UPDATE app.folders SET next_sync_at = now()`);
    await runSyncPass(ctx.cfg, worker, { budgetMs: 20_000, log: () => undefined });
    const sentView = (await api('GET', '/v1/messages?view=sent')).json().messages;
    expect(sentView.map((m: { subject: string }) => m.subject)).toEqual(['Quote 1042']);
  });

  it('undo cancels before anything is submitted; after sending it is too late', async () => {
    const o = (await send({ to: ['bob@example.org'], subject: 'Oops', text: 'x' })).json().outbound;
    expect((await api('POST', `/v1/outbound/${o.id}/undo`)).json().outbound.status).toBe('cancelled');
    await releaseNow();
    expect(await pass()).toEqual([]);
    expect(smtp.captured).toHaveLength(0);

    const o2 = (await send({ to: ['bob@example.org'], subject: 'Second', text: 'y' })).json().outbound;
    await releaseNow();
    await pass();
    const late = await api('POST', `/v1/outbound/${o2.id}/undo`);
    expect(late.statusCode).toBe(409);
    expect(late.json().error.message).toMatch(/cannot be recalled/);
  });

  it('the same Send pressed twice (or retried by a flaky network) creates one message', async () => {
    const key = randomUUID();
    const a = await api('POST', '/v1/outbound', { mailboxId, idempotencyKey: key, to: ['bob@example.org'], subject: 'Once', text: 'x' });
    const b = await api('POST', '/v1/outbound', { mailboxId, idempotencyKey: key, to: ['bob@example.org'], subject: 'Once', text: 'x' });
    expect([a.statusCode, b.statusCode]).toEqual([201, 200]);
    expect(b.json().outbound.id).toBe(a.json().outbound.id);
    await releaseNow();
    await pass();
    expect(smtp.captured).toHaveLength(1);
  });

  it('replies from the receiving mailbox with threading headers and quote, and marks the original answered', async () => {
    await onServer((c) => c.append('INBOX',
      'From: Customer <customer@example.org>\r\nTo: alice@test.local, partner@example.org\r\nCc: alice@test.local\r\nSubject: Question\r\n' +
      `Message-ID: <q@example.org>\r\nDate: ${new Date().toUTCString()}\r\n\r\nCan you help?\r\n`));
    await ctx.owner.query(`UPDATE app.mailboxes SET next_sync_at = now(), sync_lease_until = NULL`);
    await runSyncPass(ctx.cfg, worker, { budgetMs: 20_000, log: () => undefined });
    const src = (await api('GET', '/v1/messages?view=inbox')).json().messages[0];
    const sugg = (await api('GET', `/v1/messages/${src.id}/compose?mode=reply_all`)).json();
    expect(sugg).toMatchObject({ mailboxId, subject: 'Re: Question', to: [{ address: 'customer@example.org' }], cc: [{ address: 'partner@example.org' }] });

    const r = await send({ mode: 'reply_all', sourceMessageId: src.id, to: sugg.to, cc: sugg.cc, subject: sugg.subject, text: 'Yes, happy to.' });
    expect(r.statusCode).toBe(201);
    await releaseNow();
    expect(await pass()).toEqual(['sent']);
    const raw = smtp.captured[0]!.raw;
    expect(raw).toMatch(/^In-Reply-To: <q@example\.org>/m);
    expect(raw).toMatch(/^References: <q@example\.org>/m);
    expect(raw).toContain('Yes, happy to.');
    expect(raw).toMatch(/wrote:/);
    expect(raw).toContain('> Can you help?');
    const flags = await onServer(async (c) => {
      const lock = await c.getMailboxLock('INBOX');
      try {
        const m = await c.fetchOne('1', { flags: true });
        return [...(m ? m.flags ?? [] : [])];
      } finally {
        lock.release();
      }
    });
    expect(flags).toContain('\\Answered');
  });

  it('asks before exposing many recipients to each other, and before sending from another mailbox', async () => {
    const many = Array.from({ length: 12 }, (_, i) => `person${i}@example.org`);
    const r = await send({ to: many, subject: 'Hi all', text: 'x' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.details.requires).toBe('confirmVisibleRecipients');
    expect((await send({ bcc: many, to: ['me@example.org'], subject: 'Hi all', text: 'x' })).statusCode).toBe(201);
    expect((await send({ to: many, subject: 'Hi all', text: 'x', confirmVisibleRecipients: true })).statusCode).toBe(201);
    const bad = await send({ to: ['not an address', 'ok@example.org'], subject: 'x', text: 'x' });
    expect(bad.json().error.details.invalid).toEqual(['not an address']);
  });
});

describe('failures', () => {
  it('retries a temporary rejection with backoff and sends exactly once when it clears', async () => {
    const o = (await send({ to: ['tempfail-once@example.org'], subject: 'Retry me', text: 'x' })).json().outbound;
    await releaseNow();
    expect(await pass()).toEqual(['retry']);
    const s1 = await status(o.id);
    expect(s1.outbound).toMatchObject({ status: 'queued', lastErrorCode: 'SMTP_451' });
    expect(new Date(s1.outbound.nextAttemptAt).getTime()).toBeGreaterThan(Date.now() + 30_000);
    expect(await pass()).toEqual([]); // not due yet
    await dueNow();
    expect(await pass()).toEqual(['sent']);
    expect(smtp.captured).toHaveLength(1);
    expect((await status(o.id)).attempts.map((a: { outcome: string }) => a.outcome)).toEqual(['temp_failure', 'accepted']);
  });

  it('stops immediately on a permanent rejection', async () => {
    const o = (await send({ to: ['permfail@example.org'], subject: 'No such user', text: 'x' })).json().outbound;
    await releaseNow();
    expect(await pass()).toEqual(['failed']);
    expect((await status(o.id)).outbound).toMatchObject({ status: 'failed', lastErrorCode: 'SMTP_550' });
    await dueNow();
    expect(await pass()).toEqual([]);
  });

  it('gives up after the retry schedule is used up', async () => {
    const o = (await send({ to: ['tempfail@example.org'], subject: 'Never', text: 'x' })).json().outbound;
    await releaseNow();
    for (let i = 0; i < 6; i++) {
      await dueNow();
      await pass();
    }
    expect((await status(o.id)).outbound).toMatchObject({ status: 'failed', attemptCount: 6 });
  });

  it('never resends automatically when a send was interrupted; the user must confirm', async () => {
    const o = (await send({ to: ['bob@example.org'], subject: 'Interrupted', text: 'x' })).json().outbound;
    // Simulate a worker that died during the SMTP conversation.
    await ctx.owner.query(`UPDATE app.outbound_messages SET status = 'sending', lease_until = now() - interval '1 second' WHERE id = $1`, [o.id]);
    expect(await pass()).toEqual([]);
    expect((await status(o.id)).outbound.status).toBe('uncertain');
    const r = await api('POST', `/v1/outbound/${o.id}/retry`, {});
    expect(r.json().error.details.requires).toBe('confirmPossibleDuplicate');
    await api('POST', `/v1/outbound/${o.id}/retry`, { confirmPossibleDuplicate: true });
    expect(await pass()).toEqual(['sent']);
  });

  it('classifies SMTP errors: lost connection during DATA is uncertain, 4xx temporary, 5xx permanent', () => {
    expect(classifySendError({ command: 'DATA', code: 'ETIMEDOUT', message: 'Timeout' }).kind).toBe('uncertain');
    expect(classifySendError({ command: 'CONN', code: 'ECONNECTION', message: 'refused' }).kind).toBe('temp');
    expect(classifySendError({ responseCode: 421, message: 'busy' }).kind).toBe('temp');
    expect(classifySendError({ responseCode: 552, message: 'too big' }).kind).toBe('perm');
    expect(classifySendError({ responseCode: 535, message: 'auth' }).kind).toBe('auth');
  });

  it('respects the mailbox sending limit by waiting, not failing', async () => {
    await ctx.owner.query(`UPDATE app.mailboxes SET send_limit_per_hour = 1`);
    await send({ to: ['one@example.org'], subject: 'One', text: 'x' });
    await send({ to: ['two@example.org'], subject: 'Two', text: 'x' });
    await releaseNow();
    expect((await pass()).sort()).toEqual(['deferred', 'sent']);
    const list = (await api('GET', '/v1/outbound')).json().outbound;
    const waiting = list.filter((o: { status: string }) => o.status === 'queued');
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ lastErrorCode: 'RATE_LIMIT' });
    expect(smtp.captured).toHaveLength(1);
  });
});

describe('account state and isolation', () => {
  it('suspension pauses waiting messages; they are not sent after reactivation until the user resumes them', async () => {
    const { secret } = await createAdmin(ctx);
    const admin = await adminLogin(ctx, secret);
    const o = (await send({ to: ['bob@example.org'], subject: 'Paused', text: 'x' })).json().outbound;
    await admin.post(`/admin/api/users/${userId}/suspend`);
    await admin.post(`/admin/api/users/${userId}/renew`, { mode: 'from_now' });
    token = (await login(ctx, 'sender@gmail.com')).body.accessToken;
    await releaseNow();
    await ctx.owner.query(`UPDATE app.mailboxes SET status = 'active'`);
    expect(await pass()).toEqual([]);
    expect((await status(o.id)).outbound.status).toBe('paused_suspended');
    await api('POST', `/v1/outbound/${o.id}/retry`, {});
    expect(await pass()).toEqual(['sent']);
  });

  it('another user cannot see, undo, retry or discard my outgoing mail', async () => {
    const o = (await send({ to: ['bob@example.org'], subject: 'Mine', text: 'x' })).json().outbound;
    const other = await registerVerified(ctx, 'other.sender@gmail.com');
    await ctx.owner.query(`UPDATE app.users SET status = 'approved', access_expires_at = now() + interval '1 month' WHERE id = $1`, [other]);
    const t2 = (await login(ctx, 'other.sender@gmail.com')).body.accessToken;
    for (const [m, u] of [['GET', `/v1/outbound/${o.id}`], ['POST', `/v1/outbound/${o.id}/undo`], ['POST', `/v1/outbound/${o.id}/retry`], ['POST', `/v1/outbound/${o.id}/discard`]] as const) {
      expect((await api(m, u, m === 'POST' ? {} : undefined, t2)).statusCode, u).toBe(404);
    }
    // Sending from someone else's mailbox is impossible.
    expect((await api('POST', '/v1/outbound', { mailboxId, idempotencyKey: randomUUID(), to: ['x@example.org'], subject: 's', text: 't' }, t2)).statusCode).toBe(404);
    expect((await api('GET', '/v1/outbound', undefined, t2)).json().outbound).toEqual([]);
  });
});
