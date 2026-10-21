<?php /** @var \Signalpost\Core\View $this */ ?>
<?= $this->partial('admin/_nav', ['path' => $path]) ?>
<section class="card narrow">
  <form method="post" action="/admin/settings" class="stack">
    <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
    <div class="field"><label for="s-reg">Registration</label>
      <select id="s-reg" name="registration_mode">
        <?php foreach (['closed' => 'Closed — no new accounts except the owner', 'invite_only' => 'Invitation only — people join via workspace invitations', 'open' => 'Open — anyone can create an account and workspace'] as $v => $l): ?>
          <option value="<?= $v ?>" <?= $settings['registration_mode'] === $v ? 'selected' : '' ?>><?= $l ?></option>
        <?php endforeach; ?>
      </select>
      <p class="hint">"Closed" also blocks invitation acceptance for people without an account.</p></div>
    <div class="field check"><input id="s-ver" type="checkbox" name="require_email_verification" value="1" <?= $settings['require_email_verification'] ? 'checked' : '' ?>><label for="s-ver">Require email verification for self-registered accounts</label></div>
    <?php foreach (['max_workspaces_per_user' => 'Max workspaces per account', 'max_websites_per_workspace' => 'Max websites per workspace', 'max_members_per_workspace' => 'Max members per workspace', 'support_grant_max_hours' => 'Max support-access duration (hours)'] as $k => $l): ?>
      <div class="field"><label for="s-<?= $k ?>"><?= $l ?></label><input id="s-<?= $k ?>" type="number" name="<?= $k ?>" min="<?= (int) $schema[$k]['min'] ?>" max="<?= (int) $schema[$k]['max'] ?>" value="<?= (int) $settings[$k] ?>"></div>
    <?php endforeach; ?>
    <button class="btn btn-primary" type="submit">Save settings</button>
  </form>
</section>
