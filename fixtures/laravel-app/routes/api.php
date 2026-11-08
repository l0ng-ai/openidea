<?php

use App\Http\Controllers\Api\PostController;
use Illuminate\Support\Facades\Route;

// Loaded by `withRouting(api: …)` with the `api` prefix and middleware group.
Route::get('/posts', [PostController::class, 'index'])->name('api.posts.index');
