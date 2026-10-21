<?php /** @var \Signalpost\Core\View $this */ ?>
<section class="card auth-card">
  <h1>Join “<?= $this->e($inv['workspace_name']) ?>”</h1>
  <p>You were invited as <strong><?= $this->e(\Signalpost\Tenancy\Roles::label($inv['role'])) ?></strong> using <strong><?= $this->e($inv['email']) ?></strong>.</p>
  <?= $this->partial('partials/errors', ['errors' => $errors]) ?>
  <?php if ($user): ?>
    <?php if (strtolower($user['email']) !== strtolower($inv['email'])): ?>
      <div class="notice notice-error">You are signed in as <?= $this->e($user['email']) ?>. Sign out and sign in with the invited address to accept.</div>
    <?php else: ?>
      <form method="post" action="/invite/<?= $this->e($token) ?>"><input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>"><button class="btn btn-primary btn-block" type="submit">Accept invitation</button></form>
    <?php endif; ?>
  <?php elseif ($existing): ?>
    <p>You already have an account. <a href="/login">Sign in</a>, then open this invitation link again.</p>
  <?php else: ?>
    <form method="post" action="/invite/<?= $this->e($token) ?>" class="stack">
      <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
      <?= $this->partial('partials/field', ['name' => 'display_name', 'label' => 'Your name', 'errors' => $errors, 'required' => true, 'max' => 100, 'autocomplete' => 'name']) ?>
      <?= $this->partial('partials/field', ['name' => 'password', 'label' => 'Choose a password', 'type' => 'password', 'errors' => $errors, 'required' => true, 'autocomplete' => 'new-password']) ?>
      <?= $this->partial('partials/field', ['name' => 'password_confirm', 'label' => 'Confirm password', 'type' => 'password', 'errors' => $errors, 'required' => true, 'autocomplete' => 'new-password']) ?>
      <button class="btn btn-primary btn-block" type="submit">Create account and join</button>
    </form>
  <?php endif; ?>
</section>
