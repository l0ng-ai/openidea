<!DOCTYPE html>
<html lang="{{ str_replace('_', '-', app()->getLocale()) }}">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>@yield('title', config('app.name'))</title>
    @vite(['resources/css/app.css', 'resources/js/app.js'])
    @stack('head')
</head>
<body>
    <nav>
        <a href="{{ route('home') }}">{{ __('messages.welcome', ['name' => config('app.name')]) }}</a>
        <a href="{{ route('posts.index') }}">Posts</a>
        <a href="{{ route('about') }}">About</a>
    </nav>

    @if (session('status'))
        <x-alert type="success" :message="session('status')" />
    @endif

    <main>
        @yield('content')
    </main>
</body>
</html>
