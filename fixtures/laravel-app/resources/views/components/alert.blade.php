<div {{ $attributes->class(['alert', 'alert-'.$type]) }}>
    {{ $message ?? $slot }}
</div>
