<?php

declare(strict_types=1);

namespace Tests\TestSupport;

use App\Shipping\Dimensions;
use App\Shipping\Parcel;

final class ParcelFactory
{
    public static function make(int $weightGrams = 1000, ?Dimensions $dimensions = null, int $valueCents = 5000): Parcel
    {
        return new Parcel('PCL-0009', 'Bluebird Electronics', $weightGrams, $dimensions ?? new Dimensions(20, 20, 10), $valueCents);
    }
}
