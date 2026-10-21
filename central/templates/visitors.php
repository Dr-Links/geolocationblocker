<?php /** @var \Signalpost\Core\View $this */ $base = '/w/' . $ctx->workspaceId; ?>
<section class="card">
  <form method="get" class="row-form" role="search">
    <div class="field grow"><label for="vq">Search</label><input id="vq" type="search" name="q" value="<?= $this->e($q) ?>" placeholder="Visitor ID, name, email or phone" maxlength="100"></div>
    <div class="field"><label for="vs">Website</label><select id="vs" name="website"><option value="">All</option>
      <?php foreach ($sites as $s): ?><option value="<?= (int) $s['id'] ?>" <?= $website === (int) $s['id'] ? 'selected' : '' ?>><?= $this->e($s['name']) ?></option><?php endforeach; ?></select></div>
    <button class="btn">Filter</button>
  </form>
  <p class="muted small">Visitor IDs are random and pseudonymous. A profile exists only after a visitor opened the chat or permitted analytics. Names, emails and phone numbers are shown only if the visitor submitted them.</p>
  <?php if (!$rows): ?><p class="empty">No visitors found.</p><?php else: ?>
  <div class="table-wrap"><table class="table">
    <thead><tr><th>Visitor</th><th>Website</th><th>Submitted contact</th><th>First seen</th><th>Last seen</th><th>Visits</th><th>Consent</th><th></th></tr></thead>
    <tbody>
    <?php foreach ($rows as $r): ?>
      <tr><td><a href="<?= $base ?>/visitors/<?= (int) $r['id'] ?>"><code><?= $this->e(substr($r['public_id'], 0, 10)) ?></code></a></td>
        <td><?= $this->e($r['website_name']) ?></td>
        <td><?= $this->e($r['name'] ?? '') ?><?= $r['email'] ? ' <span class="muted small">' . $this->e($r['email']) . '</span>' : '' ?><?= !$r['name'] && !$r['email'] && !$r['phone'] ? '<span class="muted">—</span>' : '' ?></td>
        <td><?= $this->time($r['first_seen_at']) ?></td><td><?= $this->time($r['last_seen_at']) ?></td>
        <td><?= (int) $r['visit_count'] ?: '<span class="muted">—</span>' ?></td>
        <td><span class="pill"><?= $this->e($r['consent_state']) ?></span></td>
        <td><?= $r['blocked'] ? '<span class="pill pill-blocked">blocked</span>' : '' ?> <?= (int) $r['conversations'] ? '<span class="muted small">' . (int) $r['conversations'] . ' conv.</span>' : '' ?></td></tr>
    <?php endforeach; ?>
    </tbody>
  </table></div>
  <?php if (count($rows) === 50): ?><p><a href="?<?= $this->e(http_build_query(['q' => $q, 'website' => $website ?: null, 'before' => end($rows)['id']])) ?>">Older visitors</a></p><?php endif; ?>
  <?php endif; ?>
</section>
