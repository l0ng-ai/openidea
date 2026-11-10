<?php

declare(strict_types=1);

namespace App\Shipping;

use NoDiscard;
use Uri\Rfc3986\Uri;

final readonly class Parcel
{
    public function __construct(
        public string $code,
        public string $store,
        public int $weightGrams,
        public Dimensions $dimensions,
        public int $valueCents,
        public ParcelStatus $status = ParcelStatus::Expected,
    ) {}

    public function billableGrams(Route $route): int
    {
        return max($this->weightGrams, $this->dimensions->volumetricGrams, $route->minimumGrams());
    }

    #[NoDiscard('a parcel is immutable, use the returned one')]
    public function moveTo(ParcelStatus $next): self
    {
        if (!$this->status->canMoveTo($next)) {
            throw InvalidStatusTransition::between($this, $next);
        }

        return clone ($this, ['status' => $next]);
    }

    public function trackingUrl(Uri $tracker): Uri
    {
        return $tracker->withPath("/parcels/$this->code");
    }
}
