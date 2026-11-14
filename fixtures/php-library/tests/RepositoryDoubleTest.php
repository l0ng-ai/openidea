<?php

declare(strict_types=1);

namespace Tests;

use App\Contracts\Repository;
use App\Model\Book;
use App\Model\Genre;
use PHPUnit\Framework\TestCase;

final class RepositoryDoubleTest extends TestCase
{
    // No type on purpose: the IDE types it from setUp().
    private $books;

    protected function setUp(): void
    {
        $this->books = $this->createMock(Repository::class);
    }

    public function testFindReturnsTheStubbedBook(): void
    {
        $book = new Book('9', 'Emma', Genre::Fiction, 750);
        $this->books->method('find')->willReturn($book);

        self::assertSame($book, $this->books->find('9'));
    }
}
