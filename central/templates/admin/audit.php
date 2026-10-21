<?php /** @var \Signalpost\Core\View $this */ ?>
<?= $this->partial('admin/_nav', ['path' => $path]) ?>
<section class="card">
  <h2>Platform audit log</h2>
  <div class="table-wrap"><table class="table"><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Resource</th><th>Details</th></tr></thead><tbody>
  <?php foreach ($rows as $r): ?>
    <tr><td><?= $this->time($r['created_at']) ?></td><td><?= $this->e($r['actor_email'] ?? $r['actor_type']) ?></td><td><code><?= $this->e($r['action']) ?></code></td><td><?= $this->e($r['resource_type']) ?> <?= $this->e($r['resource_id']) ?></td><td class="small muted"><?= $this->e($r['metadata'] ?? '') ?></td></tr>
  <?php endforeach; ?></tbody></table></div>
</section>
<section class="card">
  <h2>Security events</h2>
  <p class="muted small">Restricted record. Network addresses are masked; raw IP addresses are not stored. Retained for a short period (see Privacy docs).</p>
  <div class="table-wrap"><table class="table"><thead><tr><th>When</th><th>Event</th><th>Network (masked)</th><th>User ID</th></tr></thead><tbody>
  <?php foreach ($security as $s): ?>
    <tr><td><?= $this->time($s['created_at']) ?></td><td><code><?= $this->e($s['event_type']) ?></code></td><td><?= $this->e($s['ip_masked']) ?></td><td><?= $this->e($s['user_id'] ?? '—') ?></td></tr>
  <?php endforeach; ?></tbody></table></div>
</section>
