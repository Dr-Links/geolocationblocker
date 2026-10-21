<?php /** @var \Signalpost\Core\View $this */ ?>
<section class="card narrow">
  <h1><?= $this->e($status) ?> — <?= $status === 404 ? 'Not found' : ($status === 403 ? 'Not allowed' : 'Something went wrong') ?></h1>
  <p><?= $this->e($message) ?></p>
  <p><a href="/">Return to the dashboard</a></p>
</section>
