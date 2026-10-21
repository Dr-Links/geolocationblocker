<?php /** @var \Signalpost\Core\View $this */ $base = '/w/' . $ctx->workspaceId; ?>
<section class="card">
  <div class="card-head"><h2><?= $showAll ? 'All blocks' : 'Active blocks' ?></h2>
    <a class="btn btn-ghost btn-sm" href="?all=<?= $showAll ? '0' : '1' ?>"><?= $showAll ? 'Show active only' : 'Include history' ?></a></div>
  <p class="muted small">Blocks use the opaque visitor ID only and apply to a single website. There is no IP blocking. Clearing browser storage or switching browsers gives a person a new visitor ID, which a block cannot follow.</p>
  <?php if (!$rows): ?><p class="empty">No blocked visitors.</p><?php else: ?>
  <div class="table-wrap"><table class="table">
    <thead><tr><th>Visitor</th><th>Website</th><th>Reason</th><th>Blocked</th><th>By</th><th>Status</th><th></th></tr></thead>
    <tbody>
    <?php foreach ($rows as $b): ?>
      <tr><td><a href="<?= $base ?>/visitors/<?= (int) $b['visitor_id'] ?>"><code><?= $this->e(substr($b['public_id'], 0, 10)) ?></code></a> <?= $this->e($b['name'] ?? '') ?></td>
        <td><?= $this->e($b['website_name']) ?></td><td><?= $this->e($b['reason'] ?? '') ?></td><td><?= $this->time($b['created_at']) ?></td>
        <td><?= $this->e($b['blocked_by'] ?? '—') ?><?= $b['revoked_at'] ? '<div class="muted small">unblocked ' . $this->time($b['revoked_at']) . ' by ' . $this->e($b['revoked_by'] ?? '—') . '</div>' : '' ?></td>
        <td><span class="pill pill-<?= $b['status'] === 'active' ? 'blocked' : 'revoked' ?>"><?= $this->e($b['status']) ?></span></td>
        <td><?php if ($b['status'] === 'active' && $ctx->can('visitors.block')): ?>
          <form method="post" action="<?= $base ?>/visitors/<?= (int) $b['visitor_id'] ?>/unblock"><input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>"><input type="hidden" name="return" value="blocks"><button class="btn btn-sm">Unblock</button></form>
        <?php endif; ?></td></tr>
    <?php endforeach; ?>
    </tbody>
  </table></div>
  <?php endif; ?>
</section>
