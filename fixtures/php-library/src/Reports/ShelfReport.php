<?php

declare(strict_types=1);

namespace App\Reports;

use App\Library;

use function App\format_price;

final class ShelfReport
{
    public function __construct(private readonly Library $library)
    {
    }

    public function summary(): string
    {
        // FIXME: deliberate error for diagnostics — Library has no `count()` method
        return sprintf('%d books worth %s', $this->library->count(), $this->library->totalValue());
    }

    public function price(int $cents): string
    {
        return format_price($cents);
    }
}
