<?php /** @var \Signalpost\Core\View $this */ ?>
<section class="card" id="live" data-ws="<?= (int) $ctx->workspaceId ?>" data-poll-ms="<?= (int) $pollMs ?>">
  <div class="card-head">
    <div class="legend">
      <span><span class="live-dot" aria-hidden="true"></span> Active now — activity in the last <?= (int) ($activeSeconds / 60) ?> min</span>
      <span><span class="recent-dot" aria-hidden="true"></span> Recently seen — last <?= (int) $recentMinutes ?> min</span>
    </div>
    <span class="muted small" data-updated role="status" aria-live="polite"></span>
  </div>
  <p class="muted small">“Active” means the visitor's browser contacted Signalpost recently; it does not prove they are still on the page.
    Page information appears only for visitors whose analytics are permitted, and only for pages on your connected websites.
    Visitors who never opened the chat and have not permitted analytics are not tracked and do not appear.</p>
  <div class="table-wrap"><table class="table">
    <thead><tr><th>Status</th><th>Visitor</th><th>Website</th><th>Last observed page</th><th>Last activity</th><th>Country (estimated)</th><th></th></tr></thead>
    <tbody data-rows><tr><td colspan="7" class="state">Loading…</td></tr></tbody>
  </table></div>
</section>
<script src="/assets/live.js" defer></script>
