<?php

// Minimal stand-ins for the parts of laravel/framework (and the Symfony classes it
// re-exports) that fixtures/laravel-app uses: the signatures as Laravel declares them,
// the bodies empty. Not Laravel's code; see fixtures/laravel-app/README.md.

namespace Illuminate\Contracts\Container {
    interface Container {
        /** @return mixed */
        public function make($abstract, array $parameters = []);
    }
}

namespace Illuminate\Container {
    class Container implements \Illuminate\Contracts\Container\Container {
        /** @return mixed */
        public function make($abstract, array $parameters = []) { return null; }
        public function bind($abstract, $concrete = null, $shared = false): void {}
        public function singleton($abstract, $concrete = null): void {}
        public function scoped($abstract, $concrete = null): void {}
        /** @return mixed */
        public function instance($abstract, $instance) { return $instance; }
        public function alias($abstract, $alias): void {}
    }
}

namespace Illuminate\Foundation {
    use Illuminate\Foundation\Configuration\ApplicationBuilder;

    class Application extends \Illuminate\Container\Container {
        public static function configure(?string $basePath = null): ApplicationBuilder { return new ApplicationBuilder(); }
        public function version(): string { return ''; }
        public function getLocale(): string { return ''; }
        public function handleRequest(\Illuminate\Http\Request $request): void {}
        public function handleCommand($input): int { return 0; }
    }

    class Inspiring {
        public static function quote(): string { return ''; }
    }
}

namespace Illuminate\Foundation\Configuration {
    class ApplicationBuilder {
        public function withRouting(
            ?\Closure $using = null,
            array|string|null $web = null,
            array|string|null $api = null,
            ?string $commands = null,
            ?string $channels = null,
            ?string $pages = null,
            ?string $health = null,
            string $apiPrefix = 'api',
            ?callable $then = null,
        ): static { return $this; }
        public function withMiddleware(?callable $callback = null): static { return $this; }
        public function withExceptions(?callable $using = null): static { return $this; }
        public function create(): \Illuminate\Foundation\Application { return new \Illuminate\Foundation\Application(); }
    }
    class Middleware {
        public function alias(array $aliases): static { return $this; }
    }
    class Exceptions {}
}

namespace Illuminate\Support {
    /**
     * @template TKey of array-key
     * @template TValue
     * @implements \IteratorAggregate<TKey, TValue>
     */
    class Collection implements \IteratorAggregate {
        /** @return \ArrayIterator<TKey, TValue> */
        public function getIterator(): \ArrayIterator { return new \ArrayIterator([]); }
        /** @return array<TKey, TValue> */
        public function all(): array { return []; }
        public function map(callable $callback): static { return $this; }
        /** @return TValue|null */
        public function first(?callable $callback = null, $default = null) { return null; }
    }

    class Carbon extends \DateTime {
        public function toFormattedDateString(): string { return ''; }
    }

    abstract class ServiceProvider {
        /** @var \Illuminate\Foundation\Application */
        protected $app;
        public function register(): void {}
        protected function loadViewsFrom($path, $namespace): void {}
    }
}

namespace Illuminate\Foundation\Support\Providers {
    class RouteServiceProvider extends \Illuminate\Support\ServiceProvider {
        public function boot(): void {}
    }
}

namespace Illuminate\Support\Facades {
    abstract class Facade {
        public static function __callStatic($method, $args): mixed { return null; }
    }
    class App extends Facade {
        protected static function getFacadeAccessor() { return 'app'; }
    }
    /**
     * @method static \Illuminate\Routing\Route get(string $uri, array|string|callable|null $action = null)
     * @method static \Illuminate\Routing\Route post(string $uri, array|string|callable|null $action = null)
     * @method static \Illuminate\Routing\Route delete(string $uri, array|string|callable|null $action = null)
     * @method static \Illuminate\Routing\Route put(string $uri, array|string|callable|null $action = null)
     * @method static \Illuminate\Routing\Route patch(string $uri, array|string|callable|null $action = null)
     * @method static \Illuminate\Routing\Route any(string $uri, array|string|callable|null $action = null)
     * @method static \Illuminate\Routing\Route match(array|string $methods, string $uri, array|string|callable|null $action = null)
     * @method static \Illuminate\Routing\Route view(string $uri, string $view, array $data = [], int|array $status = 200, array $headers = [])
     * @method static \Illuminate\Routing\PendingResourceRegistration resource(string $name, string $controller, array $options = [])
     * @method static \Illuminate\Routing\PendingResourceRegistration apiResource(string $name, string $controller, array $options = [])
     * @method static \Illuminate\Routing\RouteRegistrar controller(string $controller)
     * @method static void group(array $attributes, \Closure|array|string $routes)
     * @method static \Illuminate\Routing\RouteRegistrar middleware(array|string|null $middleware)
     * @method static \Illuminate\Routing\RouteRegistrar prefix(string $prefix)
     * @method static \Illuminate\Routing\RouteRegistrar name(string $value)
     * @method static bool has(string|array $name)
     */
    class Route extends Facade {
        protected static function getFacadeAccessor() { return 'router'; }
    }
    /**
     * @method static string route(string $name, mixed $parameters = [], bool $absolute = true)
     * @method static string action(string|array $action, mixed $parameters = [], bool $absolute = true)
     */
    class URL extends Facade {
        protected static function getFacadeAccessor() { return 'url'; }
    }
    /**
     * @method static void create(string $table, \Closure $callback)
     * @method static void table(string $table, \Closure $callback)
     * @method static void dropIfExists(string $table)
     */
    class Schema extends Facade {
        protected static function getFacadeAccessor() { return 'db.schema'; }
    }
    /**
     * @method static \Illuminate\Contracts\Auth\Access\Gate define(\UnitEnum|string $ability, callable|array|string $callback)
     * @method static \Illuminate\Auth\Access\Response authorize(\UnitEnum|string $ability, mixed $arguments = [])
     * @method static bool allows(iterable|\UnitEnum|string $ability, mixed $arguments = [])
     */
    class Gate extends Facade {
        protected static function getFacadeAccessor() { return \Illuminate\Contracts\Auth\Access\Gate::class; }
    }
    /**
     * @method static \Illuminate\Foundation\Console\ClosureCommand command(string $signature, \Closure $callback)
     */
    class Artisan extends Facade {
        protected static function getFacadeAccessor() { return \Illuminate\Contracts\Console\Kernel::class; }
    }
    /**
     * @method static \Illuminate\Console\Scheduling\Event command(string $command, array $parameters = [])
     */
    class Schedule extends Facade {
        protected static function getFacadeAccessor() { return \Illuminate\Console\Scheduling\Schedule::class; }
    }
    /**
     * @method static \Illuminate\Contracts\View\View make(string $view, array $data = [], array $mergeData = [])
     * @method static bool exists(string $view)
     * @method static \Illuminate\Contracts\View\View first(array $views, array $data = [], array $mergeData = [])
     * @method static array composer(array|string $views, \Closure|string $callback)
     * @method static void addNamespace(string $namespace, string|array $hints)
     */
    class View extends Facade {
        protected static function getFacadeAccessor() { return 'view'; }
    }
}

namespace Illuminate\Contracts\Auth\Access {
    interface Gate {}
}

namespace Illuminate\Auth\Access {
    class Response {}
}

namespace Illuminate\Contracts\Console {
    interface Kernel {}
}

namespace Illuminate\Console {
    class Command {
        public const SUCCESS = 0;
        public const FAILURE = 1;
        /** @var string */
        protected $signature;
        /** @var string */
        protected $description;
        public function line($string, $style = null, $verbosity = null): void {}
        public function comment($string, $verbosity = null): void {}
        /** @return mixed */
        public function option($key = null) { return null; }
    }
}

namespace Illuminate\Console\Scheduling {
    class Schedule {}
    class Event {
        public function hourly(): static { return $this; }
        public function everyFiveMinutes(): static { return $this; }
    }
}

namespace Illuminate\Foundation\Console {
    class ClosureCommand extends \Illuminate\Console\Command {
        public function purpose(string $description): static { return $this; }
        /** Forwards to the command's schedule event. */
        public function __call($method, $parameters): mixed { return null; }
    }
}

namespace Illuminate\Routing {
    class Route {
        public function name(string $name): static { return $this; }
        public function middleware(array|string|null $middleware = null): static { return $this; }
        public function withoutMiddleware(array|string $middleware): static { return $this; }
    }
    class RouteRegistrar {
        public function get(string $uri, array|string|callable|null $action = null): \Illuminate\Routing\Route { return new \Illuminate\Routing\Route(); }
        public function post(string $uri, array|string|callable|null $action = null): \Illuminate\Routing\Route { return new \Illuminate\Routing\Route(); }
        public function controller(string $controller): static { return $this; }
        public function middleware(array|string|null $middleware): static { return $this; }
        public function prefix(string $prefix): static { return $this; }
        public function name(string $value): static { return $this; }
        public function group(\Closure|array|string $callback): static { return $this; }
    }
    class PendingResourceRegistration {
        public function only(array|string $methods): static { return $this; }
        public function except(array|string $methods): static { return $this; }
        public function names(array|string $names): static { return $this; }
        public function middleware(array|string|null $middleware = null): static { return $this; }
    }
    class Redirector {
        public function route(string $route, mixed $parameters = [], int $status = 302, array $headers = []): \Illuminate\Http\RedirectResponse { return new \Illuminate\Http\RedirectResponse(); }
        public function action(string|array $action, mixed $parameters = [], int $status = 302, array $headers = []): \Illuminate\Http\RedirectResponse { return new \Illuminate\Http\RedirectResponse(); }
    }
}

namespace Symfony\Component\HttpFoundation {
    class Request {}
    class Response {}
}

namespace Illuminate\Http {
    class Request extends \Symfony\Component\HttpFoundation\Request {
        public static function capture(): static { return new static(); }
        /** @return mixed */
        public function user($guard = null) { return null; }
    }
    class Response extends \Symfony\Component\HttpFoundation\Response {}
    class RedirectResponse extends \Symfony\Component\HttpFoundation\Response {
        public function with($key, $value = null): static { return $this; }
    }
}

namespace Illuminate\Foundation\Http {
    class FormRequest extends \Illuminate\Http\Request {
        /** @return mixed */
        public function validated($key = null, $default = null) { return null; }
    }
}

namespace Illuminate\Validation {
    class Rule {
        public static function unique(string $table, string $column = 'NULL'): Rules\Unique { return new Rules\Unique(); }
        public static function enum(string $type): Rules\Enum { return new Rules\Enum(); }
    }
}

namespace Illuminate\Validation\Rules {
    class Unique {}
    class Enum {}
}

namespace Illuminate\Contracts\View {
    interface View {
        public function with($key, $value = null): static;
    }
    interface Factory {
        public function make($view, $data = [], $mergeData = []): View;
        public function exists($view): bool;
    }
}

namespace Illuminate\View {
    class View implements \Illuminate\Contracts\View\View {
        public function with($key, $value = null): static { return $this; }
    }
    class Factory implements \Illuminate\Contracts\View\Factory {
        public function make($view, $data = [], $mergeData = []): \Illuminate\Contracts\View\View { return new View(); }
        public function exists($view): bool { return false; }
        public function first(array $views, $data = [], $mergeData = []): \Illuminate\Contracts\View\View { return new View(); }
        public function addNamespace($namespace, $hints): static { return $this; }
    }
    abstract class Component {
        abstract public function render();
    }
}

namespace Illuminate\Mail {
    class Mailable {
        public function view($view, array $data = []): static { return $this; }
        public function markdown($view, array $data = []): static { return $this; }
        public function text($textView, array $data = []): static { return $this; }
        public function with($key, $value = null): static { return $this; }
    }
}

namespace Illuminate\Mail\Mailables {
    class Content {
        public function __construct(
            ?string $view = null,
            ?string $html = null,
            ?string $text = null,
            ?string $markdown = null,
            array $with = [],
            ?string $htmlString = null,
        ) {}
    }
}

namespace Illuminate\Routing {
    class ResponseFactory {
        public function view($view, $data = [], $status = 200, array $headers = []): \Illuminate\Http\Response { return new \Illuminate\Http\Response(); }
    }
}

namespace Illuminate\Contracts\Pagination {
    interface LengthAwarePaginator {}
}

namespace Illuminate\Database\Eloquent {
    /** @template TModel of Model */
    class Builder {
        public function where($column, $operator = null, $value = null, $boolean = 'and'): static { return $this; }
        public function latest($column = null): static { return $this; }
        /** @return Collection<int, TModel> */
        public function get($columns = ['*']) { return new Collection(); }
        /** @return TModel|null */
        public function first($columns = ['*']) { return null; }
        public function pluck($column, $key = null): \Illuminate\Support\Collection { return new \Illuminate\Support\Collection(); }
        public function paginate($perPage = null, $columns = ['*']): \Illuminate\Contracts\Pagination\LengthAwarePaginator { return new \Illuminate\Pagination\LengthAwarePaginator(); }
        /** @return TModel */
        public function create(array $attributes = []) { return new Model(); }
        public function exists(): bool { return false; }
        public function __call($method, $parameters): mixed { return null; }
    }

    /**
     * @template TKey of array-key
     * @template TModel of Model
     * @extends \Illuminate\Support\Collection<TKey, TModel>
     */
    class Collection extends \Illuminate\Support\Collection {}

    abstract class Model {
        /** @var array<int, string> */
        protected $fillable = [];
        /** @var array<int, string> */
        protected $hidden = [];
        /** @var array<string, string> */
        protected $casts = [];
        /** @var bool */
        public $timestamps = true;
        public function __call($method, $parameters): mixed { return null; }
        public static function __callStatic($method, $parameters): mixed { return null; }
        public function __get($key): mixed { return null; }
        public function __set($key, $value): void {}
        public function hasMany($related, $foreignKey = null, $localKey = null): Relations\HasMany { return new Relations\HasMany(); }
        public function belongsTo($related, $foreignKey = null, $ownerKey = null, $relation = null): Relations\BelongsTo { return new Relations\BelongsTo(); }
        public function belongsToMany($related, $table = null): Relations\BelongsToMany { return new Relations\BelongsToMany(); }
        public static function query(): Builder { return new Builder(); }
        public function update(array $attributes = [], array $options = []): bool { return true; }
        public function delete(): ?bool { return true; }
        public function getRouteKeyName(): string { return ''; }
    }

    trait SoftDeletes {}
}

namespace Illuminate\Database\Eloquent\Relations {
    abstract class Relation {
        public function __call($method, $parameters): mixed { return null; }
    }
    /**
     * @template TRelatedModel
     * @template TDeclaringModel
     */
    class HasMany extends Relation {}
    /**
     * @template TRelatedModel
     * @template TDeclaringModel
     */
    class BelongsTo extends Relation {}
    /**
     * @template TRelatedModel
     * @template TDeclaringModel
     */
    class BelongsToMany extends Relation {}
}

namespace Illuminate\Database\Eloquent\Casts {
    /**
     * @template TGet
     * @template TSet
     */
    class Attribute {
        public static function make(?callable $get = null, ?callable $set = null): static { return new static(); }
    }
}

namespace Illuminate\Pagination {
    class LengthAwarePaginator implements \Illuminate\Contracts\Pagination\LengthAwarePaginator {}
}

namespace Illuminate\Foundation\Auth {
    class User extends \Illuminate\Database\Eloquent\Model {
        public function can($abilities, $arguments = []): bool { return false; }
    }
}

namespace Illuminate\Notifications {
    trait Notifiable {}
}

namespace Illuminate\Database\Migrations {
    abstract class Migration {}
}

namespace Illuminate\Database {
    class Seeder {}
}

namespace Illuminate\Database\Schema {
    class Blueprint {
        public function id($column = 'id'): ColumnDefinition { return new ColumnDefinition(); }
        public function string($column, $length = null): ColumnDefinition { return new ColumnDefinition(); }
        public function text($column): ColumnDefinition { return new ColumnDefinition(); }
        public function json($column): ColumnDefinition { return new ColumnDefinition(); }
        public function boolean($column): ColumnDefinition { return new ColumnDefinition(); }
        public function timestamp($column, $precision = 0): ColumnDefinition { return new ColumnDefinition(); }
        public function unsignedInteger($column, $autoIncrement = false): ColumnDefinition { return new ColumnDefinition(); }
        public function foreignId($column): ForeignIdColumnDefinition { return new ForeignIdColumnDefinition(); }
        public function rememberToken(): ColumnDefinition { return new ColumnDefinition(); }
        public function timestamps($precision = 0): void {}
        public function softDeletes($column = 'deleted_at', $precision = 0): ColumnDefinition { return new ColumnDefinition(); }
        public function primary($columns, $name = null): void {}
        public function dropColumn($columns): void {}
    }
    /**
     * @method $this nullable(bool $value = true)
     * @method $this unique(string $indexName = null)
     * @method $this default(mixed $value)
     */
    class ColumnDefinition {
        public function __call($method, $parameters): mixed { return $this; }
    }
    class ForeignIdColumnDefinition extends ColumnDefinition {
        public function constrained($table = null, $column = 'id'): ForeignKeyDefinition { return new ForeignKeyDefinition(); }
    }
    class ForeignKeyDefinition {
        public function cascadeOnDelete(): static { return $this; }
    }
}
