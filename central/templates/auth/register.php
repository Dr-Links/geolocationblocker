<?php /** @var \Signalpost\Core\View $this */ ?>
<section class="card auth-card">
  <h1>Create your account</h1>
  <p class="muted">You will get your own private workspace. Nobody else can see its websites, visitors or conversations unless you invite them.</p>
  <?= $this->partial('partials/errors', ['errors' => $errors]) ?>
  <form method="post" action="/register" class="stack">
    <input type="hidden" name="_csrf" value="<?= $this->e($csrf) ?>">
    <?= $this->partial('partials/field', ['name' => 'display_name', 'label' => 'Your name', 'value' => $old['display_name'] ?? '', 'errors' => $errors, 'required' => true, 'max' => 100, 'autocomplete' => 'name']) ?>
    <?= $this->partial('partials/field', ['name' => 'email', 'label' => 'Email', 'type' => 'email', 'value' => $old['email'] ?? '', 'errors' => $errors, 'required' => true, 'autocomplete' => 'email']) ?>
    <?= $this->partial('partials/field', ['name' => 'workspace_name', 'label' => 'Workspace name', 'value' => $old['workspace_name'] ?? '', 'errors' => $errors, 'required' => true, 'max' => 100, 'hint' => 'For example your company or project name.']) ?>
    <?= $this->partial('partials/field', ['name' => 'password', 'label' => 'Password', 'type' => 'password', 'errors' => $errors, 'required' => true, 'autocomplete' => 'new-password', 'hint' => 'At least 10 characters.']) ?>
    <?= $this->partial('partials/field', ['name' => 'password_confirm', 'label' => 'Confirm password', 'type' => 'password', 'errors' => $errors, 'required' => true, 'autocomplete' => 'new-password']) ?>
    <button class="btn btn-primary btn-block" type="submit">Create account</button>
  </form>
  <p class="auth-links"><a href="/login">Already have an account? Sign in</a></p>
</section>
