<?php

// Minimal stand-ins for livewire/livewire's classes (names and signatures as
// Livewire declares them, bodies empty). Only installed by the tests that list
// the package in their `vendor/composer/installed.json`.

namespace Livewire {
    abstract class Component
    {
        public $id;

        public function mount() {}

        public function render() {}

        public function dispatch($event, ...$params) {}

        public function validate($rules = null, $messages = [], $attributes = []) {}

        public function reset(...$properties) {}

        public function redirect($url, $navigate = false) {}

        public function skipRender() {}
    }

    abstract class Form
    {
        public function validate($rules = null, $messages = [], $attributes = []) {}

        public function reset(...$properties) {}

        public function all() {}
    }

    class LivewireManager
    {
        public function component($name, $class = null) {}

        public function test($name, $params = []) {}

        public function visit($name) {}
    }

    class Livewire extends \Illuminate\Support\Facades\Facade
    {
        protected static function getFacadeAccessor() { return LivewireManager::class; }

        public static function component($name, $class = null) {}

        public static function test($name, $params = []) {}

        public static function visit($name) {}
    }
}
