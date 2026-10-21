import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { toAccount, type UserRow } from './lib/account.js';
import type { Config } from './lib/config.js';
import { withUser, type Db } from './lib/db.js';
import { AppError } from './lib/errors.js';
import { createHttp } from './lib/http.js';
import type { Mailer } from './lib/mailer.js';
import type { TokenSigner } from './lib/jwt.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerMeRoutes } from './routes/me.js';
import { registerPageRoutes } from './routes/pages.js';

export interface Deps {
  cfg: Config;
  db: { auth: Db; api: Db };
  mailer: Mailer;
  signer: TokenSigner;
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

export async function buildUserApi(deps: Deps): Promise<FastifyInstance> {
  const app = await createHttp(deps.cfg);
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
  app.get('/v1/config', async () => ({ minimumSupportedAppVersion: deps.cfg.minAppVersion }));
  registerAuthRoutes(app, deps);
  registerMeRoutes(app, deps);
  registerPageRoutes(app, deps);
  return app;
}
