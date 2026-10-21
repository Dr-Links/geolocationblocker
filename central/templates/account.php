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
    <p class="muted small">Multi-factor authentication is planned as a future extension.</p>
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
