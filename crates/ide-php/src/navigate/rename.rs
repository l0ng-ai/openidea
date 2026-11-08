//! Rename ([`PhpEngine::prepare_rename`], [`PhpEngine::rename`]).
//!
//! What the caret is on is worked out as for goto ([`super::symbol`]), and
//! the places to change are its usages ([`super::references`]), with the
//! declarations, PHPDoc types and string literals naming a class included.
//! On top of find usages a rename also takes:
//!
//! - for a non-private method, property or class constant, the whole
//!   hierarchy: the declarations it overrides (up to the topmost ones) and
//!   every declaration overriding those in the subtypes, so an interface
//!   method, its implementations and the calls through any of them change
//!   together (IntelliJ's documented "rename in hierarchy" behaviour);
//! - for a promoted constructor parameter, both the property (`$this->x`,
//!   `$o->x`) and the parameter (its variable in the constructor and the
//!   named arguments of `new Foo(x: …)`), whichever the caret is on;
//! - for a parameter or variable, `$name` in the PHPDoc of its function or
//!   method (`@param T $name`) and in the docblocks inside it (`@var`).
//!
//! Only the last segment of a qualified name is replaced (`use App\Book;`,
//! `\App\Book`, `'App\\Book'`), and a usage written through an alias
//! (`use App\Book as Volume;`) keeps the alias. A class renamed in a file
//! named after it (`Book.php`, the PSR-4 convention) that declares nothing
//! else also renames the file. Built-in declarations (the bundled stubs) and
//! those of `vendor/` can't be renamed, nor can `$this`, the superglobals,
//! magic methods or `self`/`static`/`parent`.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use ide_core::{CancellationToken, DocId, FileEdit, IdeError, IdeResult, Pos, Range, TextEdit, WorkspaceEdit};
use mago_syntax::cst::TriviaKind;

use super::hierarchy::Subtypes;
use super::references::{Sought, UsageKind};
use super::short_name;
use super::symbol::{Decl, MemberKind, Subject, file_text};
use crate::engine::PhpEngine;
use crate::index::path_key;
use crate::names::{NameKind, fqn_eq};
use crate::summary::{FileSummary, Visibility};
use crate::syntax::{LineIndex, ParsedFile};
use crate::types::model::MemberInfo;
use crate::types::{ClassModel, Resolver};

/// Methods PHP calls by name: renaming them changes behaviour.
const MAGIC_METHODS: &[&str] = &[
    "__construct",
    "__destruct",
    "__call",
    "__callstatic",
    "__get",
    "__set",
    "__isset",
    "__unset",
    "__sleep",
    "__wakeup",
    "__serialize",
    "__unserialize",
    "__tostring",
    "__invoke",
    "__set_state",
    "__clone",
    "__debuginfo",
];

/// Variables PHP defines.
const PREDEFINED_VARIABLES: &[&str] =
    &["this", "GLOBALS", "_SERVER", "_GET", "_POST", "_FILES", "_COOKIE", "_SESSION", "_REQUEST", "_ENV"];

/// Names a class-like can't have (reserved words and type names).
const RESERVED_CLASS_NAMES: &[&str] = &[
    "self",
    "static",
    "parent",
    "array",
    "bool",
    "callable",
    "false",
    "float",
    "int",
    "iterable",
    "mixed",
    "never",
    "null",
    "object",
    "string",
    "true",
    "void",
    "list",
    "class",
    "interface",
    "trait",
    "enum",
    "function",
    "new",
    "namespace",
    "use",
    "abstract",
    "final",
    "readonly",
    "match",
    "fn",
    "resource",
    "numeric",
];

/// What kind of declaration a rename changes; it decides which new names
/// are valid.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RenameKind {
    ClassLike,
    Function,
    Constant,
    Member(MemberKind),
    /// A variable or parameter.
    Variable,
}

impl RenameKind {
    fn of(decl: &Decl) -> Self {
        match decl {
            Decl::ClassLike(_) => RenameKind::ClassLike,
            Decl::Function(_) => RenameKind::Function,
            Decl::Constant(_) => RenameKind::Constant,
            Decl::Member(member) => RenameKind::Member(member.kind),
            Decl::Parameter { .. } => RenameKind::Variable,
            // Refused before the kind matters.
            Decl::Magic(magic) if magic.member.is_method() => RenameKind::Member(MemberKind::Method),
            Decl::Magic(_) => RenameKind::Member(MemberKind::Property),
        }
    }

    /// Written with a `$` in front.
    fn has_dollar(self) -> bool {
        matches!(self, RenameKind::Variable | RenameKind::Member(MemberKind::Property))
    }
}

/// A rename the caret allows.
struct Renaming {
    kind: RenameKind,
    /// The current name, without `$` or a namespace.
    old: String,
    /// The name under the caret (without `$` or a namespace).
    range: Range,
    subject: Subject,
}

/// The byte range of the bare name in `written`: after the last `\`, without
/// a leading `$`.
fn bare_name(written: &str) -> (usize, &str) {
    let mut start = written.rfind('\\').map_or(0, |i| i + 1);
    if written[start..].starts_with('$') {
        start += 1;
    }
    (start, &written[start..])
}

/// Whether `name` is a PHP identifier.
pub(crate) fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c == '_' || c.is_alphabetic() || !c.is_ascii())
        && chars.all(|c| c == '_' || c.is_alphanumeric() || !c.is_ascii())
}

/// The new name to write, or why it isn't valid.
fn checked_name(kind: RenameKind, new_name: &str) -> IdeResult<String> {
    let mut name = new_name.trim();
    if kind.has_dollar() {
        name = name.strip_prefix('$').unwrap_or(name);
    }
    if !is_identifier(name) {
        return Err(IdeError::invalid(format!("'{}' is not a valid PHP identifier", new_name.trim())));
    }
    let lower = name.to_ascii_lowercase();
    match kind {
        RenameKind::ClassLike if RESERVED_CLASS_NAMES.contains(&lower.as_str()) => {
            Err(IdeError::invalid(format!("'{name}' is reserved and can't name a class")))
        }
        RenameKind::Variable if PREDEFINED_VARIABLES.contains(&name) => {
            Err(IdeError::invalid(format!("'${name}' is a predefined variable")))
        }
        RenameKind::Member(MemberKind::Constant) if lower == "class" => {
            Err(IdeError::invalid("'class' can't name a class constant"))
        }
        _ => Ok(name.to_owned()),
    }
}

fn member_info<'m>(model: &'m ClassModel, kind: MemberKind, name: &str) -> Option<&'m MemberInfo> {
    match kind {
        MemberKind::Method => model.method(name).map(|m| &m.info),
        MemberKind::Property => model.property(name).map(|p| &p.info),
        MemberKind::Constant => model.constant(name).map(|c| &c.info),
    }
}

/// A key telling two sought declarations apart.
fn sought_key(sought: &Sought) -> String {
    format!("{sought:?}").to_ascii_lowercase()
}

impl PhpEngine {
    /// The range of the name a rename at `pos` in an open document would
    /// change (without `$` or a namespace). The outer `None` when the engine
    /// doesn't hold the document; the inner one when there is nothing there
    /// that can be renamed.
    pub fn prepare_rename(&self, doc: DocId, pos: Pos) -> Option<Option<Range>> {
        let parsed = self.parsed_document(doc)?;
        let path = self.document_path(doc)?;
        if let Some(range) = self.string_ref_prepare_rename(&parsed, &path, parsed.line_index().byte(pos)) {
            return Some(range);
        }
        let here = FileSummary::extract(&parsed);
        Some(self.renaming(&parsed, &path, &here, pos).map(|renaming| renaming.range))
    }

    /// The edit renaming what is at `pos` in an open document to `new_name`
    /// (see the module docs). `None` when the engine doesn't hold the
    /// document; an error when nothing there can be renamed or the name isn't
    /// valid.
    pub fn rename(
        &self,
        doc: DocId,
        pos: Pos,
        new_name: &str,
        cancel: &CancellationToken,
    ) -> Option<IdeResult<WorkspaceEdit>> {
        let parsed = self.parsed_document(doc)?;
        let path = self.document_path(doc)?;
        if let Some(edit) = self.string_ref_rename(&parsed, &path, parsed.line_index().byte(pos), new_name, cancel) {
            return Some(edit);
        }
        let here = FileSummary::extract(&parsed);
        let Some(renaming) = self.renaming(&parsed, &path, &here, pos) else {
            return Some(Err(IdeError::invalid("nothing that can be renamed at the caret")));
        };
        Some(self.rename_edit(renaming, &path, &here, new_name, cancel))
    }

    /// Whether `path` is the bundled stubs' or a Composer package's.
    pub(crate) fn is_library(&self, path: &Path) -> bool {
        let key = path_key(path);
        if key.starts_with(&path_key(&self.stub_dir())) {
            return true;
        }
        self.layout().is_some_and(|layout| key.starts_with(&format!("{}/", path_key(layout.vendor_dir()))))
    }

    fn renaming(&self, parsed: &ParsedFile, path: &Path, here: &FileSummary, pos: Pos) -> Option<Renaming> {
        let resolver = self.resolver();
        let offset = parsed.line_index().byte(pos);
        let found = self.at_caret(parsed, here, &resolver, offset)?;
        let line_index = parsed.line_index();
        let (start, end) = line_index.byte_range(found.range);
        let written = parsed.text().get(start as usize..end as usize)?;
        let (bare_start, bare) = bare_name(written);
        let range = line_index.range(start + bare_start as u32, end);
        let kind = match &found.subject {
            Subject::Variable { name, .. } => {
                if PREDEFINED_VARIABLES.contains(&name.as_str()) || bare != name {
                    return None;
                }
                RenameKind::Variable
            }
            Subject::Decls(decls) => {
                // Members only magic methods have are declared nowhere.
                if decls.iter().any(|decl| matches!(decl, Decl::Magic(_))) {
                    return None;
                }
                let first = decls.first()?;
                let kind = RenameKind::of(first);
                if decls.iter().any(|decl| RenameKind::of(decl) != kind) {
                    return None;
                }
                for decl in decls {
                    let declared = match decl {
                        Decl::ClassLike(fqn) | Decl::Function(fqn) | Decl::Constant(fqn) => short_name(fqn),
                        Decl::Member(member) => member.name.as_str(),
                        Decl::Parameter { name, .. } => name.as_str(),
                        Decl::Magic(_) => return None,
                    };
                    // `self`, an alias, or a name the caret isn't on.
                    if !bare.eq_ignore_ascii_case(declared.trim_start_matches('$')) {
                        return None;
                    }
                    if let Decl::Member(member) = decl
                        && member.kind == MemberKind::Method
                        && MAGIC_METHODS.contains(&member.name.to_ascii_lowercase().as_str())
                    {
                        return None;
                    }
                    let targets = self.decl_targets(decl, path, here);
                    if targets.is_empty() || targets.iter().any(|target| self.is_library(&target.path)) {
                        return None;
                    }
                    // A member overriding a built-in or a package's one.
                    if let Decl::Member(member) = decl
                        && let Some(info) = member.info()
                        && info.visibility != Visibility::Private
                        && self
                            .member_roots(&resolver, member.kind, &member.name, &info.declaring.fqn)
                            .iter()
                            .any(|(_, library)| *library)
                    {
                        return None;
                    }
                }
                kind
            }
        };
        Some(Renaming { kind, old: bare.to_owned(), range, subject: found.subject })
    }

    /// The class-likes above `declaring` that declare the member themselves
    /// (not private), each with whether it is library code.
    pub(crate) fn member_roots(
        &self,
        resolver: &Resolver<'_>,
        kind: MemberKind,
        name: &str,
        declaring: &str,
    ) -> Vec<(String, bool)> {
        let Some(model) = resolver.class_model(declaring) else { return Vec::new() };
        let mut out = Vec::new();
        for ancestor in model.parents.iter().chain(&model.interfaces) {
            let Some(ancestor_model) = resolver.class_model(ancestor) else { continue };
            let Some(info) = member_info(&ancestor_model, kind, name) else { continue };
            if info.visibility == Visibility::Private || !fqn_eq(NameKind::ClassLike, &info.declaring.fqn, ancestor) {
                continue;
            }
            let library = self
                .source_path(
                    NameKind::ClassLike,
                    ancestor,
                    ancestor_model.class.name_loc,
                    Path::new(""),
                    &FileSummary::default(),
                )
                .is_none_or(|path| self.is_library(&path));
            out.push((ancestor.clone(), library));
        }
        out
    }

    /// Every class-like declaring the member in its hierarchy: the topmost
    /// declarations above `declaring` and the overriding ones below them.
    pub(crate) fn member_family(
        &self,
        subtypes: &Subtypes,
        kind: MemberKind,
        name: &str,
        declaring: &str,
        cancel: &CancellationToken,
    ) -> IdeResult<Vec<String>> {
        let resolver = self.resolver();
        let mut tops = vec![declaring.to_owned()];
        tops.extend(self.member_roots(&resolver, kind, name, declaring).into_iter().map(|(fqn, _)| fqn));
        let mut family = tops.clone();
        for top in &tops {
            for subtype in subtypes.all(self, top, cancel)? {
                let Some(model) = resolver.class_model(&subtype.class.fqn) else { continue };
                let Some(info) = member_info(&model, kind, name) else { continue };
                if info.visibility != Visibility::Private {
                    family.push(info.declaring.fqn.clone());
                }
            }
        }
        let mut seen = HashSet::new();
        family.retain(|fqn| seen.insert(fqn.trim_start_matches('\\').to_ascii_lowercase()));
        Ok(family)
    }

    /// The sought declarations of find usages, widened to the hierarchy and
    /// to both sides of promoted constructor parameters.
    fn rename_sought(
        &self,
        subject: Subject,
        path: &Path,
        here: &FileSummary,
        cancel: &CancellationToken,
    ) -> IdeResult<Vec<Sought>> {
        let mut out = self.sought(subject, path, here);
        // A promoted parameter: its property.
        for sought in out.clone() {
            if let Sought::Parameter { owner, name } = &sought
                && let Sought::Member { kind: MemberKind::Method, name: method, declaring, .. } = owner.as_ref()
                && method.eq_ignore_ascii_case("__construct")
                && let Some(model) = self.class_model(declaring)
                && let Some(property) = model.property(name)
                && property.declared().is_some_and(|p| p.is_promoted)
                && fqn_eq(NameKind::ClassLike, &property.declaring.fqn, declaring)
            {
                out.push(Sought::Member {
                    kind: MemberKind::Property,
                    name: name.clone(),
                    declaring: declaring.clone(),
                    private: property.visibility == Visibility::Private,
                });
            }
        }
        // Members: the whole hierarchy.
        let subtypes = Subtypes::new(self);
        for sought in out.clone() {
            if let Sought::Member { kind, name, declaring, private: false } = &sought {
                for fqn in self.member_family(&subtypes, *kind, name, declaring, cancel)? {
                    out.push(Sought::Member { kind: *kind, name: name.clone(), declaring: fqn, private: false });
                }
            }
        }
        // A promoted property: its parameter, in the body and at named arguments.
        for sought in out.clone() {
            let Sought::Member { kind: MemberKind::Property, name, declaring, .. } = &sought else { continue };
            let Some(model) = self.class_model(declaring) else { continue };
            let Some(property) = model.property(name) else { continue };
            let Some(declared) = property.declared().filter(|p| p.is_promoted) else { continue };
            if !fqn_eq(NameKind::ClassLike, &property.declaring.fqn, declaring) {
                continue;
            }
            let Some(file) = self.class_path(&property.declaring, path, here) else { continue };
            out.push(Sought::Variable {
                file: path_key(&file),
                name: name.clone(),
                declaration: declared.name_loc.range,
            });
            let constructor = Sought::Member {
                kind: MemberKind::Method,
                name: "__construct".into(),
                declaring: declaring.clone(),
                private: false,
            };
            out.push(Sought::Parameter { owner: Box::new(constructor), name: name.clone() });
        }
        let mut seen = HashSet::new();
        out.retain(|sought| seen.insert(sought_key(sought)));
        Ok(out)
    }

    fn rename_edit(
        &self,
        renaming: Renaming,
        path: &Path,
        here: &FileSummary,
        new_name: &str,
        cancel: &CancellationToken,
    ) -> IdeResult<WorkspaceEdit> {
        let new = checked_name(renaming.kind, new_name)?;
        if new == renaming.old {
            return Ok(WorkspaceEdit::default());
        }
        let sought = self.rename_sought(renaming.subject, path, here, cancel)?;
        let usages = self.find_usages(&sought, path, here, true, cancel)?;

        // Edits by file, in a stable order.
        let mut files: BTreeMap<String, (PathBuf, Vec<TextEdit>)> = BTreeMap::new();
        let mut texts: BTreeMap<String, Option<String>> = BTreeMap::new();
        let mut declared_in: Vec<PathBuf> = Vec::new();
        for usage in &usages {
            if self.is_library(&usage.path) {
                continue;
            }
            let key = path_key(&usage.path);
            let text = texts.entry(key.clone()).or_insert_with(|| file_text(self, &usage.path));
            let Some(text) = text.as_deref() else { continue };
            let line_index = LineIndex::new(text);
            let (start, end) = line_index.byte_range(usage.range);
            let Some(written) = text.get(start as usize..end as usize) else { continue };
            let (bare_start, bare) = bare_name(written);
            // Written through an alias (or otherwise not by this name).
            if !bare.eq_ignore_ascii_case(&renaming.old) {
                continue;
            }
            if usage.kind == UsageKind::Declaration && !declared_in.contains(&usage.path) {
                declared_in.push(usage.path.clone());
            }
            let range = line_index.range(start + bare_start as u32, end);
            let edits = &mut files.entry(key).or_insert_with(|| (usage.path.clone(), Vec::new())).1;
            edits.push(TextEdit { range, new_text: new.clone() });
        }

        // `$name` in the docblocks of parameters' and variables' functions.
        for sought in &sought {
            let Sought::Variable { file, name, declaration } = sought else { continue };
            let file_path = crate::index::key_path(file);
            let file_path = self.open_document(&file_path).map_or(file_path, |document| document.path);
            if self.is_library(&file_path) {
                continue;
            }
            let key = path_key(&file_path);
            let text = texts.entry(key.clone()).or_insert_with(|| file_text(self, &file_path));
            let Some(text) = text.as_deref() else { continue };
            let line_index = LineIndex::new(text);
            for (start, end) in doc_variable_names(text, &key, name, *declaration) {
                let range = line_index.range(start, end);
                let edits = &mut files.entry(key.clone()).or_insert_with(|| (file_path.clone(), Vec::new())).1;
                edits.push(TextEdit { range, new_text: new.clone() });
            }
        }

        let mut edit = WorkspaceEdit::default();
        for (_, (file, mut edits)) in files {
            edits.sort_by_key(|edit| (edit.range.start, edit.range.end));
            edits.dedup_by(|b, a| a.range == b.range);
            edit.files.push(FileEdit::Edit { path: file.into(), edits, version: None });
        }

        // A class in a file named after it: the file too.
        if renaming.kind == RenameKind::ClassLike {
            for file in declared_in {
                if let Some(rename) = self.class_file_rename(&file, &renaming.old, &new, &mut texts) {
                    edit.files.push(rename);
                }
            }
        }
        Ok(edit)
    }

    /// Renames `file` (`Old.php` → `New.php`) when it is named after the
    /// class and declares no other class-like, function or constant.
    fn class_file_rename(
        &self,
        file: &Path,
        old: &str,
        new: &str,
        texts: &mut BTreeMap<String, Option<String>>,
    ) -> Option<FileEdit> {
        let stem = file.file_stem()?.to_str()?;
        if stem != old || file.extension()?.to_str()? != "php" {
            return None;
        }
        let key = path_key(file);
        let text = texts.entry(key.clone()).or_insert_with(|| file_text(self, file)).as_deref()?;
        let summary = FileSummary::extract(&ParsedFile::parse(&key, text));
        if summary.class_likes.len() != 1 || !summary.functions.is_empty() || !summary.constants.is_empty() {
            return None;
        }
        let to = file.with_file_name(format!("{new}.php"));
        // Another file by that name (not this one under another case).
        if to.exists() && !stem.eq_ignore_ascii_case(new) {
            return None;
        }
        Some(FileEdit::Rename { from: file.into(), to: to.into() })
    }
}

/// The byte ranges of `name` (after its `$`) in the docblocks belonging to
/// the scope of a variable declared at `declaration`: the docblock in front
/// of its function or method (`@param T $name`) and those inside it
/// (`@var T $name`). Nothing for a variable outside any function.
pub(crate) fn doc_variable_names(text: &str, file: &str, name: &str, declaration: Range) -> Vec<(u32, u32)> {
    let parsed = ParsedFile::parse(file, text);
    let summary = FileSummary::extract(&parsed);
    let at = parsed.line_index().byte(declaration.start);
    let scopes = summary
        .functions
        .iter()
        .map(|function| function.loc)
        .chain(summary.class_likes.iter().flat_map(|class| class.methods.iter().map(|method| method.loc)));
    let Some(scope) = scopes.filter(|loc| loc.start <= at && at <= loc.end).min_by_key(|loc| loc.end - loc.start)
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let program = parsed.program();
    for trivia in program.trivia.iter().filter(|trivia| trivia.kind == TriviaKind::DocBlockComment) {
        let (start, end) = (trivia.span.start.offset, trivia.span.end.offset);
        let inside = scope.start <= start && end <= scope.end;
        let before =
            end <= scope.start && text.get(end as usize..scope.start as usize).is_some_and(|gap| gap.trim().is_empty());
        if !inside && !before {
            continue;
        }
        let doc = &text[start as usize..end as usize];
        let wanted = format!("${name}");
        let mut from = 0;
        while let Some(i) = doc[from..].find(&wanted) {
            let at = from + i;
            let after = doc[at + wanted.len()..].chars().next();
            from = at + wanted.len();
            if after.is_some_and(|c| c == '_' || c.is_alphanumeric() || !c.is_ascii()) {
                continue;
            }
            let name_start = start + at as u32 + 1;
            out.push((name_start, name_start + name.len() as u32));
        }
    }
    out
}

#[cfg(test)]
mod name_tests {
    use super::*;

    #[test]
    fn names_are_checked_by_kind() {
        assert_eq!(checked_name(RenameKind::Variable, "$total").unwrap(), "total");
        assert_eq!(checked_name(RenameKind::Member(MemberKind::Property), " count ").unwrap(), "count");
        assert!(checked_name(RenameKind::ClassLike, "$Book").is_err(), "no `$` on a class");
        assert!(checked_name(RenameKind::ClassLike, "App\\Book").is_err(), "moving is another refactoring");
        assert!(checked_name(RenameKind::ClassLike, "static").is_err());
        assert!(checked_name(RenameKind::Function, "9lives").is_err());
        assert!(checked_name(RenameKind::Variable, "this").is_err());
        assert_eq!(checked_name(RenameKind::Function, "größe").unwrap(), "größe");
        assert_eq!(bare_name(r"\App\Model\Book"), (11, "Book"));
        assert_eq!(bare_name("$total"), (1, "total"));
        assert_eq!(bare_name(r"App\\Model\\Book"), (12, "Book"));
    }
}
