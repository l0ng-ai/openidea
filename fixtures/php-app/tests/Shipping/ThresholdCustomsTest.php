<?php

declare(strict_types=1);

use App\Shipping\ThresholdCustoms;
use Tests\TestSupport\ParcelFactory;

it('clears a small purchase duty-free', function (): void {
    $charges = new ThresholdCustoms()->assess([ParcelFactory::make(valueCents: 4500)], 1200);

    expect($charges->isDutyFree())->toBeTrue();
});

it('sums the parcels of one store', function (): void {
    $charges = new ThresholdCustoms()->assess([ParcelFactory::make(valueCents: 6000), ParcelFactory::make(valueCents: 5500)], 2000);

    expect($charges->vatCents)->toBe(2700)
        ->and($charges->feeCents)->toBe(500);
});

it('intentionally fails (set OPENIDEA_FAIL=1)', function (): void {
    expect(1)->toBe(2);
})->skip(getenv('OPENIDEA_FAIL') !== '1', 'intentionally fails (set OPENIDEA_FAIL=1)');
