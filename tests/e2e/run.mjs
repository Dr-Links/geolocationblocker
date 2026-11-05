// Browser E2E scenario. Run via ./run.sh (sets up WordPress + central first).
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
const axeSource = (await import('node:fs')).readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

/** Runs axe-core and returns serious/critical violations (optionally within a shadow root host). */
async function axe(page, context) {
  await page.addScriptTag({ content: axeSource });
  return page.evaluate(async (ctx) => {
    const r = await window.axe.run(ctx ? { include: [[ctx]] } : document, { resultTypes: ['violations'] });
    return r.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => v.id + ' (' + v.nodes.length + '): ' + v.nodes[0].target.join(' '));
  }, context || null);
}

const { CENTRAL_URL, WP_URL, PAIRING_CODE, WS_ID, HELPER, WPCLI_CMD } = process.env;
const results = [];
const check = (name, cond, detail = '') => { results.push([name, !!cond]); console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? ' — ' + detail : ''}`); };
const sh = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();
const sql = (q) => JSON.parse(sh(`${HELPER} query ${JSON.stringify(q)}`));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch();
try {
  // ---------------------------------------------------------------- WP admin pairing through the real UI
  console.log('== WordPress admin: connect plugin with pairing code');
  const admin = await (await browser.newContext()).newPage();
  await admin.goto(`${WP_URL}/wp-login.php`);
  await admin.fill('#user_login', 'admin');
  await admin.fill('#user_pass', 'admin-pass-123');
  await admin.click('#wp-submit');
  await admin.waitForURL(/wp-admin/);
  await admin.goto(`${WP_URL}/wp-admin/options-general.php?page=signalpost-connector`);
  await admin.fill('#sp-central', CENTRAL_URL);
  await admin.fill('#sp-code', PAIRING_CODE.toLowerCase().replace(/-/g, ' '));
  await admin.click('input[type=submit][value=Connect]');
  await admin.waitForLoadState();
  const adminText = await admin.textContent('.wrap');
  check('plugin shows Connected after pairing', adminText.includes('Connected to Signalpost'), adminText.slice(0, 200));
  check('admin page shows only the credential prefix', /spk_[0-9a-f]{12}…/.test(adminText) && !/spk_[0-9a-f]{12}\.[A-Za-z0-9_-]{20}/.test(await admin.content()));
  await admin.screenshot({ path: 'artifacts/wp-admin-connected.png', fullPage: true });

  await admin.goto(`${WP_URL}/wp-admin/options-general.php?page=signalpost-connector&tab=widget`);
  await admin.fill('#sp-greeting_title', 'Hello E2E');
  await admin.selectOption('#sp-prechat_name', 'optional');
  await admin.click('input[type=submit][value="Save widget settings"]');
  await admin.waitForLoadState();
  check('widget settings saved from WordPress', (await admin.textContent('.wrap')).includes('Widget settings saved'));

  // ---------------------------------------------------------------- visitor: no requests before interaction
  console.log('== Visitor: widget on the WordPress front end');
  const vctx = await browser.newContext();
  const visitor = await vctx.newPage();
  const widgetCalls = [];
  visitor.on('request', r => { if (r.url().includes('/api/v1/widget/')) widgetCalls.push(r.url()); });
  const pageErrors = [];
  visitor.on('pageerror', e => pageErrors.push(e.message));
  await visitor.goto(`${WP_URL}/`);
  const launcher = visitor.locator('#signalpost-chat .sp-launcher');
  await launcher.waitFor();
  check('launcher rendered with accessible label', (await launcher.getAttribute('aria-label')) === 'Chat with us');
  await sleep(1500);
  check('no widget API calls before the visitor interacts (analytics off)', widgetCalls.length === 0, widgetCalls.join(','));
  check('no localStorage identifier before interaction', (await visitor.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('signalpost')).length)) === 0);

  await launcher.click();
  const panel = visitor.locator('#signalpost-chat .sp-panel');
  await panel.waitFor({ state: 'visible' });
  check('panel is a labelled dialog', (await panel.getAttribute('role')) === 'dialog');
  check('launcher reports expanded state', (await launcher.getAttribute('aria-expanded')) === 'true');
  check('custom greeting from WordPress settings shown', (await visitor.locator('#signalpost-chat .sp-greeting').textContent()) === 'Hello E2E');
  // Optional pre-chat form shown; fill name with an XSS payload.
  await visitor.locator('#signalpost-chat #sp-f-name').fill('<img src=x onerror="window.__xss=1">Vera');
  await visitor.locator('#signalpost-chat .sp-prechat button[type=submit]').click();
  const input = visitor.locator('#signalpost-chat .sp-input');
  await input.waitFor({ state: 'visible' });
  const xss = '<img src=x onerror="window.__xss=1"><b>bold?</b> & "quotes"';
  await input.fill(xss);
  await input.press('Enter');
  const myMsg = visitor.locator('#signalpost-chat .sp-msg-visitor .sp-text').first();
  await myMsg.waitFor();
  await visitor.waitForFunction(() => {
    const m = document.querySelector('#signalpost-chat').shadowRoot.querySelector('.sp-msg-visitor .sp-meta');
    return m && !m.textContent.includes('Sending');
  }, null, { timeout: 10000 });
  check('visitor message rendered as literal text', (await myMsg.textContent()) === xss);
  check('no HTML injected into the widget', (await visitor.evaluate(() => document.querySelector('#signalpost-chat').shadowRoot.querySelectorAll('.sp-messages img, .sp-messages b').length)) === 0);
  check('token stored first-party after interaction', (await visitor.evaluate(() => Object.keys(localStorage).some(k => k.startsWith('signalpost:v1:')))));
  check('stored identifier contains no personal data', !(await visitor.evaluate(() => JSON.stringify(localStorage))).includes('Vera'));
  await visitor.screenshot({ path: 'artifacts/widget-visitor.png' });

  // ---------------------------------------------------------------- operator dashboard
  console.log('== Operator: dashboard inbox');
  const octx = await browser.newContext();
  const op = await octx.newPage();
  const opErrors = [];
  op.on('pageerror', e => opErrors.push(e.message));
  op.on('console', m => { if (m.type() === 'error') opErrors.push(m.text()); });
  await op.goto(`${CENTRAL_URL}/login`);
  await op.fill('#f-email', 'owner@example.test');
  await op.fill('#f-password', 'integration-pass-1');
  await op.click('button[type=submit]');
  await op.waitForURL(/\/w\/\d+/);
  await op.goto(`${CENTRAL_URL}/w/${WS_ID}/inbox`);
  const conv = op.locator('.conv').first();
  await conv.waitFor({ timeout: 10000 });
  check('conversation listed with unread indicator', await op.locator('.conv .unread-dot').count() === 1);
  await conv.click();
  const opMsg = op.locator('.messages .msg-visitor').first();
  await opMsg.waitFor();
  check('operator sees visitor text literally', (await opMsg.textContent()).includes(xss));
  check('no HTML injected into the dashboard', (await op.locator('.messages img, .messages b, .profile-panel img').count()) === 0);
  check('visitor name shown as submitted text', (await op.locator('.profile-panel').textContent()).includes('<img src=x onerror="window.__xss=1">Vera'));
  check('provenance labels shown', (await op.locator('.profile-panel .pill-submitted').count()) >= 1);
  check('dashboard timestamps are localised, not raw ISO', !/\d{4}-\d{2}-\d{2}T/.test(await op.locator('.conv-meta').first().textContent()));
  await op.fill('#ib-reply', 'Hi Vera, operator here.');
  await op.press('#ib-reply', 'Enter');
  await op.locator('.messages .msg-operator').first().waitFor();
  await op.screenshot({ path: 'artifacts/dashboard-inbox.png' });

  console.log('== Visitor receives the reply by polling');
  const reply = visitor.locator('#signalpost-chat .sp-msg-operator .sp-text');
  await reply.waitFor({ timeout: 15000 });
  check('visitor sees operator reply', (await reply.textContent()) === 'Hi Vera, operator here.');
  check('no XSS executed in visitor page', (await visitor.evaluate(() => window.__xss)) === undefined);
  check('no XSS executed in dashboard', (await op.evaluate(() => window.__xss)) === undefined);

  // Keyboard: Escape closes and returns focus to the launcher.
  await visitor.locator('#signalpost-chat .sp-input').focus();
  await visitor.keyboard.press('Escape');
  await sleep(200);
  check('Escape closes the panel', await panel.isHidden());
  check('focus returns to launcher', await visitor.evaluate(() => document.querySelector('#signalpost-chat').shadowRoot.activeElement?.classList.contains('sp-launcher')));

  // Persistence: reload restores the conversation from the server.
  await visitor.reload();
  await launcher.click();
  await visitor.locator('#signalpost-chat .sp-msg-operator').waitFor({ timeout: 10000 });
  check('conversation restored after reload', (await visitor.locator('#signalpost-chat .sp-msg').count()) === 2);

  // ---------------------------------------------------------------- installable app (PWA)
  console.log('== PWA: service worker, manifest, offline, privacy of the cache');
  await op.goto(`${CENTRAL_URL}/w/${WS_ID}/inbox`);
  const swState = await op.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return { scope: reg.scope, active: !!reg.active };
  });
  check('service worker active for the whole app', swState.active && swState.scope === `${CENTRAL_URL}/`, JSON.stringify(swState));
  await op.reload();
  await op.locator('.conv').first().waitFor();
  check('page controlled by the service worker after reload', await op.evaluate(() => !!navigator.serviceWorker.controller));
  const manifest = await op.evaluate(async () => (await fetch('/manifest.webmanifest')).json());
  check('manifest is standalone with 192/512 and maskable icons', manifest.display === 'standalone' && manifest.icons.some(i => i.sizes === '512x512' && i.purpose === 'maskable') && manifest.icons.some(i => i.sizes === '192x192'));
  const cached = await op.evaluate(async () => {
    const out = [];
    for (const name of await caches.keys()) { for (const req of await (await caches.open(name)).keys()) { out.push(new URL(req.url).pathname); } }
    return out;
  });
  check('cache holds only static assets and the offline page', cached.length > 0 && cached.every(p => p.startsWith('/assets/') || p === '/offline.html'), cached.join(','));
  await op.goto(`${CENTRAL_URL}/account`);
  check('account page offers device notifications', (await op.textContent('#notifications')).includes('App and notifications'));

  // ---------------------------------------------------------------- live visitors
  await op.goto(`${CENTRAL_URL}/w/${WS_ID}/live`);
  await op.locator('[data-rows] tr td').first().waitFor();
  await sleep(500);
  const liveText = await op.locator('#live').textContent();
  check('live page lists the visitor as active now', liveText.includes('Active now') && liveText.includes('Vera'));
  check('live page shows no page data without analytics consent', liveText.includes('not tracked'));

  // ---------------------------------------------------------------- blocking
  console.log('== Blocking enforced by the server');
  const vid = sql("SELECT id FROM visitors ORDER BY id LIMIT 1")[0].id;
  await op.goto(`${CENTRAL_URL}/w/${WS_ID}/visitors/${vid}`);
  op.once('dialog', d => d.accept());
  await op.fill('#b-reason', 'E2E test');
  await op.click('button:has-text("Block visitor")');
  await op.waitForLoadState();
  check('profile shows blocked state', (await op.textContent('main')).includes('Blocked'));
  await visitor.locator('#signalpost-chat .sp-input').fill('Am I blocked?');
  await visitor.locator('#signalpost-chat .sp-input').press('Enter');
  await visitor.locator('#signalpost-chat .sp-msg-failed').waitFor({ timeout: 10000 });
  const notice = await visitor.locator('#signalpost-chat .sp-notice').textContent();
  check('blocked visitor gets a generic denial', notice === 'Chat is not available right now.' && !/block/i.test(notice));
  check('blocked message was not stored', sql("SELECT COUNT(*) AS n FROM messages WHERE body = 'Am I blocked?'")[0].n === 0);

  // ---------------------------------------------------------------- consent-gated analytics
  console.log('== Optional analytics: consent required first');
  sh(`${HELPER} settings ${process.env.SITE_ID} tracking '{"analytics_enabled":true,"record_page_titles":true}'`);
  sh(`${WPCLI_CMD} eval 'Signalpost_Connection::refresh();'`);
  const actx = await browser.newContext();
  const av = await actx.newPage();
  const aCalls = [];
  av.on('request', r => { if (r.url().includes('/api/v1/widget/')) aCalls.push(new URL(r.url()).pathname.split('/').pop() + ':' + r.method()); });
  await av.goto(`${WP_URL}/`);
  const prompt = av.locator('#signalpost-chat .sp-prompt');
  await prompt.waitFor({ state: 'visible' });
  await sleep(1000);
  check('consent prompt shown when analytics enabled', await prompt.isVisible());
  check('no tracking before consent', !aCalls.some(c => c.startsWith('events')) && aCalls.length === 0, aCalls.join(','));
  await av.locator('#signalpost-chat .sp-prompt .sp-btn-primary').click();
  await av.waitForTimeout(1500);
  check('consent recorded then page view sent', aCalls.includes('consent:POST') && aCalls.includes('events:POST'), aCalls.join(','));
  await av.goto(`${WP_URL}/sample-page/?secret=1#frag`);
  await av.waitForTimeout(1500);
  const paths = sql("SELECT page_path FROM visitor_events ORDER BY id").map(r => r.page_path);
  check('page views recorded without query or fragment', paths.includes('/') && paths.includes('/sample-page/') && !paths.some(p => p.includes('secret')), paths.join(','));
  // Withdraw from inside the widget.
  await av.locator('#signalpost-chat .sp-launcher').click();
  await av.locator('#signalpost-chat .sp-consent .sp-link').click();
  await av.waitForTimeout(1500);
  check('withdrawal erases analytics', sql("SELECT COUNT(*) AS n FROM visitor_events")[0].n === 0);
  const before = aCalls.filter(c => c.startsWith('events')).length;
  await av.goto(`${WP_URL}/`);
  await av.waitForTimeout(1500);
  check('no tracking after withdrawal', aCalls.filter(c => c.startsWith('events')).length === before);

  // ---------------------------------------------------------------- mobile
  const mctx = await browser.newContext({ viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true });
  const mobile = await mctx.newPage();
  await mobile.goto(`${WP_URL}/`);
  await mobile.locator('#signalpost-chat .sp-prompt .sp-btn:not(.sp-btn-primary)').click();
  await mobile.locator('#signalpost-chat .sp-launcher').click();
  const box = await mobile.locator('#signalpost-chat .sp-panel').boundingBox();
  check('panel is full-screen on small screens', box && box.width >= 370 && box.height >= 700, JSON.stringify(box));
  check('launcher hidden behind full-screen panel', await mobile.locator('#signalpost-chat .sp-launcher').isHidden());
  await mobile.screenshot({ path: 'artifacts/widget-mobile.png' });

  // ---------------------------------------------------------------- activation codes
  console.log('== Activation codes: generate, sign up, expire, renew');
  await op.goto(`${CENTRAL_URL}/admin/codes`);
  await op.selectOption('#c-dur', '1');
  await op.fill('#c-note', 'E2E customer');
  await op.click('button:has-text("Generate")');
  const codes = (await op.textContent('pre.recovery-codes')).trim().split('\n');
  check('admin sees the new code once', codes.length === 1 && /^AC-/.test(codes[0]));
  await op.screenshot({ path: 'artifacts/admin-codes.png', fullPage: true });
  sql("INSERT INTO platform_settings (name, value, updated_at) VALUES ('require_email_verification', 'false', NOW()) ON DUPLICATE KEY UPDATE value = 'false'");
  const cctx = await browser.newContext();
  const cust = await cctx.newPage();
  await cust.goto(`${CENTRAL_URL}/register`);
  await cust.fill('#f-activation_code', codes[0]);
  await cust.fill('#f-display_name', 'Casey');
  await cust.fill('#f-email', 'casey@example.test');
  await cust.fill('#f-workspace_name', 'Casey Co');
  await cust.fill('#f-password', 'casey-password-1');
  await cust.fill('#f-password_confirm', 'casey-password-1');
  await cust.click('button:has-text("Create account")');
  await cust.waitForURL(/\/login/);
  await cust.fill('#f-email', 'casey@example.test');
  await cust.fill('#f-password', 'casey-password-1');
  await cust.click('button[type=submit]');
  await cust.waitForURL(/\/w\/\d+/);
  check('customer signed up with the code and reached the dashboard', true);
  sql("UPDATE users SET access_expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE email = 'casey@example.test'");
  await cust.reload();
  check('expired customer is locked to the renewal page', cust.url().endsWith('/renew') && (await cust.textContent('main')).includes('Your access has ended'));
  await cust.screenshot({ path: 'artifacts/renew.png' });
  await cust.fill('#f-activation_code', codes[0]);
  await cust.click('button:has-text("Activate")');
  check('used code refused on renewal', (await cust.textContent('main')).includes('not valid or has already been used'));

  // ---------------------------------------------------------------- accessibility (axe-core)
  console.log('== Accessibility audit (axe-core, serious/critical only)');
  // The dashboard's CSP (correctly) blocks injected scripts; the audit context bypasses it.
  const a11y = await (await browser.newContext({ bypassCSP: true })).newPage();
  await a11y.goto(`${CENTRAL_URL}/login`);
  let v = await axe(a11y);
  check('login page: no serious a11y violations', v.length === 0, v.join('; '));
  await a11y.fill('#f-email', 'owner@example.test');
  await a11y.fill('#f-password', 'integration-pass-1');
  await a11y.click('button[type=submit]');
  await a11y.waitForURL(/\/w\/\d+/);
  for (const path of ['', '/inbox', '/live', '/visitors', '/websites', '/members', '/privacy', '/../../account', '/../../admin/codes']) {
    await a11y.goto(`${CENTRAL_URL}/w/${WS_ID}${path}`);
    await a11y.waitForTimeout(800);
    v = await axe(a11y);
    check(`dashboard ${path || '/overview'}: no serious a11y violations`, v.length === 0, v.join('; '));
  }
  v = await (async () => { const p = await (await browser.newContext({ bypassCSP: true })).newPage(); await p.goto(`${CENTRAL_URL}/register`); return axe(p); })();
  check('register page (with code field): no serious a11y violations', v.length === 0, v.join('; '));
  await mobile.setViewportSize({ width: 1280, height: 800 });
  v = await axe(mobile, '#signalpost-chat');
  check('open widget: no serious a11y violations', v.length === 0, v.join('; '));

  check('no JavaScript errors on the visitor page', pageErrors.length === 0, pageErrors.join(' | '));
  check('no JavaScript/CSP errors in the dashboard', opErrors.length === 0, opErrors.join(' | '));

  // Connection loss: stop the central server; the service worker must serve the offline page
  // and nothing private may be available from the device.
  const offPage = await octx.newPage();
  await offPage.goto(`${CENTRAL_URL}/account`);
  await offPage.evaluate(() => navigator.serviceWorker.ready);
  execSync(`pkill -f "php -S 127.0.0.[1]:${new URL(CENTRAL_URL).port}" || true`);
  await sleep(500);
  await offPage.goto(`${CENTRAL_URL}/w/${WS_ID}/inbox`).catch(() => {});
  const offlineText = await offPage.textContent('body').catch(e => 'ERR ' + e.message);
  check('offline page shown when the server is unreachable', offlineText.includes("You're offline"), offlineText.slice(0, 200));
  check('no conversation content available offline', !(await offPage.content()).includes('operator here'));
} finally {
  await browser.close();
}

const failed = results.filter(r => !r[1]).length;
console.log(`\nBrowser E2E: ${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
