<?php

namespace App\Models;

use App\Enums\PostStatus;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Casts\Attribute;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;

class Post extends Model
{
    use SoftDeletes;

    protected $fillable = ['title', 'slug', 'body', 'status', 'published_at'];

    protected $casts = [
        'status' => PostStatus::class,
        'published_at' => 'datetime',
        'options' => 'array',
    ];

    public function author(): BelongsTo
    {
        return $this->belongsTo(User::class, 'author_id');
    }

    public function comments(): HasMany
    {
        return $this->hasMany(Comment::class);
    }

    public function tags(): BelongsToMany
    {
        return $this->belongsToMany(Tag::class);
    }

    /** Only the posts that are already out. */
    public function scopePublished(Builder $query): Builder
    {
        return $query->where('status', PostStatus::Published)->where('published_at', '<=', now());
    }

    /**
     * The first paragraph of the body.
     *
     * @return Attribute<string, never>
     */
    protected function excerpt(): Attribute
    {
        return Attribute::make(get: fn (): string => strtok((string) $this->body, "\n"));
    }

    public function getRouteKeyName(): string
    {
        return 'slug';
    }
}
