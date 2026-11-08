@extends('layouts.app')

@section('title', 'New post')

@section('content')
    <form method="POST" action="{{ route('dashboard.posts.store') }}">
        @csrf
        <input name="title" value="{{ old('title') }}">
        @error('title')
            <x-alert type="error" :message="$message" />
        @enderror
        <input name="slug" value="{{ old('slug') }}">
        <textarea name="body">{{ old('body') }}</textarea>
        <button type="submit">Save</button>
    </form>
@endsection
