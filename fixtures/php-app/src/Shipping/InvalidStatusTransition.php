<?php

declare(strict_types=1);

namespace App\Shipping;

use DomainException;

final class InvalidStatusTransition extends DomainException
{
    public static function between(Parcel $parcel, ParcelStatus $next): self
    {
        return new self(sprintf("%s can't move from %s to %s", $parcel->code, $parcel->status->value, $next->value));
    }
}
