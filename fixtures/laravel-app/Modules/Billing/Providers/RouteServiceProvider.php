<?php

namespace Modules\Billing\Providers;

use Illuminate\Foundation\Support\Providers\RouteServiceProvider as ServiceProvider;
use Illuminate\Support\Facades\Route;

class RouteServiceProvider extends ServiceProvider
{
    protected string $moduleName = 'Billing';

    /**
     * Define the routes of the module.
     */
    public function map(): void
    {
        Route::middleware('web')
            ->prefix('billing')
            ->name('billing.')
            ->group(module_path($this->moduleName, '/Routes/web.php'));

        Route::middleware('api')
            ->prefix('api/billing')
            ->name('api.billing.')
            ->group(module_path('Billing', '/Routes/api.php'));
    }
}
