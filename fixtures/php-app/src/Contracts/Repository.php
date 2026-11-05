<?php

declare(strict_types=1);

namespace App\Contracts;

use App\Support\Collection;

/**
 * @template T of object
 */
interface Repository
{
    /**
     * @return T|null
     */
    public function find(string $id): ?object;

    /**
     * @return Collection<T>
     */
    public function all(): Collection;

    /**
     * @param T $entity
     */
    public function save(object $entity): void;
}
