<?php

declare(strict_types=1);

namespace App\Shipping;

final readonly class Charges
{
    public function __construct(
        public int $vatCents,
        public int $feeCents,
    ) {}

    public static function dutyFree(): self
    {
        return new self(0, 0);
    }

    public function isDutyFree(): bool
    {
        return $this->vatCents === 0 && $this->feeCents === 0;
    }
}
