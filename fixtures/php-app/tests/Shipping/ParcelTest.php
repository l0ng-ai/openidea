<?php

declare(strict_types=1);

use App\Shipping\Dimensions;
use App\Shipping\InvalidStatusTransition;
use App\Shipping\ParcelStatus;
use App\Shipping\Route;
use Tests\TestSupport\ParcelFactory;
use Uri\Rfc3986\Uri;

it('bills the volumetric weight of a light bulky parcel', function (): void {
    $parcel = ParcelFactory::make(weightGrams: 2400, dimensions: new Dimensions(40, 30, 20));

    expect($parcel->billableGrams(Route::Air))->toBe(4800);
});

it('bills the route minimum for a small parcel', function (): void {
    $parcel = ParcelFactory::make(weightGrams: 300, dimensions: new Dimensions(10, 10, 2));

    expect($parcel->billableGrams(Route::Ground))->toBe(1000);
});

it('moves to the next status in a copy', function (): void {
    $expected = ParcelFactory::make();

    $received = $expected->moveTo(ParcelStatus::Received);

    expect($received->status)->toBe(ParcelStatus::Received)
        ->and($expected->status)->toBe(ParcelStatus::Expected)
        ->and($received->code)->toBe($expected->code);
});

it('rejects a skipped status', function (): void {
    (void) ParcelFactory::make()->moveTo(ParcelStatus::Received)->moveTo(ParcelStatus::InTransit);
})->throws(InvalidStatusTransition::class);

it('links to its tracking page', function (): void {
    $url = ParcelFactory::make()->trackingUrl(new Uri('https://track.example.com'));

    expect($url->toString())->toBe('https://track.example.com/parcels/PCL-0009');
});
