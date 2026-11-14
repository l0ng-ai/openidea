<?php

declare(strict_types=1);

require __DIR__ . '/../vendor/autoload.php';

use App\Container;
use App\Model\Book;
use App\Model\Genre;

use function App\slugify;

$container = Container::boot();
$library = $container->make('library');

$library->add(new Book('978-0441013593', 'Dune', Genre::Fiction, 1299));
$library->add(new Book('978-0553380163', 'A Brief History of Time', Genre::Science, 1850));
$library->add(new Book('978-0140449136', 'The Histories', Genre::History, 1100));

$lent = $library->checkout('978-0441013593'); // Set a breakpoint here

printf("Lent %s (%s)\n", $lent->label(), slugify($lent->title));
printf("%d of 3 available, shelf worth %s (v%s)\n", count($library->available()), $library->totalValue(), APP_VERSION);
