<?php /** @var \Signalpost\Core\View $this */ ?>
<div class="inbox" id="inbox"
     data-ws="<?= (int) $ctx->workspaceId ?>"
     data-csrf="<?= $this->e($csrf) ?>"
     data-poll-ms="<?= (int) $pollMs ?>"
     data-max-backoff-ms="<?= (int) $maxBackoffMs ?>"
     data-max-chars="<?= (int) $maxChars ?>"
     data-can-reply="<?= $ctx->can('conversations.reply') ? '1' : '0' ?>"
     data-can-update="<?= $ctx->can('conversations.update') ? '1' : '0' ?>">
  <section class="inbox-list" aria-label="Conversations">
    <form class="inbox-filters" data-filters role="search">
      <label class="sr-only" for="ib-q">Search conversations</label>
      <input id="ib-q" type="search" name="q" placeholder="Search name, email, ID or message" maxlength="100" autocomplete="off">
      <div class="row">
        <label class="sr-only" for="ib-status">Status</label>
        <select id="ib-status" name="status">
          <option value="">All statuses</option><option value="open">Open</option><option value="pending">Pending</option><option value="closed">Closed</option>
        </select>
        <label class="sr-only" for="ib-site">Website</label>
        <select id="ib-site" name="website">
          <option value="">All websites</option>
          <?php foreach ($sites as $s): ?><option value="<?= (int) $s['id'] ?>"><?= $this->e($s['name']) ?></option><?php endforeach; ?>
        </select>
      </div>
      <label class="field check small"><input type="checkbox" name="unread" value="1"> Unread only</label>
    </form>
    <div class="state" data-list-state role="status" aria-live="polite">Loading conversations…</div>
    <ul class="conv-list" data-list></ul>
    <div class="state" hidden data-more-wrap><button type="button" class="btn btn-sm" data-more>Load older</button></div>
  </section>

  <section class="thread" aria-label="Conversation" data-thread>
    <div class="state" data-thread-empty>Select a conversation to read and reply.</div>
    <div class="thread-head" hidden data-thread-head>
      <button type="button" class="btn btn-ghost btn-sm" data-back aria-label="Back to conversation list">←</button>
      <h2 data-thread-title></h2>
      <span class="pill" data-thread-status></span>
      <label class="sr-only" for="ib-set-status">Change status</label>
      <select id="ib-set-status" data-set-status hidden>
        <option value="open">Open</option><option value="pending">Pending</option><option value="closed">Closed</option>
      </select>
      <button type="button" class="btn btn-ghost btn-sm" data-profile-toggle aria-expanded="false">Visitor</button>
    </div>
    <div class="messages" data-messages role="log" aria-live="polite" aria-relevant="additions" hidden></div>
    <form class="composer" data-composer hidden>
      <label class="sr-only" for="ib-reply">Reply</label>
      <textarea id="ib-reply" rows="2" placeholder="Write a reply… (Enter to send, Shift+Enter for a new line)"></textarea>
      <button class="btn btn-primary" type="submit">Send</button>
    </form>
    <div class="state" hidden data-readonly>This conversation is read-only.</div>
  </section>

  <aside class="profile-panel" aria-label="Visitor profile" data-profile>
    <p class="muted">Visitor details appear here.</p>
  </aside>
</div>
<script src="/assets/inbox.js" defer></script>
