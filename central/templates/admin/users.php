<?php /** @var \Signalpost\Core\View $this */ ?>
<?= $this->partial('admin/_nav', ['path' => $path]) ?>
<section class="card">
  <form method="get" action="/admin/users" class="row-form"><div class="field grow"><label for="q">Search by email</label><input id="q" type="search" name="q" value="<?= $this->e($q) ?>"></div><button class="btn">Search</button></form>
  <div class="table-wrap"><table class="table">
    <thead><tr><th>ID</th><th>Email</th><th>Name</th><th>Status</th><th>Workspaces</th><th>Created</th><th>Last sign-in</th><th></th></tr></thead>
    <tbody>
    <?php foreach ($users as $u): ?>
      <tr><td><?= (int) $u['id'] ?></td><td><?= $this->e($u['email']) ?><?= $u['is_platform_admin'] ? ' <span class="pill">platform owner</span>' : '' ?></td><td><?= $this->e($u['display_name']) ?></td>
        <td><span class="pill pill-<?= $this->e($u['status']) ?>"><?= $this->e($u['status']) ?></span></td><td><?= (int) $u['workspaces'] ?></td>
        <td><?= $this->time($u['created_at']) ?></td><td><?= $this->time($u['last_login_at']) ?></td>
        <td><?php if ((int) $u['id'] !== (int) $user['id']): ?>
          <form method="post" action="/admin/users/<?= (int) $u['id'] ?>/status" data-confirm="<?= $u['status'] === 'suspended' ? 'Reactivate this account?' : 'Suspend this account? All of its sessions end immediately.' ?>">
            <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
            <input type="hidden" name="status" value="<?= $u['status'] === 'suspended' ? 'active' : 'suspended' ?>">
            <button class="btn btn-sm <?= $u['status'] === 'suspended' ? '' : 'btn-danger' ?>"><?= $u['status'] === 'suspended' ? 'Reactivate' : 'Suspend' ?></button></form>
        <?php endif; ?></td></tr>
    <?php endforeach; ?>
    </tbody>
  </table></div>
</section>
