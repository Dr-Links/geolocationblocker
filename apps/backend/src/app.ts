import cookie from '@fastify/cookie';
import { registerWebApp, spaFallback, webAppDir } from './web/webapp.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { toAccount, type UserRow } from './lib/account.js';
import type { Config } from './lib/config.js';
import { withUser, type Db } from './lib/db.js';
import { AppError } from './lib/errors.js';
import { createHttp } from './lib/http.js';
import type { Mailer } from './lib/mailer.js';
import type { TokenSigner } from './lib/jwt.js';
import { defaultDiscoveryDeps, type DiscoveryDeps } from './mail/discovery.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerMailboxRoutes } from './routes/mailboxes.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerOutboundRoutes } from './routes/outbound.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerComposeRoutes } from './routes/compose.js';
import { registerDeviceRoutes } from './routes/devices.js';
import { registerStorageRoutes } from './routes/storage.js';
import { registerSecurityRoutes } from './routes/security.js';
import { registerThreadRoutes } from './routes/threads.js';
import { registerMeRoutes } from './routes/me.js';
import { registerPageRoutes } from './routes/pages.js';

export interface Deps {
  cfg: Config;
  db: { auth: Db; api: Db };
  mailer: Mailer;
  signer: TokenSigner;
  /** DNS/HTTP lookups for mailbox server discovery (replaceable in tests). */
  discovery: DiscoveryDeps;
  /** Send from the API process right after the undo window (the cron job is the fallback). Default true. */
  inProcessSend?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: { user: UserRow; sessionId: string };
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireActive: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export async function buildUserApi(input: Omit<Deps, 'discovery'> & { discovery?: DiscoveryDeps }): Promise<FastifyInstance> {
  const deps: Deps = { ...input, discovery: input.discovery ?? defaultDiscoveryDeps(input.cfg) };
  const webDir = webAppDir(deps.cfg);
  const app = await createHttp(deps.cfg, { notFound: spaFallback(webDir) });
  await app.register(cookie);
  if (webDir) await registerWebApp(app, webDir);
  app.decorateRequest('auth', undefined);

  // Verifies the access token AND that its session is still live, on every request,
  // so revocation and suspension take effect immediately.
  app.decorate('authenticate', async (req: FastifyRequest) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const claims = token ? await deps.signer.verifyAccess(token) : null;
    if (!claims) throw new AppError(401, 'unauthorized', 'Please sign in.');
    const found = await withUser(deps.db.api, claims.sub, async (c) => {
      const s = await c.query(`SELECT 1 FROM sessions WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()`, [claims.sid]);
      if (!s.rowCount) return null;
      const u = await c.query<UserRow>(`SELECT * FROM users WHERE id = app.current_user_id()`);
      return u.rows[0] ?? null;
    });
    if (!found || found.status === 'deleting') throw new AppError(401, 'session_revoked', 'Your session has ended. Please sign in again.');
    req.auth = { user: found, sessionId: claims.sid };
  });

  app.decorate('requireActive', async (req: FastifyRequest) => {
    const account = toAccount(req.auth!.user);
    switch (account.displayStatus) {
      case 'active':
        return;
      case 'pending':
        throw new AppError(403, 'account_pending', 'Your account is waiting for administrator approval.');
      case 'expired':
        throw new AppError(403, 'account_expired', 'Your access period has ended. Contact the administrator to renew.');
      default:
        throw new AppError(403, 'account_suspended', 'Your account is suspended. Contact the administrator.');
    }
  });

  app.get('/healthz', async () => ({ ok: true }));
  /** Database reachable (for a load balancer). Background job ages are reported but do not fail it. */
  app.get('/readyz', async (_req, reply) => {
    try {
      const { rows } = await deps.db.api.query<{ ages: Record<string, number> }>(`SELECT app.heartbeat_ages() AS ages`);
      return { ok: true, db: 'ok', jobAgesSeconds: rows[0]?.ages ?? {} };
    } catch {
      return reply.code(503).send({ ok: false, db: 'unreachable' });
    }
  });
  /** For an uptime monitor: 503 when the cron job (scheduler) or mailbox sync has stopped running. */
  app.get('/healthz/jobs', async (_req, reply) => {
    try {
      const { rows } = await deps.db.api.query<{ ages: Record<string, number> }>(`SELECT app.heartbeat_ages() AS ages`);
      const ages = rows[0]?.ages ?? {};
      const stale = ['scheduler', 'sync'].filter((j) => ages[j] === undefined || ages[j]! > deps.cfg.jobStaleSeconds);
      return reply.code(stale.length ? 503 : 200).send({ ok: !stale.length, stale, jobAgesSeconds: ages });
    } catch {
      return reply.code(503).send({ ok: false, db: 'unreachable' });
    }
  });
  app.get('/v1/config', async () => ({
    minimumSupportedAppVersion: deps.cfg.minAppVersion,
    latestAppVersion: deps.cfg.latestAppVersion ?? null,
    appDownloadUrl: deps.cfg.appDownloadUrl ?? null,
    webPushPublicKey: deps.cfg.push.webPush?.publicKey ?? null,
  }));
  registerAuthRoutes(app, deps);
  registerMeRoutes(app, deps);
  registerPageRoutes(app, deps);
  registerMailboxRoutes(app, deps);
  registerMessageRoutes(app, deps);
  registerOutboundRoutes(app, deps);
  registerThreadRoutes(app, deps);
  registerSearchRoutes(app, deps);
  registerComposeRoutes(app, deps);
  registerDeviceRoutes(app, deps);
  registerStorageRoutes(app, deps);
  registerSecurityRoutes(app, deps);
  return app;
}
