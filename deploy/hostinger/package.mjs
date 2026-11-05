// Builds the archive deployed to Hostinger Node.js sites: deploy/hostinger/out/allwebmails.zip
// Prerequisites (from the repository root): npm run build, and the web app exported to apps/mobile/dist-web
// (cd apps/mobile && npx expo export --platform web --output-dir dist-web).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.cwd();
const out = join(root, 'deploy/hostinger/out');
const stage = join(out, 'app');
for (const f of ['apps/backend/dist/entry-api.js', 'apps/admin-web/dist/index.html', 'apps/mobile/dist-web/index.html']) {
  if (!existsSync(join(root, f))) throw new Error(`${f} missing — build it first (see the comment at the top of this file)`);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(root, 'apps/backend/dist'), join(stage, 'dist'), { recursive: true });
cpSync(join(root, 'apps/backend/migrations'), join(stage, 'migrations'), { recursive: true });
cpSync(join(root, 'apps/admin-web/dist'), join(stage, 'admin-web'), { recursive: true });
cpSync(join(root, 'apps/mobile/dist-web'), join(stage, 'web'), { recursive: true });
cpSync(join(root, 'deploy/hostinger/start.cjs'), join(stage, 'start.cjs'));
const pkg = JSON.parse(readFileSync(join(root, 'apps/backend/package.json'), 'utf8'));
writeFileSync(join(stage, 'package.json'), JSON.stringify({
  name: 'allwebmails-server', version: pkg.version, private: true, type: 'module', main: 'start.cjs',
  engines: { node: '>=22' },
  scripts: { build: 'node -e "console.log(\'prebuilt\')"', start: 'node start.cjs' },
  dependencies: pkg.dependencies,
}, null, 2) + '\n');
execFileSync('zip', ['-qr', join(out, 'allwebmails.zip'), '.'], { cwd: stage });
console.log(`Archive ready: ${join(out, 'allwebmails.zip')}`);
