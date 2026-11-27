<?php

declare(strict_types=1);

namespace App\Shipping;

use Closure;
use Override;

final class ThresholdCustoms implements CustomsPolicy
{
    private const int DutyFreeCents = 100_00;

    private const int DutyFreeGrams = 20_000;

    private const int VatPercent = 20;

    private const Closure ValueCents = static function (Parcel $parcel): int {
        return $parcel->valueCents;
    };

    private const Closure WeightGrams = static function (Parcel $parcel): int {
        return $parcel->weightGrams;
    };

    #[Override]
    public string $name = 'threshold';

    #[Override]
    public function assess(array $parcels, int $freightCents): Charges
    {
        $valueCents = $parcels |> (fn (array $all): array => array_map(self::ValueCents, $all)) |> array_sum(...);
        $grams = $parcels |> (fn (array $all): array => array_map(self::WeightGrams, $all)) |> array_sum(...);
        $parcelCount = count($parcels);

        if (!$this->exceedsDutyFree($valueCents, $grams)) {
            return Charges::dutyFree();
        }

        // TODO: add the duty by goods code
        $vatCents = intdiv(($valueCents + $freightCents) * self::VatPercent, 100);

        return new Charges($vatCents, $this->clearanceFee($valueCents));
    }

    private function exceedsDutyFree(int $valueCents, int $grams): bool
    {
        if ($valueCents > self::DutyFreeCents) {
            return true;
        }

        return $grams > self::DutyFreeGrams;
    }

    private function clearanceFee(int $valueCents): int
    {
        // FIXME: read the tiers from configuration
        return match (true) {
            $valueCents <= 1_000_00 => 5_00,
            $valueCents <= 5_000_00 => 25_00,
            default => 75_00,
        };
    }
}
