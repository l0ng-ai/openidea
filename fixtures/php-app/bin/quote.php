<?php

declare(strict_types=1);

use App\Shipping\Dimensions;
use App\Shipping\Parcel;
use App\Shipping\Route;
use App\Shipping\Shipment;
use App\Shipping\Tariff;
use App\Shipping\ThresholdCustoms;
use Uri\Rfc3986\Uri;

require __DIR__.'/../vendor/autoload.php';

function money(int $cents): string
{
    return $cents / 100
        |> (fn (float $dollars): string => number_format($dollars, 2))
        |> (fn (string $amount): string => '$'.$amount);
}

$tariff = new Tariff(['air' => 1000, 'ground' => 500]);
$customs = new ThresholdCustoms;
$tracker = new Uri('https://track.example.com');
$shipment = new Shipment('FL-0412', Route::Air)
    ->add(new Parcel('PCL-0001', 'Northwind Books', 1200, new Dimensions(30, 20, 10), 4500))
    ->add(new Parcel('PCL-0002', 'Bluebird Electronics', 2400, new Dimensions(40, 30, 20), 6000))
    ->add(new Parcel('PCL-0003', 'Bluebird Electronics', 800, new Dimensions(20, 15, 10), 5500));

foreach ($shipment->byStore() as $store => $parcels) {
    $freightCents = 0;
    foreach ($parcels as $parcel) {
        $cents = $tariff->freightCents($parcel, $shipment->route);
        $freightCents += $cents;
        printf("%s  %.2f kg billable  freight %s\n", $parcel->code, $parcel->billableGrams($shipment->route) / 1000, money($cents));
    }

    $charges = $customs->assess($parcels, $freightCents);
    $summary = $charges->isDutyFree() ? 'duty-free' : sprintf('VAT %s, clearance fee %s', money($charges->vatCents), money($charges->feeCents));
    echo "$store: $summary\n";
}

$heaviest = $shipment->heaviest(); // Set a breakpoint here
if ($heaviest !== null) {
    echo "Heaviest: $heaviest->code, tracking {$heaviest->trackingUrl($tracker)->toString()}\n";
}
