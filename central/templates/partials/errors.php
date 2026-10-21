<?php /** @var \Signalpost\Core\View $this */ if (!empty($errors['_form'])): ?>
<div class="notice notice-error" role="alert"><?= $this->e($errors['_form']) ?></div>
<?php endif; ?>
