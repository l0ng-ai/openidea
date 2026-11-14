<?php

namespace PHPSTORM_META {

    // `Container::make('books')` returns a BookRepository; a class-string argument returns that class.
    override(\App\Container::make(0), map([
        'books' => \App\Repository\BookRepository::class,
        'library' => \App\Library::class,
        '' => '@',
    ]));

    // `Collection::first()` on a collection built by `Container::make` keeps its element type.
    override(\App\Support\Collection::first(), type(0));

    expectedArguments(\App\Container::make(), 0, 'books', 'library');
}
