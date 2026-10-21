<?php /** @var \Signalpost\Core\View $this */ ?>
<section class="card auth-card">
  <h1>Reset your password</h1>
  <p class="muted">Enter your account email. If it exists, we will send a link that is valid for one hour.</p>
  <form method="post" action="/forgot-password" class="stack">
    <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
    <?= $this->partial('partials/field', ['name' => 'email', 'label' => 'Email', 'type' => 'email', 'errors' => $errors, 'required' => true, 'autocomplete' => 'email']) ?>
    <button class="btn btn-primary btn-block" type="submit">Send reset link</button>
  </form>
  <p class="auth-links"><a href="/login">Back to sign in</a></p>
</section>
