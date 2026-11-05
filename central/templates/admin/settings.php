<?php /** @var \Signalpost\Core\View $this */ ?>
<?= $this->partial('admin/_nav', ['path' => $path]) ?>
<section class="card narrow">
  <form method="post" action="/admin/settings" class="stack">
    <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
    <div class="field"><label for="s-reg">Registration</label>
      <select id="s-reg" name="registration_mode">
        <?php foreach (['closed' => 'Closed — no new accounts except the owner', 'invite_only' => 'Invitation only — people join via workspace invitations', 'code' => 'Activation code — people sign up with a single-use code you generate', 'open' => 'Open — anyone can create an account and workspace (no time limit)'] as $v => $l): ?>
          <option value="<?= $v ?>" <?= $settings['registration_mode'] === $v ? 'selected' : '' ?>><?= $l ?></option>
        <?php endforeach; ?>
      </select>
      <p class="hint">"Closed" also blocks invitation acceptance for people without an account.</p></div>
    <div class="field check"><input id="s-ver" type="checkbox" name="require_email_verification" value="1" <?= $settings['require_email_verification'] ? 'checked' : '' ?>><label for="s-ver">Require email verification for self-registered accounts</label></div>
    <fieldset class="stack"><legend>Activation codes and time-limited access</legend>
      <div class="field check"><input id="s-mcode" type="checkbox" name="members_need_own_code" value="1" <?= $settings['members_need_own_code'] ? 'checked' : '' ?>><label for="s-mcode">Invited team members need their own activation code (otherwise they share their workspace owner's access period)</label></div>
      <div class="field"><label for="s-widgets">While a workspace owner's access has expired, their chat widgets</label>
        <select id="s-widgets" name="expired_owner_widgets">
          <option value="offline" <?= $settings['expired_owner_widgets'] === 'offline' ? 'selected' : '' ?>>go offline (visitors see “chat not available”; all data is kept)</option>
          <option value="keep" <?= $settings['expired_owner_widgets'] === 'keep' ? 'selected' : '' ?>>keep accepting visitor messages (owner can read them after renewing)</option>
        </select></div>
      <div class="field"><label for="s-remind">Email a renewal reminder this many days before access ends (0 = off)</label><input id="s-remind" type="number" name="access_reminder_days" min="0" max="30" value="<?= (int) $settings['access_reminder_days'] ?>"></div>
    </fieldset>
    <?php foreach (['max_workspaces_per_user' => 'Max workspaces per account', 'max_websites_per_workspace' => 'Max websites per workspace', 'max_members_per_workspace' => 'Max members per workspace', 'support_grant_max_hours' => 'Max support-access duration (hours)'] as $k => $l): ?>
      <div class="field"><label for="s-<?= $k ?>"><?= $l ?></label><input id="s-<?= $k ?>" type="number" name="<?= $k ?>" min="<?= (int) $schema[$k]['min'] ?>" max="<?= (int) $schema[$k]['max'] ?>" value="<?= (int) $settings[$k] ?>"></div>
    <?php endforeach; ?>
    <button class="btn btn-primary" type="submit">Save settings</button>
  </form>
</section>
