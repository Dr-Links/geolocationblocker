<?php /** @var \Signalpost\Core\View $this */ ?>
<section class="card narrow">
  <h2><?= $first ? 'Create your first workspace' : 'Create a workspace' ?></h2>
  <p class="muted">A workspace keeps its websites, visitors, conversations and members completely separate from every other workspace.</p>
  <?= $this->partial('partials/errors', ['errors' => $errors]) ?>
  <form method="post" action="/workspaces" class="stack">
    <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
    <?= $this->partial('partials/field', ['name' => 'name', 'label' => 'Workspace name', 'errors' => $errors, 'required' => true, 'max' => 100]) ?>
    <button class="btn btn-primary" type="submit">Create workspace</button>
  </form>
</section>
