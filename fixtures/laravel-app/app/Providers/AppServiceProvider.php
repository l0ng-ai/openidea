<?php

namespace App\Providers;

use App\Models\Post;
use App\Models\User;
use App\Services\FeedBuilder;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        $this->app->singleton('blog.feed', FeedBuilder::class);
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        Gate::define('publish-posts', fn (User $user) => $user->is_admin);
        Gate::define('edit-post', fn (User $user, Post $post) => $user->id === $post->author_id);
    }
}
