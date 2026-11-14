<?php

declare(strict_types=1);

namespace App;

use App\Repository\BookRepository;
use Closure;
use InvalidArgumentException;

/**
 * A tiny service container. `.phpstorm.meta.php` tells the IDE what `make()` returns.
 */
final class Container
{
    /** @var array<string, Closure(self): object> */
    private array $factories = [];

    /** @var array<string, object> */
    private array $instances = [];

    public static function boot(): self
    {
        $container = new self();
        $container->set('books', fn (): BookRepository => new BookRepository());
        $container->set('library', fn (self $c): Library => new Library($c->make('books')));

        return $container;
    }

    /**
     * @param Closure(self): object $factory
     */
    public function set(string $id, Closure $factory): void
    {
        $this->factories[$id] = $factory;
        unset($this->instances[$id]);
    }

    public function make(string $id): object
    {
        if (!isset($this->instances[$id])) {
            $factory = $this->factories[$id]
                ?? (class_exists($id) ? fn (): object => new $id() : throw new InvalidArgumentException("Unknown service {$id}"));
            $this->instances[$id] = $factory($this);
        }

        return $this->instances[$id];
    }
}
