//! Inspections: per-file checks that report problems with quick-fixes.
//!
//! - An [`Inspection`] has an id (`PhpUndefinedClass`, the name used in
//!   `@noinspection`), a default severity and a check that visits one
//!   parsed file with its types through an [`InspectionContext`] and
//!   reports [`Problem`]s. A problem may carry [`QuickFix`]es, each a
//!   `WorkspaceEdit`. The checks are registered in
//!   [`Inspections::builtin`] ([`undefined`]: undefined class-likes,
//!   functions and constants; [`members`]: undefined methods, properties
//!   and class constants; [`variables`]: undefined, possibly undefined and
//!   unused local variables; [`calls`]: argument count, named arguments,
//!   argument, return and property types, lenient or strict
//!   ([`Inspections::builtin_with`]); [`unused`]: unused imports, private
//!   members and parameters; [`control`]: unreachable statements, missing
//!   returns, `void` functions returning a value and `never` functions
//!   returning; [`level`]: syntax newer than the project's PHP version and
//!   uses of deprecated symbols; [`routes`]: Symfony and Laravel route
//!   names no route defines; [`views`]: Laravel view names no view file
//!   has; [`laravel`]: undefined Laravel configuration keys, environment
//!   keys, translations and Vite assets); [`PhpEngine::set_inspections`] replaces the
//!   set, and [`PhpEngine::configure_inspections`] builds it from the
//!   settings ([`InspectionConfig`]: the inspection profile in effect, where
//!   the engine's inspections are `lsp:php:<Id>`, turned off or with their
//!   type checks set to strict).
//! - [`PhpEngine::inspect_file`] inspects any file, for batch Inspect Code.
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
//!   import actions and the context actions on a declaration's signature
//!   ([`intentions`]: add a return or parameter type, add or update the
//!   PHPDoc). The fixes the inspections attach (create a missing member or
//!   class, initialize a variable, remove an unused variable or import) are
//!   in [`fixes`].
//!
//! The model follows IntelliJ's public description of code inspections
//! (`https://plugins.jetbrains.com/docs/intellij/code-inspections.html`):
//! a short name, a default level, a visitor and quick-fixes.

pub mod calls;
pub mod control;
pub(crate) mod fixes;
pub(crate) mod intentions;
pub mod laravel;
pub mod level;
pub mod members;
pub mod routes;
pub(crate) mod runner;
pub mod suppress;
#[cfg(test)]
mod tests;
pub mod undefined;
pub mod unused;
pub mod variables;
pub mod views;

use std::collections::{BTreeMap, BTreeSet};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use ide_core::inspection_settings::InspectionOverride;
use ide_core::settings::Settings;
use ide_core::{CancellationToken, Diagnostic, DocId, Range, Severity, TextEdit, WorkspaceEdit};

use crate::engine::PhpEngine;
use crate::imports::{ImportAction, QUICKFIX, REWRITE, file_edit, wanted};
use crate::names::FileNames;
use crate::summary::FileSummary;
use crate::syntax::{DIAGNOSTIC_SOURCE, ParsedFile};
use crate::types::{ExprTypes, Resolver, Type};

pub use calls::TypeCheckMode;
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
        Self::builtin_with(TypeCheckMode::default())
    }

    /// The engine's own inspections, the call and type checks in `mode`.
    pub fn builtin_with(mode: TypeCheckMode) -> Self {
        Self::builtin_modes(&|_| mode)
    }

    /// The engine's own inspections as the settings configure them: the
    /// disabled ones left out, the call and type checks each in its mode.
    pub fn configured(config: &InspectionConfig) -> Self {
        let all = Self::builtin_modes(&|id| config.mode(id));
        Self::new(all.list.into_iter().filter(|i| config.enabled(i.id())).collect())
    }

    /// The engine's own inspections, each call and type check in the mode
    /// `mode` gives for its id.
    fn builtin_modes(mode: &dyn Fn(&'static str) -> TypeCheckMode) -> Self {
        let mut list: Vec<Arc<dyn Inspection>> = vec![
            Arc::new(undefined::UndefinedClass),
            Arc::new(undefined::UndefinedFunction),
            Arc::new(undefined::UndefinedConstant),
            Arc::new(members::UndefinedMethod),
            Arc::new(members::UndefinedField),
            Arc::new(members::UndefinedClassConstant),
            Arc::new(variables::UndefinedVariable),
            Arc::new(variables::UnusedVariable),
            Arc::new(calls::ArgumentCount { mode: mode("PhpMethodParametersCountMismatch") }),
            Arc::new(calls::NamedArgument { mode: mode("PhpUnknownNamedArgument") }),
            Arc::new(calls::ArgumentType { mode: mode("PhpParams") }),
            Arc::new(calls::ReturnType { mode: mode("PhpIncompatibleReturnType") }),
            Arc::new(calls::PropertyType { mode: mode("PhpFieldAssignmentTypeMismatch") }),
            Arc::new(unused::UnusedImport),
            Arc::new(unused::UnusedPrivateMethod),
            Arc::new(unused::UnusedPrivateField),
            Arc::new(unused::UnusedPrivateConstant),
            Arc::new(unused::UnusedParameter),
            Arc::new(control::UnreachableStatement),
            Arc::new(control::MissingReturn),
            Arc::new(control::VoidReturn),
            Arc::new(control::NeverReturn),
            Arc::new(level::LanguageLevel),
            Arc::new(level::Deprecation),
            Arc::new(routes::UndefinedRoute),
            Arc::new(views::UndefinedView),
        ];
        for inspection in laravel::UndefinedReference::all() {
            list.push(Arc::new(inspection));
        }
        Self::new(list)
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

/// The inspection id the profile (Settings › Editor › Inspections) stores
/// the engine's settings under: the engine's diagnostics arrive from the
/// producer `php`, so `lsp:php` is all of them and `lsp:php:<Id>` one
/// inspection (`producerInspectionId` / `codeInspectionId` in
/// `src/platform/inspections.ts`).
pub const PROFILE_ID: &str = "lsp:php";

/// The option that turns a call or type inspection to
/// [`TypeCheckMode::Strict`] (Settings › PHP › Inspections).
pub const STRICT_OPTION: &str = "strict";

/// What the settings change about the engine's inspections. The severities
/// the profile sets are applied by the UI, like those of every other
/// producer; the engine leaves out the disabled inspections, which then
/// cost nothing, and runs the type checks in their mode.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InspectionConfig {
    /// Every inspection is off (`lsp:php` disabled).
    pub all_disabled: bool,
    /// Ids of the inspections turned off.
    pub disabled: BTreeSet<String>,
    /// Ids of the call and type inspections in strict mode.
    pub strict: BTreeSet<String>,
}

impl InspectionConfig {
    /// From the overrides of an inspection profile.
    pub fn from_profile(overrides: &BTreeMap<String, InspectionOverride>) -> Self {
        let mut config = Self {
            all_disabled: overrides.get(PROFILE_ID).is_some_and(|o| o.enabled == Some(false)),
            ..Self::default()
        };
        let prefix = format!("{PROFILE_ID}:");
        for (key, o) in overrides {
            let Some(id) = key.strip_prefix(&prefix) else { continue };
            if o.enabled == Some(false) {
                config.disabled.insert(id.to_owned());
            }
            if o.options.as_ref().and_then(|options| options.get(STRICT_OPTION)) == Some(&true) {
                config.strict.insert(id.to_owned());
            }
        }
        config
    }

    /// From the profile in effect in `settings`.
    pub fn from_settings(settings: &Settings) -> Self {
        Self::from_profile(settings.inspections.active_overrides())
    }

    pub fn enabled(&self, id: &str) -> bool {
        !self.all_disabled && !self.disabled.contains(id)
    }

    pub fn mode(&self, id: &str) -> TypeCheckMode {
        if self.strict.contains(id) { TypeCheckMode::Strict } else { TypeCheckMode::Lenient }
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
    /// The file's expression types and flows, shared by all inspections
    /// (with the names and summary they were built on).
    types: &'a ExprTypes<'a, 'a>,
    members: OnceLock<Vec<members::Found>>,
    variables: OnceLock<Vec<variables::Found>>,
    calls: OnceLock<Vec<calls::Found>>,
    unused: OnceLock<Vec<unused::Found>>,
    control: OnceLock<Vec<control::Found>>,
}

impl<'a> InspectionContext<'a> {
    pub fn new(
        engine: &'a PhpEngine,
        parsed: &'a ParsedFile,
        path: &'a Path,
        cancel: &'a CancellationToken,
        types: &'a ExprTypes<'a, 'a>,
    ) -> Self {
        Self {
            engine,
            parsed,
            path,
            cancel,
            types,
            members: OnceLock::new(),
            variables: OnceLock::new(),
            calls: OnceLock::new(),
            unused: OnceLock::new(),
            control: OnceLock::new(),
        }
    }

    /// The file's resolved names (computed once for all inspections).
    pub fn names(&self) -> &'a FileNames {
        self.types.names()
    }

    /// The file's declarations (computed once for all inspections).
    pub fn summary(&self) -> &'a FileSummary {
        self.types.summary()
    }

    /// The file's expression types, with the flow graph of each
    /// function-like built once for all inspections.
    pub fn types(&self) -> &'a ExprTypes<'a, 'a> {
        self.types
    }

    /// The file's undefined members (computed once for the three member
    /// inspections).
    pub(crate) fn undefined_members(&self) -> &[members::Found] {
        self.members.get_or_init(|| members::find(self))
    }

    /// The file's variable problems (computed once for the variable
    /// inspections).
    pub(crate) fn variables(&self) -> &[variables::Found] {
        self.variables.get_or_init(|| variables::find(self))
    }

    /// The file's call and type problems, certain or not (computed once for
    /// the call and type inspections).
    pub(crate) fn calls(&self) -> &[calls::Found] {
        self.calls.get_or_init(|| calls::find(self))
    }

    /// The file's unused private members (computed once for the three
    /// private member inspections).
    pub(crate) fn unused_members(&self) -> &[unused::Found] {
        self.unused.get_or_init(|| unused::find(self))
    }

    /// The file's control-flow problems (computed once for the four
    /// control-flow inspections).
    pub(crate) fn control(&self) -> &[control::Found] {
        self.control.get_or_init(|| control::find(self))
    }

    pub fn resolver(&self) -> Resolver<'a> {
        self.engine.resolver()
    }

    /// The type of the innermost expression at byte `offset`.
    pub fn type_at(&self, offset: u32) -> Option<Type> {
        let (expr, frames) = self.types.find(offset)?;
        Some(self.types.type_of(expr, &frames).widen())
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

    /// Applies the inspection settings (the profile in effect). Open
    /// documents are inspected again only when the configuration changed.
    pub fn configure_inspections(&self, config: InspectionConfig) {
        {
            let mut current = self.shared_inspection_config().lock();
            if *current == config {
                return;
            }
            *current = config.clone();
        }
        self.set_inspections(Inspections::configured(&config));
    }

    /// Runs every inspection over the current version of an open document.
    /// `None` when the engine doesn't hold it or `cancel` fired.
    pub fn inspect(&self, doc: DocId, cancel: &CancellationToken) -> Option<Inspected> {
        let document = self.open_documents().into_iter().find(|d| d.doc == doc && !d.embedded)?;
        let parsed = self.parse_open(&document);
        let (diagnostics, problems) = self.run_inspections(&parsed, &document.path, cancel)?;
        Some(Inspected { doc, version: document.version, path: document.path.clone(), diagnostics, problems })
    }

    /// Batch Inspect Code: the diagnostics of the file `path`, whose text is
    /// `text` (the file on disk; when the engine holds the file as an open
    /// document, its buffer and background result are used instead). Run
    /// it once indexing finished, or the checks that need other files stay
    /// quiet. `None` when `cancel` fired.
    pub fn inspect_file(&self, path: &Path, text: &str, cancel: &CancellationToken) -> Option<Vec<Diagnostic>> {
        if let Some(document) = self.open_document(path) {
            return self.inspected(document.doc).map(|inspected| inspected.diagnostics.clone());
        }
        let path = crate::project::normalize(path);
        let parsed = ParsedFile::parse(&path.to_string_lossy(), text);
        self.run_inspections(&parsed, &path, cancel).map(|(diagnostics, _)| diagnostics)
    }

    /// The parser's syntax errors and the problems of every inspection, the
    /// suppressed ones dropped.
    fn run_inspections(
        &self,
        parsed: &ParsedFile,
        path: &Path,
        cancel: &CancellationToken,
    ) -> Option<(Vec<Diagnostic>, Vec<Problem>)> {
        let inspections = self.inspections();
        // One set of names, declarations and flow graphs for every
        // inspection, rather than one per inspection family.
        let names = FileNames::resolve(parsed);
        let summary = FileSummary::extract(parsed);
        let resolver = self.resolver();
        let types = ExprTypes::new(parsed, &names, &summary, &resolver);
        let cx = InspectionContext::new(self, parsed, path, cancel, &types);
        let mut problems = Problems::new(parsed);
        for inspection in inspections.iter() {
            if cancel.is_cancelled() {
                return None;
            }
            problems.begin(inspection.as_ref());
            let before = problems.items.len();
            let ran = catch_unwind(AssertUnwindSafe(|| inspection.check(&cx, &mut problems)));
            if ran.is_err() {
                tracing::warn!("php inspection {} panicked on {}", inspection.id(), path.display());
                problems.items.truncate(before);
            }
        }
        if cancel.is_cancelled() {
            return None;
        }
        let mut problems = problems.items;
        if !problems.is_empty() {
            let suppressions = Suppressions::scan(parsed);
            problems.retain(|p| !suppressions.suppresses(p.inspection, p.start));
            for problem in &mut problems {
                if let Some(fix) = suppressions.suppress_fix(parsed, path, problem.inspection, problem.start) {
                    problem.fixes.push(fix);
                }
            }
        }
        problems.sort_by_key(|p| (p.start, p.end));
        let mut diagnostics = parsed.diagnostics();
        diagnostics.extend(problems.iter().map(Problem::to_diagnostic));
        Some((diagnostics, problems))
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
    /// actions, then the context actions on a declaration it touches, then
    /// Extract variable / constant / method, Inline, and Generate.
    /// Filtered by `only` (code action kinds). `None` when the engine
    /// doesn't hold the document.
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
        if wanted(only, REWRITE) {
            let parsed = self.parsed_document(doc)?;
            let path = self.document_path(doc)?;
            let (start, end) = parsed.line_index().byte_range(range);
            out.extend(intentions::intentions(self, &parsed, &path, start, end));
            out.extend(self.validation_intentions(&parsed, &path, start, end));
        }
        if [
            crate::refactor::EXTRACT_VARIABLE,
            crate::refactor::EXTRACT_CONSTANT,
            crate::refactor::EXTRACT_METHOD,
            crate::refactor::EXTRACT_FUNCTION,
        ]
        .iter()
        .any(|kind| wanted(only, kind))
        {
            let parsed = self.parsed_document(doc)?;
            let path = self.document_path(doc)?;
            let (start, end) = parsed.line_index().byte_range(range);
            out.extend(crate::refactor::extract_actions(self, &parsed, &path, start, end, only));
        }
        if [crate::refactor::INLINE_VARIABLE, crate::refactor::INLINE_METHOD, crate::refactor::INLINE_FUNCTION]
            .iter()
            .any(|kind| wanted(only, kind))
        {
            let parsed = self.parsed_document(doc)?;
            let path = self.document_path(doc)?;
            let (start, end) = parsed.line_index().byte_range(range);
            out.extend(crate::refactor::inline_actions(self, &parsed, &path, start, end, only));
        }
        if crate::refactor::GENERATE_KINDS.iter().any(|kind| wanted(only, kind)) {
            let parsed = self.parsed_document(doc)?;
            let path = self.document_path(doc)?;
            let (start, end) = parsed.line_index().byte_range(range);
            out.extend(crate::refactor::generate_actions(self, &parsed, &path, start, end, only));
        }
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
