<?php /** @var \Signalpost\Core\View $this */ ?>
<section class="card auth-card wide">
  <h1>Install Signalpost</h1>
  <p>Create the platform owner account. This page works only once, while no account exists.</p>
  <div class="notice notice-info">
    <strong>Prove you control this hosting account.</strong> A one-time setup token was written to
    <code><?= $this->e($tokenPath) ?></code> inside the application directory (not web-accessible).
    Open it with cPanel File Manager or SSH and paste its contents below. The file is deleted after installation.
  </div>
  <?= $this->partial('partials/errors', ['errors' => $errors]) ?>
  <form method="post" action="/install" class="stack">
    <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
    <?= $this->partial('partials/field', ['name' => 'setup_token', 'label' => 'Setup token', 'errors' => $errors, 'required' => true, 'autocomplete' => 'off']) ?>
    <?= $this->partial('partials/field', ['name' => 'display_name', 'label' => 'Your name', 'value' => $old['display_name'] ?? '', 'errors' => $errors, 'required' => true, 'max' => 100]) ?>
    <?= $this->partial('partials/field', ['name' => 'email', 'label' => 'Owner email', 'type' => 'email', 'value' => $old['email'] ?? '', 'errors' => $errors, 'required' => true, 'autocomplete' => 'username']) ?>
    <?= $this->partial('partials/field', ['name' => 'workspace_name', 'label' => 'First workspace name', 'value' => $old['workspace_name'] ?? '', 'errors' => $errors, 'required' => true, 'max' => 100]) ?>
    <?= $this->partial('partials/field', ['name' => 'password', 'label' => 'Password', 'type' => 'password', 'errors' => $errors, 'required' => true, 'autocomplete' => 'new-password', 'hint' => 'At least 10 characters. Use a password manager.']) ?>
    <?= $this->partial('partials/field', ['name' => 'password_confirm', 'label' => 'Confirm password', 'type' => 'password', 'errors' => $errors, 'required' => true, 'autocomplete' => 'new-password']) ?>
    <button class="btn btn-primary btn-block" type="submit">Create owner and finish</button>
  </form>
</section>
