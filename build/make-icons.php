<?php

// Generates the dashboard app icons (PWA, favicon, Apple touch icon) with GD.
// Usage: php build/make-icons.php   → central/public/assets/icons/*.png

declare(strict_types=1);

$out = __DIR__ . '/../central/public/assets/icons';
@mkdir($out, 0755, true);

function draw(int $size, bool $maskable): GdImage
{
    $s = 4; // supersample for smooth edges
    $n = $size * $s;
    $im = imagecreatetruecolor($n, $n);
    imagesavealpha($im, true);
    imagealphablending($im, false);
    imagefill($im, 0, 0, imagecolorallocatealpha($im, 0, 0, 0, 127));
    imagealphablending($im, true);
    $bg = imagecolorallocate($im, 0x15, 0x52, 0x54);
    $white = imagecolorallocate($im, 0xff, 0xff, 0xff);
    $amber = imagecolorallocate($im, 0xf0, 0xa0, 0x3c);

    if ($maskable) {
        imagefilledrectangle($im, 0, 0, $n, $n, $bg); // full bleed; safe zone is the inner 80%
    } else {
        $r = (int) ($n * 0.22);
        imagefilledrectangle($im, $r, 0, $n - $r, $n, $bg);
        imagefilledrectangle($im, 0, $r, $n, $n - $r, $bg);
        foreach ([[$r, $r], [$n - $r, $r], [$r, $n - $r], [$n - $r, $n - $r]] as [$cx, $cy]) {
            imagefilledellipse($im, $cx, $cy, 2 * $r, 2 * $r, $bg);
        }
    }
    // Speech bubble, scaled into the maskable safe zone.
    $scale = $maskable ? 0.62 : 0.74;
    $w = $n * $scale;
    $h = $w * 0.72;
    $x0 = ($n - $w) / 2;
    $y0 = ($n - $h) / 2 - $n * 0.04;
    $rad = (int) ($h * 0.32);
    imagefilledrectangle($im, (int) ($x0 + $rad), (int) $y0, (int) ($x0 + $w - $rad), (int) ($y0 + $h), $white);
    imagefilledrectangle($im, (int) $x0, (int) ($y0 + $rad), (int) ($x0 + $w), (int) ($y0 + $h - $rad), $white);
    foreach ([[$x0 + $rad, $y0 + $rad], [$x0 + $w - $rad, $y0 + $rad], [$x0 + $rad, $y0 + $h - $rad], [$x0 + $w - $rad, $y0 + $h - $rad]] as [$cx, $cy]) {
        imagefilledellipse($im, (int) $cx, (int) $cy, 2 * $rad, 2 * $rad, $white);
    }
    // Tail.
    imagefilledpolygon($im, [
        (int) ($x0 + $w * 0.22), (int) ($y0 + $h - 2),
        (int) ($x0 + $w * 0.16), (int) ($y0 + $h + $h * 0.30),
        (int) ($x0 + $w * 0.46), (int) ($y0 + $h - 2),
    ], $white);
    // Three "typing" dots, the middle one in the accent colour.
    $dy = (int) ($y0 + $h / 2);
    $dr = (int) ($h * 0.15);
    foreach ([0.28, 0.5, 0.72] as $i => $fx) {
        imagefilledellipse($im, (int) ($x0 + $w * $fx), $dy, $dr * 2, $dr * 2, $i === 1 ? $amber : $bg);
    }
    $final = imagecreatetruecolor($size, $size);
    imagesavealpha($final, true);
    imagealphablending($final, false);
    imagefill($final, 0, 0, imagecolorallocatealpha($final, 0, 0, 0, 127));
    imagecopyresampled($final, $im, 0, 0, 0, 0, $size, $size, $n, $n);
    return $final;
}

foreach ([['icon-192.png', 192, false], ['icon-512.png', 512, false], ['maskable-512.png', 512, true],
          ['apple-touch-icon.png', 180, true], ['favicon-32.png', 32, false], ['badge-96.png', 96, false]] as [$file, $size, $mask]) {
    imagepng(draw($size, $mask), $out . '/' . $file, 9);
    echo "wrote {$file}\n";
}
