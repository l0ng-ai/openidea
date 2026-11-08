@extends('layouts.app')

@section('content')
    <h1>{{ __('messages.welcome', ['name' => config('app.name')]) }}</h1>
    @isset($latest)
        @include('posts._card', ['post' => $latest])
    @endisset
@endsection
