import { chromium } from 'playwright';
import fs from 'node:fs';

const { APP, CENTRAL_URL, WP_URL, PLUGIN_ZIP, CENTRAL_DB, DB_USER, DB_PASS } = process.env;
const results = [];
const check = (name, cond, detail = '') => { results.push(!!cond); console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? ' — ' + detail : ''}`); };

// 1. Unconfigured package explains what to do and offers a key.
const unconfigured = await (await fetch(`${CENTRAL_URL}/`)).text();
check('unconfigured install shows setup instructions', unconfigured.includes('not configured yet'));
const key = (unconfigured.match(/\b[0-9a-f]{64}\b/) || [])[0];
check('a fresh application key is offered', !!key);
check('no config.php shipped', !fs.existsSync(`${APP}/config/config.php`));

// 2. Create config.php from the example exactly as the docs describe.
let cfg = fs.readFileSync(`${APP}/config/config.example.php`, 'utf8');
cfg = cfg.replace("'url' => 'https://chat.example.com'", `'url' => '${CENTRAL_URL}'`)
  .replace("'key' => ''", `'key' => '${key}'`)
  .replace("'host' => 'localhost'", "'host' => '127.0.0.1'")
  .replace("'name' => 'cpaneluser_signalpost'", `'name' => '${CENTRAL_DB}'`)
  .replace("'user' => 'cpaneluser_spapp'", `'user' => '${DB_USER}'`)
  .replace("'password' => ''", `'password' => '${DB_PASS}'`)
  // Local test only: no TLS on PHP's built-in server.
  .replace("'force_https' => true", "'force_https' => false");
fs.writeFileSync(`${APP}/config/config.php`, cfg, { mode: 0o600 });

const browser = await chromium.launch();
try {
  const page = await (await browser.newContext()).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  // 3. Web installer with the setup token from the filesystem.
  await page.goto(`${CENTRAL_URL}/login`);
  check('login redirects to installer on empty database', page.url().endsWith('/install'));
  const token = fs.readFileSync(`${APP}/storage/setup-token.txt`, 'utf8').trim();
  check('setup token file is private (0600)', (fs.statSync(`${APP}/storage/setup-token.txt`).mode & 0o777) === 0o600);
  check('token not shown in installer page', !(await page.content()).includes(token));
  await page.fill('#f-setup_token', token);
  await page.fill('#f-display_name', 'Platform Owner');
  await page.fill('#f-email', 'owner@example.test');
  await page.fill('#f-workspace_name', 'First Workspace');
  await page.fill('#f-password', 'a-strong-owner-pass-1');
  await page.fill('#f-password_confirm', 'a-strong-owner-pass-1');
  await page.click('button[type=submit]');
  await page.waitForURL(/\/login\?ok=installed/);
  check('installer finished', (await page.textContent('main')).includes('Installation complete'));
  check('setup token deleted', !fs.existsSync(`${APP}/storage/setup-token.txt`));
  check('installer disabled afterwards', (await fetch(`${CENTRAL_URL}/install`)).status === 404);

  // 4. Sign in, register a website, generate a pairing code through the UI.
  await page.fill('#f-email', 'owner@example.test');
  await page.fill('#f-password', 'a-strong-owner-pass-1');
  await page.click('button[type=submit]');
  await page.waitForURL(/\/w\/\d+$/);
  const ws = page.url().match(/\/w\/(\d+)/)[1];
  await page.goto(`${CENTRAL_URL}/admin`);
  const health = await page.textContent('main');
  check('health: no pending migrations', !health.includes('pending'));
  check('health: config not world-readable', health.includes('config.php world-readable') && !health.includes('chmod 600'));
  await page.goto(`${CENTRAL_URL}/w/${ws}/websites`);
  await page.fill('#f-name', 'Clean WP');
  await page.fill('#f-origin', WP_URL);
  await page.click('button:has-text("Add website")');
  await page.waitForURL(/websites\/\d+/);
  await page.click('button:has-text("Generate pairing code")');
  const code = (await page.textContent('.secret-box')).trim();
  check('pairing code displayed once', /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/.test(code), code);

  // 5. Install the plugin ZIP through the standard WordPress uploader.
  const wp = await (await browser.newContext()).newPage();
  await wp.goto(`${WP_URL}/wp-login.php`);
  await wp.fill('#user_login', 'admin');
  await wp.fill('#user_pass', 'admin-pass-123');
  await wp.click('#wp-submit');
  await wp.waitForURL(/wp-admin/);
  await wp.goto(`${WP_URL}/wp-admin/plugin-install.php?tab=upload`);
  await wp.setInputFiles('#pluginzip', PLUGIN_ZIP);
  await wp.click('#install-plugin-submit');
  await wp.waitForSelector('text=Plugin installed successfully', { timeout: 30000 });
  check('plugin ZIP installed via Plugins → Add New → Upload', true);
  await wp.click('a:has-text("Activate Plugin")');
  await wp.waitForURL(/plugins\.php/);
  check('plugin activated', (await wp.content()).includes('Plugin activated'));
  await wp.goto(`${WP_URL}/wp-admin/options-general.php?page=signalpost-connector`);
  await wp.fill('#sp-central', CENTRAL_URL);
  await wp.fill('#sp-code', code);
  await wp.click('input[type=submit][value=Connect]');
  await wp.waitForLoadState();
  check('plugin connected', (await wp.textContent('.wrap')).includes('Connected to Signalpost'));

  // 6. Smoke test: visitor message arrives in the dashboard.
  const v = await (await browser.newContext()).newPage();
  await v.goto(`${WP_URL}/`);
  await v.locator('#signalpost-chat .sp-launcher').click();
  await v.locator('#signalpost-chat .sp-input').fill('Hello from a clean install');
  await v.locator('#signalpost-chat .sp-input').press('Enter');
  await v.waitForTimeout(1000);
  await page.goto(`${CENTRAL_URL}/w/${ws}/inbox`);
  await page.locator('.conv').first().waitFor({ timeout: 10000 });
  check('message visible in central inbox', (await page.textContent('.conv-list')).includes('Hello from a clean install'));
  check('no browser errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
}
const failed = results.filter(r => !r).length;
console.log(`\nClean install: ${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
