<?php /** @var \Signalpost\Core\View $this */ ?>
<?= $this->partial('admin/_nav', ['path' => $path]) ?>
<section class="card">
  <div class="table-wrap"><table class="table">
    <thead><tr><th>ID</th><th>Name</th><th>Owner</th><th>Members</th><th>Websites</th><th>Status</th><th>Created</th><th></th></tr></thead>
    <tbody>
    <?php foreach ($rows as $w): ?>
      <tr><td><?= (int) $w['id'] ?></td><td><?= $this->e($w['name']) ?></td><td><?= $this->e($w['owner_email']) ?></td><td><?= (int) $w['members'] ?></td><td><?= (int) $w['websites'] ?></td>
        <td><span class="pill pill-<?= $this->e($w['status']) ?>"><?= $this->e($w['status']) ?></span></td><td><?= $this->time($w['created_at']) ?></td>
        <td><form method="post" action="/admin/workspaces/<?= (int) $w['id'] ?>/status" data-confirm="<?= $w['status'] === 'suspended' ? 'Reactivate this workspace?' : 'Suspend this workspace? Members lose access and its chat widgets stop working.' ?>">
          <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>"><input type="hidden" name="status" value="<?= $w['status'] === 'suspended' ? 'active' : 'suspended' ?>">
          <button class="btn btn-sm <?= $w['status'] === 'suspended' ? '' : 'btn-danger' ?>"><?= $w['status'] === 'suspended' ? 'Reactivate' : 'Suspend' ?></button></form></td></tr>
    <?php endforeach; ?>
    </tbody>
  </table></div>
</section>
