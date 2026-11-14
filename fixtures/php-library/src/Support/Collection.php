<?php

declare(strict_types=1);

namespace App\Support;

use ArrayIterator;
use Countable;
use IteratorAggregate;

/**
 * An immutable list.
 *
 * @template T
 * @implements IteratorAggregate<int, T>
 */
final class Collection implements IteratorAggregate, Countable
{
    /**
     * @param list<T> $items
     */
    public function __construct(private readonly array $items = [])
    {
    }

    /**
     * @template U
     * @param callable(T): U $fn
     * @return Collection<U>
     */
    public function map(callable $fn): self
    {
        return new self(array_map($fn, $this->items));
    }

    /**
     * @param callable(T): bool $fn
     * @return Collection<T>
     */
    public function filter(callable $fn): self
    {
        return new self(array_values(array_filter($this->items, $fn)));
    }

    /**
     * @param T $item
     * @return Collection<T>
     */
    public function push(mixed $item): self
    {
        return new self([...$this->items, $item]);
    }

    /**
     * @return T|null
     */
    public function first(): mixed
    {
        return $this->items[0] ?? null;
    }

    /**
     * @return list<T>
     */
    public function toArray(): array
    {
        return $this->items;
    }

    public function count(): int
    {
        return count($this->items);
    }

    /**
     * @return ArrayIterator<int, T>
     */
    public function getIterator(): ArrayIterator
    {
        return new ArrayIterator($this->items);
    }
}
