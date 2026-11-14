<?php

declare(strict_types=1);

namespace App\Model;

use InvalidArgumentException;

final class Book
{
    public const MAX_TITLE = 200;

    public function __construct(
        public readonly string $isbn,
        public readonly string $title,
        public readonly Genre $genre,
        public readonly int $priceCents,
        public readonly bool $available = true,
    ) {
        if ($title === '' || strlen($title) > self::MAX_TITLE) {
            throw new InvalidArgumentException("Invalid title for {$isbn}");
        }
    }

    public function withAvailability(bool $available): self
    {
        return new self($this->isbn, $this->title, $this->genre, $this->priceCents, $available);
    }

    public function label(): string
    {
        return sprintf('%s (%s)', $this->title, $this->genre->label());
    }
}
