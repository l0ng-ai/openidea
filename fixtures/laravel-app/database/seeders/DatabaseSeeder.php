<?php

namespace Database\Seeders;

use App\Enums\PostStatus;
use App\Models\User;
use Illuminate\Database\Seeder;

class DatabaseSeeder extends Seeder
{
    /**
     * Seed the application's database.
     */
    public function run(): void
    {
        $user = User::create([
            'name' => 'Test User',
            'email' => 'test@example.com',
            'password' => 'password',
        ]);

        $user->posts()->create([
            'title' => 'Hello, Laravel',
            'slug' => 'hello-laravel',
            'body' => "The first post.\n\nMore text.",
            'status' => PostStatus::Published,
            'published_at' => now(),
        ]);
    }
}
