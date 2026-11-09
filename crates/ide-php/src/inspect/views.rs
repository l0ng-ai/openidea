//! `PhpUndefinedView`: in a Laravel project, a view name (the `viewName`
//! string references: `view('…')`, `View::make('…')`, `Route::view(…, '…')`,
//! a mailable's `markdown('…')`, …) that no view file has. The quick-fix
//! "Create view" creates the Blade template where Laravel looks for it
//! (`resources/views/a/b.blade.php` for `a.b`, the first folder of a
//! namespace for `pkg::a.b`).
//!
//! Only plain string literals are checked, only while the indexes are ready
//! and the project has some view, and a name in a namespace the engine
//! doesn't know (a package's views) is never reported. The same check runs
//! in Blade templates (`@include('…')`, `@extends('…')`,
//! [`crate::engine::PhpEngine::blade_problems`]).

use ide_core::Severity;

use super::{Inspection, InspectionContext, Problems, QuickFix};
use crate::engine::{EngineState, is_meta_path};
use crate::frameworks::laravel::refs::ViewName;

/// `PhpUndefinedView`.
pub struct UndefinedView;

impl Inspection for UndefinedView {
    fn id(&self) -> &'static str {
        "PhpUndefinedView"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    fn check(&self, cx: &InspectionContext<'_>, out: &mut Problems) {
        if cx.engine.status().state != EngineState::Ready || is_meta_path(cx.path) {
            return;
        }
        let Some(views) = cx.engine.laravel_views() else { return };
        if views.is_empty() {
            return;
        }
        // The places of the `ide.json` rules too ([`ViewName::undefined`]).
        for found in cx.engine.undefined_references(cx.parsed, cx.path, &[&ViewName], cx.cancel) {
            let problem = out.report(found.start, found.end, found.problem.message);
            if let Some((title, edit)) = found.problem.fix {
                problem.with_fix(QuickFix { title, edit, preferred: true });
            }
        }
    }
}
