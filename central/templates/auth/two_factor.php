<?php /** @var \Signalpost\Core\View $this */ ?>
<section class="card auth-card">
  <h1>Two-factor authentication</h1>
  <p class="muted">Enter the 6-digit code from your authenticator app, or one of your recovery codes.</p>
  <?= $this->partial('partials/errors', ['errors' => $errors]) ?>
  <form method="post" action="/login/2fa" class="stack">
    <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
    <?= $this->partial('partials/field', ['name' => 'code', 'label' => 'Code', 'errors' => $errors, 'required' => true, 'autocomplete' => 'one-time-code', 'max' => 11]) ?>
    <button class="btn btn-primary btn-block" type="submit">Verify</button>
  </form>
  <p class="auth-links"><a href="/login">Cancel</a></p>
</section>
