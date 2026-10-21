<?php /** @var \Signalpost\Core\View $this */ ?>
<section class="card">
  <p class="muted">Sensitive actions in this workspace. Entries never contain message text, passwords, credentials or visitor contact details.</p>
  <?php if (!$rows): ?><p class="empty">No audit entries yet.</p><?php else: ?>
  <div class="table-wrap"><table class="table">
    <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Resource</th><th>Details</th></tr></thead>
    <tbody>
    <?php foreach ($rows as $r): ?>
      <tr><td><?= $this->time($r['created_at']) ?></td>
        <td><?= $this->e($r['actor_email'] ?? ($r['actor_type'] === 'user' ? '(deleted user)' : $r['actor_type'])) ?><?= $r['actor_type'] === 'support' ? ' <span class="pill pill-warn">support</span>' : '' ?></td>
        <td><code><?= $this->e($r['action']) ?></code></td>
        <td><?= $this->e($r['resource_type']) ?> <?= $this->e($r['resource_id']) ?></td>
        <td class="small muted"><?= $this->e($r['metadata'] ?? '') ?></td></tr>
    <?php endforeach; ?>
    </tbody>
  </table></div>
  <?php if (count($rows) === 100): ?><p><a href="?before=<?= (int) end($rows)['id'] ?>">Older entries</a></p><?php endif; ?>
  <?php endif; ?>
</section>
