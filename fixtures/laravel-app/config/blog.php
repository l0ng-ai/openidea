<?php

return [

    'posts_per_page' => (int) env('BLOG_POSTS_PER_PAGE', 10),

    'feed' => [
        'enabled' => (bool) env('BLOG_FEED_ENABLED', true),
        'title' => 'Latest posts',
        'limit' => 20,
    ],

    'comments' => [
        'moderated' => true,
    ],

];
