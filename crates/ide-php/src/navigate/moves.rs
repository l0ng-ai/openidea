//! Move file or class ([`PhpEngine::file_moves_edit`]).
//!
//! When PHP files (or folders holding them) move inside the project's
//! autoload roots, the namespace a moved file should declare is the one its
//! new directory stands for (PSR-4/PSR-0, `AutoloadMap::namespace_of_dir`).
//! A file renamed after the one class-like it declares (`Book.php` →
//! `Volume.php`) renames that class too. Every class-like, function and
//! constant of the moved file then has a new fully qualified name, and the
//! edit, in terms of the paths before the move (as `workspace/willRenameFiles`
//! answers), keeps the project working:
//!
//! - the moved file's `namespace` statement is changed (added to a file in
//!   the global namespace, removed when it moves to the global one), and the
//!   names it wrote relative to its old namespace (`new Author()` meaning
//!   `App\Model\Author`) get a `use` import, so they keep their meaning;
//! - in every file mentioning a moved declaration (candidates from the word
//!   index, then each name resolved again): `use` imports are rewritten,
//!   fully qualified names (`\App\Model\Book`) are rewritten, names written
//!   relative to a namespace get an import, or stay short where the
//!   declaration now lives in the file's own namespace; aliases are kept;
//! - class names in PHPDoc types and string literals naming a moved class
//!   (`'App\\Model\\Book'`) change along.
//!
//! IntelliJ documents the same behaviour for PHP's Move refactoring: the
//! namespace follows the target directory and references and imports are
//! updated. Files in `vendor/` and the bundled stubs are never edited.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Path, PathBuf};

use ide_core::{CancellationToken, FileEdit, IdeError, IdeResult, TextEdit, WorkspaceEdit};
use mago_syntax::cst::TriviaKind;
use rayon::prelude::*;

use super::references::{Sought, UsageKind, doc_type_names};
use super::rename::is_identifier;
use super::symbol::file_text;
use super::{find_declaration, namespace_of, short_name};
use crate::engine::PhpEngine;
use crate::index::{key_path, path_key};
use crate::names::{FileNames, NameKind, NameRole, Resolution, ResolvedName, fqn_eq};
use crate::project::is_php_path;
use crate::summary::FileSummary;
use crate::syntax::{LineIndex, ParsedFile};

/// The edits of one file.
type FileEdits = (PathBuf, Vec<TextEdit>);

/// A declaration whose fully qualified name changes.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Renamed {
    kind: NameKind,
    old: String,
    new: String,
}

/// A moved file whose namespace or class name changes.
#[derive(Clone, Debug)]
struct MovedFile {
    key: String,
    old_ns: String,
    new_ns: String,
}

/// What a set of moves changes.
#[derive(Debug, Default)]
struct Plan {
    files: Vec<MovedFile>,
    renamed: Vec<Renamed>,
}

impl Plan {
    /// The new name of `fqn` when it moves.
    fn target(&self, kind: NameKind, fqn: &str) -> Option<&str> {
        let fqn = fqn.trim_start_matches('\\');
        self.renamed.iter().find(|r| r.kind == kind && fqn_eq(kind, &r.old, fqn)).map(|r| r.new.as_str())
    }

    fn moved(&self, key: &str) -> Option<&MovedFile> {
        self.files.iter().find(|file| file.key == key)
    }
}

fn join_ns(namespace: &str, name: &str) -> String {
    if namespace.is_empty() { name.to_owned() } else { format!("{namespace}\\{name}") }
}

fn ns_eq(a: &str, b: &str) -> bool {
    fqn_eq(NameKind::Namespace, a.trim_matches('\\'), b.trim_matches('\\'))
}

fn starts_with_ignore_case(s: &str, prefix: &str) -> bool {
    s.len() >= prefix.len() && s.is_char_boundary(prefix.len()) && s[..prefix.len()].eq_ignore_ascii_case(prefix)
}

/// The `.php` files below `from`, paired with where they end up below `to`.
fn php_files_below(
    from: &Path,
    to: &Path,
    out: &mut Vec<(PathBuf, PathBuf)>,
    cancel: &CancellationToken,
) -> IdeResult<()> {
    let mut stack = vec![from.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        let mut entries: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
        entries.sort();
        for path in entries {
            if path.is_dir() {
                stack.push(path);
            } else if is_php_path(&path)
                && let Ok(rel) = path.strip_prefix(from)
            {
                out.push((path.clone(), to.join(rel)));
            }
        }
    }
    Ok(())
}

impl PhpEngine {
    /// The edit keeping references intact when files or folders move
    /// (`moves`: from → to, before the move), in terms of the paths before
    /// the move (see the module docs). Empty when no moved PHP file changes
    /// namespace or class name.
    pub fn file_moves_edit(
        &self,
        moves: &[(PathBuf, PathBuf)],
        cancel: &CancellationToken,
    ) -> IdeResult<WorkspaceEdit> {
        let mut pairs = Vec::new();
        for (from, to) in moves {
            if from.is_dir() {
                php_files_below(from, to, &mut pairs, cancel)?;
            } else if is_php_path(from) {
                pairs.push((from.clone(), to.clone()));
            }
        }
        let plan = self.move_plan(&pairs);
        if plan.files.is_empty() {
            return Ok(WorkspaceEdit::default());
        }

        // The moved files and every file mentioning a moved declaration.
        let mut keys: Vec<String> = plan.files.iter().map(|file| file.key.clone()).collect();
        let words: BTreeSet<String> = plan.renamed.iter().map(|r| short_name(&r.old).to_ascii_lowercase()).collect();
        for word in &words {
            keys.extend(self.files_with_word(word)?.iter().map(|path| path_key(path)));
        }
        let stub_dir = path_key(&self.stub_dir());
        let mut seen = HashSet::new();
        keys.retain(|key| seen.insert(key.clone()) && !key.starts_with(&stub_dir) && !self.is_library(&key_path(key)));

        let found: Vec<IdeResult<Option<FileEdits>>> = keys
            .par_iter()
            .map(|key| {
                if cancel.is_cancelled() {
                    return Err(IdeError::cancelled());
                }
                Ok(self.move_edits_in(key, &plan))
            })
            .collect();
        let mut files: BTreeMap<String, (PathBuf, Vec<TextEdit>)> = BTreeMap::new();
        for edits in found {
            if let Some((path, edits)) = edits? {
                files.entry(path_key(&path)).or_insert_with(|| (path, Vec::new())).1.extend(edits);
            }
        }

        // String literals naming a moved class.
        let sought: Vec<Sought> = plan
            .renamed
            .iter()
            .filter(|r| r.kind == NameKind::ClassLike)
            .map(|r| Sought::Name { kind: NameKind::ClassLike, fqn: r.old.clone() })
            .collect();
        if !sought.is_empty() {
            let first = key_path(&plan.files[0].key);
            let usages = self.find_usages(&sought, &first, &FileSummary::default(), false, cancel)?;
            let mut texts: BTreeMap<String, Option<String>> = BTreeMap::new();
            for usage in usages.iter().filter(|usage| usage.kind == UsageKind::String) {
                if self.is_library(&usage.path) {
                    continue;
                }
                let key = path_key(&usage.path);
                let text = texts.entry(key.clone()).or_insert_with(|| file_text(self, &usage.path));
                let Some(text) = text.as_deref() else { continue };
                let line_index = LineIndex::new(text);
                let (start, end) = line_index.byte_range(usage.range);
                let Some(written) = text.get(start as usize..end as usize) else { continue };
                let Some(new_text) = string_spelling(&plan, written) else { continue };
                let edits = &mut files.entry(key).or_insert_with(|| (usage.path.clone(), Vec::new())).1;
                edits.push(TextEdit { range: usage.range, new_text });
            }
        }

        let mut edit = WorkspaceEdit::default();
        for (_, (path, mut edits)) in files {
            edits.sort_by_key(|edit| (edit.range.start, edit.range.end));
            edits.dedup_by(|b, a| a.range == b.range);
            if !edits.is_empty() {
                edit.files.push(FileEdit::Edit { path: path.into(), edits, version: None });
            }
        }
        Ok(edit)
    }

    /// The moved files whose namespace or class name changes, and the
    /// declarations they rename.
    fn move_plan(&self, pairs: &[(PathBuf, PathBuf)]) -> Plan {
        let mut plan = Plan::default();
        let Some(layout) = self.layout() else { return plan };
        for (from, to) in pairs {
            if self.is_library(from) || !is_php_path(to) {
                continue;
            }
            let Some(text) = file_text(self, from) else { continue };
            let key = path_key(from);
            let parsed = ParsedFile::parse(&key, text.as_str());
            let names = FileNames::resolve(&parsed);
            let mut namespaces = namespace_declarations(&names);
            if namespaces.len() > 1 {
                continue;
            }
            let old_ns = namespaces.pop().and_then(|n| n.resolution.primary().map(str::to_owned)).unwrap_or_default();
            let Some(new_ns) = to.parent().and_then(|dir| layout.autoload().namespace_of_dir(dir)) else { continue };
            let summary = FileSummary::extract(&parsed);

            // `Book.php` → `Volume.php` renames the class `Book` it declares.
            let old_stem = from.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
            let new_stem = to.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
            let renamed_class = (old_stem != new_stem
                && is_identifier(new_stem)
                && summary.class_likes.len() == 1
                && summary.class_likes[0].name == old_stem)
                .then(|| summary.class_likes[0].fqn.clone());
            if old_ns == new_ns && renamed_class.is_none() {
                continue;
            }

            let in_old_ns = |fqn: &str| ns_eq(namespace_of(fqn), &old_ns);
            for class in summary.class_likes.iter().filter(|class| in_old_ns(&class.fqn)) {
                let renamed = renamed_class.as_deref().is_some_and(|fqn| fqn_eq(NameKind::ClassLike, fqn, &class.fqn));
                let short = if renamed { new_stem } else { class.name.as_str() };
                plan.renamed.push(Renamed {
                    kind: NameKind::ClassLike,
                    old: class.fqn.clone(),
                    new: join_ns(&new_ns, short),
                });
            }
            if old_ns != new_ns {
                for function in summary.functions.iter().filter(|function| in_old_ns(&function.fqn)) {
                    plan.renamed.push(Renamed {
                        kind: NameKind::Function,
                        old: function.fqn.clone(),
                        new: join_ns(&new_ns, short_name(&function.fqn)),
                    });
                }
                for constant in summary.constants.iter().filter(|constant| in_old_ns(&constant.fqn)) {
                    // `define()` names are global whatever the namespace.
                    if constant.kind == crate::summary::ConstantKind::Define {
                        continue;
                    }
                    plan.renamed.push(Renamed {
                        kind: NameKind::Constant,
                        old: constant.fqn.clone(),
                        new: join_ns(&new_ns, short_name(&constant.fqn)),
                    });
                }
            }
            plan.files.push(MovedFile { key, old_ns, new_ns });
        }
        plan
    }

    /// Whether `fqn` is declared in `summary` or in the index.
    fn is_declared(&self, kind: NameKind, fqn: &str, summary: &FileSummary) -> bool {
        find_declaration(summary, kind, fqn).is_some()
            || self.index().is_some_and(|index| !index.declarations(kind, fqn).unwrap_or_default().is_empty())
    }

    /// The edits of one file (its open buffer, else the file on disk).
    fn move_edits_in(&self, key: &str, plan: &Plan) -> Option<FileEdits> {
        let path = key_path(key);
        let path = self.open_document(&path).map_or(path, |document| document.path);
        let text = file_text(self, &path)?;
        let parsed = ParsedFile::parse(key, text.as_str());
        let names = FileNames::resolve(&parsed);
        let summary = FileSummary::extract(&parsed);
        let mut rewriter = Rewriter {
            engine: self,
            text: &text,
            names: &names,
            summary: &summary,
            plan,
            moved: plan.moved(key),
            single_namespace: namespace_declarations(&names).len() <= 1,
            edits: Vec::new(),
            imports: BTreeMap::new(),
            stuck: Vec::new(),
        };
        for name in names.names() {
            rewriter.name(name);
        }
        rewriter.doc_comments(&parsed);
        rewriter.namespace_and_imports();
        let line_index = parsed.line_index();
        let edits: Vec<TextEdit> = rewriter
            .edits
            .into_iter()
            .map(|(start, end, new_text)| TextEdit { range: line_index.range(start, end), new_text })
            .collect();
        (!edits.is_empty()).then_some((path, edits))
    }
}

fn namespace_declarations(names: &FileNames) -> Vec<&ResolvedName> {
    names.names().iter().filter(|name| name.kind == NameKind::Namespace && name.role == NameRole::Declaration).collect()
}

/// A string literal's contents naming a moved class, spelled with the new
/// name in the same style (leading `\`, doubled separators).
fn string_spelling(plan: &Plan, written: &str) -> Option<String> {
    let doubled = written.contains("\\\\");
    let normalized = if doubled { written.replace("\\\\", "\\") } else { written.to_owned() };
    let leading = normalized.starts_with('\\');
    let target = plan.target(NameKind::ClassLike, &normalized)?;
    let separator = if doubled { "\\\\" } else { "\\" };
    let mut out = target.replace('\\', separator);
    if leading {
        out.insert_str(0, separator);
    }
    (out != written).then_some(out)
}

/// The import kinds in the order they are written.
fn import_order(kind: NameKind) -> u8 {
    match kind {
        NameKind::Function => 1,
        NameKind::Constant => 2,
        _ => 0,
    }
}

/// Rewrites the names of one file.
struct Rewriter<'a> {
    engine: &'a PhpEngine,
    text: &'a str,
    names: &'a FileNames,
    summary: &'a FileSummary,
    plan: &'a Plan,
    moved: Option<&'a MovedFile>,
    /// Imports are only added to files with at most one namespace.
    single_namespace: bool,
    /// `(start, end, new text)` in bytes.
    edits: Vec<(u32, u32, String)>,
    /// Imports to add: `(order, lower-case short name)` → `(kind, fqn)`.
    imports: BTreeMap<(u8, String), (NameKind, String)>,
    /// Moved declarations imported by a group `use` whose prefix doesn't
    /// fit the new name: their short names are written fully qualified.
    stuck: Vec<(NameKind, String)>,
}

impl Rewriter<'_> {
    fn replace(&mut self, name: &ResolvedName, new_text: String) {
        if new_text != name.text {
            self.edits.push((name.start, name.end, new_text));
        }
    }

    /// What `name` resolves to, and its new name when that moves. `None`
    /// when nothing about it can change.
    fn resolved(&self, name: &ResolvedName) -> Option<(String, Option<String>)> {
        let kind = name.kind;
        match &name.resolution {
            Resolution::Fqn(fqn) => Some((fqn.clone(), self.plan.target(kind, fqn).map(str::to_owned))),
            Resolution::Fallback { namespaced, .. } => {
                if let Some(target) = self.plan.target(kind, namespaced) {
                    return Some((namespaced.clone(), Some(target.to_owned())));
                }
                // A namespaced function or constant the moved file relied on.
                (self.moved.is_some() && self.engine.is_declared(kind, namespaced, self.summary))
                    .then(|| (namespaced.clone(), None))
            }
            Resolution::Relative(_) => None,
        }
    }

    fn name(&mut self, name: &ResolvedName) {
        if name.kind == NameKind::Namespace || name.role == NameRole::Alias {
            return;
        }
        let Some((resolved, target)) = self.resolved(name) else { return };
        match name.role {
            NameRole::Declaration => {
                if let Some(target) = target {
                    self.replace(name, short_name(&target).to_owned());
                }
            }
            NameRole::Import => {
                let Some(target) = target else { return };
                let written = name.text.trim_start_matches('\\');
                if fqn_eq(name.kind, written, &resolved) {
                    self.replace(name, target);
                } else {
                    // An item of a group `use`: its prefix must stay valid.
                    let prefix = &resolved[..resolved.len().saturating_sub(written.len())];
                    if !prefix.is_empty() && starts_with_ignore_case(&target, prefix) {
                        self.replace(name, target[prefix.len()..].to_owned());
                    } else {
                        self.stuck.push((name.kind, resolved));
                    }
                }
            }
            NameRole::Reference => self.reference(name, &resolved, target.as_deref()),
            NameRole::Alias => {}
        }
    }

    fn reference(&mut self, name: &ResolvedName, resolved: &str, target: Option<&str>) {
        let written = name.text.as_str();
        if written.starts_with('\\') {
            if let Some(target) = target {
                self.replace(name, format!("\\{target}"));
            }
            return;
        }
        if name.imported {
            let Some(target) = target else { return };
            let stuck = self.stuck.iter().any(|(kind, fqn)| *kind == name.kind && fqn_eq(*kind, fqn, resolved));
            if written.contains('\\') || stuck {
                // Through an imported namespace (`use App\Model; Model\Book`),
                // or a group `use` that can't follow.
                self.replace(name, format!("\\{target}"));
            } else if written.eq_ignore_ascii_case(short_name(resolved)) {
                // The import is rewritten; its short name may change (an
                // alias stays).
                self.replace(name, short_name(target).to_owned());
            }
            return;
        }
        // Relative to the namespace the name is in.
        let now = self.names.scope_at(name.start).namespace().to_owned();
        let after = match self.moved {
            Some(moved) if ns_eq(&now, &moved.old_ns) => moved.new_ns.clone(),
            _ => now.clone(),
        };
        if target.is_none() && ns_eq(&now, &after) {
            return;
        }
        let target = target.unwrap_or(resolved).to_owned();
        let spelled = self.spelling(name.kind, &target, resolved, &after);
        self.replace(name, spelled);
    }

    /// How to write `target` (formerly `resolved`) in namespace `after`.
    fn spelling(&mut self, kind: NameKind, target: &str, resolved: &str, after: &str) -> String {
        let (target_ns, short) = (namespace_of(target), short_name(target));
        if ns_eq(target_ns, after) {
            return short.to_owned();
        }
        // Unqualified functions and constants fall back to the global ones.
        if target_ns.is_empty() && kind != NameKind::ClassLike {
            return short.to_owned();
        }
        let prefix = format!("{after}\\");
        if !after.is_empty() && starts_with_ignore_case(target, &prefix) {
            return target[prefix.len()..].to_owned();
        }
        if self.can_import(kind, target, resolved) {
            return short.to_owned();
        }
        format!("\\{target}")
    }

    /// Whether `target` can be written by its short name through an import
    /// (planning the import when it isn't there yet).
    fn can_import(&mut self, kind: NameKind, target: &str, resolved: &str) -> bool {
        if !self.single_namespace {
            return false;
        }
        let short = short_name(target);
        let same = |fqn: &str| fqn_eq(kind, fqn, target) || fqn_eq(kind, fqn, resolved);
        // Imported already (or will be, once its import is rewritten).
        let scope = self.names.scope_at(self.text.len() as u32);
        let existing = scope.resolve(kind, short);
        if existing.imported {
            return existing
                .resolution
                .candidates()
                .any(|fqn| same(fqn) || self.plan.target(kind, fqn).is_some_and(|moved| fqn_eq(kind, moved, target)));
        }
        let key = (import_order(kind), short.to_ascii_lowercase());
        if let Some((_, planned)) = self.imports.get(&key) {
            return fqn_eq(kind, planned, target);
        }
        // A class-like of the file by that name, or another name written
        // the same way that means something else.
        if kind == NameKind::ClassLike
            && self.summary.class_likes.iter().any(|class| class.name.eq_ignore_ascii_case(short) && !same(&class.fqn))
        {
            return false;
        }
        let clash = self.names.names().iter().any(|name| {
            name.kind == kind
                && name.role == NameRole::Reference
                && !name.imported
                && name.text.eq_ignore_ascii_case(short)
                && !name.resolution.candidates().any(same)
        });
        if clash {
            return false;
        }
        self.imports.insert(key, (kind, target.to_owned()));
        true
    }

    /// Class names in the types of PHPDoc tags: only names of declared
    /// class-likes, so pseudo-types (`int`, `list`, `class-string`) and
    /// unknown names are left alone.
    fn doc_comments(&mut self, parsed: &ParsedFile) {
        let program = parsed.program();
        for trivia in program.trivia.iter().filter(|trivia| trivia.kind == TriviaKind::DocBlockComment) {
            let doc = String::from_utf8_lossy(trivia.value);
            let base = trivia.span.start.offset;
            let scope = self.names.scope_at(base);
            for (start, end) in doc_type_names(&doc) {
                let written = &doc[start..end];
                let resolved = scope.resolve(NameKind::ClassLike, written);
                let Some(fqn) = resolved.resolution.primary() else { continue };
                if self.plan.target(NameKind::ClassLike, fqn).is_none()
                    && (self.moved.is_none() || !self.engine.is_declared(NameKind::ClassLike, fqn, self.summary))
                {
                    continue;
                }
                let name = ResolvedName {
                    start: base + start as u32,
                    end: base + end as u32,
                    range: Default::default(),
                    text: written.to_owned(),
                    kind: NameKind::ClassLike,
                    role: NameRole::Reference,
                    resolution: resolved.resolution,
                    imported: resolved.imported,
                };
                self.name(&name);
            }
        }
    }

    fn newline(&self) -> &'static str {
        if self.text.contains("\r\n") { "\r\n" } else { "\n" }
    }

    /// After `<?php` (and a `declare(…);` right after it).
    fn header_offset(&self) -> u32 {
        let Some(tag) = self.text.find("<?php") else { return 0 };
        let mut at = tag + "<?php".len();
        let rest = &self.text[at..];
        let trimmed = rest.trim_start();
        if trimmed.len() >= 7
            && trimmed[..7].eq_ignore_ascii_case("declare")
            && let Some(semi) = trimmed.find(';')
        {
            at += rest.len() - trimmed.len() + semi + 1;
        }
        at as u32
    }

    /// The offset just past the first `ch` at or after `from`.
    fn past(&self, from: u32, ch: char) -> Option<u32> {
        let i = self.text.get(from as usize..)?.find(ch)?;
        Some(from + i as u32 + 1)
    }

    /// The moved file's `namespace` statement, and the imports to add.
    fn namespace_and_imports(&mut self) {
        let nl = self.newline();
        let declaration = namespace_declarations(self.names).first().map(|name| (*name).clone());
        let mut header = String::new();
        let mut namespace_end = None;
        if let Some(moved) = self.moved
            && !ns_eq(&moved.old_ns, &moved.new_ns)
        {
            match &declaration {
                Some(name) if moved.new_ns.is_empty() => self.remove_namespace(name),
                Some(name) => self.edits.push((name.start, name.end, moved.new_ns.clone())),
                None => {
                    header = format!("{nl}{nl}namespace {};", moved.new_ns);
                }
            }
            if moved.new_ns.is_empty() {
                namespace_end = None;
            } else if let Some(name) = &declaration {
                namespace_end = self.namespace_statement_end(name);
            }
        } else if let Some(name) = &declaration {
            namespace_end = self.namespace_statement_end(name);
        }
        if self.imports.is_empty() {
            if !header.is_empty() {
                let at = self.header_offset();
                self.edits.push((at, at, header));
            }
            return;
        }
        let lines: Vec<String> = self
            .imports
            .values()
            .map(|(kind, fqn)| match kind {
                NameKind::Function => format!("use function {fqn};"),
                NameKind::Constant => format!("use const {fqn};"),
                _ => format!("use {fqn};"),
            })
            .collect();
        let block = lines.join(nl);
        let last_import = self.names.names().iter().rev().find(|name| name.role == NameRole::Import).map(|n| n.end);
        if let Some(at) = last_import.and_then(|end| self.past(end, ';')) {
            if !header.is_empty() {
                let header_at = self.header_offset();
                self.edits.push((header_at, header_at, header));
            }
            self.edits.push((at, at, format!("{nl}{block}")));
        } else if let Some(at) = namespace_end {
            self.edits.push((at, at, format!("{nl}{nl}{block}")));
        } else {
            let at = self.header_offset();
            self.edits.push((at, at, format!("{header}{nl}{nl}{block}")));
        }
    }

    /// Just past `namespace Name;` (or its `{`).
    fn namespace_statement_end(&self, name: &ResolvedName) -> Option<u32> {
        let rest = self.text.get(name.end as usize..)?;
        let i = rest.find([';', '{'])?;
        Some(name.end + i as u32 + 1)
    }

    /// Removes `namespace Name;` (a braced `namespace Name {` keeps its
    /// braces as global code).
    fn remove_namespace(&mut self, name: &ResolvedName) {
        let Some(keyword) = self.text[..name.start as usize].rfind("namespace") else { return };
        let rest = &self.text[name.end as usize..];
        let Some(i) = rest.find([';', '{']) else { return };
        if rest[i..].starts_with('{') {
            let start = (keyword + "namespace".len()) as u32;
            self.edits.push((start, name.end, String::new()));
            return;
        }
        let mut end = name.end as usize + i + 1;
        // The line break after it, and one blank line.
        for _ in 0..2 {
            let after = &self.text[end..];
            let skip = after.len() - after.trim_start_matches([' ', '\t']).len();
            if after[skip..].starts_with("\r\n") {
                end += skip + 2;
            } else if after[skip..].starts_with('\n') {
                end += skip + 1;
            } else {
                break;
            }
        }
        self.edits.push((keyword as u32, end as u32, String::new()));
    }
}

#[cfg(test)]
mod spelling_tests {
    use super::*;

    #[test]
    fn strings_keep_their_style() {
        let plan = Plan {
            files: Vec::new(),
            renamed: vec![Renamed {
                kind: NameKind::ClassLike,
                old: r"App\Model\Book".into(),
                new: r"App\Entity\Volume".into(),
            }],
        };
        assert_eq!(string_spelling(&plan, r"App\Model\Book").as_deref(), Some(r"App\Entity\Volume"));
        assert_eq!(string_spelling(&plan, r"App\\Model\\Book").as_deref(), Some(r"App\\Entity\\Volume"));
        assert_eq!(string_spelling(&plan, r"\App\model\BOOK").as_deref(), Some(r"\App\Entity\Volume"));
        assert_eq!(string_spelling(&plan, r"App\Model\Author"), None);
        assert!(ns_eq(r"\App\Model", "app\\model"));
        assert_eq!(join_ns("", "Book"), "Book");
    }
}
