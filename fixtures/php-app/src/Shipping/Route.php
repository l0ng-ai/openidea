<?php

declare(strict_types=1);

namespace App\Shipping;

use Deprecated;

enum Route: string
{
    case Air = 'air';
    case Ground = 'ground';

    #[Deprecated('sea freight is no longer offered', since: '2026-01')]
    case Sea = 'sea';

    public function minimumGrams(): int
    {
        return match ($this) {
            self::Air => 100,
            default => 1000,
        };
    }
}
