<?php /** @var \Signalpost\Core\View $this */ ?>
<section class="card auth-card">
  <h1>Verify your email</h1>
  <?php if ($failed): ?>
    <div class="notice notice-error" role="alert">This verification link is invalid or has expired. Sign in to request a new one.</div>
    <p><a href="/login">Back to sign in</a></p>
  <?php else: ?>
    <form method="post" action="/verify-email" class="stack">
      <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
      <input type="hidden" name="token" value="<?= $this->e($token) ?>">
      <button class="btn btn-primary btn-block" type="submit">Confirm my email address</button>
    </form>
  <?php endif; ?>
</section>
