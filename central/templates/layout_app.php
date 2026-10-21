<?php
/** @var \Signalpost\Core\View $this */
$ctx = $ctx ?? $this->shared('ctx');
$user = $user ?? null;
$workspaces = $workspaces ?? [];
$nav = static function (string $href, string $label, string $icon, string $current) {
    $active = $current === $href || ($href !== '' && str_starts_with($current, $href . '/'));
    return [$href, $label, $icon, $active];
};
?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title><?= $this->e($title ?? 'Dashboard') ?> · Signalpost</title>
<link rel="stylesheet" href="/assets/app.css">
</head>
<body class="app">
<a class="skip-link" href="#main">Skip to content</a>
<div class="shell">
  <aside class="sidebar" id="sidebar" aria-label="Primary">
    <div class="sidebar-head">
      <a class="brand" href="/"><span class="brand-mark" aria-hidden="true"></span>Signalpost</a>
    </div>
    <?php if ($workspaces): ?>
    <form class="ws-switch" method="get" action="/" data-ws-switch>
      <label for="ws-select" class="sr-only">Workspace</label>
      <select id="ws-select" name="ws">
        <?php foreach ($workspaces as $w): ?>
          <option value="<?= (int) $w['id'] ?>" <?= $ctx && $ctx->workspaceId === (int) $w['id'] ? 'selected' : '' ?>>
            <?= $this->e($w['name']) ?><?= $w['role'] === 'support' ? ' (support)' : '' ?>
          </option>
        <?php endforeach; ?>
      </select>
    </form>
    <?php endif; ?>
    <?php if ($ctx): $base = '/w/' . $ctx->workspaceId; ?>
    <nav class="nav">
      <?php
      $items = [
          [$base, 'Overview', 'grid', 'workspace.view'],
          [$base . '/inbox', 'Inbox', 'inbox', 'conversations.read'],
          [$base . '/live', 'Live visitors', 'pulse', 'visitors.read'],
          [$base . '/visitors', 'Visitor profiles', 'people', 'visitors.read'],
          [$base . '/blocks', 'Visitor blocking', 'shield', 'visitors.read'],
          [$base . '/websites', 'Websites & widget', 'globe', 'websites.read'],
          [$base . '/members', 'Members', 'team', 'workspace.view'],
          [$base . '/privacy', 'Privacy & retention', 'lock', 'privacy.manage'],
          [$base . '/audit', 'Audit history', 'list', 'audit.read'],
          [$base . '/settings', 'Workspace settings', 'gear', 'workspace.manage'],
      ];
      foreach ($items as [$href, $label, $icon, $perm]):
          if (!$ctx->can($perm)) { continue; }
          $active = $path === $href || ($href !== $base && str_starts_with($path, $href));
      ?>
        <a href="<?= $this->e($href) ?>" class="nav-item<?= $active ? ' active' : '' ?>"<?= $active ? ' aria-current="page"' : '' ?>>
          <span class="ico ico-<?= $icon ?>" aria-hidden="true"></span><?= $this->e($label) ?>
        </a>
      <?php endforeach; ?>
    </nav>
    <?php endif; ?>
    <div class="sidebar-foot">
      <a href="/workspaces/new" class="nav-item"><span class="ico ico-plus" aria-hidden="true"></span>New workspace</a>
      <?php if ($user && $user['is_platform_admin']): ?>
        <a href="/admin" class="nav-item<?= str_starts_with($path, '/admin') ? ' active' : '' ?>"><span class="ico ico-server" aria-hidden="true"></span>Platform admin</a>
      <?php endif; ?>
    </div>
  </aside>
  <div class="main-col">
    <header class="topbar">
      <button type="button" class="icon-btn menu-btn" aria-controls="sidebar" aria-expanded="false" data-menu-toggle>
        <span class="ico ico-menu" aria-hidden="true"></span><span class="sr-only">Menu</span>
      </button>
      <div class="topbar-title">
        <?php if ($ctx): ?><span class="crumb"><?= $this->e($ctx->workspaceName) ?></span><?php endif; ?>
        <h1><?= $this->e($title ?? '') ?></h1>
      </div>
      <?php if ($ctx && $ctx->isSupport()): ?>
        <span class="pill pill-warn" title="Every page you open is recorded in this workspace's audit history.">Support access · read-only · audited</span>
      <?php endif; ?>
      <?php if ($user): ?>
      <div class="topbar-user">
        <a href="/account" class="user-link"><span class="avatar" aria-hidden="true"><?= $this->e(mb_strtoupper(mb_substr($user['display_name'] ?: $user['email'], 0, 1))) ?></span><span class="user-name"><?= $this->e($user['display_name'] ?: $user['email']) ?></span></a>
        <form method="post" action="/logout">
          <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
          <button type="submit" class="btn btn-ghost btn-sm">Sign out</button>
        </form>
      </div>
      <?php endif; ?>
    </header>
    <main id="main" class="content" tabindex="-1">
      <?php if (!empty($notice)): ?>
        <div class="notice notice-ok" role="status"><?= $this->e($notice) ?></div>
      <?php endif; ?>
      <?= $this->content() ?>
    </main>
  </div>
</div>
<script src="/assets/app.js" defer></script>
</body>
</html>
