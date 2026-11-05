<?php

declare(strict_types=1);

namespace Tests;

use App\Support\Collection;
use PHPUnit\Framework\TestCase;

final class CollectionTest extends TestCase
{
    public function testMapAndFilter(): void
    {
        $numbers = new Collection([1, 2, 3, 4]);

        $even = $numbers->filter(fn (int $n): bool => $n % 2 === 0)->map(fn (int $n): int => $n * 10);

        self::assertSame([20, 40], $even->toArray());
        self::assertCount(4, $numbers);
    }

    public function testFirstOfEmptyIsNull(): void
    {
        self::assertNull((new Collection())->first());
        self::assertSame('a', (new Collection())->push('a')->first());
    }
}
