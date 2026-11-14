<?php

// Minimal stand-ins for inertiajs/inertia-laravel's classes (names and
// signatures as the adapter declares them, bodies empty). Only installed by the
// tests that list the package in their `vendor/composer/installed.json`.

namespace Inertia {
    class Response
    {
        public function with($key, $value = null) { return $this; }
    }

    class ResponseFactory
    {
        public function render($component, $props = []): Response { return new Response(); }

        public function share($key, $value = null) {}
    }

    class Inertia extends \Illuminate\Support\Facades\Facade
    {
        protected static function getFacadeAccessor() { return ResponseFactory::class; }

        public static function render($component, $props = []): Response { return new Response(); }

        public static function share($key, $value = null) {}
    }
}

namespace Inertia\Testing {
    class AssertableInertia
    {
        public function component($value = null, $shouldExist = null): self { return $this; }

        public function has($key, $length = null, $callback = null): self { return $this; }
    }
}
