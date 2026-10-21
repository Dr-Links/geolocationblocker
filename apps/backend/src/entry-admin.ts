import { buildAdminApi } from './admin/app.js';
import { loadConfig } from './lib/config.js';
import { appRoot, loadEnvFile } from './lib/envfile.js';
import { createPool } from './lib/db.js';
import { createMailer } from './lib/mailer.js';
import { join } from 'node:path';

loadEnvFile();
const cfg = loadConfig();
// The deployment package ships the built dashboard in <appRoot>/admin-web.
cfg.adminStaticDir ??= join(appRoot, 'admin-web');
const app = await buildAdminApi({ cfg, db: createPool(cfg, 'admin'), mailer: createMailer(cfg) });
await app.listen({ port: Number(process.env.PORT ?? cfg.adminPort), host: cfg.host });
