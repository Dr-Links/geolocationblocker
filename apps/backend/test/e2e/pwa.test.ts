import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, type Db } from '../../src/lib/db.js';
import { runSyncPass } from '../../src/sync/runner.js';
import type { DiscoveryDeps } from '../../src/mail/discovery.js';
import { PASSWORD, bearer, login, makeCtx, registerVerified, resetData, type Ctx } from '../helpers.js';
import { MAIL_DIR, MAIL_PASSWORD, startSmtp } from '../mailserver/smtp.js';

// End-to-end test of the real web app build (expo export --platform web) in Chromium.
// Set WEB_E2E_DIR to the export folder; skipped otherwise, or when Playwright is not installed.
const WEB = process.env.WEB_E2E_DIR;
/* eslint-disable @typescript-eslint/no-explicit-any */
// Playwright is pre-installed globally (not a project dependency), so it is loaded untyped.
type PW = { chromium: { launch(): Promise<any> } };
let pw: PW | null = null;
try {
  pw = createRequire(import.meta.url)('playwright') as PW;
} catch {
  pw = null;
}
const enabled = !!WEB && existsSync(`${WEB}/index.html`) && !!pw;
const PORT = 19750;
const BASE = `http://127.0.0.1:${PORT}`;
const noDiscovery: DiscoveryDeps = { resolveMx: async () => [], resolveSrv: async () => [], fetchText: async () => null };

let ctx: Ctx;
let worker: Db;
let smtp: Awaited<ReturnType<typeof startSmtp>>;
let browser: any;

beforeAll(async () => {
  if (!enabled) return;
  ctx = await makeCtx({ env: { MAIL_EXTRA_CA_FILE: `${MAIL_DIR}/ca.pem`, WEB_APP_DIR: WEB! }, discovery: noDiscovery });
  worker = createPool(ctx.cfg, 'worker');
  smtp = await startSmtp(() => ({ 'alice@test.local': MAIL_PASSWORD }));
  await ctx.api.listen({ port: PORT, host: '127.0.0.1' });
  browser = await pw!.chromium.launch();
}, 60_000);
afterAll(async () => {
  if (!enabled) return;
  await browser?.close();
  await smtp.close();
  await worker.end();
  await ctx.close();
});

describe.skipIf(!enabled)('web app (PWA) in a real browser', () => {
  it('signs in, reads mail safely, warns before opening links, and composes', async () => {
    await resetData(ctx);
    // A user with one mailbox and one message containing a deceptive link.
    const email = 'pwa.user@gmail.com';
    const uid = await registerVerified(ctx, email);
    await ctx.owner.query(`UPDATE app.users SET status = 'approved', access_expires_at = now() + interval '1 month' WHERE id = $1`, [uid]);
    const phone = (await login(ctx, email)).body.accessToken as string;
    const c = new ImapFlow({ host: '127.0.0.1', port: 19993, secure: true, auth: { user: 'alice@test.local', pass: MAIL_PASSWORD }, logger: false,
      tls: { ca: readFileSync(`${MAIL_DIR}/ca.pem`), servername: 'localhost' } });
    c.on('error', () => undefined);
    await c.connect();
    for (const f of await c.list()) {
      const lock = await c.getMailboxLock(f.path);
      try { if (c.mailbox && c.mailbox.exists) await c.messageDelete('1:*'); } finally { lock.release(); }
    }
    await c.append('INBOX', `From: Bank <alerts@paypa1.example>\r\nTo: alice@test.local\r\nSubject: Verify your account\r\nMessage-ID: <${randomUUID()}@x>\r\n` +
      `Date: ${new Date().toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: text/html\r\n\r\n<p>Hello PWA reader</p><a href="https://login.paypa1.example/">https://www.paypal.com</a><script>parent.document.title='pwned'</script>\r\n`);
    await c.logout();
    const add = await ctx.api.inject({ method: 'POST', url: '/v1/mailboxes', headers: bearer(phone), payload: { email: 'alice@test.local', password: MAIL_PASSWORD,
      manual: { imap: { host: 'localhost', port: 19993, security: 'tls', username: 'alice@test.local' }, smtp: { host: 'localhost', port: 19465, security: 'tls', username: 'alice@test.local' } } } });
    expect(add.statusCode).toBe(201);
    await ctx.owner.query(`UPDATE app.mailboxes SET next_sync_at = now()`);
    await runSyncPass(ctx.cfg, worker, { budgetMs: 20_000, log: () => undefined });

    const context = await browser.newContext();
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('console', (m: any) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
    page.on('pageerror', (e: any) => problems.push(`pageerror: ${e.message}`));
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP blocked ${e.violatedDirective} ${e.blockedURI}`));
    });
    const dialogs: string[] = [];
    page.on('dialog', async (d: any) => { dialogs.push(d.message()); await d.dismiss(); });

    await page.goto(BASE);
    await page.getByLabel('Gmail address').fill(email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    const shot = (n: string) => (process.env.E2E_DEBUG ? page.screenshot({ path: `${process.env.E2E_DEBUG}/${n}.png` }) : Promise.resolve());
    await page.getByText('Open all inboxes').click();
    await page.getByText('Verify your account').click();

    const mail = page.frameLocator('iframe[title="Message"]');
    await expect.poll(() => mail.locator('body').textContent()).toContain('Hello PWA reader');
    await expect.poll(() => page.getByText('This message looks dangerous').count()).toBeGreaterThan(0);
    expect(await page.title()).not.toBe('pwned');               // the email's script never ran
    // The refresh token is not readable by page scripts.
    expect(await page.evaluate(() => document.cookie)).not.toContain('awm_rt');
    expect((await context.cookies()).find((k: any) => k.name === 'awm_rt')).toMatchObject({ httpOnly: true, sameSite: 'Strict' });

    // A link click in the mail is handed to the app, which asks before opening it.
    await mail.locator('a').click();
    await expect.poll(() => dialogs.length).toBeGreaterThan(0);
    expect(dialogs.join('\n')).toMatch(/paypa1\.example/);

    // Compose: type in the editor frame, format, and see it reach the app (autosaved draft on the server).
    await page.goto(`${BASE}/compose`);
    const editor = page.frameLocator('iframe[title="Message editor"]').locator('#e');
    await editor.click();
    await editor.pressSequentially('Typed in the browser');
    await page.getByLabel('Bold').click();
    await page.getByLabel('Subject').fill('From the web app');
    await shot('compose');
    await expect.poll(async () => {
      const r = await ctx.api.inject({ method: 'GET', url: '/v1/drafts', headers: bearer(phone) });
      return JSON.stringify(r.json());
    }, { timeout: 15_000 }).toContain('Typed in the browser');

    // A reload keeps the session (cookie refresh) without storing tokens in the page.
    await page.goto(`${BASE}/inbox`);
    await expect.poll(() => page.getByText('Verify your account').count(), { timeout: 15_000 }).toBeGreaterThan(0);
    await shot('after-reload');
    expect(await page.getByLabel('Gmail address').count()).toBe(0);
    const ls = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)));
    expect(ls).not.toMatch(/token|Hello PWA reader/i);

    expect(problems.filter((p) => /CSP blocked|pageerror/.test(p))).toEqual([]);
    await context.close();
  }, 120_000);
});
