<?php

namespace App\Services;

use App\Models\Post;

class FeedBuilder
{
    /** @return list<string> */
    public function titles(): array
    {
        if (! config('blog.feed.enabled')) {
            return [];
        }

        return Post::published()->pluck('title')->all();
    }
}
