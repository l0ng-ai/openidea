//! Inspections: per-file checks that report problems with quick-fixes.
//!
//! - An [`Inspection`] has an id (`PhpUndefinedClass`, the name used in
//!   `@noinspection`), a default severity and a check that visits one
//!   parsed file with its types through an [`InspectionContext`] and
//!   reports [`Problem`]s. A problem may carry [`QuickFix`]es, each a
//!   `WorkspaceEdit`. The checks are registered in
//!   [`Inspections::builtin`] ([`undefined`]: undefined class-likes,
//!   functions and constants; [`members`]: undefined methods, properties
//!   and class constants); [`PhpEngine::set_inspections`] replaces the
//!   set (tests, and the settings of phase 4.10).
//! - [`PhpEngine::inspect`] runs every inspection over an open document,
//!   drops the problems a `@noinspection` comment suppresses
//!   ([`suppress`]), and gives them as IDE diagnostics (`source: "php"`,
//!   `code`: the inspection id) after the parser's syntax errors, which are
//!   always reported and can't be suppressed. A panicking inspection is
//!   logged and skipped.
//! - In the background ([`runner`]), every change to an open document
//!   schedules a run after a short debounce; a newer change cancels the run
//!   in progress. Results are pushed as `IdeEvent::Diagnostics { source:
//!   "php" }`, and cleared when the document closes or the engine stops.
//!   Open documents are inspected again when indexing finishes or a watcher
//!   batch was applied, since other files' declarations changed.
//! - [`PhpEngine::code_actions`] gives the quick-fixes of the problems at a
//!   range (plus "Suppress for statement", which adds `@noinspection` to
//!   the statement's docblock or puts one in front of it) along with the
//!   import actions.
//!
//! The model follows IntelliJ's public description of code inspections
//! (`https://plugins.jetbrains.com/docs/intellij/code-inspections.html`):
//! a short name, a default level, a visitor and quick-fixes.

pub mod members;
pub(crate) mod runner;
pub mod suppress;
#[cfg(test)]
mod tests;
pub mod undefined;

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use ide_core::{CancellationToken, Diagnostic, DocId, Range, Severity, TextEdit, WorkspaceEdit};

use crate::engine::PhpEngine;
use crate::imports::{ImportAction, QUICKFIX, file_edit, wanted};
use crate::names::FileNames;
use crate::summary::FileSummary;
use crate::syntax::{DIAGNOSTIC_SOURCE, ParsedFile};
use crate::types::{Resolver, Type};

pub use suppress::Suppressions;

/// One check over a file.
pub trait Inspection: Send + Sync {
    /// The short name, used as the diagnostic code and in `@noinspection`.
    fn id(&self) -> &'static str;

    /// The severity of its problems unless a problem sets its own.
    fn default_severity(&self) -> Severity;

    /// Visits the file and reports what it finds.
    fn check(&self, cx: &InspectionContext<'_>, out: &mut Problems);
}

/// The set of inspections the engine runs, in order.
#[derive(Clone, Default)]
pub struct Inspections {
    list: Vec<Arc<dyn Inspection>>,
}

impl Inspections {
    /// The engine's own inspections (syntax errors are reported
    /// regardless).
    pub fn builtin() -> Self {
        Self::new(vec![
            Arc::new(undefined::UndefinedClass),
            Arc::new(undefined::UndefinedFunction),
            Arc::new(undefined::UndefinedConstant),
            Arc::new(members::UndefinedMethod),
            Arc::new(members::UndefinedField),
            Arc::new(members::UndefinedClassConstant),
        ])
    }

    pub fn new(list: Vec<Arc<dyn Inspection>>) -> Self {
        Self { list }
    }

    pub fn iter(&self) -> impl Iterator<Item = &Arc<dyn Inspection>> {
        self.list.iter()
    }

    pub fn ids(&self) -> Vec<&'static str> {
        self.list.iter().map(|i| i.id()).collect()
    }

    pub fn len(&self) -> usize {
        self.list.len()
    }

    pub fn is_empty(&self) -> bool {
        self.list.is_empty()
    }
}

impl std::fmt::Debug for Inspections {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_list().entries(self.ids()).finish()
    }
}

/// A quick-fix: an edit with a title.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuickFix {
    pub title: String,
    pub edit: WorkspaceEdit,
    /// Applied by "fix the problem" shortcuts when it is the obvious fix.
    pub preferred: bool,
}

/// A problem an inspection found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Problem {
    /// The inspection's id.
    pub inspection: &'static str,
    pub severity: Severity,
    /// Byte offsets, end exclusive.
    pub start: u32,
    pub end: u32,
    pub range: Range,
    pub message: String,
    /// Shown faded (unused code).
    pub unnecessary: bool,
    /// Shown struck through.
    pub deprecated: bool,
    pub fixes: Vec<QuickFix>,
}

impl Problem {
    pub fn with_fix(&mut self, fix: QuickFix) -> &mut Self {
        self.fixes.push(fix);
        self
    }

    pub fn with_severity(&mut self, severity: Severity) -> &mut Self {
        self.severity = severity;
        self
    }

    pub fn unnecessary(&mut self) -> &mut Self {
        self.unnecessary = true;
        self
    }

    pub fn deprecated(&mut self) -> &mut Self {
        self.deprecated = true;
        self
    }

    pub fn to_diagnostic(&self) -> Diagnostic {
        Diagnostic {
            range: self.range,
            severity: self.severity,
            message: self.message.clone(),
            source: Some(DIAGNOSTIC_SOURCE.to_owned()),
            code: Some(self.inspection.to_owned()),
            unnecessary: self.unnecessary,
            deprecated: self.deprecated,
            server: None,
        }
    }
}

/// Where the inspections report: each problem is stamped with the running
/// inspection's id and severity.
pub struct Problems<'a> {
    parsed: &'a ParsedFile,
    inspection: &'static str,
    severity: Severity,
    items: Vec<Problem>,
}

impl<'a> Problems<'a> {
    fn new(parsed: &'a ParsedFile) -> Self {
        Self { parsed, inspection: "", severity: Severity::Warning, items: Vec::new() }
    }

    fn begin(&mut self, inspection: &dyn Inspection) {
        self.inspection = inspection.id();
        self.severity = inspection.default_severity();
    }

    /// Reports a problem over bytes `start..end` (clamped to the text).
    pub fn report(&mut self, start: u32, end: u32, message: impl Into<String>) -> &mut Problem {
        let len = self.parsed.line_index().len();
        let end = end.min(len);
        let start = start.min(end);
        self.items.push(Problem {
            inspection: self.inspection,
            severity: self.severity,
            start,
            end,
            range: self.parsed.line_index().range(start, end),
            message: message.into(),
            unnecessary: false,
            deprecated: false,
            fixes: Vec::new(),
        });
        self.items.last_mut().expect("just pushed")
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
}

/// What an inspection sees: the file, its names, summary and types.
pub struct InspectionContext<'a> {
    pub engine: &'a PhpEngine,
    pub parsed: &'a ParsedFile,
    /// The document's path (normalized).
    pub path: &'a Path,
    pub cancel: &'a CancellationToken,
    names: OnceLock<FileNames>,
    summary: OnceLock<FileSummary>,
    members: OnceLock<Vec<members::Found>>,
}

impl<'a> InspectionContext<'a> {
    pub fn new(engine: &'a PhpEngine, parsed: &'a ParsedFile, path: &'a Path, cancel: &'a CancellationToken) -> Self {
        Self {
            engine,
            parsed,
            path,
            cancel,
            names: OnceLock::new(),
            summary: OnceLock::new(),
            members: OnceLock::new(),
        }
    }

    /// The file's resolved names (computed once for all inspections).
    pub fn names(&self) -> &FileNames {
        self.names.get_or_init(|| FileNames::resolve(self.parsed))
    }

    /// The file's declarations (computed once for all inspections).
    pub fn summary(&self) -> &FileSummary {
        self.summary.get_or_init(|| FileSummary::extract(self.parsed))
    }

    /// The file's undefined members (computed once for the three member
    /// inspections).
    pub(crate) fn undefined_members(&self) -> &[members::Found] {
        self.members.get_or_init(|| members::find(self))
    }

    pub fn resolver(&self) -> Resolver<'a> {
        self.engine.resolver()
    }

    /// The type of the innermost expression at byte `offset`.
    pub fn type_at(&self, offset: u32) -> Option<Type> {
        crate::types::type_at(self.parsed, &self.engine.resolver(), offset)
    }

    pub fn text(&self) -> &str {
        self.parsed.text()
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }

    /// An edit of this file replacing bytes `start..end` with `new_text`.
    pub fn edit(&self, start: u32, end: u32, new_text: impl Into<String>) -> WorkspaceEdit {
        let range = self.parsed.line_index().range(start, end);
        file_edit(self.path, vec![TextEdit { range, new_text: new_text.into() }])
    }
}

/// The result of inspecting one version of an open document.
#[derive(Clone, Debug)]
pub struct Inspected {
    pub doc: DocId,
    pub version: u32,
    pub path: PathBuf,
    /// Syntax errors first, then the problems in source order.
    pub diagnostics: Vec<Diagnostic>,
    /// The problems that weren't suppressed, in source order.
    pub problems: Vec<Problem>,
}

impl PhpEngine {
    /// The inspections the engine runs.
    pub fn inspections(&self) -> Inspections {
        self.shared_inspections().0.read().clone()
    }

    /// Replaces the inspections the engine runs; open documents are
    /// inspected again.
    pub fn set_inspections(&self, inspections: Inspections) {
        let (set, runner) = self.shared_inspections();
        *set.write() = inspections;
        runner.forget_results();
        for document in self.open_documents() {
            runner.schedule(document.doc);
        }
    }

    /// Runs every inspection over the current version of an open document.
    /// `None` when the engine doesn't hold it or `cancel` fired.
    pub fn inspect(&self, doc: DocId, cancel: &CancellationToken) -> Option<Inspected> {
        let document = self.open_documents().into_iter().find(|d| d.doc == doc)?;
        let parsed = self.parse_open(&document);
        let inspections = self.inspections();
        let cx = InspectionContext::new(self, &parsed, &document.path, cancel);
        let mut problems = Problems::new(&parsed);
        for inspection in inspections.iter() {
            if cancel.is_cancelled() {
                return None;
            }
            problems.begin(inspection.as_ref());
            let before = problems.items.len();
            let ran = catch_unwind(AssertUnwindSafe(|| inspection.check(&cx, &mut problems)));
            if ran.is_err() {
                tracing::warn!("php inspection {} panicked on {}", inspection.id(), document.path.display());
                problems.items.truncate(before);
            }
        }
        if cancel.is_cancelled() {
            return None;
        }
        let mut problems = problems.items;
        if !problems.is_empty() {
            let suppressions = Suppressions::scan(&parsed);
            problems.retain(|p| !suppressions.suppresses(p.inspection, p.start));
            for problem in &mut problems {
                if let Some(fix) = suppressions.suppress_fix(&parsed, &document.path, problem.inspection, problem.start)
                {
                    problem.fixes.push(fix);
                }
            }
        }
        problems.sort_by_key(|p| (p.start, p.end));
        let mut diagnostics = parsed.diagnostics();
        diagnostics.extend(problems.iter().map(Problem::to_diagnostic));
        Some(Inspected { doc, version: document.version, path: document.path.clone(), diagnostics, problems })
    }

    /// The latest inspection of the document's current version: the
    /// background run's when it is up to date, a new run otherwise.
    pub fn inspected(&self, doc: DocId) -> Option<Arc<Inspected>> {
        let version = self.open_documents().into_iter().find(|d| d.doc == doc)?.version;
        let (_, runner) = self.shared_inspections();
        if let Some(found) = runner.result(doc).filter(|r| r.version == version) {
            return Some(found);
        }
        let inspected = Arc::new(self.inspect(doc, &CancellationToken::new())?);
        runner.store(inspected.clone());
        Some(inspected)
    }

    /// The code actions of a range: the quick-fixes of the problems that
    /// touch it (each problem's own fixes, then "suppress"), then the import
    /// actions. Filtered by `only` (code action kinds). `None` when the
    /// engine doesn't hold the document.
    pub fn code_actions(&self, doc: DocId, range: Range, only: &[String]) -> Option<Vec<ImportAction>> {
        let mut out = Vec::new();
        if wanted(only, QUICKFIX) {
            let inspected = self.inspected(doc)?;
            let touching: Vec<&Problem> = inspected
                .problems
                .iter()
                .filter(|p| p.range.start <= range.end && range.start <= p.range.end)
                .collect();
            // Real fixes before the suppressions.
            let fixes = touching.iter().flat_map(|p| p.fixes.iter().filter(|f| !is_suppress(f)));
            let suppress = touching.iter().flat_map(|p| p.fixes.iter().filter(|f| is_suppress(f)));
            for fix in fixes.chain(suppress) {
                if out.iter().any(|a: &ImportAction| a.title == fix.title) {
                    continue;
                }
                out.push(ImportAction {
                    title: fix.title.clone(),
                    kind: QUICKFIX,
                    preferred: fix.preferred,
                    edit: fix.edit.clone(),
                });
            }
        }
        out.extend(self.import_actions(doc, range, only)?);
        Some(out)
    }

    /// Blocks until no background inspection is pending or running. False on
    /// timeout.
    pub fn wait_inspections(&self, timeout: std::time::Duration) -> bool {
        self.shared_inspections().1.wait_idle(timeout)
    }
}

fn is_suppress(fix: &QuickFix) -> bool {
    fix.title.starts_with(suppress::SUPPRESS_TITLE)
}
