import { readFileSync } from 'node:fs';
import { ImapFlow } from 'imapflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, type Db } from '../src/lib/db.js';
import { toTsQuery } from '../src/routes/search.js';
import { runSyncPass } from '../src/sync/runner.js';
import type { DiscoveryDeps } from '../src/mail/discovery.js';
import { bearer, login, makeCtx, registerVerified, resetData, type Ctx } from './helpers.js';
import { MAIL_DIR, MAIL_PASSWORD, startSmtp } from './mailserver/smtp.js';

const noDiscovery: DiscoveryDeps = { resolveMx: async () => [], resolveSrv: async () => [], fetchText: async () => null };
const manual = (user: string) => ({
  imap: { host: 'localhost', port: 19993, security: 'tls', username: user },
  smtp: { host: 'localhost', port: 19465, security: 'tls', username: user },
});

async function onServer<T>(user: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = new ImapFlow({ host: '127.0.0.1', port: 19993, secure: true, auth: { user, pass: MAIL_PASSWORD }, logger: false,
    tls: { ca: readFileSync(`${MAIL_DIR}/ca.pem`), servername: 'localhost' } });
  c.on('error', () => undefined);
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.logout();
  }
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
function mail(o: { id: string; subject: string; from?: string; to?: string; text: string; inReplyTo?: string; references?: string[]; date?: Date; attach?: boolean }) {
  const refs = o.references ?? (o.inReplyTo ? [o.inReplyTo] : []);
  const head = [
    `From: ${o.from ?? 'Customer <customer@example.org>'}`, `To: ${o.to ?? 'alice@test.local'}`, `Subject: ${o.subject}`,
    `Date: ${(o.date ?? new Date()).toUTCString()}`, `Message-ID: <${o.id}>`,
    ...(o.inReplyTo ? [`In-Reply-To: <${o.inReplyTo}>`] : []), ...(refs.length ? [`References: ${refs.map((r) => `<${r}>`).join(' ')}`] : []),
    'MIME-Version: 1.0',
  ];
  if (!o.attach) return `${head.join('\r\n')}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${o.text}\r\n`;
  return `${head.join('\r\n')}\r\nContent-Type: multipart/mixed; boundary="x"\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\n${o.text}\r\n` +
    `--x\r\nContent-Type: application/pdf; name="a.pdf"\r\nContent-Disposition: attachment; filename="a.pdf"\r\n\r\nPDF\r\n--x--\r\n`;
}

let ctx: Ctx;
let worker: Db;
let smtp: Awaited<ReturnType<typeof startSmtp>>;
let token: string;
let alice: string;
let bob: string;

const api = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object, t = token) => ctx.api.inject({ method, url, headers: bearer(t), payload });
const sync = async () => {
  await ctx.owner.query(`UPDATE app.mailboxes SET next_sync_at = now(), sync_lease_until = NULL`);
  await ctx.owner.query(`UPDATE app.folders SET next_sync_at = now()`);
  return runSyncPass(ctx.cfg, worker, { budgetMs: 30_000, log: () => undefined });
};
const search = async (qs: string) => (await api('GET', `/v1/search?${qs}`)).json().results.map((m: { subject: string }) => m.subject).sort();

beforeAll(async () => {
  ctx = await makeCtx({ env: { MAIL_EXTRA_CA_FILE: `${MAIL_DIR}/ca.pem` }, discovery: noDiscovery });
  worker = createPool(ctx.cfg, 'worker');
  smtp = await startSmtp(() => ({ 'alice@test.local': MAIL_PASSWORD, 'bob@test.local': MAIL_PASSWORD }));
});
afterAll(async () => {
  await smtp.close();
  await worker.end();
  await ctx.close();
});
beforeEach(async () => {
  await resetData(ctx);
  for (const user of ['alice@test.local', 'bob@test.local']) {
    await onServer(user, async (c) => {
      for (const f of await c.list()) {
        const lock = await c.getMailboxLock(f.path);
        try {
          if (c.mailbox && c.mailbox.exists) await c.messageDelete('1:*');
        } finally {
          lock.release();
        }
      }
    });
  }
  const uid = await registerVerified(ctx, 'searcher@gmail.com');
  await ctx.owner.query(`UPDATE app.users SET status = 'approved', access_expires_at = now() + interval '1 month' WHERE id = $1`, [uid]);
  token = (await login(ctx, 'searcher@gmail.com')).body.accessToken;
  alice = (await api('POST', '/v1/mailboxes', { email: 'alice@test.local', password: MAIL_PASSWORD, manual: manual('alice@test.local') })).json().mailbox.id;
  bob = (await api('POST', '/v1/mailboxes', { email: 'bob@test.local', password: MAIL_PASSWORD, manual: manual('bob@test.local') })).json().mailbox.id;
});

describe('conversations', () => {
  it('groups a conversation across two of my mailboxes and labels each message', async () => {
    await onServer('alice@test.local', (c) => c.append('INBOX', mail({ id: 'p1@example.org', subject: 'Project kickoff', text: 'Start?', date: daysAgo(2) }), [], daysAgo(2)));
    await onServer('bob@test.local', (c) => c.append('INBOX', mail({ id: 'p2@example.org', subject: 'Re: Project kickoff', to: 'bob@test.local', inReplyTo: 'p1@example.org', text: 'Yes, Monday.' })));
    await sync();
    const threads = (await api('GET', '/v1/threads?view=inbox')).json().threads;
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ messageCount: 2, unreadCount: 2 });
    expect(threads[0].mailboxes.sort()).toEqual(['alice@test.local', 'bob@test.local']);
    const t = (await api('GET', `/v1/threads/${threads[0].id}`)).json();
    expect(t.messages.map((m: { subject: string; mailbox: { email: string } }) => [m.subject, m.mailbox.email])).toEqual([
      ['Project kickoff', 'alice@test.local'], ['Re: Project kickoff', 'bob@test.local'],
    ]);
    // Filtering by one mailbox still finds the conversation through that mailbox's message.
    expect((await api('GET', `/v1/threads?view=inbox&mailboxId=${alice}`)).json().threads[0].id).toBe(threads[0].id);
  });

  it('merges two conversations when a later message links them', async () => {
    await onServer('alice@test.local', async (c) => {
      await c.append('INBOX', mail({ id: 'a@example.org', subject: 'Part A', text: 'a', date: daysAgo(3) }));
      await c.append('INBOX', mail({ id: 'b@example.org', subject: 'Part B', text: 'b', date: daysAgo(2) }));
    });
    await sync();
    expect((await api('GET', '/v1/threads?view=inbox')).json().threads).toHaveLength(2);
    await onServer('alice@test.local', (c) => c.append('INBOX', mail({ id: 'c@example.org', subject: 'Re: both', text: 'c', inReplyTo: 'b@example.org', references: ['a@example.org', 'b@example.org'] })));
    await sync();
    const threads = (await api('GET', '/v1/threads?view=inbox')).json().threads;
    expect(threads).toHaveLength(1);
    expect(threads[0].messageCount).toBe(3);
  });

  it('uses the subject only as a narrow fallback (reply prefix + shared participant + 14 days)', async () => {
    await onServer('alice@test.local', async (c) => {
      await c.append('INBOX', mail({ id: 'inv@example.org', subject: 'Invoice 77', text: 'Invoice attached', date: daysAgo(5) }));
      // Reply whose original is missing headers, same correspondent → joins.
      await c.append('INBOX', mail({ id: 'inv-re@example.org', subject: 'RE: Invoice 77', text: 'Paid', date: daysAgo(4) }));
      // Same subject from a stranger → separate.
      await c.append('INBOX', mail({ id: 'spam@example.org', subject: 'Re: Invoice 77', from: 'stranger@evil.example', text: 'Click here', date: daysAgo(3) }));
      // Not a reply at all → separate even with the same subject.
      await c.append('INBOX', mail({ id: 'inv2@example.org', subject: 'Invoice 77', text: 'Another one', date: daysAgo(1) }));
    });
    await sync();
    const threads = (await api('GET', '/v1/threads?view=inbox')).json().threads;
    const counts = threads.map((t: { messageCount: number }) => t.messageCount).sort();
    expect(counts).toEqual([1, 1, 2]);
  });
});

describe('search', () => {
  beforeEach(async () => {
    await onServer('alice@test.local', async (c) => {
      await c.append('INBOX', mail({ id: 's1@example.org', subject: 'Quotation for steel beams', from: 'Ada Buyer <ada@buyer.example>', text: 'Please quote 40 tonnes', date: daysAgo(10) }), ['\\Seen', '\\Flagged'], daysAgo(10));
      await c.append('INBOX', mail({ id: 's2@example.org', subject: 'Lunch', from: 'friend@example.org', text: 'Pizza on Friday?', date: daysAgo(1) }), [], daysAgo(1));
      await c.append('Sent', mail({ id: 's3@example.org', subject: 'Re: Quotation for steel beams', from: 'alice@test.local', to: 'Ada Buyer <ada@buyer.example>', text: 'Our quotation is attached', attach: true, date: daysAgo(9) }), ['\\Seen'], daysAgo(9));
    });
    await onServer('bob@test.local', (c) => c.append('INBOX', mail({ id: 's4@example.org', subject: 'Steel delivery schedule', to: 'bob@test.local', text: 'Trucks arrive Tuesday', date: daysAgo(3) }), [], daysAgo(3)));
    await sync();
  });

  it('searches text across all mailboxes including Sent, with prefix matching', async () => {
    expect(await search('q=steel')).toEqual(['Quotation for steel beams', 'Re: Quotation for steel beams', 'Steel delivery schedule']);
    expect(await search('q=quot')).toEqual(['Quotation for steel beams', 'Re: Quotation for steel beams']); // prefix
    expect(await search('q=tonnes')).toEqual(['Quotation for steel beams']); // body text
    expect(await search('q=steel%20tuesday')).toEqual(['Steel delivery schedule']); // all words must match
  });

  it('combines filters: sender, recipient, subject, mailbox, folder, state, attachments, dates', async () => {
    expect(await search('from=ada')).toEqual(['Quotation for steel beams']);
    expect(await search('from=Buyer')).toEqual(['Quotation for steel beams']); // by display name
    expect(await search('to=ada%40buyer')).toEqual(['Re: Quotation for steel beams']);
    expect(await search('subject=lunch')).toEqual(['Lunch']);
    expect(await search(`q=steel&mailboxId=${bob}`)).toEqual(['Steel delivery schedule']);
    expect(await search('q=steel&in=sent')).toEqual(['Re: Quotation for steel beams']);
    expect(await search('unread=1')).toEqual(['Lunch', 'Steel delivery schedule']);
    expect(await search('flagged=1')).toEqual(['Quotation for steel beams']);
    expect(await search('hasAttachments=1')).toEqual(['Re: Quotation for steel beams']);
    expect(await search(`dateFrom=${encodeURIComponent(daysAgo(5).toISOString())}`)).toEqual(['Lunch', 'Steel delivery schedule']);
    const r = await api('GET', '/v1/search?q=steel');
    expect(r.json().results[0].mailbox.email).toBeDefined(); // every result says which mailbox holds it
  });

  it('is safe against query syntax and never shows other users\' mail', async () => {
    expect(toTsQuery("steel' & | ! :* ()")).toBe('steel:*');
    expect((await api('GET', `/v1/search?q=${encodeURIComponent("'); DROP TABLE messages; --")}`)).statusCode).toBe(200);
    expect((await api('GET', `/v1/search?q=${encodeURIComponent('&&&')}`)).statusCode).toBe(400);
    const other = await registerVerified(ctx, 'snoop@gmail.com');
    await ctx.owner.query(`UPDATE app.users SET status = 'approved', access_expires_at = now() + interval '1 month' WHERE id = $1`, [other]);
    const t2 = (await login(ctx, 'snoop@gmail.com')).body.accessToken;
    expect((await api('GET', '/v1/search?q=steel', undefined, t2)).json().results).toEqual([]);
    expect((await api('GET', '/v1/threads?view=inbox', undefined, t2)).json().threads).toEqual([]);
  });

  it('saves searches per user', async () => {
    const s = await api('POST', '/v1/saved-searches', { name: 'Steel deals', query: { q: 'steel', in: 'any' } });
    expect(s.statusCode).toBe(201);
    expect((await api('POST', '/v1/saved-searches', { name: 'Steel deals', query: { q: 'x' } })).statusCode).toBe(409);
    const list = (await api('GET', '/v1/saved-searches')).json().savedSearches;
    expect(list).toMatchObject([{ name: 'Steel deals', query: { q: 'steel' } }]);
    expect((await api('DELETE', `/v1/saved-searches/${list[0].id}`)).statusCode).toBe(204);
  });

  it('finds older mail on the server and imports it', async () => {
    await onServer('alice@test.local', (c) => c.append('INBOX', mail({ id: 'old@example.org', subject: 'Contract 2019', text: 'Original warranty terms', date: daysAgo(400) }), [], daysAgo(400)));
    await sync();
    expect(await search('q=warranty')).toEqual([]); // outside the 90-day window
    const r = await api('POST', `/v1/mailboxes/${alice}/server-search`, { q: 'warranty' });
    expect(r.json()).toMatchObject({ imported: 1 });
    expect(await search('q=warranty')).toEqual(['Contract 2019']);
  });
});
