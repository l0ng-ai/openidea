<?php

declare(strict_types=1);

namespace App;

use App\Model\Book;
use App\Repository\BookRepository;
use App\Support\Collection;
use DomainException;

final class Library
{
    public function __construct(private readonly BookRepository $books)
    {
    }

    public function add(Book $book): void
    {
        $this->books->save($book);
    }

    public function find(string $isbn): ?Book
    {
        return $this->books->find($isbn);
    }

    /**
     * @throws DomainException when the book is unknown or already lent out
     */
    public function checkout(string $isbn): Book
    {
        $book = $this->find($isbn);
        if ($book === null || !$book->available) {
            throw new DomainException("Cannot check out {$isbn}");
        }
        $lent = $book->withAvailability(false);
        $this->books->save($lent);

        return $lent;
    }

    /**
     * @return Collection<Book>
     */
    public function available(): Collection
    {
        return $this->books->all()->filter(fn (Book $book): bool => $book->available);
    }

    public function totalValue(): string
    {
        // TODO: support more than one currency
        $cents = array_sum($this->books->all()->map(fn (Book $book): int => $book->priceCents)->toArray());

        return format_price($cents);
    }
}
