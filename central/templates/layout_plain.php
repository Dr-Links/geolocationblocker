<?php /** @var \Signalpost\Core\View $this */ ?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title><?= $this->e($title ?? 'Signalpost') ?> · Signalpost</title>
<link rel="stylesheet" href="/assets/app.css">
</head>
<body class="plain">
<main class="plain-main" id="main">
  <a class="brand brand-lg" href="/"><span class="brand-mark" aria-hidden="true"></span>Signalpost</a>
  <?= $this->content() ?>
</main>
<script src="/assets/app.js" defer></script>
</body>
</html>
