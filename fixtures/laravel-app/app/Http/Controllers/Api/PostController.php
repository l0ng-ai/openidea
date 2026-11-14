<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Post;

class PostController extends Controller
{
    /** @return array<int, array<string, mixed>> */
    public function index(): array
    {
        return Post::published()->get()->map(fn (Post $post) => [
            'title' => $post->title,
            'url' => route('posts.show', $post),
        ])->all();
    }
}
