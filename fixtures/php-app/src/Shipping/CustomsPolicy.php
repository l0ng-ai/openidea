<?php

declare(strict_types=1);

namespace App\Shipping;

interface CustomsPolicy
{
    public string $name { get; }

    /** @param list<Parcel> $parcels */
    public function assess(array $parcels, int $freightCents): Charges;
}
