import { readFileSync } from 'node:fs';
import { ImapFlow } from 'imapflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, type Db } from '../src/lib/db.js';
import { runSyncPass } from '../src/sync/runner.js';
import type { DiscoveryDeps } from '../src/mail/discovery.js';
import { bearer, login, makeCtx, registerVerified, resetData, type Ctx } from './helpers.js';
import { MAIL_DIR, MAIL_PASSWORD, startSmtp } from './mailserver/smtp.js';

const noDiscovery: DiscoveryDeps = { resolveMx: async () => [], resolveSrv: async () => [], fetchText: async () => null };
const MANUAL = {
  imap: { host: 'localhost', port: 19993, security: 'tls', username: 'alice@test.local' },
  smtp: { host: 'localhost', port: 19465, security: 'tls', username: 'alice@test.local' },
};

function imap() {
  const c = new ImapFlow({ host: '127.0.0.1', port: 19993, secure: true, auth: { user: 'alice@test.local', pass: MAIL_PASSWORD }, logger: false,
    tls: { ca: readFileSync(`${MAIL_DIR}/ca.pem`), servername: 'localhost' } });
  c.on('error', () => undefined);
  return c;
}

/** Direct access to the test mailbox, playing the role of "the mail server / another email client". */
async function onServer<T>(fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = imap();
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.logout();
  }
}

function rfc822(o: { id: string; subject: string; from?: string; to?: string; date?: Date; inReplyTo?: string; html?: string; text?: string; attachment?: { name: string; data: string } }) {
  const boundary = 'b-' + o.id.replace(/\W/g, '');
  const headers = [
    `From: ${o.from ?? 'Customer <customer@example.org>'}`,
    `To: ${o.to ?? 'Alice <alice@test.local>'}`,
    `Subject: ${o.subject}`,
    `Date: ${(o.date ?? new Date()).toUTCString()}`,
    `Message-ID: <${o.id}>`,
    ...(o.inReplyTo ? [`In-Reply-To: <${o.inReplyTo}>`, `References: <${o.inReplyTo}>`] : []),
    'Authentication-Results: mx.test.local; spf=pass smtp.mailfrom=example.org; dkim=pass; dmarc=pass',
    'MIME-Version: 1.0',
  ];
  const parts = [`--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${o.text ?? `Plain text of ${o.subject}`}\r\n`];
  if (o.html) parts.push(`--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${o.html}\r\n`);
  const alt = `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n${parts.join('')}--${boundary}--\r\n`;
  if (!o.attachment) return `${headers.join('\r\n')}\r\n${alt}`;
  const outer = `o-${boundary}`;
  return `${headers.join('\r\n')}\r\nContent-Type: multipart/mixed; boundary="${outer}"\r\n\r\n--${outer}\r\n${alt}--${outer}\r\n` +
    `Content-Type: application/pdf; name="${o.attachment.name}"\r\nContent-Disposition: attachment; filename="${o.attachment.name}"\r\n` +
    `Content-Transfer-Encoding: base64\r\n\r\n${Buffer.from(o.attachment.data).toString('base64')}\r\n--${outer}--\r\n`;
}

let ctx: Ctx;
let worker: Db;
let smtp: Awaited<ReturnType<typeof startSmtp>>;
let token: string;
let mailboxId: string;

const api = (method: 'GET' | 'POST', url: string, payload?: object, t = token) =>
  ctx.api.inject({ method, url, headers: bearer(t), payload });
const sync = () => runSyncPass(ctx.cfg, worker, { budgetMs: 30_000, log: () => undefined });
const forceDue = () => ctx.owner.query(`UPDATE app.mailboxes SET next_sync_at = now(), sync_lease_until = NULL`);
const inbox = async () => (await api('GET', '/v1/messages?view=inbox')).json().messages as Array<{ id: string; subject: string; isSeen: boolean; pendingSync: boolean }>;

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
  // Empty every folder of the test mailbox on the server.
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
  const userId = await registerVerified(ctx, 'syncer@gmail.com');
  await ctx.owner.query(`UPDATE app.users SET status = 'approved', access_expires_at = now() + interval '1 month' WHERE id = $1`, [userId]);
  token = (await login(ctx, 'syncer@gmail.com')).body.accessToken;
  const r = await api('POST', '/v1/mailboxes', { email: 'alice@test.local', password: MAIL_PASSWORD, manual: MANUAL });
  expect(r.statusCode, r.body).toBe(201);
  mailboxId = r.json().mailbox.id;
});

describe('incoming synchronisation', () => {
  it('imports messages with bodies, addresses, attachments, threads; merges copies; never duplicates', async () => {
    await onServer(async (c) => {
      await c.append('INBOX', rfc822({ id: 'q1@example.org', subject: 'Quote request', attachment: { name: 'spec.pdf', data: 'PDF-DATA' } }), [], new Date(Date.now() - 3600_000));
      await c.append('INBOX', rfc822({ id: 'q2@example.org', subject: 'Re: Quote request', inReplyTo: 'q1@example.org' }));
      await c.append('INBOX', rfc822({ id: 'other@example.org', subject: 'Quote request' })); // same subject, unrelated
      // The same message also in Sent (e.g. sent to yourself) → one message, two locations.
      await c.append('Sent', rfc822({ id: 'q2@example.org', subject: 'Re: Quote request', inReplyTo: 'q1@example.org' }), ['\\Seen']);
      await c.append('INBOX', rfc822({ id: 'old@example.org', subject: 'Too old', date: new Date(Date.now() - 200 * 86400_000) }), [], new Date(Date.now() - 200 * 86400_000));
    });
    const results = await sync();
    expect(results[0]).toMatchObject({ ok: true });
    const list = await inbox();
    expect(list.map((m) => m.subject).sort()).toEqual(['Quote request', 'Quote request', 'Re: Quote request']); // 200-day-old one is outside the 90-day window
    const { rows } = await ctx.owner.query<{ n: number; locs: number }>(
      `SELECT count(*)::int AS n, (SELECT count(*)::int FROM app.message_locations l JOIN app.messages m2 ON m2.id = l.message_id WHERE m2.message_id_header = 'q2@example.org') AS locs
         FROM app.messages WHERE message_id_header = 'q2@example.org'`);
    expect(rows[0]).toEqual({ n: 1, locs: 2 });

    const threads = await ctx.owner.query<{ message_id_header: string; thread_id: string }>(`SELECT message_id_header, thread_id FROM app.messages`);
    const t = Object.fromEntries(threads.rows.map((r) => [r.message_id_header, r.thread_id]));
    expect(t['q1@example.org']).toBe(t['q2@example.org']);
    expect(t['other@example.org']).not.toBe(t['q1@example.org']); // same subject alone never merges

    const q1 = list.find((m) => m.subject === 'Quote request' && m.id) && (await ctx.owner.query<{ id: string }>(`SELECT id FROM app.messages WHERE message_id_header = 'q1@example.org'`)).rows[0]!.id;
    const detail = (await api('GET', `/v1/messages/${q1}`)).json().message;
    expect(detail.from).toEqual({ address: 'customer@example.org', name: 'Customer' });
    expect(detail.to).toEqual([{ address: 'alice@test.local', name: 'Alice' }]);
    expect(detail.body.text).toContain('Plain text of Quote request');
    expect(detail.attachments).toMatchObject([{ filename: 'spec.pdf', mimeType: 'application/pdf', risk: 'low' }]);
    expect(detail.authResults).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'pass' });
    expect(detail.mailbox.email).toBe('alice@test.local');

    const dl = await ctx.api.inject({ method: 'GET', url: `/v1/messages/${q1}/attachments/${detail.attachments[0].id}`, headers: bearer(token) });
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toBe('PDF-DATA');
    expect(dl.headers['content-disposition']).toContain('spec.pdf');

    // Running again changes nothing (idempotent).
    await forceDue();
    const again = await sync();
    expect(again[0]).toMatchObject({ ok: true, newMessages: 0 });
    expect((await ctx.owner.query(`SELECT count(*)::int AS n FROM app.messages`)).rows[0].n).toBe(3);
  });

  it('detects new mail, read state, deletions and moves made on the server', async () => {
    await onServer((c) => c.append('INBOX', rfc822({ id: 'a@example.org', subject: 'First' })));
    await sync();
    await onServer(async (c) => {
      await c.append('INBOX', rfc822({ id: 'b@example.org', subject: 'Second' }));
      await c.append('INBOX', rfc822({ id: 'c@example.org', subject: 'Third' }));
    });
    await forceDue();
    const r = await sync();
    expect(r[0]!.newInbox).toHaveLength(2); // these will trigger "New email received at …" notifications (M7)

    await onServer(async (c) => {
      const lock = await c.getMailboxLock('INBOX');
      try {
        const [first] = (await c.search({ header: { 'message-id': 'a@example.org' } }, { uid: true })) || [];
        const [second] = (await c.search({ header: { 'message-id': 'b@example.org' } }, { uid: true })) || [];
        const [third] = (await c.search({ header: { 'message-id': 'c@example.org' } }, { uid: true })) || [];
        await c.messageFlagsAdd(String(first), ['\\Seen'], { uid: true });
        await c.messageDelete(String(second), { uid: true });
        await c.messageMove(String(third), 'Archive', { uid: true });
      } finally {
        lock.release();
      }
    });
    const idsBefore = (await ctx.owner.query<{ id: string; message_id_header: string }>(`SELECT id, message_id_header FROM app.messages`)).rows;
    await forceDue();
    await sync();
    const list = await inbox();
    expect(list.map((m) => m.subject)).toEqual(['First']);
    expect(list[0]!.isSeen).toBe(true);
    // Deleted on the server: kept on the platform but clearly marked.
    const stored = (await api('GET', '/v1/messages?view=stored_only')).json().messages;
    expect(stored.map((m: { subject: string; onServer: boolean }) => [m.subject, m.onServer])).toEqual([['Second', false]]);
    // Moved on the server: same message (same id), now in Archive — no duplicate.
    const third = (await ctx.owner.query<{ id: string; folders: string[] }>(
      `SELECT m.id, array_agg(f.special_use) AS folders FROM app.messages m JOIN app.message_locations l ON l.message_id = m.id
         JOIN app.folders f ON f.id = l.folder_id WHERE m.message_id_header = 'c@example.org' GROUP BY m.id`)).rows;
    expect(third).toEqual([{ id: idsBefore.find((x) => x.message_id_header === 'c@example.org')!.id, folders: ['archive'] }]);
  });

  it('sanitises HTML, strips scripts and blocks remote images unless allowed', async () => {
    await onServer((c) => c.append('INBOX', rfc822({ id: 'h@example.org', subject: 'Newsletter',
      html: '<p onclick="steal()">Hi <b>there</b></p><script>alert(1)</script><a href="javascript:alert(2)">x</a><a href="https://ok.example/">ok</a><img src="https://tracker.example/p.gif"><style>body{background:url(https://x)}</style>' })));
    await sync();
    const id = (await inbox())[0]!.id;
    const m = (await api('GET', `/v1/messages/${id}`)).json().message;
    expect(m.body.html).not.toMatch(/script|onclick|javascript:|<style/i);
    expect(m.body.html).toContain('<b>there</b>');
    expect(m.body.html).toContain('href="https://ok.example/"');
    expect(m.body.html).toContain('rel="noopener noreferrer nofollow"');
    expect(m.body.hasRemoteContent).toBe(true);
    expect(m.body.html).toContain('data-blocked-src="https://tracker.example/p.gif"');
    expect(m.body.html).not.toMatch(/ src="https:/);
    const shown = (await api('GET', `/v1/messages/${id}?remoteImages=1`)).json().message;
    expect(shown.body.html).toContain('src="https://tracker.example/p.gif"');
  });

  it('handles large messages by fetching only their text', async () => {
    const big = 'x'.repeat(2.5 * 1024 * 1024);
    await onServer((c) => c.append('INBOX', rfc822({ id: 'big@example.org', subject: 'Big file', text: 'Please see the drawing.', attachment: { name: 'drawing.pdf', data: big } })));
    await sync();
    const id = (await inbox())[0]!.id;
    const m = (await api('GET', `/v1/messages/${id}`)).json().message;
    expect(m.body.text).toContain('Please see the drawing.');
    expect(m.attachments[0]).toMatchObject({ filename: 'drawing.pdf' });
    const { rows } = await ctx.owner.query<{ stored_bytes: number }>(`SELECT stored_bytes FROM app.message_bodies WHERE message_id = $1`, [id]);
    expect(rows[0]!.stored_bytes).toBeLessThan(10_000); // the attachment was not copied into the body
  });
});

describe('user actions reach the server', () => {
  const serverFlags = (id: string) => onServer(async (c) => {
    for (const path of ['INBOX', 'Archive', 'Trash', 'Junk']) {
      const lock = await c.getMailboxLock(path);
      try {
        const uids = (await c.search({ header: { 'message-id': id } }, { uid: true })) || [];
        if (uids.length) {
          const m = await c.fetchOne(String(uids[0]), { flags: true }, { uid: true });
          return { path, flags: [...(m ? m.flags ?? [] : [])] };
        }
      } finally {
        lock.release();
      }
    }
    return null;
  });

  it('mark read, flag, archive, trash and delete forever', async () => {
    await onServer((c) => c.append('INBOX', rfc822({ id: 'act@example.org', subject: 'Act on me' })));
    await sync();
    const id = (await inbox())[0]!.id;

    const read = (await api('POST', `/v1/messages/${id}/actions`, { action: 'mark_read' })).json();
    expect(read).toMatchObject({ appliedOnServer: true, message: { isSeen: true, pendingSync: false } });
    await api('POST', `/v1/messages/${id}/actions`, { action: 'flag' });
    expect(await serverFlags('act@example.org')).toEqual({ path: 'INBOX', flags: expect.arrayContaining(['\\Seen', '\\Flagged']) });

    const arch = (await api('POST', `/v1/messages/${id}/actions`, { action: 'archive' })).json();
    expect(arch.appliedOnServer).toBe(true);
    expect((await serverFlags('act@example.org'))?.path).toBe('Archive');
    expect(await inbox()).toEqual([]);
    // The same message id survives the move.
    expect((await api('GET', `/v1/messages/${id}`)).json().message.folders).toMatchObject([{ specialUse: 'archive' }]);

    await api('POST', `/v1/messages/${id}/actions`, { action: 'trash' });
    expect((await serverFlags('act@example.org'))?.path).toBe('Trash');
    expect((await api('POST', `/v1/messages/${id}/actions`, { action: 'delete_forever' })).statusCode).toBe(400); // needs confirmation
    const del = await api('POST', `/v1/messages/${id}/actions`, { action: 'delete_forever', confirm: true });
    expect(del.json().appliedOnServer).toBe(true);
    expect(await serverFlags('act@example.org')).toBeNull();
    expect((await api('GET', `/v1/messages/${id}`)).statusCode).toBe(404);
  });

  it('keeps an action pending while the server is unreachable and applies it at the next sync', async () => {
    await onServer((c) => c.append('INBOX', rfc822({ id: 'later@example.org', subject: 'Later' })));
    await sync();
    const id = (await inbox())[0]!.id;
    await ctx.owner.query(`UPDATE app.mailbox_server_settings SET imap_port = 19994`); // outage
    const r = (await api('POST', `/v1/messages/${id}/actions`, { action: 'mark_read' })).json();
    expect(r).toMatchObject({ appliedOnServer: false, message: { isSeen: true, pendingSync: true } });
    expect((await serverFlags('later@example.org'))?.flags).not.toContain('\\Seen');
    // A server-side sync during the pending period must not overwrite the user's intent.
    await ctx.owner.query(`UPDATE app.mailbox_server_settings SET imap_port = 19993`);
    await ctx.owner.query(`UPDATE app.mailboxes SET status = 'active', next_sync_at = now(), sync_lease_until = NULL`);
    await sync();
    expect((await serverFlags('later@example.org'))?.flags).toContain('\\Seen');
    expect((await inbox())[0]).toMatchObject({ isSeen: true, pendingSync: false });
  });

  it('the same clientOpId is applied only once (offline retries)', async () => {
    await onServer((c) => c.append('INBOX', rfc822({ id: 'once@example.org', subject: 'Once' })));
    await sync();
    const id = (await inbox())[0]!.id;
    const op = '11111111-2222-4333-8444-555555555555';
    await api('POST', `/v1/messages/${id}/actions`, { action: 'archive', clientOpId: op });
    await api('POST', `/v1/messages/${id}/actions`, { action: 'archive', clientOpId: op });
    const { rows } = await ctx.owner.query(`SELECT count(*)::int AS n FROM app.mailbox_operations`);
    expect(rows[0].n).toBe(1);
  });
});

describe('isolation and concurrency', () => {
  it('other users cannot read messages, attachments or act on them', async () => {
    await onServer((c) => c.append('INBOX', rfc822({ id: 'secret@example.org', subject: 'Private', attachment: { name: 'a.pdf', data: 'x' } })));
    await sync();
    const id = (await inbox())[0]!.id;
    const att = (await api('GET', `/v1/messages/${id}`)).json().message.attachments[0].id;
    const other = await registerVerified(ctx, 'nosy@gmail.com');
    await ctx.owner.query(`UPDATE app.users SET status = 'approved', access_expires_at = now() + interval '1 month' WHERE id = $1`, [other]);
    const t2 = (await login(ctx, 'nosy@gmail.com')).body.accessToken;
    expect((await api('GET', `/v1/messages/${id}`, undefined, t2)).statusCode).toBe(404);
    expect((await api('GET', `/v1/messages/${id}/attachments/${att}`, undefined, t2)).statusCode).toBe(404);
    expect((await api('POST', `/v1/messages/${id}/actions`, { action: 'mark_read' }, t2)).statusCode).toBe(404);
    expect((await api('GET', `/v1/mailboxes/${mailboxId}/folders`, undefined, t2)).statusCode).toBe(404);
    expect((await api('GET', '/v1/messages?view=inbox', undefined, t2)).json().messages).toEqual([]);
  });

  it('overlapping sync runs never process the same mailbox twice', async () => {
    await onServer((c) => c.append('INBOX', rfc822({ id: 'race@example.org', subject: 'Race' })));
    const [a, b] = await Promise.all([sync(), sync()]);
    expect(a!.length + b!.length).toBe(1);
    expect((await ctx.owner.query(`SELECT count(*)::int AS n FROM app.messages`)).rows[0].n).toBe(1);
  });

  it('does not sync suspended or expired accounts', async () => {
    await onServer((c) => c.append('INBOX', rfc822({ id: 'paused@example.org', subject: 'Paused' })));
    await ctx.owner.query(`UPDATE app.users SET access_expires_at = now() - interval '1 second' WHERE email_display = 'syncer@gmail.com'`);
    expect(await sync()).toEqual([]);
  });
});
