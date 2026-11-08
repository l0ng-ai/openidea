<article>
    <h2><a href="{{ route('posts.show', $post) }}">{{ $post->title }}</a></h2>
    <x-badge :status="$post->status" />
    <p>{{ $post->excerpt }}</p>
    <a href="{{ route('posts.show', $post) }}">{{ __('Read more') }}</a>
</article>
