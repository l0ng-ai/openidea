<?php

namespace App\Http\Requests;

use App\Enums\PostStatus;
use App\Models\Post;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class StorePostRequest extends FormRequest
{
    public function authorize(): bool
    {
        return $this->user()->can('create', Post::class);
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'title' => 'required|string|max:255',
            'slug' => ['required', 'alpha_dash', Rule::unique('posts', 'slug')],
            'body' => 'required|string',
            'status' => ['required', Rule::enum(PostStatus::class)],
            'published_at' => 'nullable|date|after:now',
        ];
    }

    /** @return array<string, string> */
    public function messages(): array
    {
        return [
            'slug.unique' => __('messages.slug_taken'),
        ];
    }
}
