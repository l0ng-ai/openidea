<?php

use Illuminate\Support\Facades\Route;
use Modules\Billing\Http\Controllers\InvoiceController;

// Loaded by the module's RouteServiceProvider: `api/billing` prefix, `api.billing.` names.
Route::get('/invoices', [InvoiceController::class, 'index'])->name('invoices.index');
