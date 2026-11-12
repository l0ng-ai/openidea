<?php

declare(strict_types=1);

namespace App\Shipping;

enum ParcelStatus: string
{
    case Expected = 'expected';
    case Received = 'received';
    case AwaitingContents = 'awaiting_contents';
    case ContentsConfirmed = 'contents_confirmed';
    case InTransit = 'in_transit';
    case Arrived = 'arrived';
    case Held = 'held';
    case Ready = 'ready';
    case Delivered = 'delivered';

    public function canMoveTo(self $next): bool
    {
        return match ($this) {
            self::Expected => $next === self::Received,
            self::Received => $next === self::AwaitingContents,
            self::AwaitingContents => $next === self::ContentsConfirmed,
            self::ContentsConfirmed => $next === self::InTransit,
            self::InTransit => $next === self::Arrived,
            self::Arrived => in_array($next, [self::Ready, self::Held], true),
            self::Held => $next === self::Ready,
            self::Ready => $next === self::Delivered,
            self::Delivered => false,
        };
    }
}
