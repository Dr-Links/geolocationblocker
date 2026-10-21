<?php
/** @var \Signalpost\Core\View $this */
$base = '/w/' . $ctx->workspaceId;
$canBlock = $ctx->can('visitors.block');
?>
<div class="legend" aria-label="Information sources">
  <span class="pill pill-submitted">Submitted by the visitor</span>
  <span class="pill pill-observed">Observed automatically</span>
  <span class="pill pill-inferred">Estimated / inferred</span>
  <span class="muted small">No information comes from an external identity integration in this version.</span>
</div>
<div class="two-col spaced">
  <section class="card">
    <h2>Identity</h2>
    <dl class="kv">
      <dt>Visitor ID</dt><dd><code><?= $this->e($v['public_id']) ?></code> <span class="muted small">random, pseudonymous</span></dd>
      <dt>Website</dt><dd><?= $this->e($v['website_name']) ?></dd>
      <dt>Name</dt><dd><?= $v['name'] !== null ? $this->e($v['name']) . ' <span class="pill pill-submitted">submitted</span>' : '<span class="muted">not provided</span>' ?></dd>
      <dt>Email</dt><dd><?= $v['email'] !== null ? $this->e($v['email']) . ' <span class="pill pill-submitted">submitted</span>' : '<span class="muted">not provided</span>' ?></dd>
      <dt>Phone</dt><dd><?= $v['phone'] !== null ? $this->e($v['phone']) . ' <span class="pill pill-submitted">submitted</span>' : '<span class="muted">not provided</span>' ?></dd>
    </dl>
    <p class="muted small">Submitted details are not verified. A profile does not reveal who the person really is.</p>
  </section>
  <section class="card">
    <h2>Activity</h2>
    <dl class="kv">
      <dt>First seen</dt><dd><?= $this->time($v['first_seen_at']) ?> <span class="pill pill-observed">observed</span></dd>
      <dt>Last seen</dt><dd><?= $this->time($v['last_seen_at']) ?> <span class="pill pill-observed">observed</span></dd>
      <dt>Visits</dt><dd><?= $tracking['analytics_enabled'] ? (int) $v['visit_count'] . ' <span class="pill pill-observed">observed</span>' : '<span class="muted">not tracked (essential chat only)</span>' ?></dd>
      <dt>Browser / OS</dt><dd><?= $v['browser'] ? $this->e($v['browser'] . ' / ' . $v['os']) . ' <span class="pill pill-observed">observed, coarse</span>' : '<span class="muted">not recorded</span>' ?></dd>
      <dt>Country</dt><dd><?= $v['country_code'] ? $this->e($v['country_code']) . ' <span class="pill pill-inferred">estimated from network address</span>' : '<span class="muted">unknown</span>' ?></dd>
      <dt>Consent</dt><dd><span class="pill"><?= $this->e($v['consent_state']) ?></span> <?= $analyticsPermitted ? '<span class="pill pill-ok">analytics permitted</span>' : '<span class="pill">no optional analytics</span>' ?></dd>
      <dt>Tracking mode</dt><dd><span class="pill pill-mode"><?= $tracking['analytics_enabled'] ? 'Analytics (policy-gated)' : 'Essential chat only' ?></span></dd>
    </dl>
  </section>
</div>

<section class="card">
  <div class="card-head"><h2>Blocking</h2>
    <?php if ($block): ?><span class="pill pill-blocked">Blocked</span><?php else: ?><span class="pill pill-ok">Not blocked</span><?php endif; ?></div>
  <?php if ($block): ?>
    <p>Blocked <?= $this->time($block['created_at']) ?> by <?= $this->e($block['blocked_by'] ?? '(deleted user)') ?>.
      <?php if ($block['reason']): ?>Reason: <em><?= $this->e($block['reason']) ?></em><?php endif; ?></p>
    <?php if ($canBlock): ?>
    <form method="post" action="<?= $base ?>/visitors/<?= (int) $v['id'] ?>/unblock"><input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>"><button class="btn">Unblock visitor</button></form>
    <?php endif; ?>
  <?php elseif ($canBlock): ?>
    <form method="post" action="<?= $base ?>/visitors/<?= (int) $v['id'] ?>/block" class="row-form" data-confirm="Block this visitor ID on <?= $this->e($v['website_name']) ?>?">
      <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
      <div class="field grow"><label for="b-reason">Reason (internal, optional)</label><input id="b-reason" name="reason" maxlength="500" type="text"></div>
      <button class="btn btn-danger">Block visitor</button>
    </form>
  <?php endif; ?>
  <p class="muted small">Blocking applies to this visitor ID on this website only and is enforced by the server. It is not IP-based. If the person clears browser storage or uses another browser, they receive a new visitor ID and the block will not apply.</p>
  <?php if ($blockHistory): ?>
    <h3 class="small muted">History</h3>
    <ul class="list small"><?php foreach ($blockHistory as $h): ?>
      <li><span><?= $this->e($h['status']) ?> · blocked <?= $this->time($h['created_at']) ?> by <?= $this->e($h['blocked_by'] ?? '—') ?><?= $h['revoked_at'] ? ' · unblocked ' . $this->time($h['revoked_at']) . ' by ' . $this->e($h['revoked_by'] ?? '—') : '' ?></span></li>
    <?php endforeach; ?></ul>
  <?php endif; ?>
</section>

<div class="two-col">
  <section class="card">
    <h2>Conversations</h2>
    <?php if (!$conversations): ?><p class="empty">No conversations.</p><?php else: ?>
    <ul class="list"><?php foreach ($conversations as $c): ?>
      <li><a href="<?= $base ?>/inbox?c=<?= (int) $c['id'] ?>">#<?= (int) $c['id'] ?> <span class="pill pill-<?= $this->e($c['status']) ?>"><?= $this->e($c['status']) ?></span><?= $c['read_only'] ? ' <span class="pill">read-only</span>' : '' ?>
        <span class="muted small">started <?= $this->time($c['created_at']) ?>, last message <?= $this->time($c['last_message_at']) ?></span></a></li>
    <?php endforeach; ?></ul>
    <?php endif; ?>
  </section>
  <section class="card">
    <h2>Browsing timeline <span class="pill pill-observed">observed</span></h2>
    <?php if (!$tracking['analytics_enabled']): ?>
      <p class="empty">Analytics are disabled for this website, so no browsing history is collected.</p>
    <?php elseif (!$timeline): ?>
      <p class="empty">No page views recorded. Pages are recorded only after the visitor permits analytics, and never on excluded paths.</p>
    <?php else: ?>
      <p class="muted small">Only pages on <?= $this->e($v['website_name']) ?> where the connector is installed and analytics were permitted. This is not a complete browsing history.</p>
      <ol class="timeline"><?php foreach ($timeline as $e): ?>
        <li><code><?= $this->e($e['page_path']) ?></code><?= $e['page_title'] ? ' — ' . $this->e($e['page_title']) : '' ?>
          <div class="muted small"><?= $this->time($e['occurred_at']) ?><?= $e['referrer_origin'] ? ' · from ' . $this->e($e['referrer_origin']) : '' ?></div></li>
      <?php endforeach; ?></ol>
    <?php endif; ?>
  </section>
</div>

<div class="two-col">
  <section class="card">
    <h2>Pre-chat submissions <span class="pill pill-submitted">submitted</span></h2>
    <?php if (!$contacts): ?><p class="empty">None.</p><?php else: ?>
    <ul class="list small"><?php foreach ($contacts as $s): ?>
      <li><span><?= $this->time($s['submitted_at']) ?> · <?= $this->e(implode(' · ', array_filter([$s['name'], $s['email'], $s['phone']]))) ?></span></li>
    <?php endforeach; ?></ul><?php endif; ?>
  </section>
  <section class="card">
    <h2>Consent records</h2>
    <?php if (!$consents): ?><p class="empty">No decisions recorded.</p><?php else: ?>
    <ul class="list small"><?php foreach ($consents as $c): ?>
      <li><span><?= $this->time($c['recorded_at']) ?> · <?= $this->e($c['category']) ?>: <strong><?= $this->e($c['decision']) ?></strong> · policy v<?= $this->e($c['policy_version']) ?> · via <?= $this->e($c['source']) ?></span></li>
    <?php endforeach; ?></ul><?php endif; ?>
  </section>
</div>

<?php if ($ctx->can('privacy.manage')): ?>
<section class="card">
  <h2>Delete this visitor's data</h2>
  <p>Deletes the profile, conversations, messages, analytics, contact submissions and blocks for this visitor ID. Consent records are kept (detached from the profile) until their retention period ends. Backups may retain data until they expire.</p>
  <form method="post" action="<?= $base ?>/visitors/<?= (int) $v['id'] ?>/delete" data-confirm="Permanently delete all data for this visitor?">
    <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>"><button class="btn btn-danger">Delete visitor data</button></form>
</section>
<?php endif; ?>
