//! `PhpUndefinedView`: in a Laravel project, a view name (the `viewName`
//! string references: `view('…')`, `View::make('…')`, `Route::view(…, '…')`,
//! a mailable's `markdown('…')`, …) that no view file has. The quick-fix
//! "Create view" creates the Blade template where Laravel looks for it
//! (`resources/views/a/b.blade.php` for `a.b`, the first folder of a
//! namespace for `pkg::a.b`).
//!
//! Only plain string literals are checked, only while the indexes are ready
//! and the project has some view, and a name in a namespace the engine
//! doesn't know (a package's views) is never reported.

use ide_core::{FileEdit, Severity, WorkspaceEdit};

use super::{Inspection, InspectionContext, Problems, QuickFix};
use crate::engine::{EngineState, is_meta_path};
use crate::frameworks::laravel::refs::{ReferenceKind, ViewName, kind_of, sites};

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
        let resolver = cx.resolver();
        for site in sites(cx.parsed, &resolver, &[&ViewName], None) {
            if cx.is_cancelled() {
                return;
            }
            let value = &site.value;
            // Only plain literals (no interpolation or escapes).
            if value.is_empty() || value.contains(['$', '\\', '{']) || views.get(value).is_some() {
                continue;
            }
            if let Some((namespace, _)) = value.split_once("::")
                && views.namespace(namespace).is_none()
            {
                continue;
            }
            if !kind_of(&site, &resolver).is_some_and(|kind| kind.id() == ViewName.id()) {
                continue;
            }
            let problem = out.report(site.start, site.end, format!("View '{value}' is not defined"));
            if let Some(path) = views.new_path(value) {
                let edit = WorkspaceEdit {
                    files: vec![FileEdit::Create { path: path.into(), overwrite: false }],
                    ..WorkspaceEdit::default()
                };
                problem.with_fix(QuickFix { title: format!("Create view '{value}'"), edit, preferred: true });
            }
        }
    }
}
