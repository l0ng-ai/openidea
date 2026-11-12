//! The "undefined …" inspections of Laravel string references
//! ([`UndefinedReference`]), each over one reference kind and reporting
//! what [`ReferenceKind::undefined`] says, with its quick-fix:
//!
//! - `PhpUndefinedConfigKey`: a configuration key below a known array that
//!   isn't there.
//! - `PhpUndefinedEnvKey`: an `env()` key neither `.env` nor `.env.example`
//!   sets (fix: add it to `.env.example`).
//! - `PhpUndefinedTranslation`: a translation key no locale has (fix:
//!   create it in every locale).
//! - `PhpUndefinedViteAsset`: a Vite asset that is neither a file, an entry
//!   point nor in the build manifest.
//! - `PhpUnknownValidationRule`: a validation rule that is neither one of
//!   Laravel's nor registered with `Validator::extend(…)`.
//! - `PhpUnknownEloquentColumn`: a column name in a query or a model's
//!   attribute lists that the model's table doesn't have, when the
//!   migrations say for certain which columns it has.
//! - `PhpUnknownAbility`: an ability (`Gate::allows`, `$user->can`, `@can`,
//!   …) that no gate defines and that isn't a method of the policy of its
//!   model (of any policy, without a model); also the ability of `can:`
//!   middleware (`->middleware('can:update,post')`).
//! - `PhpUnknownGuard`: a guard (`auth('…')`, `Auth::guard`, `@auth`, the
//!   `auth:`/`guest:` middleware) that `config/auth.php` doesn't declare.
//! - `PhpUnknownPasswordBroker`: a password broker (`Password::broker('…')`)
//!   that `config/auth.php` doesn't declare.
//! - `PhpUndefinedInertiaPage`: an Inertia page (`Inertia::render`,
//!   `inertia()`, `Route::inertia`) no page folder has (fix: create the
//!   page).
//! - `PhpUndefinedController`: a route action naming a controller class or
//!   method that doesn't exist (fixes: create the controller, add the
//!   method; [`crate::frameworks::laravel::refs::ControllerAction`]).
//! - `PhpUnknownArtisanCommand`: an Artisan command name (`Artisan::call`,
//!   `$this->call`, `Schedule::command`, `$this->artisan`) no command has;
//!   only with `vendor/` installed, so the packages' commands are known.
//!
//! They run only while the indexes are ready, in Laravel projects.

use ide_core::Severity;

use super::{Inspection, InspectionContext, Problems, QuickFix};
use crate::engine::{EngineState, is_meta_path};
use crate::frameworks::laravel::refs::{
    ArtisanCommandKind, ArtisanOptionKind, AuthGuard, ConfigKey, ControllerAction, EloquentField, EnvKey, Gate,
    InertiaPageKind, PasswordBroker, ReferenceKind, TranslationKey, ValidationRule, ViewName, ViteAsset,
};

/// One "undefined …" inspection; see the module documentation.
pub struct UndefinedReference {
    id: &'static str,
    kind: &'static dyn ReferenceKind,
}

/// The inspections, as `(inspection id, kind)`.
const INSPECTIONS: [(&str, &dyn ReferenceKind); 13] = [
    ("PhpUndefinedConfigKey", &ConfigKey),
    ("PhpUndefinedEnvKey", &EnvKey),
    ("PhpUndefinedTranslation", &TranslationKey),
    ("PhpUndefinedViteAsset", &ViteAsset),
    ("PhpUnknownValidationRule", &ValidationRule),
    ("PhpUnknownEloquentColumn", &EloquentField),
    ("PhpUnknownAbility", &Gate),
    ("PhpUndefinedInertiaPage", &InertiaPageKind),
    ("PhpUnknownGuard", &AuthGuard),
    ("PhpUnknownPasswordBroker", &PasswordBroker),
    ("PhpUndefinedController", &ControllerAction),
    ("PhpUnknownArtisanCommand", &ArtisanCommandKind),
    ("PhpUnknownArtisanOption", &ArtisanOptionKind),
];

impl UndefinedReference {
    /// Every inspection of the module.
    pub fn all() -> Vec<Self> {
        INSPECTIONS.iter().map(|(id, kind)| Self { id, kind: *kind }).collect()
    }
}

/// The id of the inspection over the kind `kind` (`configKey`).
pub fn inspection_id(kind: &str) -> Option<&'static str> {
    // Views have their own inspection (`crate::inspect::views`).
    if kind == ViewName.id() {
        return Some("PhpUndefinedView");
    }
    INSPECTIONS.iter().find(|(_, known)| known.id() == kind).map(|(id, _)| *id)
}

impl Inspection for UndefinedReference {
    fn id(&self) -> &'static str {
        self.id
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    fn check(&self, cx: &InspectionContext<'_>, out: &mut Problems) {
        if cx.engine.status().state != EngineState::Ready || is_meta_path(cx.path) {
            return;
        }
        for found in cx.engine.undefined_references(cx.parsed, cx.path, &[self.kind], cx.cancel) {
            let problem = out.report(found.start, found.end, found.problem.message);
            problem.with_severity(found.problem.severity);
            for (index, fix) in found.problem.fixes.into_iter().enumerate() {
                problem.with_fix(QuickFix { title: fix.title, edit: fix.edit, preferred: index == 0, open: fix.open });
            }
        }
    }
}
