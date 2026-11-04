import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, type Db } from '../src/lib/db.js';
import { runSendPass } from '../src/send/sender.js';
import { runSyncPass } from '../src/sync/runner.js';
import type { DiscoveryDeps } from '../src/mail/discovery.js';
import { bearer, login, makeCtx, registerVerified, resetData, type Ctx } from './helpers.js';
import { MAIL_DIR, MAIL_PASSWORD, startSmtp } from './mailserver/smtp.js';

const noDiscovery: DiscoveryDeps = { resolveMx: async () => [], resolveSrv: async () => [], fetchText: async () => null };
const MANUAL = {
  imap: { host: 'localhost', port: 19993, security: 'tls', username: 'alice@test.local' },
  smtp: { host: 'localhost', port: 19465, security: 'tls', username: 'alice@test.local' },
};
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const PDF = Buffer.from('%PDF-1.4\n% test document with a secret phrase: PINEAPPLE-42\n%%EOF');

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

const api = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object, t = token) => ctx.api.inject({ method, url, headers: bearer(t), payload });
const upload = (name: string, data: Buffer, inline = false, t = token) => ctx.api.inject({
  method: 'PUT', url: `/v1/uploads?filename=${encodeURIComponent(name)}${inline ? '&inline=1' : ''}`,
  headers: { ...bearer(t), 'content-type': 'application/octet-stream' }, payload: data,
});
const send = (payload: object) => api('POST', '/v1/outbound', { mailboxId, idempotencyKey: randomUUID(), ...payload });
const sendNow = async () => {
  await ctx.owner.query(`UPDATE app.outbound_messages SET release_at = now() - interval '1 second' WHERE status = 'pending_undo'`);
  return runSendPass(ctx.cfg, worker, 20_000, () => undefined);
};
const sync = async () => {
  await ctx.owner.query(`UPDATE app.mailboxes SET next_sync_at = now(), sync_lease_until = NULL`);
  return runSyncPass(ctx.cfg, worker, { budgetMs: 20_000, log: () => undefined });
};
function filesUnder(dir: string): string[] {
  try {
    return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? filesUnder(join(dir, f)) : [join(dir, f)]));
  } catch {
    return [];
  }
}

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
  userId = await registerVerified(ctx, 'composer@gmail.com');
  await ctx.owner.query(`UPDATE app.users SET status = 'approved', access_expires_at = now() + interval '1 month' WHERE id = $1`, [userId]);
  token = (await login(ctx, 'composer@gmail.com')).body.accessToken;
  mailboxId = (await api('POST', '/v1/mailboxes', { email: 'alice@test.local', password: MAIL_PASSWORD, displayName: 'Alice', manual: MANUAL })).json().mailbox.id;
  await sync();
});

describe('uploads', () => {
  it('detects the real file type, flags disguised programs, encrypts on disk and deduplicates per user', async () => {
    const pdf = await upload('quote.pdf', PDF);
    expect(pdf.statusCode).toBe(201);
    expect(pdf.json().upload).toMatchObject({ mimeType: 'application/pdf', risk: 'low', sizeBytes: PDF.length });
    const fake = await upload('invoice.pdf', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)]));
    expect(fake.json().upload).toMatchObject({ mimeType: 'application/x-msdownload', risk: 'dangerous' });
    expect((await upload('notes.txt', Buffer.from('hello'), true)).statusCode).toBe(400); // inline must be an image
    expect((await upload('../../etc/passwd', Buffer.from('x'))).json().upload.risk).toBeDefined(); // name is sanitised, never a path
    // Stored content is encrypted: the secret phrase is nowhere on disk.
    const files = filesUnder(ctx.cfg.blobDir);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(readFileSync(f).includes(Buffer.from('PINEAPPLE-42'))).toBe(false);
    // Same content again → same blob.
    await upload('copy-of-quote.pdf', PDF);
    const { rows } = await ctx.owner.query(`SELECT count(*)::int AS n FROM app.blobs WHERE user_id = $1`, [userId]);
    expect(rows[0].n).toBe(3); // pdf, fake exe, passwd text — the copy reused the pdf blob
  });
});

describe('composing', () => {
  it('sends attachments, inline images and the signature exactly once', async () => {
    const att = (await upload('quote.pdf', PDF)).json().upload;
    const img = (await upload('logo.png', PNG, true)).json().upload;
    const sig = (await api('POST', '/v1/signatures', { name: 'Work', text: 'Alice\nSales Manager', html: '<b>Alice</b><br>Sales Manager' })).json();
    await send({
      to: ['bob@example.org'], subject: 'Quote', text: 'Please find the quote attached.', uploadIds: [att.id], signatureId: sig.id,
      html: `<p>Please find the <b>quote</b> attached.</p><p><img src="data:image/png;base64,AAAA" data-upload-id="${img.id}"></p>`,
    });
    expect(await sendNow()).toEqual(['sent']);
    // Read it the way a recipient's email client would.
    const parsed = await simpleParser(smtp.captured[0]!.raw, { keepCidLinks: true });
    const files = parsed.attachments.map((a) => ({ name: a.filename, cid: a.cid, related: a.related }));
    expect(files).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'quote.pdf' }), expect.objectContaining({ cid: `${img.id}@inline` })]));
    expect(parsed.attachments.find((a) => a.filename === 'quote.pdf')!.content.equals(PDF)).toBe(true);
    expect(parsed.html).toContain(`src="cid:${img.id}@inline"`);
    expect(parsed.html).not.toContain('data-upload-id');
    expect(parsed.html).not.toContain('data:image/png;base64,AAAA');
    expect(parsed.text!.match(/Sales Manager/g)?.length).toBe(1);
    expect((parsed.html as string).match(/Sales Manager/g)?.length).toBe(1);
    expect(parsed.text).toMatch(/^-- $/m);
  });

  it('uses the mailbox default signature unless told otherwise', async () => {
    const sig = (await api('POST', '/v1/signatures', { name: 'Default', text: 'Regards, Alice' })).json();
    await api('PUT', `/v1/mailboxes/${mailboxId}/default-signature`, { signatureId: sig.id });
    await send({ to: ['a@example.org'], subject: 'With default', text: 'Hi' });
    await send({ to: ['b@example.org'], subject: 'Without', text: 'Hi', signatureId: null });
    await sendNow();
    const bySubject = Object.fromEntries(smtp.captured.map((c) => [c.raw.match(/^Subject: (.*)$/m)![1]!, c.raw]));
    expect(bySubject['With default']).toContain('Regards, Alice');
    expect(bySubject['Without']).not.toContain('Regards, Alice');
  });

  it('forwards the original attachments and shows embedded images of received mail', async () => {
    const boundary = 'b1';
    await onServer((c) => c.append('INBOX',
      'From: Supplier <supplier@example.org>\r\nTo: alice@test.local\r\nSubject: Drawings\r\nMessage-ID: <dr@example.org>\r\n' +
      `Date: ${new Date().toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="${boundary}"\r\n\r\n` +
      `--${boundary}\r\nContent-Type: text/html\r\n\r\n<p>See logo <img src="cid:logo123"></p>\r\n` +
      `--${boundary}\r\nContent-Type: image/png\r\nContent-ID: <logo123>\r\nContent-Transfer-Encoding: base64\r\n\r\n${PNG.toString('base64')}\r\n` +
      `--${boundary}\r\nContent-Type: application/pdf; name="plan.pdf"\r\nContent-Disposition: attachment; filename="plan.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${PDF.toString('base64')}\r\n--${boundary}--\r\n`));
    await sync();
    const src = (await api('GET', '/v1/messages?view=inbox')).json().messages[0];
    const shown = (await api('GET', `/v1/messages/${src.id}`)).json().message;
    expect(shown.body.html).toContain(`src="data:image/png;base64,${PNG.toString('base64')}"`);
    const sugg = (await api('GET', `/v1/messages/${src.id}/compose?mode=forward`)).json();
    await send({ mode: 'forward', sourceMessageId: src.id, to: ['partner@example.org'], subject: sugg.subject, text: 'FYI' });
    expect(await sendNow()).toEqual(['sent']);
    const raw = smtp.captured[0]!.raw;
    expect(raw).toMatch(/^Subject: Fwd: Drawings/m);
    expect(raw).toContain('filename=plan.pdf');
    expect(raw).toContain('Forwarded message');
  });
});

describe('templates and drafts', () => {
  it('stores templates and quick replies per user', async () => {
    expect((await api('POST', '/v1/templates', { kind: 'quick_reply', name: 'Thanks', text: 'Thank you, we will reply shortly.' })).statusCode).toBe(201);
    expect((await api('POST', '/v1/templates', { kind: 'quick_reply', name: 'Thanks', text: 'dup' })).statusCode).toBe(409);
    expect((await api('POST', '/v1/templates', { kind: 'template', name: 'Quote', subject: 'Your quotation', text: 'Dear customer,' })).statusCode).toBe(201);
    const list = (await api('GET', '/v1/templates')).json().templates;
    expect(list.map((t: { kind: string; name: string }) => `${t.kind}:${t.name}`)).toEqual(['quick_reply:Thanks', 'template:Quote']);
  });

  it('saves drafts across devices without silently overwriting, and removes the draft when it is sent', async () => {
    const id = randomUUID();
    const created = await api('POST', '/v1/drafts', { id, mailboxId, to: ['bob@example.org'], subject: 'Draft', text: 'v1', device: 'phone' });
    expect(created.statusCode).toBe(201);
    // Uploading the same offline draft again is harmless.
    expect((await api('POST', '/v1/drafts', { id, mailboxId, subject: 'Draft', text: 'v1' })).json().draft.version).toBe(1);
    const fromTablet = await api('PUT', `/v1/drafts/${id}`, { version: 1, mailboxId, to: ['bob@example.org'], subject: 'Draft', text: 'v2 tablet', device: 'tablet' });
    expect(fromTablet.json().draft.version).toBe(2);
    const stalePhone = await api('PUT', `/v1/drafts/${id}`, { version: 1, mailboxId, subject: 'Draft', text: 'v2 phone', device: 'phone' });
    expect(stalePhone.statusCode).toBe(409);
    expect(stalePhone.json().error.details.current).toMatchObject({ text: 'v2 tablet', updatedByDevice: 'tablet', version: 2 });
    await send({ to: ['bob@example.org'], subject: 'Draft', text: 'v2 tablet', draftId: id });
    expect((await api('GET', `/v1/drafts/${id}`)).statusCode).toBe(404);
  });
});

describe('scheduled sending', () => {
  it('sends at the scheduled time, can be turned back into a draft, and rejects times in the past', async () => {
    const soon = await send({ to: ['bob@example.org'], subject: 'Too soon', text: 'x', sendAt: new Date(Date.now() + 5_000).toISOString() });
    expect(soon.statusCode).toBe(400);
    const at = new Date(Date.now() + 3600_000).toISOString();
    const o = (await send({ to: ['bob@example.org'], subject: 'Monday report', text: 'Report', sendAt: at, timeZone: 'Africa/Lagos' })).json().outbound;
    expect(o).toMatchObject({ status: 'scheduled', scheduledAt: at, canUndo: false });
    expect(await runSendPass(ctx.cfg, worker, 20_000, () => undefined)).toEqual([]);
    await ctx.owner.query(`UPDATE app.outbound_messages SET scheduled_at = now() - interval '1 second' WHERE id = $1`, [o.id]);
    expect(await runSendPass(ctx.cfg, worker, 20_000, () => undefined)).toEqual(['sent']);

    const o2 = (await send({ to: ['bob@example.org'], subject: 'Edit me', text: 'first version', sendAt: at })).json().outbound;
    const edit = await api('POST', `/v1/outbound/${o2.id}/edit`, {});
    expect(edit.json().draft).toMatchObject({ subject: 'Edit me', text: 'first version', to: ['bob@example.org'] });
    expect((await api('GET', `/v1/outbound/${o2.id}`)).json().outbound.status).toBe('cancelled');
    await ctx.owner.query(`UPDATE app.outbound_messages SET scheduled_at = now() - interval '1 second'`);
    await runSendPass(ctx.cfg, worker, 20_000, () => undefined);
    expect(smtp.captured).toHaveLength(1); // the edited one did not go out
  });
});

describe('isolation', () => {
  it('another user cannot use my uploads, drafts, signatures or templates', async () => {
    const att = (await upload('quote.pdf', PDF)).json().upload;
    const draft = (await api('POST', '/v1/drafts', { mailboxId, subject: 'Mine', text: 'x' })).json().draft;
    const sig = (await api('POST', '/v1/signatures', { name: 'Mine', text: 'x' })).json();
    const other = await registerVerified(ctx, 'intruder@gmail.com');
    await ctx.owner.query(`UPDATE app.users SET status = 'approved', access_expires_at = now() + interval '1 month' WHERE id = $1`, [other]);
    const t2 = (await login(ctx, 'intruder@gmail.com')).body.accessToken;
    expect((await api('GET', `/v1/drafts/${draft.id}`, undefined, t2)).statusCode).toBe(404);
    expect((await api('GET', '/v1/signatures', undefined, t2)).json().signatures).toEqual([]);
    expect((await api('PUT', `/v1/signatures/${sig.id}`, { name: 'x', text: 'y' }, t2)).statusCode).toBe(404);
    // Their own mailbox, my upload id: refused.
    const theirs = await ctx.owner.query<{ id: string }>(
      `INSERT INTO app.mailboxes (user_id, email_address) VALUES ($1, 'x@test.local') RETURNING id`, [other]);
    const r = await api('POST', '/v1/outbound', { mailboxId: theirs.rows[0]!.id, idempotencyKey: randomUUID(), to: ['a@example.org'], subject: 's', text: 't', uploadIds: [att.id] }, t2);
    expect(r.statusCode).toBe(404);
  });
});
