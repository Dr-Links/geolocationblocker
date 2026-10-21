<?php /** @var \Signalpost\Core\View $this */ ?>
<section class="card auth-card">
  <h1>Choose a new password</h1>
  <?= $this->partial('partials/errors', ['errors' => $errors]) ?>
  <form method="post" action="/reset-password" class="stack">
    <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
    <input type="hidden" name="token" value="<?= $this->e($token) ?>">
    <?= $this->partial('partials/field', ['name' => 'password', 'label' => 'New password', 'type' => 'password', 'errors' => $errors, 'required' => true, 'autocomplete' => 'new-password']) ?>
    <?= $this->partial('partials/field', ['name' => 'password_confirm', 'label' => 'Confirm new password', 'type' => 'password', 'errors' => $errors, 'required' => true, 'autocomplete' => 'new-password']) ?>
    <button class="btn btn-primary btn-block" type="submit">Set password</button>
  </form>
  <p class="muted small">All existing sessions will be signed out.</p>
</section>
