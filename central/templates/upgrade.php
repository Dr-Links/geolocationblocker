<?php /** @var \Signalpost\Core\View $this */ ?>
<section class="card auth-card wide">
  <h1>Finish updating <?= $this->e($this->appName()) ?></h1>
  <p>New files were uploaded. The database needs <?= count($pending) ?> update step<?= count($pending) > 1 ? 's' : '' ?> before the site can be used: <code><?= $this->e(implode(', ', $pending)) ?></code>.</p>
  <div class="notice notice-info">
    <strong>Back up the database first</strong> (hPanel → Databases → phpMyAdmin → Export).
    Then open <code>signalpost/storage/upgrade-token.txt</code> with the File Manager and paste its contents below. The file is deleted afterwards.
  </div>
  <form method="post" action="/upgrade" class="stack">
    <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
    <?= $this->partial('partials/field', ['name' => 'upgrade_token', 'label' => 'Update token', 'errors' => $errors, 'required' => true, 'autocomplete' => 'off']) ?>
    <button class="btn btn-primary btn-block" type="submit">Apply update</button>
  </form>
</section>
