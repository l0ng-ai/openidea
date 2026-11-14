<?php

namespace App\Http\Controllers;

use App\Models\Post;
use Illuminate\Contracts\View\View;

class HomeController extends Controller
{
    /** A single-action (invokable) controller. */
    public function __invoke(): View
    {
        return view('welcome', ['latest' => Post::published()->first()]);
    }
}
