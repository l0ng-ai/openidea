<?php

use App\Http\Controllers\PostController;
use Illuminate\Support\Facades\Route;

// Loaded by the `then:` callback of `withRouting` with the `admin` prefix, the
// `admin.` name prefix and the `web` and `auth` middleware.
Route::get('/posts', [PostController::class, 'index'])->name('posts.index');
