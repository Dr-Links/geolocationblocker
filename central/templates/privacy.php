<?php /** @var \Signalpost\Core\View $this */ $base = '/w/' . $ctx->workspaceId; ?>
<?= $this->partial('partials/errors', ['errors' => $errors]) ?>
<section class="card">
  <h2>Tracking mode and retention by website</h2>
  <p class="muted small">Optional analytics retention is independent of conversation retention. Change values on each website's Tracking and Retention tabs.</p>
  <?php if (!$sites): ?><p class="empty">No websites yet.</p><?php else: ?>
  <div class="table-wrap"><table class="table">
    <thead><tr><th>Website</th><th>Mode</th><th>Legal basis</th><th>Events</th><th>Sessions</th><th>Contacts</th><th>Inactive profiles</th><th>Conversations</th><th>Consent records</th></tr></thead>
    <tbody>
    <?php foreach ($sites as $s): $r = $s['settings']['retention']; $t = $s['settings']['tracking']; ?>
      <tr><td><a href="<?= $base ?>/websites/<?= (int) $s['id'] ?>?tab=retention"><?= $this->e($s['name']) ?></a></td>
        <td><span class="pill pill-mode"><?= $t['analytics_enabled'] ? 'Analytics' : 'Essential only' ?></span></td>
        <td><?= $t['analytics_enabled'] ? $this->e($t['legal_basis'] === 'consent' ? 'Consent (v' . $t['policy_version'] . ')' : 'Other documented basis') : '—' ?></td>
        <td><?= (int) $r['events_days'] ?> d</td><td><?= (int) $r['sessions_days'] ?> d</td><td><?= (int) $r['contacts_days'] ?> d</td>
        <td><?= (int) $r['visitor_inactive_days'] ?> d</td><td><?= $r['conversations_days'] ? (int) $r['conversations_days'] . ' d' : 'keep' ?></td><td><?= (int) $r['consent_days'] ?> d</td></tr>
    <?php endforeach; ?>
    </tbody>
  </table></div>
  <?php endif; ?>
</section>

<div class="two-col">
  <section class="card">
    <h2>Retention cleanup</h2>
    <p>Last automatic run (cron): <?= $lastCron ? $this->time($lastCron) : '<strong class="text-warn">never — ask the platform owner to set up the cron job</strong>' ?></p>
    <form method="post" action="<?= $base ?>/privacy/cleanup" class="row-form">
      <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
      <button class="btn" name="mode" value="preview">Preview (dry run)</button>
      <button class="btn btn-danger" name="mode" value="run" data-confirm-click="Delete all data that is past its retention period now?">Run cleanup now</button>
    </form>
    <?php if ($report): ?>
      <div class="notice <?= $report['dry_run'] ? 'notice-info' : 'notice-ok' ?>" role="status">
        <p><strong><?= $report['dry_run'] ? 'Dry run — nothing was deleted. These records are eligible:' : 'Cleanup finished. Deleted:' ?></strong></p>
        <ul class="small"><?php foreach ($report['totals'] as $k => $n): ?><li><?= $this->e(str_replace('_', ' ', $k)) ?>: <?= (int) $n ?></li><?php endforeach; ?></ul>
        <?php if (!$report['complete']): ?><p class="small">More eligible data remains; it is removed in further runs (each run is capped to stay light on shared hosting).</p><?php endif; ?>
      </div>
    <?php endif; ?>
  </section>
  <section class="card">
    <h2>Export workspace data</h2>
    <p>Downloads a JSON file with this workspace's websites, settings, visitors, contact details, conversations, messages, analytics, consent records, blocks and audit history. Credentials, password hashes and tokens are never included. The export is recorded in the audit history.</p>
    <form method="post" action="<?= $base ?>/privacy/export"><input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>"><button class="btn btn-primary">Download export</button></form>
    <p class="muted small">For a single person's data, open their visitor profile and use “Export visitor data”.</p>
  </section>
</div>

<section class="card">
  <h2>Delete this workspace</h2>
  <?php if ($isPrimaryOwner): ?>
    <p>Permanently deletes the workspace and everything in it: websites and their credentials, visitors, conversations, messages, analytics, consent records, blocks, members' access and audit history. Other workspaces are not affected. Connected WordPress sites stop showing the chat. Backups may retain data until they expire. <strong>This cannot be undone.</strong> Consider exporting first.</p>
    <form method="post" action="<?= $base ?>/privacy/delete-workspace" class="stack narrow-form" data-confirm="Permanently delete this workspace and all of its data?">
      <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
      <?= $this->partial('partials/field', ['name' => 'confirm_name', 'label' => 'Type the workspace name: ' . $ctx->workspaceName, 'errors' => $errors, 'required' => true]) ?>
      <?= $this->partial('partials/field', ['name' => 'password', 'label' => 'Your password', 'type' => 'password', 'errors' => $errors, 'required' => true, 'autocomplete' => 'current-password']) ?>
      <div><button class="btn btn-danger">Delete workspace permanently</button></div>
    </form>
  <?php else: ?>
    <p class="muted">Only the primary owner can delete the workspace.</p>
  <?php endif; ?>
</section>
