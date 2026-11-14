<?php

declare(strict_types=1);

namespace App\Model;

enum Genre: string
{
    case Fiction = 'fiction';
    case Science = 'science';
    case History = 'history';

    public function label(): string
    {
        return match ($this) {
            self::Fiction => 'Fiction',
            self::Science => 'Science',
            self::History => 'History',
        };
    }
}
