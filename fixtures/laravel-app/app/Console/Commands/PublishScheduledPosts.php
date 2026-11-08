<?php

namespace App\Console\Commands;

use App\Enums\PostStatus;
use App\Models\Post;
use Illuminate\Console\Command;

class PublishScheduledPosts extends Command
{
    /**
     * The name and signature of the console command.
     *
     * @var string
     */
    protected $signature = 'posts:publish {--dry-run : List the posts without publishing them}';

    /**
     * The console command description.
     *
     * @var string
     */
    protected $description = 'Publish the scheduled posts whose time has come';

    public function handle(): int
    {
        $due = Post::where('status', PostStatus::Scheduled)->where('published_at', '<=', now())->get();
        foreach ($due as $post) {
            $this->line($post->title);
            if (! $this->option('dry-run')) {
                $post->update(['status' => PostStatus::Published]);
            }
        }

        return self::SUCCESS;
    }
}
