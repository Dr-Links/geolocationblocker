<?php /** @var \Signalpost\Core\View $this */ $base = '/w/' . $ctx->workspaceId; ?>
<section class="card">
  <div class="card-head"><h2>Connected websites</h2></div>
  <?php if (!$sites): ?>
    <p class="empty">No websites yet.<?= $ctx->can('websites.manage') ? ' Add one below, then install the Signalpost Connector plugin on it.' : '' ?></p>
  <?php else: ?>
  <div class="table-wrap"><table class="table">
    <thead><tr><th>Name</th><th>Address</th><th>Status</th><th>Tracking mode</th><th>Last connection</th><th>Plugin</th></tr></thead>
    <tbody>
    <?php foreach ($sites as $s): ?>
      <tr><td><a href="<?= $base ?>/websites/<?= (int) $s['id'] ?>"><strong><?= $this->e($s['name']) ?></strong></a></td>
        <td><?= $this->e($s['canonical_origin']) ?></td>
        <td><span class="pill pill-<?= $this->e($s['status']) ?>"><?= $this->e($s['status']) ?></span></td>
        <td><span class="pill pill-mode"><?= $s['tracking_policy'] === 'analytics' ? 'Analytics (policy-gated)' : 'Essential chat only' ?></span></td>
        <td><?= $this->time($s['last_connected_at']) ?></td><td><?= $this->e($s['plugin_version'] ?? '—') ?></td></tr>
    <?php endforeach; ?>
    </tbody>
  </table></div>
  <?php endif; ?>
</section>
<?php if ($ctx->can('websites.manage')): ?>
<section class="card narrow">
  <h2>Add a WordPress website</h2>
  <?= $this->partial('partials/errors', ['errors' => $errors]) ?>
  <form method="post" action="<?= $base ?>/websites" class="stack">
    <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
    <?= $this->partial('partials/field', ['name' => 'name', 'label' => 'Website name', 'value' => $old['name'] ?? '', 'errors' => $errors, 'required' => true, 'max' => 100]) ?>
    <?= $this->partial('partials/field', ['name' => 'origin', 'label' => 'Site address', 'type' => 'url', 'value' => $old['origin'] ?? '', 'errors' => $errors, 'required' => true, 'hint' => 'Exactly as visitors see it, e.g. https://www.example.com — scheme and host only. www and non-www are different addresses.']) ?>
    <button class="btn btn-primary" type="submit">Add website</button>
  </form>
</section>
<?php endif; ?>
