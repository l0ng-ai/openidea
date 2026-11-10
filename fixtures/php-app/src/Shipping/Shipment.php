<?php

declare(strict_types=1);

namespace App\Shipping;

use ArrayIterator;
use Countable;
use IteratorAggregate;

/** @implements IteratorAggregate<int, Parcel> */
final class Shipment implements Countable, IteratorAggregate
{
    /** @var list<Parcel> */
    public private(set) array $parcels = [];

    public function __construct(
        public readonly string $flight,
        public readonly Route $route,
    ) {}

    public function add(Parcel $parcel): self
    {
        $this->parcels[] = $parcel;

        return $this;
    }

    public function heaviest(): ?Parcel
    {
        return $this->parcels
            |> (fn (array $parcels): array => $this->sortedByBillableWeight($parcels))
            |> array_last(...);
    }

    public function isReadyForDeparture(): bool
    {
        return array_all($this->parcels, fn (Parcel $parcel): bool => $parcel->status === ParcelStatus::ContentsConfirmed);
    }

    /** @return array<string, list<Parcel>> */
    public function byStore(): array
    {
        $groups = [];
        foreach ($this->parcels as $parcel) {
            $groups[$parcel->store][] = $parcel;
        }

        return $groups;
    }

    /** @return ArrayIterator<int, Parcel> */
    public function getIterator(): ArrayIterator
    {
        return new ArrayIterator($this->parcels);
    }

    public function count(): int
    {
        return count($this->parcels);
    }

    /**
     * @param  list<Parcel>  $parcels
     * @return list<Parcel>
     */
    private function sortedByBillableWeight(array $parcels): array
    {
        usort($parcels, fn (Parcel $a, Parcel $b): int => $a->billableGrams($this->route) <=> $b->billableGrams($this->route));

        return $parcels;
    }
}
