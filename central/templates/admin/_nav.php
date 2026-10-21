<?php /** @var \Signalpost\Core\View $this */ ?>
<nav class="tabs" aria-label="Platform administration">
  <?php foreach (['/admin' => 'Health', '/admin/users' => 'Accounts', '/admin/workspaces' => 'Workspaces', '/admin/settings' => 'Settings', '/admin/audit' => 'Audit & security'] as $href => $label): ?>
    <a href="<?= $href ?>" class="tab<?= $path === $href ? ' active' : '' ?>"<?= $path === $href ? ' aria-current="page"' : '' ?>><?= $label ?></a>
  <?php endforeach; ?>
</nav>
<p class="muted small">Platform administration works with account-level information only. Conversations and visitor data stay private to each workspace unless its owner grants temporary support access.</p>
