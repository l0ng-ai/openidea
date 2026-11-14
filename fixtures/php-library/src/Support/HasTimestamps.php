<?php

declare(strict_types=1);

namespace App\Support;

use DateTimeImmutable;

trait HasTimestamps
{
    private ?DateTimeImmutable $touchedAt = null;

    public function touch(): void
    {
        $this->touchedAt = new DateTimeImmutable();
    }

    public function touchedAt(): ?DateTimeImmutable
    {
        return $this->touchedAt;
    }
}
