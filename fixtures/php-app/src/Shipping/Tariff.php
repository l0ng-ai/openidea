<?php

declare(strict_types=1);

namespace App\Shipping;

final readonly class Tariff
{
    /** @param array<string, int> $centsPerKg */
    public function __construct(private array $centsPerKg) {}

    public function freightCents(Parcel $parcel, Route $route): int
    {
        $grams = $parcel->billableGrams($route);

        return intdiv($grams * $this->centsPerKg[$route->value] + 999, 1000);
    }
}
