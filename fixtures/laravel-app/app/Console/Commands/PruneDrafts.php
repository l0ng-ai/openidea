<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Symfony\Component\Console\Attribute\AsCommand;

#[AsCommand(name: 'posts:prune-drafts', description: 'Delete the drafts nobody touched for a while')]
class PruneDrafts extends Command
{
    protected $signature = 'posts:prune-drafts {days=30 : Age of the drafts in days} {--force : Delete without asking}';

    public function handle(): int
    {
        $days = (int) $this->argument('days');
        $this->line("Pruning drafts older than {$days} days");
        $this->call('posts:publish', ['--dry-run' => true]);

        return self::SUCCESS;
    }
}
