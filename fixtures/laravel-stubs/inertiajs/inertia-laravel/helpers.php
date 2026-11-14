<?php

// Stand-in for inertiajs/inertia-laravel's global helper.

/** @return \Inertia\ResponseFactory|\Inertia\Response */
function inertia($component = null, $props = []) { return new \Inertia\ResponseFactory(); }
