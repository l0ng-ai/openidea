<?php

declare(strict_types=1);

namespace App\Repository;

use App\Contracts\Repository;
use App\Support\Collection;

/**
 * Keeps entities in memory, keyed by {@see idOf()}.
 *
 * @template T of object
 * @implements Repository<T>
 */
abstract class AbstractRepository implements Repository
{
    /** @var array<string, T> */
    protected array $items = [];

    /**
     * @param T $entity
     */
    abstract protected function idOf(object $entity): string;

    public function find(string $id): ?object
    {
        return $this->items[$id] ?? null;
    }

    public function all(): Collection
    {
        return new Collection(array_values($this->items));
    }

    public function save(object $entity): void
    {
        $this->items[$this->idOf($entity)] = $entity;
    }
}
