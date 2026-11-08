<?php

namespace App\Http\Controllers;

use App\Http\Requests\StorePostRequest;
use App\Models\Post;
use Illuminate\Contracts\View\View;
use Illuminate\Http\RedirectResponse;
use Illuminate\Support\Facades\Gate;

class PostController extends Controller
{
    public function index(): View
    {
        $posts = Post::published()->latest('published_at')->paginate(config('blog.posts_per_page'));

        return view('posts.index', ['posts' => $posts]);
    }

    public function show(Post $post): View
    {
        $title = $post->title;
        $published = $post->published_at;

        return view('posts.show', compact('post', 'title', 'published'));
    }

    public function create(): View
    {
        return view('posts.create');
    }

    public function store(StorePostRequest $request): RedirectResponse
    {
        $post = $request->user()->posts()->create($request->validated());

        return redirect()->route('posts.show', $post)->with('status', __('messages.post_created'));
    }

    public function destroy(Post $post): RedirectResponse
    {
        Gate::authorize('delete', $post);
        $post->delete();

        // Deliberate: the method doesn't exist (the fixture's one intentional problem).
        $this->forgetCachedFeed();

        return to_route('posts.index');
    }
}
