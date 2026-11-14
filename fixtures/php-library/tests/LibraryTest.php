<?php

declare(strict_types=1);

namespace Tests;

use App\Container;
use App\Library;
use App\Model\Book;
use App\Model\Genre;
use App\Repository\BookRepository;
use DomainException;
use PHPUnit\Framework\TestCase;

use function App\format_price;
use function App\slugify;

final class LibraryTest extends TestCase
{
    private Library $library;

    protected function setUp(): void
    {
        $this->library = Container::boot()->make('library');
        $this->library->add(new Book('1', 'Dune', Genre::Fiction, 1299));
        $this->library->add(new Book('2', 'Cosmos', Genre::Science, 1001));
    }

    public function testCheckoutMarksTheBookUnavailable(): void
    {
        $lent = $this->library->checkout('1');

        self::assertFalse($lent->available);
        self::assertCount(1, $this->library->available());
        $this->expectException(DomainException::class);
        $this->library->checkout('1');
    }

    public function testTotalValue(): void
    {
        self::assertSame('23.00 EUR', $this->library->totalValue());
    }

    public function testRepositoryFiltersByGenre(): void
    {
        $books = new BookRepository();
        $books->save(new Book('3', 'SPQR', Genre::History, 900));

        self::assertSame('SPQR', $books->byGenre(Genre::History)->first()?->title);
        self::assertCount(0, $books->byGenre(Genre::Fiction));
        self::assertNotNull($books->touchedAt());
    }

    public function testHelpers(): void
    {
        self::assertSame('0.05 EUR', format_price(5));
        self::assertSame('a-brief-history', slugify('A Brief History!'));
    }

    public function testIntentionallyFailing(): void
    {
        if (getenv('OPENIDEA_FAIL') === false) {
            self::markTestSkipped('set OPENIDEA_FAIL=1 to run');
        }
        // FIXME: wrong on purpose (QA: failing test in the test tree)
        self::assertSame('0.00 EUR', $this->library->totalValue());
    }
}
