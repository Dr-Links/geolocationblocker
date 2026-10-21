<?php /** @var \Signalpost\Core\View $this */ $base = '/w/' . $ctx->workspaceId; ?>
<section class="card narrow">
  <h2>Workspace name</h2>
  <?= $this->partial('partials/errors', ['errors' => $errors]) ?>
  <form method="post" action="<?= $base ?>/settings" class="stack">
    <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
    <?= $this->partial('partials/field', ['name' => 'name', 'label' => 'Name', 'value' => $ctx->workspaceName, 'errors' => $errors, 'required' => true, 'max' => 100]) ?>
    <button class="btn btn-primary" type="submit">Save</button>
  </form>
  <p class="muted small">Export and deletion of workspace data are under <a href="<?= $base ?>/privacy">Privacy &amp; retention</a>.</p>
</section>
