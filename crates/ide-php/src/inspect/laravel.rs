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
//!
//! They run only while the indexes are ready, in Laravel projects.

use ide_core::Severity;

use super::{Inspection, InspectionContext, Problems, QuickFix};
use crate::engine::{EngineState, is_meta_path};
use crate::frameworks::laravel::refs::{ConfigKey, EnvKey, ReferenceKind, TranslationKey, ValidationRule, ViteAsset};

/// One "undefined …" inspection; see the module documentation.
pub struct UndefinedReference {
    id: &'static str,
    kind: &'static dyn ReferenceKind,
}

/// The inspections, as `(inspection id, kind)`.
const INSPECTIONS: [(&str, &dyn ReferenceKind); 5] = [
    ("PhpUndefinedConfigKey", &ConfigKey),
    ("PhpUndefinedEnvKey", &EnvKey),
    ("PhpUndefinedTranslation", &TranslationKey),
    ("PhpUndefinedViteAsset", &ViteAsset),
    ("PhpUnknownValidationRule", &ValidationRule),
];

impl UndefinedReference {
    /// Every inspection of the module.
    pub fn all() -> Vec<Self> {
        INSPECTIONS.iter().map(|(id, kind)| Self { id, kind: *kind }).collect()
    }
}

/// The id of the inspection over the kind `kind` (`configKey`).
pub fn inspection_id(kind: &str) -> Option<&'static str> {
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
            if let Some((title, edit)) = found.problem.fix {
                problem.with_fix(QuickFix { title, edit, preferred: true });
            }
        }
    }
}
