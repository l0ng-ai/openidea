<?php

declare(strict_types=1);

namespace App\Repository;

use App\Model\Book;
use App\Model\Genre;
use App\Support\Collection;
use App\Support\HasTimestamps;

/**
 * @extends AbstractRepository<Book>
 */
class BookRepository extends AbstractRepository
{
    use HasTimestamps;

    /**
     * @param Book $entity
     */
    protected function idOf(object $entity): string
    {
        return $entity->isbn;
    }

    public function save(object $entity): void
    {
        parent::save($entity);
        $this->touch();
    }

    /**
     * @return Collection<Book>
     */
    public function byGenre(Genre $genre): Collection
    {
        return $this->all()->filter(fn (Book $book): bool => $book->genre === $genre);
    }
}
