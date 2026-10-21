<?php
/** @var \Signalpost\Core\View $this */
$id = 'f-' . $name;
$err = $errors[$name] ?? null;
$type = $type ?? 'text';
?>
<div class="field<?= $err ? ' has-error' : '' ?>">
  <label for="<?= $this->e($id) ?>"><?= $this->e($label) ?><?php if (!empty($optional)): ?> <span class="muted">(optional)</span><?php endif; ?></label>
  <?php if ($type === 'textarea'): ?>
    <textarea id="<?= $this->e($id) ?>" name="<?= $this->e($name) ?>" rows="<?= (int) ($rows ?? 3) ?>"<?= $err ? ' aria-invalid="true" aria-describedby="' . $this->e($id) . '-err"' : '' ?> maxlength="<?= (int) ($max ?? 1000) ?>"><?= $this->e($value ?? '') ?></textarea>
  <?php else: ?>
    <input id="<?= $this->e($id) ?>" type="<?= $this->e($type) ?>" name="<?= $this->e($name) ?>" value="<?= $type === 'password' ? '' : $this->e($value ?? '') ?>"
      <?= !empty($required) ? 'required' : '' ?> <?= isset($autocomplete) ? 'autocomplete="' . $this->e($autocomplete) . '"' : '' ?>
      <?= isset($max) ? 'maxlength="' . (int) $max . '"' : '' ?>
      <?= $err ? 'aria-invalid="true" aria-describedby="' . $this->e($id) . '-err"' : '' ?>>
  <?php endif; ?>
  <?php if (!empty($hint)): ?><p class="hint"><?= $this->e($hint) ?></p><?php endif; ?>
  <?php if ($err): ?><p class="field-error" id="<?= $this->e($id) ?>-err"><?= $this->e($err) ?></p><?php endif; ?>
</div>
