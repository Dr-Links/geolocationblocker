import { buildUserApi } from './app.js';
import { loadConfig } from './lib/config.js';
import { loadEnvFile } from './lib/envfile.js';
import { createPool } from './lib/db.js';
import { TokenSigner } from './lib/jwt.js';
import { createMailer } from './lib/mailer.js';

loadEnvFile();
const cfg = loadConfig();
const app = await buildUserApi({
  cfg,
  db: { auth: createPool(cfg, 'auth'), api: createPool(cfg, 'api') },
  mailer: createMailer(cfg),
  signer: await TokenSigner.create(cfg.jwtPrivateKeyPem),
});
if (!cfg.jwtPrivateKeyPem) app.log.warn('JWT_PRIVATE_KEY not set: using an ephemeral key (development only).');
// Under cPanel/Passenger the port is assigned by Passenger, which intercepts listen().
await app.listen({ port: Number(process.env.PORT ?? cfg.port), host: cfg.host });
