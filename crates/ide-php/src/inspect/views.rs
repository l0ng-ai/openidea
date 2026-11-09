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
use crate::frameworks::laravel::refs::{ReferenceKind, ViewName, classify, prefixed, sites_with};

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
        // The places of the `ide.json` rules too.
        let project = cx.engine.laravel();
        let rules = project.as_ref().map(|project| project.ide_json.completions.as_slice()).unwrap_or_default();
        for site in sites_with(cx.parsed, &resolver, &[&ViewName], rules, None) {
            if cx.is_cancelled() {
                return;
            }
            // Only plain literals (no interpolation or escapes).
            if site.value.is_empty() || site.value.contains(['$', '\\', '{']) {
                continue;
            }
            let Some((kind, rule)) = classify(&site, &resolver, rules) else { continue };
            let value = &prefixed(&site, rule);
            if kind.id() != ViewName.id() || views.get(value).is_some() {
                continue;
            }
            if let Some((namespace, _)) = value.split_once("::")
                && views.namespace(namespace).is_none()
            {
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
