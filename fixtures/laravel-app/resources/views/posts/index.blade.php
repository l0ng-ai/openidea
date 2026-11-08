@extends('layouts.app')

@section('title', 'Posts')

@section('content')
    @forelse ($posts as $post)
        @include('posts._card', ['post' => $post])
    @empty
        <p>{{ __('No posts yet.') }}</p>
    @endforelse
@endsection
