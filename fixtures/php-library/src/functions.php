<?php

declare(strict_types=1);

namespace App;

/**
 * Formats an amount in cents, e.g. `format_price(1299)` is "12.99 EUR".
 */
function format_price(int $cents, string $currency = DEFAULT_CURRENCY): string
{
    return sprintf('%d.%02d %s', intdiv($cents, 100), $cents % 100, $currency);
}

/**
 * Lower-case words joined by dashes: "The Left Hand" becomes "the-left-hand".
 */
function slugify(string $text): string
{
    // TODO: transliterate accented letters instead of dropping them
    $slug = preg_replace('/[^a-z0-9]+/', '-', strtolower($text)) ?? '';

    return trim($slug, '-');
}
