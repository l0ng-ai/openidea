//! Move class (`refactor.move.class`, IDEA's Move Class for a file holding
//! several classes): one class-like of a file that declares more than one
//! moves into its own file, named after it where PSR-4 autoloading expects
//! it.
//!
//! - **Where:** the file Composer's autoload map gives the class
//!   (`AutoloadMap::class_files`, PSR-4/PSR-0), so the new path matches
//!   the namespace and the class name; outside the autoload roots, a file
//!   named after the class next to the current one. Not offered for the
//!   class the current file is already named after, or when the new file
//!   exists.
//! - **The new file:** `<?php`, the file's `declare(…)`, the class's
//!   namespace, the imports the class uses (each `use` written out on its
//!   own), then the class with its docblock and attributes. Its fully
//!   qualified name doesn't change, so no reference elsewhere does.
//! - **The old file:** the class goes with its lines, and the imports only
//!   it used go too.
//!
//! Offered with the caret on the class's header (its docblock, attributes,
//! modifiers and name, up to `{`). The rules are our own, after IntelliJ's
//! documented Move Class refactoring for PHP.

use std::path::{Path, PathBuf};

use ide_core::{FileEdit, Location, Range, TextEdit, WorkspaceEdit};
use mago_span::HasSpan;
use mago_syntax::cst::Statement;

use super::hierarchy::{doc_start, reindent};
use crate::engine::PhpEngine;
use crate::imports::{ImportAction, file_imports, removal, unused_imports, wanted};
use crate::inspect::fixes::{line_indent, newline};
use crate::names::{FileNames, NameKind};
use crate::summary::{ClassLike, FileSummary};
use crate::syntax::ParsedFile;

/// The code action kind of Move class.
pub const MOVE_CLASS: &str = "refactor.move.class";

fn short(fqn: &str) -> &str {
    fqn.rsplit('\\').next().unwrap_or(fqn)
}

fn namespace(fqn: &str) -> &str {
    fqn.rsplit_once('\\').map_or("", |(ns, _)| ns)
}

/// Where the class's own file goes: the autoload map's file for it, else
/// one named after it next to `path`.
pub(crate) fn class_file(engine: &PhpEngine, fqn: &str, path: &Path) -> Option<PathBuf> {
    let mapped = engine.layout().and_then(|layout| layout.autoload().class_files(fqn).into_iter().next());
    mapped.or_else(|| Some(path.parent()?.join(format!("{}.php", short(fqn)))))
}

/// The Move class action for bytes `start..end` of an open document.
pub(crate) fn move_class_actions(
    engine: &PhpEngine,
    parsed: &ParsedFile,
    path: &Path,
    start: u32,
    end: u32,
    only: &[String],
) -> Vec<ImportAction> {
    if !wanted(only, MOVE_CLASS) {
        return Vec::new();
    }
    let summary = FileSummary::extract(parsed);
    if summary.has_errors || summary.class_likes.len() < 2 {
        return Vec::new();
    }
    let text = parsed.text();
    let Some(class) = summary.class_likes.iter().find(|class| {
        let from = doc_start(text, class.loc.start);
        let header_end = text[class.name_loc.end as usize..class.loc.end as usize]
            .find('{')
            .map_or(class.name_loc.end, |at| class.name_loc.end + at as u32);
        from <= start && end <= header_end
    }) else {
        return Vec::new();
    };
    move_class(engine, parsed, path, class).into_iter().collect()
}

/// Whether the class is a statement of the file or of a namespace (not
/// declared inside a function or condition).
fn top_level(parsed: &ParsedFile, class: &ClassLike) -> bool {
    let is_it = |statement: &Statement<'_>| {
        matches!(statement, Statement::Class(_) | Statement::Interface(_) | Statement::Trait(_) | Statement::Enum(_))
            && statement.span().start.offset <= class.name_loc.start
            && class.name_loc.end <= statement.span().end.offset
    };
    parsed.program().statements.iter().any(|statement| match statement {
        Statement::Namespace(ns) => ns.statements().iter().any(is_it),
        other => is_it(other),
    })
}

fn move_class(engine: &PhpEngine, parsed: &ParsedFile, path: &Path, class: &ClassLike) -> Option<ImportAction> {
    if !top_level(parsed, class) {
        return None;
    }
    let text = parsed.text();
    let nl = newline(text);
    let target = class_file(engine, &class.fqn, path)?;
    let named_after = path.file_stem().is_some_and(|stem| stem.to_string_lossy() == short(&class.fqn));
    if named_after || target.exists() || engine.open_document(&target).is_some() {
        return None;
    }

    // The class with its docblock and attributes, at column 0.
    let from = doc_start(text, class.loc.start);
    let declaration = reindent(&text[from as usize..class.loc.end as usize], line_indent(text, from), "");

    // The namespace region the class is in: its imports apply to it.
    let region_start = parsed
        .program()
        .statements
        .iter()
        .find_map(|statement| match statement {
            Statement::Namespace(ns)
                if ns.span().start.offset <= class.loc.start && class.loc.end <= ns.span().end.offset =>
            {
                Some(ns.span().start.offset)
            }
            _ => None,
        })
        .unwrap_or(0);
    let imports: Vec<(NameKind, String, String)> = file_imports(parsed)
        .into_iter()
        .filter(|import| region_start <= import.start && import.end <= class.loc.start)
        .map(|import| {
            let kind = match import.kind {
                NameKind::Function => "function ",
                NameKind::Constant => "const ",
                _ => "",
            };
            let alias = if import.aliased { format!(" as {}", import.local) } else { String::new() };
            let line = format!("use {kind}{}{alias};", import.fqn);
            (import.kind, import.fqn, line)
        })
        .collect();
    let declare: Option<String> = parsed.program().statements.iter().find_map(|statement| match statement {
        Statement::Declare(declare) => {
            Some(text[declare.span().start.offset as usize..declare.span().end.offset as usize].to_owned())
        }
        _ => None,
    });

    // The new file, then without the imports the class doesn't use.
    let render = |imports: &[&str]| {
        let mut out = format!("<?php{nl}{nl}");
        if let Some(declare) = &declare {
            out.push_str(&format!("{declare}{nl}{nl}"));
        }
        let ns = namespace(&class.fqn);
        if !ns.is_empty() {
            out.push_str(&format!("namespace {ns};{nl}{nl}"));
        }
        if !imports.is_empty() {
            out.push_str(&imports.join(nl));
            out.push_str(&format!("{nl}{nl}"));
        }
        out.push_str(&declaration);
        out.push_str(nl);
        out
    };
    let all: Vec<&str> = imports.iter().map(|(_, _, line)| line.as_str()).collect();
    let draft = ParsedFile::parse("moved.php", render(&all));
    let unused = unused_imports(&draft, &FileNames::resolve(&draft));
    let used: Vec<&str> = imports
        .iter()
        .filter(|(kind, fqn, _)| !unused.iter().any(|u| u.kind == *kind && u.fqn == *fqn))
        .map(|(_, _, line)| line.as_str())
        .collect();
    let new_text = render(&used);

    // The old file without the class, and without the imports only it used.
    let (mut cut_from, cut_to) = removal(text, from, class.loc.end);
    // Last in the file or namespace: the blank lines before it go too.
    let after = text[cut_to as usize..].trim_start();
    if after.is_empty() || after.starts_with('}') {
        while let Some(line) = text[..cut_from as usize].strip_suffix('\n').map(|before| {
            let start = before.rfind('\n').map_or(0, |at| at + 1);
            (start, before[start..].trim().is_empty())
        }) {
            match line {
                (start, true) if start > 0 => cut_from = start as u32,
                _ => break,
            }
        }
    }
    let rest = format!("{}{}", &text[..cut_from as usize], &text[cut_to as usize..]);
    let before = unused_imports(parsed, &FileNames::resolve(parsed));
    let rest_parsed = ParsedFile::parse("rest.php", rest);
    let index = parsed.line_index();
    let mut old_edits = vec![TextEdit { range: index.range(cut_from, cut_to), new_text: String::new() }];
    let shift = cut_to - cut_from;
    for unused in unused_imports(&rest_parsed, &FileNames::resolve(&rest_parsed)) {
        if before.iter().any(|b| b.kind == unused.kind && b.fqn == unused.fqn) {
            continue;
        }
        let (start, end) = unused.remove;
        let (start, end) = if end <= cut_from { (start, end) } else { (start + shift, end + shift) };
        old_edits.push(TextEdit { range: index.range(start, end), new_text: String::new() });
    }
    old_edits.sort_by_key(|edit| (edit.range.start, edit.range.end));

    let mut edit = WorkspaceEdit::default();
    edit.files.push(FileEdit::Create { path: target.clone().into(), overwrite: false });
    edit.files.push(FileEdit::Edit {
        path: target.clone().into(),
        edits: vec![TextEdit { range: Range::default(), new_text: new_text.clone() }],
        version: None,
    });
    edit.files.push(FileEdit::Edit { path: path.to_path_buf().into(), edits: old_edits, version: None });

    let shown = engine
        .layout()
        .and_then(|layout| target.strip_prefix(layout.root()).ok().map(Path::to_path_buf))
        .unwrap_or_else(|| target.file_name().map(PathBuf::from).unwrap_or_default());
    let shown = shown.to_string_lossy().replace('\\', "/");
    let name_at = new_text.find(&format!(" {}", short(&class.fqn))).map_or(0, |at| at + 1) as u32;
    let lines = crate::syntax::LineIndex::new(&new_text);
    let name = lines.range(name_at, name_at + short(&class.fqn).len() as u32);
    Some(ImportAction {
        title: format!("Move class '{}' to {shown}", short(&class.fqn)),
        kind: MOVE_CLASS,
        preferred: false,
        edit,
        open: Some(Location::file(target, name)),
    })
}
