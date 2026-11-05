<?php /** @var \Signalpost\Core\View $this */ ?>
<section class="card auth-card">
  <?php if ($expired): ?>
    <h1>Your access has ended</h1>
    <p>Your account and all of its data are kept. Enter a new activation code from the administrator to continue with this same account.</p>
  <?php else: ?>
    <h1>Renew access</h1>
    <p class="muted"><?= $expiresAt ? 'Your current access ends ' . $this->time($expiresAt) . '. A new code adds its time to the end of your current period.' : 'Your account has no time limit.' ?></p>
  <?php endif; ?>
  <?= $this->partial('partials/errors', ['errors' => $errors]) ?>
  <form method="post" action="/renew" class="stack">
    <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
    <?= $this->partial('partials/field', ['name' => 'activation_code', 'label' => 'Activation code', 'errors' => $errors, 'required' => true, 'max' => 40, 'autocomplete' => 'off']) ?>
    <button class="btn btn-primary btn-block" type="submit">Activate</button>
  </form>
  <form method="post" action="/logout" class="auth-links"><input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>"><button class="btn btn-ghost btn-sm" type="submit">Sign out</button></form>
  <?php if (!$expired): ?><p class="auth-links"><a href="/">Back to the dashboard</a></p><?php endif; ?>
</section>
