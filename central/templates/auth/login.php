<?php /** @var \Signalpost\Core\View $this */ ?>
<section class="card auth-card">
  <h1>Sign in</h1>
  <?php if (!empty($notice)): ?><div class="notice notice-ok" role="status"><?= $this->e($notice) ?></div><?php endif; ?>
  <?= $this->partial('partials/errors', ['errors' => $errors]) ?>
  <form method="post" action="/login" class="stack">
    <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
    <?= $this->partial('partials/field', ['name' => 'email', 'label' => 'Email', 'type' => 'email', 'value' => $email, 'errors' => $errors, 'required' => true, 'autocomplete' => 'username']) ?>
    <?= $this->partial('partials/field', ['name' => 'password', 'label' => 'Password', 'type' => 'password', 'errors' => $errors, 'required' => true, 'autocomplete' => 'current-password']) ?>
    <button class="btn btn-primary btn-block" type="submit">Sign in</button>
  </form>
  <p class="auth-links"><a href="/forgot-password">Forgot your password?</a>
  <?php if ($registration === 'open'): ?> · <a href="/register">Create an account</a><?php endif; ?></p>
  <?php if (!empty($unverified)): ?>
  <form method="post" action="/verify-email/resend" class="inline-form">
    <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
    <input type="hidden" name="email" value="<?= $this->e($email) ?>">
    <button class="btn btn-ghost btn-sm" type="submit">Send a new verification link</button>
  </form>
  <?php endif; ?>
</section>
