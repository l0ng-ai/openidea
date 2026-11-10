<?php

declare(strict_types=1);

namespace App\Shipping;

final class Dimensions
{
    public int $volumetricGrams {
        get => intdiv($this->lengthCm * $this->widthCm * $this->heightCm, 5);
    }

    public function __construct(
        public readonly int $lengthCm,
        public readonly int $widthCm,
        public readonly int $heightCm,
    ) {}
}
