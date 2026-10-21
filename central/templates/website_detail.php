<?php
/** @var \Signalpost\Core\View $this */
$base = '/w/' . $ctx->workspaceId;
$siteUrl = $base . '/websites/' . (int) $site['id'];
$w = $settings['widget'];
$t = $settings['tracking'];
$r = $settings['retention'];
$canEdit = $ctx->can('settings.manage');
$dis = $canEdit ? '' : ' disabled';
$sel = static fn ($a, $b) => $a === $b ? ' selected' : '';
$chk = static fn ($v) => $v ? ' checked' : '';
?>
<nav class="tabs" aria-label="Website sections">
  <?php foreach (['connection' => 'Connection', 'widget' => 'Widget', 'tracking' => 'Tracking & consent', 'retention' => 'Retention'] as $k => $label): ?>
    <a class="tab<?= $tab === $k ? ' active' : '' ?>" href="<?= $siteUrl ?>?tab=<?= $k ?>"<?= $tab === $k ? ' aria-current="page"' : '' ?>><?= $label ?></a>
  <?php endforeach; ?>
</nav>
<?= $this->partial('partials/errors', ['errors' => $errors]) ?>

<?php if ($tab === 'connection'): ?>
  <?php if ($pairingCode): ?>
  <section class="card notice-warn" aria-live="polite">
    <h2>Pairing code</h2>
    <p>In WordPress, open <strong>Settings → Signalpost Chat</strong>, enter the Central URL <code><?= $this->e($centralUrl) ?></code> and this code. It works once and expires in <?= (int) $pairingTtlMinutes ?> minutes. It is not shown again.</p>
    <div class="copy-row"><div class="secret-box" data-copy-source><?= $this->e($pairingCode) ?></div><button type="button" class="btn btn-sm" data-copy>Copy</button></div>
  </section>
  <?php endif; ?>
  <div class="two-col">
    <section class="card">
      <h2>Status</h2>
      <dl class="kv">
        <dt>Status</dt><dd><span class="pill pill-<?= $this->e($site['status']) ?>"><?= $this->e($site['status']) ?></span></dd>
        <dt>Address</dt><dd><?= $this->e($site['canonical_origin']) ?></dd>
        <dt>Last connection</dt><dd><?= $this->time($site['last_connected_at']) ?></dd>
        <dt>Last visitor activity</dt><dd><?= $this->time($site['last_activity_at']) ?></dd>
        <dt>Plugin / WordPress</dt><dd><?= $this->e($site['plugin_version'] ?? '—') ?> / <?= $this->e($site['platform_version'] ?? '—') ?></dd>
        <dt>Tracking mode</dt><dd><span class="pill pill-mode"><?= $site['tracking_policy'] === 'analytics' ? 'Analytics enabled (consent/policy-gated)' : 'Essential chat only' ?></span></dd>
        <dt>Widget key (public)</dt><dd><code><?= $this->e($site['public_key']) ?></code></dd>
        <?php if ($site['rotation_requested_at']): ?><dt>Rotation</dt><dd><span class="pill pill-warn">requested — completes on the plugin's next contact</span></dd><?php endif; ?>
      </dl>
    </section>
    <section class="card">
      <h2>Credentials</h2>
      <p class="muted small">Only a non-secret prefix is shown. Secrets are stored as hashes and are never displayed.</p>
      <?php if (!$credentials): ?><p class="empty">No active credentials. Generate a pairing code to connect the plugin.</p><?php else: ?>
      <ul class="list"><?php foreach ($credentials as $c): ?>
        <li><span><code>spk_<?= $this->e($c['key_prefix']) ?>…</code> <span class="muted small">created <?= $this->time($c['created_at']) ?>, last used <?= $this->time($c['last_used_at']) ?></span>
        <?php if ($c['revoked_at']): ?><span class="pill pill-warn">expires <?= $this->time($c['revoked_at']) ?></span><?php endif; ?></span></li>
      <?php endforeach; ?></ul>
      <?php endif; ?>
      <?php if ($ctx->can('credentials.manage')): ?>
      <div class="row-form">
        <form method="post" action="<?= $siteUrl ?>/pairing-code"><input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>"><button class="btn btn-primary"><?= $site['status'] === 'connected' ? 'Re-pair (new code)' : 'Generate pairing code' ?></button></form>
        <?php if ($credentials): ?>
        <form method="post" action="<?= $siteUrl ?>/rotate"><input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>"><button class="btn">Rotate credentials</button></form>
        <form method="post" action="<?= $siteUrl ?>/disconnect" data-confirm="Disconnect this website? Its credentials stop working immediately and the widget disappears. Conversations and visitor data are kept."><input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>"><button class="btn btn-danger">Disconnect</button></form>
        <?php endif; ?>
      </div>
      <p class="hint">Rotation happens server-to-server on the plugin's next contact (within about 15 minutes, or immediately via the plugin's “Test connection”). The previous credential remains valid for 10 minutes afterwards.</p>
      <?php endif; ?>
    </section>
  </div>
  <?php if ($ctx->can('websites.manage')): ?>
  <div class="two-col">
    <section class="card">
      <h2>Details</h2>
      <form method="post" action="<?= $siteUrl ?>" class="stack">
        <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
        <?= $this->partial('partials/field', ['name' => 'name', 'label' => 'Website name', 'value' => $site['name'], 'errors' => $errors, 'required' => true, 'max' => 100]) ?>
        <?= $this->partial('partials/field', ['name' => 'origin', 'label' => 'Site address (allowed origin)', 'type' => 'url', 'value' => $site['canonical_origin'], 'errors' => $errors, 'required' => true]) ?>
        <button class="btn btn-primary" type="submit">Save</button>
      </form>
    </section>
    <section class="card">
      <h2>Delete website</h2>
      <p>Permanently deletes this website's visitors, conversations, messages, analytics, consent records and settings from Signalpost. Backups may retain data until they expire. This cannot be undone.</p>
      <form method="post" action="<?= $siteUrl ?>/delete" class="stack" data-confirm="Permanently delete this website and all of its data?">
        <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
        <?= $this->partial('partials/field', ['name' => 'confirm_name', 'label' => 'Type the website name to confirm', 'errors' => $errors, 'required' => true]) ?>
        <button class="btn btn-danger" type="submit">Delete website and its data</button>
      </form>
    </section>
  </div>
  <?php endif; ?>

<?php elseif ($tab === 'widget'): ?>
  <form method="post" action="<?= $siteUrl ?>/settings/widget" class="card stack">
    <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
    <?php if (!$canEdit): ?><p class="notice notice-info">Only owners can change widget settings.</p><?php endif; ?>
    <div class="field check"><input id="w-enabled" type="checkbox" name="enabled" value="1"<?= $chk($w['enabled']) . $dis ?>><label for="w-enabled">Show the chat widget on this website</label></div>
    <fieldset class="stack"><legend>Appearance</legend>
      <?= $this->partial('partials/field', ['name' => 'brand_name', 'label' => 'Brand name shown in the widget header', 'value' => $w['brand_name'], 'disabled' => !$canEdit, 'errors' => $errors, 'max' => 40, 'optional' => true]) ?>
      <div class="field"><label for="w-color">Primary colour</label><input id="w-color" type="color" name="primary_color" value="<?= $this->e($w['primary_color']) ?>"<?= $dis ?>></div>
      <div class="field"><label for="w-pos">Position</label><select id="w-pos" name="position"<?= $dis ?>><option value="right"<?= $sel($w['position'], 'right') ?>>Bottom right</option><option value="left"<?= $sel($w['position'], 'left') ?>>Bottom left</option></select></div>
      <div class="field"><label for="w-off">Distance from edge (px)</label><input id="w-off" type="number" min="0" max="80" name="offset_px" value="<?= (int) $w['offset_px'] ?>"<?= $dis ?>></div>
      <?= $this->partial('partials/field', ['name' => 'launcher_label', 'label' => 'Launcher button label (screen readers and tooltip)', 'value' => $w['launcher_label'], 'disabled' => !$canEdit, 'errors' => $errors, 'max' => 30]) ?>
      <div class="field check"><input id="w-brand" type="checkbox" name="show_branding" value="1"<?= $chk($w['show_branding']) . $dis ?>><label for="w-brand">Show “Powered by Signalpost”</label></div>
    </fieldset>
    <fieldset class="stack"><legend>Welcome screen</legend>
      <?= $this->partial('partials/field', ['name' => 'greeting_title', 'label' => 'Greeting', 'value' => $w['greeting_title'], 'disabled' => !$canEdit, 'errors' => $errors, 'max' => 60]) ?>
      <?= $this->partial('partials/field', ['name' => 'welcome_message', 'label' => 'Welcome message', 'type' => 'textarea', 'value' => $w['welcome_message'], 'disabled' => !$canEdit, 'errors' => $errors, 'max' => 300, 'optional' => true]) ?>
    </fieldset>
    <fieldset class="stack"><legend>Pre-chat form</legend>
      <p class="hint">Ask only for what you need to help. Values are validated, stored as plain text, and visible only to this workspace.</p>
      <?php foreach (['prechat_name' => 'Name', 'prechat_email' => 'Email', 'prechat_phone' => 'Phone'] as $k => $l): ?>
        <div class="field"><label for="w-<?= $k ?>"><?= $l ?></label><select id="w-<?= $k ?>" name="<?= $k ?>"<?= $dis ?>>
          <option value="off"<?= $sel($w[$k], 'off') ?>>Don't ask</option><option value="optional"<?= $sel($w[$k], 'optional') ?>>Optional</option><option value="required"<?= $sel($w[$k], 'required') ?>>Required before chatting</option></select></div>
      <?php endforeach; ?>
      <?= $this->partial('partials/field', ['name' => 'prechat_notice', 'label' => 'Privacy notice shown on the form', 'type' => 'textarea', 'value' => $w['prechat_notice'], 'disabled' => !$canEdit, 'errors' => $errors, 'max' => 300, 'optional' => true, 'hint' => 'e.g. a link text to your privacy policy (plain text).']) ?>
    </fieldset>
    <fieldset class="stack"><legend>Behaviour</legend>
      <?= $this->partial('partials/field', ['name' => 'hidden_paths', 'label' => 'Hide the widget on these paths (one per line)', 'type' => 'textarea', 'value' => implode("\n", $w['hidden_paths']), 'errors' => $errors, 'optional' => true, 'max' => 10000]) ?>
      <div class="field"><label for="w-reopen">Reopen a closed conversation if the visitor writes within (hours)</label><input id="w-reopen" type="number" min="0" max="720" name="reopen_window_hours" value="<?= (int) $w['reopen_window_hours'] ?>"<?= $dis ?>><p class="hint">After this window a new conversation starts. 0 always starts a new conversation.</p></div>
      <div class="field"><label for="w-block">When a visitor is blocked, their existing conversations become</label><select id="w-block" name="block_conversation_action"<?= $dis ?>>
        <option value="read_only"<?= $sel($w['block_conversation_action'], 'read_only') ?>>Read-only (visitor sees history, cannot write)</option>
        <option value="close"<?= $sel($w['block_conversation_action'], 'close') ?>>Closed</option></select></div>
    </fieldset>
    <?php if ($canEdit): ?><div><button class="btn btn-primary" type="submit">Save widget settings</button></div><?php endif; ?>
  </form>

<?php elseif ($tab === 'tracking'): ?>
  <section class="card notice-info">
    <p><strong>Essential chat</strong> (an opaque chat identifier, your conversations and messages, timestamps and delivery state) always works and does not depend on these settings.</p>
    <p><strong>Optional analytics</strong> — page-view history, visit counts, referrer, coarse browser/OS and estimated country — is collected only when enabled here <em>and</em> permitted for the individual visitor. If permission cannot be verified, nothing optional is collected.</p>
    <p class="small">Signalpost does not make your website legally compliant by itself. Decide with your adviser which legal basis applies in your jurisdictions; see docs/PRIVACY.md.</p>
  </section>
  <form method="post" action="<?= $siteUrl ?>/settings/tracking" class="card stack">
    <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
    <div class="field check"><input id="t-an" type="checkbox" name="analytics_enabled" value="1"<?= $chk($t['analytics_enabled']) . $dis ?>><label for="t-an">Enable optional visitor analytics for this website</label></div>
    <div class="field"><label for="t-basis">Legal basis for analytics</label><select id="t-basis" name="legal_basis"<?= $dis ?>>
      <option value="consent"<?= $sel($t['legal_basis'], 'consent') ?>>Consent — collect only after the visitor opts in (recommended)</option>
      <option value="other"<?= $sel($t['legal_basis'], 'other') ?>>Another documented basis — collect unless the visitor objects</option></select></div>
    <div class="field check"><input id="t-ack" type="checkbox" name="ack_other_basis" value="1"<?= $dis ?>><label for="t-ack">If choosing “another basis”: I confirm my organisation has assessed and documented that basis for these purposes.</label></div>
    <?php if (!empty($errors['ack_other_basis'])): ?><p class="field-error"><?= $this->e($errors['ack_other_basis']) ?></p><?php endif; ?>
    <div class="field"><label for="t-src">Consent signal source</label><select id="t-src" name="consent_source"<?= $dis ?>>
      <option value="widget"<?= $sel($t['consent_source'], 'widget') ?>>Signalpost widget asks the visitor</option>
      <option value="wp_consent_api"<?= $sel($t['consent_source'], 'wp_consent_api') ?>>WordPress Consent API (your cookie banner plugin, “statistics” category)</option>
      <option value="custom"<?= $sel($t['consent_source'], 'custom') ?>>Custom JavaScript call (window.Signalpost.setAnalyticsConsent)</option></select>
      <p class="hint">Without a signal from the chosen source, the visitor's state stays “unknown” and no optional analytics run.</p></div>
    <?= $this->partial('partials/field', ['name' => 'policy_version', 'label' => 'Privacy policy version', 'value' => $t['policy_version'], 'disabled' => !$canEdit, 'errors' => $errors, 'max' => 32, 'hint' => 'Recorded with each consent decision. Changing it asks visitors again.']) ?>
    <?= $this->partial('partials/field', ['name' => 'excluded_paths', 'label' => 'Never track these paths (one per line)', 'type' => 'textarea', 'rows' => 6, 'value' => implode("\n", $t['excluded_paths']), 'disabled' => !$canEdit, 'errors' => $errors, 'max' => 10000, 'hint' => 'Prefix match. Keep account, checkout, payment and login pages here.']) ?>
    <fieldset class="stack"><legend>Optional details (only when analytics is permitted)</legend>
      <div class="field check"><input id="t-title" type="checkbox" name="record_page_titles" value="1"<?= $chk($t['record_page_titles']) . $dis ?>><label for="t-title">Record page titles</label></div>
      <div class="field check"><input id="t-ref" type="checkbox" name="record_referrer" value="1"<?= $chk($t['record_referrer']) . $dis ?>><label for="t-ref">Record referring website (origin only, never full URL)</label></div>
      <div class="field check"><input id="t-geo" type="checkbox" name="estimate_country" value="1"<?= $chk($t['estimate_country']) . $dis ?>><label for="t-geo">Estimate country from IP address (local lookup; the IP is not stored)</label></div>
      <div class="field check"><input id="t-ua" type="checkbox" name="collect_browser" value="1"<?= $chk($t['collect_browser']) . $dis ?>><label for="t-ua">Record coarse browser and operating system family</label></div>
      <div class="field"><label for="t-sess">New visit after inactivity of (minutes)</label><input id="t-sess" type="number" min="5" max="240" name="session_timeout_minutes" value="<?= (int) $t['session_timeout_minutes'] ?>"<?= $dis ?>></div>
    </fieldset>
    <?php if ($canEdit): ?><div><button class="btn btn-primary" type="submit">Save tracking settings</button></div><?php endif; ?>
  </form>

<?php else: ?>
  <form method="post" action="<?= $siteUrl ?>/settings/retention" class="card stack">
    <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
    <p class="muted">Data older than these limits is removed by the cleanup job (cPanel cron or “Run cleanup” under Privacy &amp; retention). Analytics retention is independent of conversation retention.</p>
    <?php foreach ([
        'events_days' => ['Page-view events (days)', 'Optional analytics.'],
        'sessions_days' => ['Visit sessions (days)', 'Optional analytics.'],
        'contacts_days' => ['Pre-chat form submissions (days)', 'Profile fields stay until the profile is removed.'],
        'visitor_inactive_days' => ['Delete visitor profiles inactive for (days)', 'Profiles with no activity for this long are deleted together with their conversations.'],
        'conversations_days' => ['Conversations and messages (days since last message, 0 = keep)', ''],
        'consent_days' => ['Consent records (days)', 'Keep long enough to demonstrate consent where required.'],
    ] as $k => [$label, $hint]): ?>
      <div class="field"><label for="r-<?= $k ?>"><?= $label ?></label><input id="r-<?= $k ?>" type="number" name="<?= $k ?>" min="<?= (int) \Signalpost\Sites\SettingsSchema::RETENTION[$k][2] ?>" max="3650" value="<?= (int) $r[$k] ?>"<?= $dis ?>><?php if ($hint): ?><p class="hint"><?= $this->e($hint) ?></p><?php endif; ?>
      <?php if (!empty($errors[$k])): ?><p class="field-error"><?= $this->e($errors[$k]) ?></p><?php endif; ?></div>
    <?php endforeach; ?>
    <?php if ($canEdit): ?><div><button class="btn btn-primary" type="submit">Save retention settings</button></div><?php endif; ?>
  </form>
<?php endif; ?>
