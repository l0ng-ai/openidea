<?php

declare(strict_types=1);

use App\Shipping\Dimensions;
use App\Shipping\ParcelStatus;
use App\Shipping\Route;
use App\Shipping\Shipment;
use Tests\TestSupport\ParcelFactory;

it('finds the heaviest parcel by billable weight', function (): void {
    $bulky = ParcelFactory::make(weightGrams: 900, dimensions: new Dimensions(40, 30, 20));
    $dense = ParcelFactory::make(weightGrams: 3000, dimensions: new Dimensions(10, 10, 10));

    $shipment = new Shipment('FL-0412', Route::Air)->add($dense)->add($bulky);

    expect($shipment->heaviest())->toBe($bulky);
});

it('departs once every parcel has confirmed contents', function (): void {
    $confirmed = ParcelFactory::make()
        ->moveTo(ParcelStatus::Received)
        ->moveTo(ParcelStatus::AwaitingContents)
        ->moveTo(ParcelStatus::ContentsConfirmed);

    $shipment = new Shipment('FL-0412', Route::Air)->add($confirmed);

    expect($shipment->isReadyForDeparture())->toBeTrue()
        ->and($shipment->add(ParcelFactory::make())->isReadyForDeparture())->toBeFalse();
});

it('keeps its parcel list read-only from outside', function (): void {
    $shipment = new Shipment('FL-0412', Route::Air);

    expect(fn () => $shipment->parcels = [])->toThrow(Error::class);
});
