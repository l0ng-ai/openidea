<?php

declare(strict_types=1);

use App\Shipping\Charges;
use App\Shipping\CustomsPolicy;
use App\Shipping\Parcel;
use App\Shipping\Tariff;
use App\Shipping\ThresholdCustoms;

arch('value objects are final and readonly')
    ->expect([Charges::class, Parcel::class, Tariff::class])
    ->toBeFinal()
    ->toBeReadonly();

arch('customs policies implement the contract')
    ->expect(ThresholdCustoms::class)
    ->toImplement(CustomsPolicy::class);

arch('application code does not contain debug helpers')
    ->expect('App')
    ->not->toUse(['dd', 'dump', 'var_dump']);
