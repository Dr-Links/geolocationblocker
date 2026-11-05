<?php /** @var \Signalpost\Core\View $this */ ?>
<?= $this->partial('admin/_nav', ['path' => $path]) ?>
<?php if ($newCodes): ?>
<section class="card notice-warn" aria-live="polite">
  <h2><?= count($newCodes) ?> new activation code<?= count($newCodes) > 1 ? 's' : '' ?></h2>
  <p><strong>Copy them now — they are shown only once.</strong> Only a fingerprint is stored. Each code creates one account or renews one existing account.</p>
  <div class="copy-row"><pre class="recovery-codes" data-copy-source><?= $this->e(implode("\n", $newCodes)) ?></pre><button type="button" class="btn btn-sm" data-copy>Copy</button></div>
</section>
<?php endif; ?>
<section class="card">
  <h2>Generate codes</h2>
  <?= $this->partial('partials/errors', ['errors' => $errors]) ?>
  <form method="post" action="/admin/codes" class="row-form">
    <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
    <div class="field"><label for="c-dur">Access period</label><select id="c-dur" name="duration_months">
      <?php foreach ($durations as $d): ?><option value="<?= (int) $d ?>"><?= $d === 12 ? '1 year' : $d . ' month' . ($d > 1 ? 's' : '') ?></option><?php endforeach; ?></select></div>
    <div class="field"><label for="c-qty">How many</label><input id="c-qty" type="number" name="quantity" min="1" max="50" value="1"></div>
    <div class="field grow"><label for="c-note">Note (who it's for)</label><input id="c-note" type="text" name="note" maxlength="255" placeholder="e.g. Jane Doe — Acme Ltd"></div>
    <button class="btn btn-primary" type="submit">Generate</button>
  </form>
  <p class="hint">The period starts when the code is used. Renewing before expiry adds the time to the end of the current period. When a period ends, the account is signed out and can only be reopened with a new code.</p>
</section>
<section class="card">
  <div class="card-head"><h2>Codes</h2>
    <nav class="tabs" aria-label="Filter">
      <?php foreach (['all' => 'All', 'unused' => 'Unused', 'used' => 'Used', 'revoked' => 'Revoked'] as $k => $l): ?>
        <a class="tab<?= $filter === $k ? ' active' : '' ?>" href="/admin/codes?status=<?= $k ?>"><?= $l ?></a>
      <?php endforeach; ?>
    </nav></div>
  <?php if (!$rows): ?><p class="empty">No codes yet.</p><?php else: ?>
  <div class="table-wrap"><table class="table">
    <thead><tr><th>Code</th><th>Period</th><th>Note</th><th>Created</th><th>Status</th><th>Used by</th><th>Account access until</th><th></th></tr></thead>
    <tbody>
    <?php foreach ($rows as $c):
        $status = $c['revoked_at'] ? 'revoked' : ($c['used_at'] ? 'used' : 'unused'); ?>
      <tr><td><code>AC-…-<?= $this->e($c['code_hint']) ?></code></td>
        <td><?= (int) $c['duration_months'] === 12 ? '1 year' : (int) $c['duration_months'] . ' mo' ?></td>
        <td><?= $this->e($c['note']) ?></td>
        <td><?= $this->time($c['created_at']) ?><div class="muted small"><?= $this->e($c['created_by'] ?? '') ?></div></td>
        <td><span class="pill pill-<?= $status === 'unused' ? 'ok' : ($status === 'used' ? 'mode' : 'revoked') ?>"><?= $status ?></span>
          <?= $c['used_for'] ? '<div class="muted small">' . $this->e($c['used_for'] === 'signup' ? 'new account' : 'renewal') . ' · ' . $this->time($c['used_at']) . '</div>' : '' ?></td>
        <td><?= $this->e($c['used_by'] ?? '—') ?></td>
        <td><?= $c['used_by'] ? $this->time($c['access_expires_at']) : '—' ?></td>
        <td><?php if ($status === 'unused'): ?><form method="post" action="/admin/codes/<?= (int) $c['id'] ?>/revoke"><input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>"><button class="btn btn-sm btn-danger">Revoke</button></form><?php endif; ?></td></tr>
    <?php endforeach; ?>
    </tbody>
  </table></div>
  <?php endif; ?>
</section>
