<?php /** @var \Signalpost\Core\View $this */ $base = '/w/' . $ctx->workspaceId; ?>
<div class="stat-grid">
  <div class="stat"><span class="stat-label">Open conversations</span><span class="stat-value"><?= (int) $stats['open'] ?></span></div>
  <div class="stat"><span class="stat-label">Pending</span><span class="stat-value"><?= (int) $stats['pending'] ?></span></div>
  <div class="stat"><span class="stat-label">Active visitors now</span><span class="stat-value"><?= (int) $stats['active_visitors'] ?></span>
    <span class="stat-note">Seen in the last <?= (int) ($this->app()->config->int('limits.active_visitor_seconds') / 60) ?> min</span></div>
  <div class="stat"><span class="stat-label">Messages today (UTC)</span><span class="stat-value"><?= (int) $stats['messages_today'] ?></span></div>
  <div class="stat"><span class="stat-label">Websites connected</span><span class="stat-value"><?= (int) $stats['connected'] ?> / <?= (int) $stats['websites'] ?></span></div>
</div>

<div class="two-col">
  <section class="card">
    <div class="card-head"><h2>Recent conversations</h2><?php if ($ctx->can('conversations.read')): ?><a href="<?= $base ?>/inbox" class="btn btn-ghost btn-sm">Open inbox</a><?php endif; ?></div>
    <?php if (!$recent): ?>
      <p class="empty">No conversations yet. They appear here when a visitor sends the first message from a connected website.</p>
    <?php else: ?>
      <ul class="list">
        <?php foreach ($recent as $c): ?>
          <li><a href="<?= $base ?>/inbox?c=<?= (int) $c['id'] ?>">
            <strong><?= $this->e($c['name'] ?: 'Visitor ' . substr($c['public_id'], 0, 8)) ?></strong>
            <span class="muted">· <?= $this->e($c['website_name']) ?></span>
            <span class="pill pill-<?= $this->e($c['status']) ?>"><?= $this->e($c['status']) ?></span>
            <span class="muted small"><?= $this->time($c['last_message_at']) ?></span>
          </a></li>
        <?php endforeach; ?>
      </ul>
    <?php endif; ?>
  </section>
  <section class="card">
    <div class="card-head"><h2>Websites</h2><?php if ($ctx->can('websites.manage')): ?><a href="<?= $base ?>/websites" class="btn btn-ghost btn-sm">Manage</a><?php endif; ?></div>
    <?php if (!$sites): ?>
      <p class="empty">No websites yet. <?php if ($ctx->can('websites.manage')): ?><a href="<?= $base ?>/websites">Add your first WordPress website</a>.<?php endif; ?></p>
    <?php else: ?>
      <ul class="list">
        <?php foreach ($sites as $s): ?>
          <li><a href="<?= $base ?>/websites/<?= (int) $s['id'] ?>">
            <strong><?= $this->e($s['name']) ?></strong> <span class="muted small"><?= $this->e($s['canonical_origin']) ?></span>
            <span class="pill pill-<?= $this->e($s['status']) ?>"><?= $this->e($s['status']) ?></span>
            <span class="pill pill-mode" title="Active tracking mode"><?= $s['tracking_policy'] === 'analytics' ? 'Analytics (consent-gated)' : 'Essential chat only' ?></span>
          </a></li>
        <?php endforeach; ?>
      </ul>
    <?php endif; ?>
  </section>
</div>
