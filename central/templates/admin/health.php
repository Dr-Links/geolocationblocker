<?php /** @var \Signalpost\Core\View $this */ $h = $health; ?>
<?= $this->partial('admin/_nav', ['path' => $path]) ?>
<div class="stat-grid">
  <div class="stat"><span class="stat-label">Accounts</span><span class="stat-value"><?= (int) $h['counts']['users'] ?></span></div>
  <div class="stat"><span class="stat-label">Workspaces</span><span class="stat-value"><?= (int) $h['counts']['workspaces'] ?></span></div>
  <div class="stat"><span class="stat-label">Websites</span><span class="stat-value"><?= (int) $h['counts']['websites'] ?></span></div>
  <div class="stat"><span class="stat-label">Failed sign-ins (24h)</span><span class="stat-value"><?= (int) $h['failed_logins_24h'] ?></span></div>
</div>
<section class="card">
  <h2>System</h2>
  <dl class="kv">
    <dt>Signalpost</dt><dd><?= $this->e($h['app_version']) ?></dd>
    <dt>PHP</dt><dd><?= $this->e($h['php_version']) ?></dd>
    <dt>Database</dt><dd><?= $this->e($h['db_version']) ?></dd>
    <dt>Migrations</dt><dd><?= (int) $h['migrations_applied'] ?> applied<?php if ($h['migrations_pending']): ?>, <strong class="text-warn"><?= count($h['migrations_pending']) ?> pending</strong>
      <form method="post" action="/admin/migrate" class="inline-form" data-confirm="Back up the database before running migrations. Continue?"><input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>"><button class="btn btn-sm">Run now</button></form><?php endif; ?></dd>
    <dt>Storage writable</dt><dd><?= $h['storage_writable'] ? 'Yes' : '<strong class="text-warn">No — check storage/ permissions</strong>' ?></dd>
    <dt>config.php world-readable</dt><dd><?= $h['config_world_readable'] === null ? 'Using environment-provided path' : ($h['config_world_readable'] ? '<strong class="text-warn">Yes — chmod 600 config/config.php</strong>' : 'No') ?></dd>
    <dt>HTTPS enforced</dt><dd><?= $h['https_forced'] ? 'Yes' : '<strong class="text-warn">No</strong>' ?></dd>
    <dt>Last cron run</dt><dd><?= $h['last_cron_run'] ? $this->time($h['last_cron_run']) : '<span class="text-warn">Never — see docs/CRON.md</span>' ?></dd>
  </dl>
</section>
<section class="card">
  <h2>Recent warnings and errors</h2>
  <?php if (!$h['recent_errors']): ?><p class="empty">No recent errors logged.</p><?php else: ?>
  <div class="table-wrap"><table class="table"><thead><tr><th>Time (UTC)</th><th>Level</th><th>Message</th><th>Context (redacted)</th></tr></thead><tbody>
  <?php foreach ($h['recent_errors'] as $e): ?>
    <tr><td><?= $this->e($e['ts'] ?? '') ?></td><td><?= $this->e($e['level'] ?? '') ?></td><td><?= $this->e($e['message'] ?? '') ?></td><td class="small"><code><?= $this->e(json_encode($e['context'] ?? [])) ?></code></td></tr>
  <?php endforeach; ?></tbody></table></div>
  <?php endif; ?>
</section>
