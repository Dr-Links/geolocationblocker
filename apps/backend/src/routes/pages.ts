import { PASSWORD_MIN_LENGTH } from '@app/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import type { Deps } from '../app.js';
import { resetPassword, verifyEmail } from './auth.js';

// Minimal server-rendered pages for links opened from emails. No JavaScript; tokens are
// only consumed on POST, so link scanners that prefetch GET URLs cannot use them up.

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(reply: FastifyReply, title: string, body: string, status = 200) {
  return reply
    .code(status)
    .header('content-type', 'text/html; charset=utf-8')
    .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
    .header('cache-control', 'no-store')
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${esc(title)}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f6f8;color:#1f2933;margin:0;padding:16px}
main{max-width:420px;margin:48px auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{font-size:22px;margin:0 0 12px}p{line-height:1.5}label{display:block;font-weight:600;margin:14px 0 6px}
input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cbd2d9;border-radius:8px;font-size:16px}
button{margin-top:18px;width:100%;padding:12px;border:0;border-radius:8px;background:#1d4ed8;color:#fff;font-size:16px;font-weight:600;cursor:pointer}
.err{color:#b91c1c}.ok{color:#047857}.hint{color:#52606d;font-size:14px}</style></head>
<body><main><h1>${esc(title)}</h1>${body}</main></body></html>`);
}

const tokenQuery = z.object({ token: z.string().min(10).max(200) });

export function registerPageRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/v1/pages/verify-email', async (req, reply) => {
    const q = tokenQuery.safeParse(req.query);
    if (!q.success) return page(reply, 'Link not valid', '<p class="err">This link is incomplete. Open it again from your email.</p>', 400);
    return page(reply, 'Confirm your email', `<p>Press the button to confirm your Gmail address.</p>
<form method="post" action="/v1/pages/verify-email"><input type="hidden" name="token" value="${esc(q.data.token)}"><button type="submit">Confirm email address</button></form>`);
  });

  app.post('/v1/pages/verify-email', { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const q = tokenQuery.safeParse(req.body);
    if (!q.success) return page(reply, 'Link not valid', '<p class="err">This link is incomplete.</p>', 400);
    try {
      await verifyEmail(deps, q.data.token, req.ip);
      return page(reply, 'Email confirmed', '<p class="ok">Thank you. Your account is now waiting for approval by the administrator.</p><p>You will receive an email when it is approved. You can close this page.</p>');
    } catch (err) {
      if (err instanceof AppError) return page(reply, 'Link not valid', `<p class="err">${esc(err.message)}</p>`, 400);
      throw err;
    }
  });

  const resetForm = (token: string, error?: string) => `
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/v1/pages/reset-password">
<input type="hidden" name="token" value="${esc(token)}">
<label for="p1">New password</label><input id="p1" name="password" type="password" autocomplete="new-password" minlength="${PASSWORD_MIN_LENGTH}" required>
<label for="p2">Repeat new password</label><input id="p2" name="password2" type="password" autocomplete="new-password" minlength="${PASSWORD_MIN_LENGTH}" required>
<p class="hint">At least ${PASSWORD_MIN_LENGTH} characters. A short phrase of several words works well.</p>
<button type="submit">Change password</button></form>`;

  app.get('/v1/pages/reset-password', async (req, reply) => {
    const q = tokenQuery.safeParse(req.query);
    if (!q.success) return page(reply, 'Link not valid', '<p class="err">This link is incomplete. Open it again from your email.</p>', 400);
    return page(reply, 'Choose a new password', resetForm(q.data.token));
  });

  app.post('/v1/pages/reset-password', { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const b = z.object({ token: z.string().min(10).max(200), password: z.string().max(1024), password2: z.string().max(1024) }).safeParse(req.body);
    if (!b.success) return page(reply, 'Link not valid', '<p class="err">This link is incomplete.</p>', 400);
    if (b.data.password !== b.data.password2) return page(reply, 'Choose a new password', resetForm(b.data.token, 'The two passwords do not match.'), 400);
    try {
      await resetPassword(deps, b.data.token, b.data.password, req.ip);
      return page(reply, 'Password changed', '<p class="ok">Your password has been changed. Sign in to the app with your new password.</p>');
    } catch (err) {
      if (err instanceof AppError && err.code === 'weak_password') return page(reply, 'Choose a new password', resetForm(b.data.token, err.message), 400);
      if (err instanceof AppError) return page(reply, 'Link not valid', `<p class="err">${esc(err.message)}</p>`, 400);
      throw err;
    }
  });
}
