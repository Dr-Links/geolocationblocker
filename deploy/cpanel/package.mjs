// Builds the folder you upload to cPanel: deploy/cpanel/out/emailplatform/
// Run from the repository root: npm run package:cpanel
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const out = join(root, 'deploy/cpanel/out/emailplatform');
const backend = join(root, 'apps/backend');

for (const required of ['apps/backend/dist/entry-api.js', 'apps/admin-web/dist/index.html']) {
  if (!existsSync(join(root, required))) throw new Error(`${required} missing — run "npm run build" first`);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(backend, 'dist'), join(out, 'dist'), { recursive: true });
cpSync(join(backend, 'migrations'), join(out, 'migrations'), { recursive: true });
cpSync(join(root, 'apps/admin-web/dist'), join(out, 'admin-web'), { recursive: true });
cpSync(join(root, 'deploy/cpanel/api.cjs'), join(out, 'api.cjs'));
cpSync(join(root, 'deploy/cpanel/admin.cjs'), join(out, 'admin.cjs'));
cpSync(join(root, 'deploy/cpanel/env.example'), join(out, 'env.example'));

const pkg = JSON.parse(readFileSync(join(backend, 'package.json'), 'utf8'));
writeFileSync(join(out, 'package.json'), JSON.stringify({
  name: 'emailplatform-server',
  version: pkg.version,
  private: true,
  type: 'module',
  engines: { node: '>=20.12' },
  scripts: {
    migrate: 'node dist/cli.js db:migrate',
    'admin:create': 'node dist/cli.js admin:create',
    'scheduler:tick': 'node dist/cli.js scheduler:tick',
  },
  dependencies: pkg.dependencies,
}, null, 2) + '\n');
console.log(`Deployment folder ready: ${out}`);
