@extends('layouts.app')

@section('title', $title)

@push('head')
    <meta name="author" content="{{ $post->author->name }}">
@endpush

@section('content')
    <h1>{{ $title }}</h1>
    <p>{{ $published?->toFormattedDateString() }} · {{ $post->status->label() }}</p>
    <div>{!! nl2br(e($post->body)) !!}</div>

    @can('edit-post', $post)
        <form method="POST" action="{{ route('dashboard.posts.destroy', $post) }}">
            @csrf
            @method('DELETE')
            <button type="submit">Delete</button>
        </form>
    @endcan

    @foreach ($post->comments as $comment)
        <x-alert :message="$comment->body" />
    @endforeach
@endsection
