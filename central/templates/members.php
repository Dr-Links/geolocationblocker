<?php /** @var \Signalpost\Core\View $this */ $base = '/w/' . $ctx->workspaceId; ?>
<?= $this->partial('partials/errors', ['errors' => $errors]) ?>
<?php if ($inviteUrl): ?>
  <div class="notice notice-ok" role="status">
    <p><strong>Invitation created.</strong> It was emailed. If email delivery is not configured, send this one-time link yourself. It is shown only once and expires in 7 days.</p>
    <div class="copy-row"><input type="text" readonly value="<?= $this->e($inviteUrl) ?>" aria-label="Invitation link" data-copy-source><button type="button" class="btn btn-sm" data-copy>Copy</button></div>
  </div>
<?php endif; ?>
<section class="card">
  <div class="card-head"><h2>Members</h2></div>
  <div class="table-wrap"><table class="table">
    <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Since</th><?php if ($ctx->can('members.manage')): ?><th><span class="sr-only">Actions</span></th><?php endif; ?></tr></thead>
    <tbody>
    <?php foreach ($members as $m): $isPrimary = (int) $m['user_id'] === $ctx->primaryOwnerId; ?>
      <tr>
        <td><?= $this->e($m['display_name']) ?><?= $isPrimary ? ' <span class="pill">primary owner</span>' : '' ?></td>
        <td><?= $this->e($m['email']) ?></td>
        <td>
          <?php if ($ctx->can('members.manage') && !$isPrimary && $m['status'] === 'active'): ?>
            <form method="post" action="<?= $base ?>/members/<?= (int) $m['id'] ?>/role" class="inline-form">
              <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
              <label class="sr-only" for="role-<?= (int) $m['id'] ?>">Role</label>
              <select id="role-<?= (int) $m['id'] ?>" name="role" data-autosubmit>
                <?php foreach ($roles as $r): ?><option value="<?= $r ?>" <?= $m['role'] === $r ? 'selected' : '' ?>><?= $this->e(\Signalpost\Tenancy\Roles::label($r)) ?></option><?php endforeach; ?>
              </select>
              <noscript><button class="btn btn-sm">Save</button></noscript>
            </form>
          <?php else: ?><?= $this->e(\Signalpost\Tenancy\Roles::label($m['role'])) ?><?php endif; ?>
        </td>
        <td><span class="pill pill-<?= $this->e($m['status']) ?>"><?= $this->e($m['status']) ?></span><?= $m['user_status'] === 'suspended' ? ' <span class="pill pill-warn">account suspended</span>' : '' ?></td>
        <td><?= $this->time($m['created_at']) ?></td>
        <?php if ($ctx->can('members.manage')): ?>
        <td class="actions"><?php if (!$isPrimary && $m['status'] === 'active'): ?>
          <form method="post" action="<?= $base ?>/members/<?= (int) $m['id'] ?>/revoke" data-confirm="Remove this member? They lose access immediately.">
            <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>"><button class="btn btn-danger btn-sm">Remove</button></form>
        <?php endif; ?></td>
        <?php endif; ?>
      </tr>
    <?php endforeach; ?>
    </tbody>
  </table></div>
</section>

<?php if ($ctx->can('members.manage')): ?>
<div class="two-col">
  <section class="card">
    <h2>Invite someone</h2>
    <p class="muted">Agents can read and answer conversations, view visitor profiles and block visitors. Owners can also manage websites, credentials, privacy settings, members, exports and deletion.</p>
    <form method="post" action="<?= $base ?>/members/invite" class="stack">
      <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
      <?= $this->partial('partials/field', ['name' => 'email', 'label' => 'Email', 'type' => 'email', 'errors' => $errors, 'required' => true]) ?>
      <div class="field"><label for="f-role">Role</label>
        <select id="f-role" name="role"><option value="agent">Agent</option><option value="owner">Owner</option></select></div>
      <button class="btn btn-primary" type="submit">Send invitation</button>
    </form>
  </section>
  <section class="card">
    <h2>Pending invitations</h2>
    <?php if (!$invitations): ?><p class="empty">No pending invitations.</p><?php else: ?>
    <ul class="list">
      <?php foreach ($invitations as $i): ?>
        <li><span><?= $this->e($i['email']) ?> · <?= $this->e(\Signalpost\Tenancy\Roles::label($i['role'])) ?> <span class="muted small">expires <?= $this->time($i['expires_at']) ?></span></span>
          <form method="post" action="<?= $base ?>/invitations/<?= (int) $i['id'] ?>/revoke" class="inline-form"><input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>"><button class="btn btn-ghost btn-sm">Revoke</button></form></li>
      <?php endforeach; ?>
    </ul>
    <?php endif; ?>
  </section>
</div>
<?php endif; ?>

<?php if ($ctx->can('workspace.manage')): ?>
<section class="card">
  <h2>Platform support access</h2>
  <p class="muted">The platform administrator cannot see your conversations or visitors. If you need help, you can grant temporary <strong>read-only</strong> access. Every page they open is recorded in your audit history, and you can revoke access at any time.</p>
  <form method="post" action="<?= $base ?>/support-grants" class="row-form">
    <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
    <div class="field"><label for="f-hours">Duration (hours)</label><input id="f-hours" type="number" name="hours" min="1" max="168" value="4"></div>
    <div class="field grow"><label for="f-reason">Reason</label><input id="f-reason" type="text" name="reason" maxlength="255" required placeholder="e.g. Investigating missing messages"></div>
    <button class="btn" type="submit">Grant access</button>
  </form>
  <?php if ($grants): ?>
  <div class="table-wrap"><table class="table"><thead><tr><th>Granted</th><th>By</th><th>Reason</th><th>Expires</th><th>Status</th><th></th></tr></thead><tbody>
  <?php foreach ($grants as $g): $active = !$g['revoked_at'] && strtotime($g['expires_at'] . ' UTC') > time(); ?>
    <tr><td><?= $this->time($g['created_at']) ?></td><td><?= $this->e($g['granted_by'] ?? '—') ?></td><td><?= $this->e($g['reason']) ?></td><td><?= $this->time($g['expires_at']) ?></td>
      <td><?= $active ? '<span class="pill pill-warn">active</span>' : '<span class="pill">ended</span>' ?></td>
      <td><?php if ($active): ?><form method="post" action="<?= $base ?>/support-grants/<?= (int) $g['id'] ?>/revoke"><input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>"><button class="btn btn-danger btn-sm">Revoke</button></form><?php endif; ?></td></tr>
  <?php endforeach; ?></tbody></table></div>
  <?php endif; ?>
</section>
<?php endif; ?>
