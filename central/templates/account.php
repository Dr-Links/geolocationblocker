<?php /** @var \Signalpost\Core\View $this */ ?>
<?= $this->partial('partials/errors', ['errors' => $errors]) ?>
<div class="two-col">
  <section class="card">
    <h2>Profile</h2>
    <p class="muted">Signed in as <strong><?= $this->e($user['email']) ?></strong></p>
    <form method="post" action="/account/profile" class="stack">
      <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
      <?= $this->partial('partials/field', ['name' => 'display_name', 'label' => 'Display name (shown to visitors as the replying agent)', 'value' => $user['display_name'], 'errors' => $errors, 'required' => true, 'max' => 100]) ?>
      <button class="btn btn-primary" type="submit">Save</button>
    </form>
  </section>
  <section class="card">
    <h2>Change password</h2>
    <form method="post" action="/account/password" class="stack">
      <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
      <?= $this->partial('partials/field', ['name' => 'current_password', 'label' => 'Current password', 'type' => 'password', 'errors' => $errors, 'required' => true, 'autocomplete' => 'current-password']) ?>
      <?= $this->partial('partials/field', ['name' => 'new_password', 'label' => 'New password', 'type' => 'password', 'errors' => $errors, 'required' => true, 'autocomplete' => 'new-password']) ?>
      <?= $this->partial('partials/field', ['name' => 'new_password_confirm', 'label' => 'Confirm new password', 'type' => 'password', 'errors' => $errors, 'required' => true, 'autocomplete' => 'new-password']) ?>
      <button class="btn btn-primary" type="submit">Change password</button>
    </form>
  </section>
</div>
<section class="card">
  <div class="card-head"><h2>Active sessions</h2>
    <form method="post" action="/account/sessions/revoke-others"><input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>"><button class="btn btn-ghost btn-sm">Sign out all other sessions</button></form></div>
  <div class="table-wrap"><table class="table">
    <thead><tr><th>Device</th><th>Network (masked)</th><th>Signed in</th><th>Last active</th><th></th></tr></thead>
    <tbody>
    <?php foreach ($sessions as $s): ?>
      <tr><td><?= $this->e($s['user_agent_summary']) ?><?= (int) $s['id'] === $currentSessionId ? ' <span class="pill pill-ok">this session</span>' : '' ?></td>
        <td><?= $this->e($s['ip_masked']) ?></td><td><?= $this->time($s['created_at']) ?></td><td><?= $this->time($s['last_seen_at']) ?></td>
        <td><?php if ((int) $s['id'] !== $currentSessionId): ?><form method="post" action="/account/sessions/<?= (int) $s['id'] ?>/revoke"><input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>"><button class="btn btn-ghost btn-sm">Revoke</button></form><?php endif; ?></td></tr>
    <?php endforeach; ?>
    </tbody>
  </table></div>
</section>

<section class="card" id="notifications" data-push data-csrf="<?= $this->e($csrf) ?>">
  <h2>App and notifications</h2>
  <p class="muted">Install <?= $this->e($this->appName()) ?> on your phone or computer (browser menu → “Install app” / “Add to Home Screen”) and get notified when visitors write. On iPhone and iPad, add it to the Home Screen first (iOS 16.4 or later), then enable notifications from the installed app.</p>
  <div class="row-form">
    <button type="button" class="btn btn-primary" data-push-enable hidden>Enable notifications on this device</button>
    <button type="button" class="btn" data-push-test hidden>Send a test notification</button>
    <button type="button" class="btn btn-ghost" data-push-disable hidden>Turn off on this device</button>
  </div>
  <p class="small" data-push-status role="status" aria-live="polite"></p>
  <form method="post" action="/account/notifications" class="stack">
    <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
    <div class="field check"><input id="n-preview" type="checkbox" name="push_show_preview" value="1"<?= $pushPreview ? ' checked' : '' ?>><label for="n-preview">Show the first words of the visitor's message in notifications</label></div>
    <p class="hint">Off by default: notifications then only say that a visitor wrote and on which website. Notification content is encrypted for your device, but may appear on your lock screen.</p>
    <div><button class="btn" type="submit">Save notification settings</button></div>
  </form>
  <?php if ($devices): ?>
  <h3 class="small muted">Devices receiving notifications</h3>
  <ul class="list small"><?php foreach ($devices as $d): ?>
    <li><span><?= $this->e($d['device_summary'] ?: 'Device') ?> · added <?= $this->time($d['created_at']) ?> · last delivered <?= $this->time($d['last_success_at']) ?></span>
      <form method="post" action="/account/devices/<?= (int) $d['id'] ?>/remove" class="inline-form"><input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>"><button class="btn btn-ghost btn-sm">Remove</button></form></li>
  <?php endforeach; ?></ul>
  <?php endif; ?>
</section>

<section class="card" id="two-factor">
  <div class="card-head"><h2>Two-factor authentication</h2><?= $twoFactorOn ? '<span class="pill pill-ok">on</span>' : '<span class="pill">off</span>' ?></div>
  <?php if ($recoveryCodes): ?>
    <div class="notice notice-warn" role="status">
      <p><strong>Save these recovery codes now.</strong> Each works once if you lose your phone. They will not be shown again.</p>
      <pre class="recovery-codes" data-copy-source><?= $this->e(implode("\n", $recoveryCodes)) ?></pre>
    </div>
  <?php endif; ?>
  <?php if (!$twoFactorOn && $setupSecret): ?>
    <ol class="stack small">
      <li>In an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Aegis…) add an account with this key:
        <div class="copy-row"><div class="secret-box" data-copy-source><?= $this->e(trim(chunk_split($setupSecret, 4, ' '))) ?></div><button type="button" class="btn btn-sm" data-copy>Copy</button></div>
        <?php if (!empty($setupUri)): ?><p>On a phone you can tap: <a href="<?= $this->e($setupUri) ?>">open in authenticator app</a></p><?php endif; ?></li>
      <li>Enter the 6-digit code the app shows:</li>
    </ol>
    <form method="post" action="/account/2fa/enable" class="row-form">
      <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
      <div class="field"><label for="f-code">Code</label><input id="f-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></div>
      <button class="btn btn-primary">Turn on</button>
    </form>
    <?php if (!empty($errors['code'])): ?><p class="field-error"><?= $this->e($errors['code']) ?></p><?php endif; ?>
  <?php elseif (!$twoFactorOn): ?>
    <p>Protect your account with a code from your phone in addition to your password.</p>
    <form method="post" action="/account/2fa/setup"><input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>"><button class="btn btn-primary">Set up two-factor authentication</button></form>
  <?php else: ?>
    <p>Sign-in requires a code from your authenticator app. Recovery codes left: <strong><?= (int) $recoveryLeft ?></strong>.</p>
    <div class="two-col">
      <form method="post" action="/account/2fa/recovery-codes" class="stack">
        <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
        <div class="field"><label for="f-rc">Current code</label><input id="f-rc" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="11" required></div>
        <?php if (!empty($errors['recovery_code'])): ?><p class="field-error"><?= $this->e($errors['recovery_code']) ?></p><?php endif; ?>
        <div><button class="btn">Generate new recovery codes</button></div>
      </form>
      <form method="post" action="/account/2fa/disable" class="stack" data-confirm="Turn off two-factor authentication?">
        <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
        <?= $this->partial('partials/field', ['name' => 'password', 'label' => 'Password', 'type' => 'password', 'errors' => $errors, 'required' => true, 'autocomplete' => 'current-password']) ?>
        <?= $this->partial('partials/field', ['name' => 'code', 'label' => 'Current code', 'errors' => $errors, 'required' => true, 'autocomplete' => 'one-time-code', 'max' => 11]) ?>
        <div><button class="btn btn-danger">Turn off</button></div>
      </form>
    </div>
  <?php endif; ?>
</section>
