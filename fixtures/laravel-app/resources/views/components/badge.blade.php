@props(['status'])

<span @class(['badge', 'badge-published' => $status === \App\Enums\PostStatus::Published])>
    {{ $status->label() }}
</span>
