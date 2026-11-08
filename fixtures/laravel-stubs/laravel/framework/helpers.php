<?php

// Minimal stand-ins for laravel/framework's global helpers (signatures as Laravel
// declares them, bodies empty). See fixtures/laravel-app/README.md.

/** @return mixed */
function app($abstract = null, array $parameters = []) { return null; }

/** @return mixed */
function resolve($name, array $parameters = []) { return null; }

/** @return mixed */
function config($key = null, $default = null) { return null; }

/** @return mixed */
function env($key, $default = null) { return null; }

/** @return mixed */
function session($key = null, $default = null) { return null; }

/** @return mixed */
function old($key = null, $default = null) { return null; }

/** @return mixed */
function __($key = null, $replace = [], $locale = null) { return null; }

function view($view = null, $data = [], $mergeData = []): \Illuminate\Contracts\View\View { return new \Illuminate\View\View(); }

function route($name, $parameters = [], $absolute = true): string { return ''; }

function redirect($to = null, $status = 302, $headers = [], $secure = null): \Illuminate\Routing\Redirector { return new \Illuminate\Routing\Redirector(); }

function to_route($route, $parameters = [], $status = 302, $headers = []): \Illuminate\Http\RedirectResponse { return new \Illuminate\Http\RedirectResponse(); }

function now($tz = null): \Illuminate\Support\Carbon { return new \Illuminate\Support\Carbon(); }

function e($value, $doubleEncode = true): string { return ''; }

function abort_unless($boolean, $code, $message = '', array $headers = []): void {}

function base_path($path = ''): string { return ''; }

function database_path($path = ''): string { return ''; }

function resource_path($path = ''): string { return ''; }
