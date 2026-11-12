//! Find usages ([`PhpEngine::references`]).
//!
//! What the caret is on is worked out as for goto ([`super::symbol`]). The
//! word index ([`crate::index::PhpIndex::files_with_word`]) and the open
//! buffers give the candidate files: those containing the declaration's
//! short name (a member's or parameter's name) as a word. Each candidate is
//! parsed and every occurrence of that name in it is resolved again the way
//! goto would resolve it; the true matches are kept:
//!
//! - class-like, function and constant names through the name resolution
//!   (imports included, `use … as` aliases and `self`/`static`/`parent`
//!   not), with the namespace fallback of unqualified functions and
//!   constants;
//! - members at `->`, `?->`, `::` and first-class callables, looked up on
//!   the receiver's class models; a member that overrides the sought one, or
//!   that it overrides, counts too (calls through an interface or a
//!   subclass), except for private members;
//! - parameters at named arguments of calls to their function or method,
//!   and as variables in its body;
//! - variables in their function-like (the declaring parameter, closure
//!   capture or first write is the declaration);
//! - class names in PHPDoc types (`@param Foo`, `@return list<Foo>`,
//!   `@throws`, `@mixin`, …) and string literals naming the class
//!   (`'App\\Foo'`), marked [`UsageKind::Doc`] and [`UsageKind::String`];
//! - constant names in the strings of `define('X', …)`, `defined('X')` and
//!   `constant('X')` ([`UsageKind::String`]).
//!
//! [`PhpEngine::possible_usages`] lists, in the same candidate files, the
//! dynamic uses that may reach a function, method or property but that a
//! rename can't follow: `$f()`, `$o->$m()`, `$o->$p`, `Foo::$$p`, and string
//! callables (`'f'`, `'Foo::m'`, `[$o, 'm']`) passed where the callee's
//! parameter is `callable` or `callable-string`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use ide_core::{CancellationToken, DocId, IdeError, IdeResult, Pos, Range};
use mago_span::{HasSpan, Span};
use mago_syntax::cst::{
    Access, AnonymousClass, Argument, ArgumentList, ArrayElement, ArrowFunction, Call, Class,
    ClassLikeConstantSelector, ClassLikeMemberSelector, Closure, DirectVariable, Enum, Expression, Function, Interface,
    Literal, LiteralString, Method, PartialApplication, Trait, TriviaKind, Variable,
};
use mago_syntax::walker::Walker;
use rayon::prelude::*;

use super::short_name;
use super::symbol::{Decl, Lookup, Member, MemberKind, Subject};
use crate::engine::{OpenDocument, PhpEngine};
use crate::index::path_key;
use crate::index::words::contains_word;
use crate::names::{FileNames, NameKind, NameRole, fqn_eq};
use crate::summary::{FileSummary, Visibility};
use crate::syntax::ParsedFile;
use crate::types::{ExprTypes, Frame, StringKind, Type};

/// How a usage refers to the declaration.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum UsageKind {
    /// The declaration itself.
    Declaration,
    /// Code: a name, member access, named argument or variable.
    Code,
    /// A type in a PHPDoc comment.
    Doc,
    /// A string literal naming the class, or the constant in
    /// `define('X')`, `defined('X')` and `constant('X')`.
    String,
    /// A dynamic use that may reach the declaration but can't be renamed
    /// safely (`$f()`, `$o->$m()`, a string callable); only
    /// [`PhpEngine::possible_usages`] gives these.
    Possible,
}

/// One usage found by [`PhpEngine::references`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Usage {
    pub path: PathBuf,
    pub range: Range,
    pub kind: UsageKind,
}

/// What is searched for.
#[derive(Clone, Debug)]
pub(crate) enum Sought {
    /// A class-like, function or constant.
    Name {
        kind: NameKind,
        fqn: String,
    },
    Member {
        kind: MemberKind,
        name: String,
        declaring: String,
        private: bool,
    },
    /// A parameter, at named arguments; `owner` is a function or method.
    Parameter {
        owner: Box<Sought>,
        name: String,
    },
    /// A variable of one file, by the range of its declaration.
    Variable {
        file: String,
        name: String,
        declaration: Range,
    },
    /// Another name a model method is used by (Laravel): a local scope
    /// called without its prefix, a relation or an accessor read as a
    /// property. Found where the use resolves to the method `of`.
    Alias {
        kind: MemberKind,
        name: String,
        of: Box<Sought>,
    },
}

impl Sought {
    /// The word every file mentioning this contains; `None` when only one
    /// file can.
    fn word(&self) -> Option<&str> {
        match self {
            Sought::Name { fqn, .. } => Some(short_name(fqn)),
            Sought::Member { name, .. } | Sought::Parameter { name, .. } | Sought::Alias { name, .. } => {
                Some(name.as_str())
            }
            Sought::Variable { .. } => None,
        }
    }
}

impl PhpEngine {
    /// The usages of what is at `pos` in an open document, sorted by file and
    /// position (the declaration among them when `include_declaration`).
    /// `None` when the engine doesn't hold the document or the caret is on
    /// nothing it resolves.
    pub fn references(
        &self,
        doc: DocId,
        pos: Pos,
        include_declaration: bool,
        cancel: &CancellationToken,
    ) -> Option<IdeResult<Vec<Usage>>> {
        let parsed = self.parsed_document(doc)?;
        let path = self.document_path(doc)?;
        if let Some(found) =
            self.string_ref_references(&parsed, &path, parsed.line_index().byte(pos), include_declaration, cancel)
        {
            return Some(found);
        }
        let here = FileSummary::extract(&parsed);
        let sought = {
            let resolver = self.resolver();
            let offset = parsed.line_index().byte(pos);
            let found = self.at_caret(&parsed, &here, &resolver, offset)?;
            self.sought(found.subject, &path, &here)
        };
        if sought.is_empty() {
            return None;
        }
        let mut sought = sought;
        sought.extend(self.model_method_aliases(&sought));
        let found = self.find_usages(&sought, &path, &here, include_declaration, cancel);
        Some(found.and_then(|mut usages| {
            // A controller method's routes count as its usages, and a
            // Livewire component's names as the class's.
            let before = usages.len();
            for sought in &sought {
                match sought {
                    Sought::Member { kind: MemberKind::Method, name, declaring, .. } => {
                        usages.extend(self.route_action_usages(declaring, name));
                    }
                    Sought::Name { kind: NameKind::ClassLike, fqn } => {
                        usages.extend(self.livewire_class_usages(fqn, cancel)?);
                    }
                    _ => {}
                }
            }
            if usages.len() > before {
                usages.sort_by_key(|usage| (path_key(&usage.path), usage.range.start));
                usages.dedup_by(|b, a| path_key(&a.path) == path_key(&b.path) && a.range == b.range);
            }
            Ok(usages)
        }))
    }

    /// The other names Eloquent model methods among `sought` are used by:
    /// `published()` for the local scope `scopePublished`, the property
    /// `author` for a relation `author()` (and `author_count`), `first_name`
    /// for the accessor `getFirstNameAttribute` or `firstName(): Attribute`.
    /// Only uses that resolve to the method count, so a guess that names
    /// something else finds nothing.
    fn model_method_aliases(&self, sought: &[Sought]) -> Vec<Sought> {
        use crate::types::provider::laravel::snake;
        const MODEL: &str = r"Illuminate\Database\Eloquent\Model";
        let mut out = Vec::new();
        for sought in sought {
            let Sought::Member { kind: MemberKind::Method, name, declaring, .. } = sought else { continue };
            if !self.class_model(declaring).is_some_and(|model| model.is_subclass_of(MODEL)) {
                continue;
            }
            let mut aliases: Vec<(MemberKind, String)> = Vec::new();
            let mut alias = |kind: MemberKind, alias: String| {
                let known = aliases.iter().any(|(k, a)| *k == kind && *a == alias);
                if !alias.is_empty() && !known && !(kind == MemberKind::Method && alias.eq_ignore_ascii_case(name)) {
                    aliases.push((kind, alias.clone()));
                    out.push(Sought::Alias { kind, name: alias, of: Box::new(sought.clone()) });
                }
            };
            let lower = name.to_ascii_lowercase();
            if lower.starts_with("scope") && name.len() > 5 {
                let rest = &name[5..];
                let mut chars = rest.chars();
                let first = chars.next().map(|c| c.to_ascii_lowercase().to_string()).unwrap_or_default();
                alias(MemberKind::Method, first + chars.as_str());
                continue;
            }
            if lower.starts_with("get") && lower.ends_with("attribute") && name.len() > 12 {
                alias(MemberKind::Property, snake(&name[3..name.len() - 9]));
                continue;
            }
            alias(MemberKind::Property, name.clone());
            alias(MemberKind::Property, snake(name));
            alias(MemberKind::Property, format!("{}_count", snake(name)));
        }
        out
    }

    pub(super) fn sought(&self, subject: Subject, path: &Path, here: &FileSummary) -> Vec<Sought> {
        let file = path_key(path);
        let mut out = Vec::new();
        match subject {
            Subject::Variable { name, declarations, .. } => {
                for declaration in declarations {
                    out.push(Sought::Variable {
                        file: file.clone(),
                        name: name.clone(),
                        declaration: declaration.range,
                    });
                    // A parameter: also its named arguments.
                    if let Some(owner) = parameter_owner(here, declaration.start) {
                        out.push(Sought::Parameter { owner: Box::new(owner), name: name.clone() });
                    }
                }
            }
            Subject::Decls(decls) => {
                for decl in decls {
                    if let Decl::Parameter { owner, name } = &decl {
                        // Its uses in the body, as a variable of the declaring file.
                        for target in self.decl_targets(&decl, path, here) {
                            out.push(Sought::Variable {
                                file: path_key(&target.path),
                                name: name.clone(),
                                declaration: target.range,
                            });
                        }
                        if let Some(owner) = sought_decl(owner) {
                            out.push(Sought::Parameter { owner: Box::new(owner), name: name.clone() });
                        }
                    } else {
                        out.extend(sought_decl(&decl));
                    }
                }
            }
        }
        out
    }

    pub(crate) fn find_usages(
        &self,
        sought: &[Sought],
        path: &Path,
        here: &FileSummary,
        include_declaration: bool,
        cancel: &CancellationToken,
    ) -> IdeResult<Vec<Usage>> {
        let stub_dir = path_key(&self.stub_dir());
        let mut out = self.scan_candidates(sought, path, false, cancel)?;
        // Member and parameter declarations aren't occurrences the scan
        // visits; name declarations come from the name resolution too.
        for sought in sought {
            let decl = match sought {
                Sought::Name { kind, fqn } => match kind {
                    NameKind::ClassLike => Decl::ClassLike(fqn.clone()),
                    NameKind::Function => Decl::Function(fqn.clone()),
                    _ => Decl::Constant(fqn.clone()),
                },
                Sought::Member { kind, name, declaring, .. } => {
                    let Some(model) = self.class_model(declaring) else { continue };
                    let ty = crate::types::Type::named(declaring);
                    let context = crate::types::Context::in_class(declaring);
                    Decl::Member(Member { kind: *kind, model, name: name.clone(), receiver: ty.clone(), context, ty })
                }
                _ => continue,
            };
            for target in self.decl_targets(&decl, path, here) {
                if !path_key(&target.path).starts_with(&stub_dir) {
                    out.push(Usage { path: target.path, range: target.range, kind: UsageKind::Declaration });
                }
            }
        }
        // One usage per place; a declaration wins over the same place found
        // as code.
        out.sort_by(|a, b| {
            (path_key(&a.path), a.range.start, a.range.end, a.kind).cmp(&(
                path_key(&b.path),
                b.range.start,
                b.range.end,
                b.kind,
            ))
        });
        out.dedup_by(|b, a| path_key(&a.path) == path_key(&b.path) && a.range == b.range);
        if !include_declaration {
            out.retain(|usage| usage.kind != UsageKind::Declaration);
        }
        Ok(out)
    }

    /// The dynamic uses that may reach the sought functions, methods or
    /// properties (see the module docs), sorted by file and position;
    /// library files left out.
    pub(crate) fn possible_usages(
        &self,
        sought: &[Sought],
        path: &Path,
        cancel: &CancellationToken,
    ) -> IdeResult<Vec<Usage>> {
        let dynamic = sought.iter().any(|sought| match sought {
            Sought::Name { kind, .. } => *kind == NameKind::Function,
            Sought::Member { kind, .. } => *kind != MemberKind::Constant,
            _ => false,
        });
        if !dynamic {
            return Ok(Vec::new());
        }
        let mut out = self.scan_candidates(sought, path, true, cancel)?;
        out.retain(|usage| !self.is_library(&usage.path));
        out.sort_by_key(|usage| (path_key(&usage.path), usage.range.start, usage.range.end));
        out.dedup_by(|b, a| path_key(&a.path) == path_key(&b.path) && a.range == b.range);
        Ok(out)
    }

    /// Scans the files that may mention the sought declarations: for their
    /// usages, or with `possible` for their possible usages.
    fn scan_candidates(
        &self,
        sought: &[Sought],
        path: &Path,
        possible: bool,
        cancel: &CancellationToken,
    ) -> IdeResult<Vec<Usage>> {
        let mut files: Vec<String> = vec![path_key(path)];
        for sought in sought {
            match sought {
                Sought::Variable { file, .. } => files.push(file.clone()),
                _ => {
                    let word = sought.word().unwrap_or_default();
                    files.extend(self.files_with_word(word)?.iter().map(|p| path_key(p)));
                }
            }
        }
        let mut seen = HashSet::new();
        files.retain(|file| seen.insert(file.clone()));
        let documents = self.open_documents();
        let stub_dir = path_key(&self.stub_dir());
        let mode = if possible { ScanMode::Possible } else { ScanMode::Usages };
        let found: Vec<IdeResult<Vec<Usage>>> = files
            .par_iter()
            .filter(|file| !file.starts_with(&stub_dir))
            .map(|file| {
                if cancel.is_cancelled() {
                    return Err(IdeError::cancelled());
                }
                Ok(self.scan_file(file, &documents, sought, mode).map(|(usages, _)| usages).unwrap_or_default())
            })
            .collect();
        let mut out = Vec::new();
        for usages in found {
            out.extend(usages?);
        }
        Ok(out)
    }

    /// The indexed files and open buffers containing `word`.
    pub(super) fn files_with_word(&self, word: &str) -> IdeResult<Vec<PathBuf>> {
        let mut out = match self.index() {
            Some(index) => index.files_with_word(word)?,
            None => Vec::new(),
        };
        for document in self.open_documents() {
            if contains_word(&document.text, word) {
                out.push(document.path);
            }
        }
        Ok(out)
    }

    /// Whether a variable named `name` (without `$`) is already declared in
    /// the scope of some usage of the sought variables: a parameter, a
    /// closure's `use`, or a variable written in the same function (arrow
    /// functions see their parent's).
    pub(crate) fn variable_name_taken(&self, sought: &[Sought], name: &str) -> bool {
        let documents = self.open_documents();
        let mut files: Vec<&str> = sought
            .iter()
            .filter_map(|sought| match sought {
                Sought::Variable { file, .. } => Some(file.as_str()),
                _ => None,
            })
            .collect();
        files.dedup();
        files.into_iter().any(|file| {
            self.scan_file(file, &documents, sought, ScanMode::Probe(name.as_bytes())).is_some_and(|(_, taken)| taken)
        })
    }

    /// The usages (or possible usages) in one file, its open buffer or else
    /// the file on disk, and, when probing a name, whether a variable by
    /// that name is declared where a sought variable is used.
    fn scan_file(
        &self,
        file: &str,
        documents: &[OpenDocument],
        sought: &[Sought],
        mode: ScanMode<'_>,
    ) -> Option<(Vec<Usage>, bool)> {
        let path = crate::index::key_path(file);
        if crate::frameworks::laravel::views::is_blade(&path) {
            return self.scan_template(file, &path, sought, mode);
        }
        let open = documents.iter().find(|document| path_key(&document.path) == file);
        let parsed = match open {
            Some(document) => self.parse_open(document),
            None => {
                let text = std::fs::read_to_string(&path).ok()?;
                std::sync::Arc::new(ParsedFile::parse(file, text.as_str()))
            }
        };
        let path = open.map_or(path, |document| document.path.clone());
        let (found, taken) = self.scan_parsed(&parsed, file, sought, mode);
        Some((found.into_iter().map(|(range, kind)| Usage { path: path.clone(), range, kind }).collect(), taken))
    }

    /// [`scan_file`](Self::scan_file) for a Blade template: the PHP it
    /// compiles to (with the variables its controllers pass it), the
    /// occurrences mapped back to the template. Read from disk when it is
    /// open (its embedded document holds the compiled PHP).
    fn scan_template(
        &self,
        file: &str,
        path: &Path,
        sought: &[Sought],
        mode: ScanMode<'_>,
    ) -> Option<(Vec<Usage>, bool)> {
        let text = self.current_text(path)?.replace("\r\n", "\n");
        let compiled = self.blade_compile(path, &text);
        let parsed = ParsedFile::parse(file, compiled.php.as_str());
        let (found, taken) = self.scan_parsed(&parsed, file, sought, mode);
        let (compiled_lines, lines) = (parsed.line_index(), crate::syntax::LineIndex::new(&text));
        let usages = found
            .into_iter()
            .filter_map(|(range, kind)| {
                let start = compiled.blade_offset(compiled_lines.byte(range.start))?;
                let end = compiled.blade_offset(compiled_lines.byte(range.end))?;
                Some(Usage { path: path.to_path_buf(), range: lines.range(start, end), kind })
            })
            .collect();
        Some((usages, taken))
    }

    /// The occurrences of `sought` in `parsed` (the file `file`), and
    /// whether a probed variable name is taken.
    fn scan_parsed(
        &self,
        parsed: &ParsedFile,
        file: &str,
        sought: &[Sought],
        mode: ScanMode<'_>,
    ) -> (Vec<(Range, UsageKind)>, bool) {
        let resolver = self.resolver();
        let names = FileNames::resolve(parsed);
        let here = FileSummary::extract(parsed);
        let types = ExprTypes::new(parsed, &names, &here, &resolver);
        let lookup = Lookup { parsed, names: &names, here: &here, resolver: &resolver, types: &types };
        let probe = match mode {
            ScanMode::Probe(name) => Some(name),
            _ => None,
        };
        let possible = mode == ScanMode::Possible;
        let mut scan =
            Scan { lookup, file, sought, frames: Vec::new(), found: Vec::new(), probe, taken: false, possible };
        if mode == ScanMode::Usages {
            scan.names();
            scan.doc_comments();
        }
        ScanWalker.walk_program(parsed.program(), &mut scan);
        (scan.found, scan.taken)
    }
}

/// The function or method of `here` with a parameter declared at `start`.
fn parameter_owner(here: &FileSummary, start: u32) -> Option<Sought> {
    for function in &here.functions {
        if function.params.iter().any(|param| param.name_loc.start == start) {
            return Some(Sought::Name { kind: NameKind::Function, fqn: function.fqn.clone() });
        }
    }
    for class in &here.class_likes {
        for method in &class.methods {
            if method.params.iter().any(|param| param.name_loc.start == start) {
                return Some(Sought::Member {
                    kind: MemberKind::Method,
                    name: method.name.clone(),
                    declaring: class.fqn.clone(),
                    private: method.visibility == Visibility::Private,
                });
            }
        }
    }
    None
}

pub(super) fn sought_decl(decl: &Decl) -> Option<Sought> {
    Some(match decl {
        Decl::ClassLike(fqn) => Sought::Name { kind: NameKind::ClassLike, fqn: fqn.clone() },
        Decl::Function(fqn) => Sought::Name { kind: NameKind::Function, fqn: fqn.clone() },
        Decl::Constant(fqn) => Sought::Name { kind: NameKind::Constant, fqn: fqn.clone() },
        Decl::Member(member) => {
            let info = member.info()?;
            Sought::Member {
                kind: member.kind,
                name: member.name.clone(),
                declaring: info.declaring.fqn.clone(),
                private: info.visibility == Visibility::Private,
            }
        }
        Decl::Parameter { .. } | Decl::Magic(_) | Decl::ShapeProperty { .. } => return None,
    })
}

/// Whether two member names are the same (methods ignore case).
fn same_member_name(kind: MemberKind, a: &str, b: &str) -> bool {
    match kind {
        MemberKind::Method => a.eq_ignore_ascii_case(b),
        MemberKind::Property | MemberKind::Constant => a.trim_start_matches('$') == b.trim_start_matches('$'),
    }
}

/// What [`PhpEngine::scan_file`] looks for.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ScanMode<'s> {
    Usages,
    /// Whether a variable by this name is declared where a sought variable
    /// is used.
    Probe(&'s [u8]),
    /// Possible usages ([`UsageKind::Possible`]).
    Possible,
}

/// `define`, `defined` or `constant` as the callee (any case, with or
/// without the leading `\`), and the string literal of its first argument
/// when it names a global or namespaced constant (not `Foo::BAR`): the
/// literal and the name without a leading `\`.
pub(crate) fn constant_name_argument<'a>(
    function: &Expression<'_>,
    list: &'a ArgumentList<'a>,
) -> Option<(&'a LiteralString<'a>, String)> {
    let Expression::Identifier(identifier) = function else { return None };
    let callee = identifier.value();
    let callee = callee.strip_prefix(b"\\").unwrap_or(callee);
    if !["define", "defined", "constant"].iter().any(|name| callee.eq_ignore_ascii_case(name.as_bytes())) {
        return None;
    }
    let first = match list.arguments.first()? {
        Argument::Positional(argument) => argument.value,
        Argument::Named(argument) => argument.value,
    };
    let Expression::Literal(Literal::String(string)) = first else { return None };
    let value = String::from_utf8_lossy(string.value?);
    let name = value.strip_prefix('\\').unwrap_or(&value);
    let valid = !name.is_empty() && name.split('\\').all(super::rename::is_identifier);
    (valid && string.raw.len() >= 2).then(|| (string, name.to_owned()))
}

/// The string literal `expr` is, maybe parenthesized: its value.
fn literal_string<'a>(expr: &'a Expression<'a>) -> Option<(&'a LiteralString<'a>, String)> {
    match expr {
        Expression::Parenthesized(inner) => literal_string(inner.expression),
        Expression::Literal(Literal::String(string)) if string.raw.len() >= 2 => {
            Some((string, String::from_utf8_lossy(string.value?).into_owned()))
        }
        _ => None,
    }
}

/// The span inside a string literal's quotes.
fn inside_quotes(string: &LiteralString<'_>) -> (u32, u32) {
    (string.span.start.offset + 1, string.span.end.offset - 1)
}

/// The occurrences of the sought declarations in one file.
struct Scan<'a, 'r, 's> {
    lookup: Lookup<'a, 'r>,
    file: &'s str,
    sought: &'s [Sought],
    frames: Vec<Frame<'a>>,
    found: Vec<(Range, UsageKind)>,
    /// A variable name to look for in the scopes of the sought variables.
    probe: Option<&'s [u8]>,
    /// Whether `probe` is declared in one of them.
    taken: bool,
    /// Only possible usages are collected.
    possible: bool,
}

impl<'a> Scan<'a, '_, '_> {
    fn add(&mut self, span: Span, kind: UsageKind) {
        let range = self.lookup.parsed.line_index().span_range(span);
        self.found.push((range, kind));
    }

    fn add_bytes(&mut self, start: u32, end: u32, kind: UsageKind) {
        let range = self.lookup.parsed.line_index().range(start, end);
        self.found.push((range, kind));
    }

    /// Whether a found declaration is (one of) the sought ones.
    fn matches(&self, decl: &Decl) -> bool {
        self.sought.iter().any(|sought| self.decl_matches(sought, decl))
    }

    fn decl_matches(&self, sought: &Sought, decl: &Decl) -> bool {
        match (sought, decl) {
            (Sought::Name { kind: NameKind::ClassLike, fqn }, Decl::ClassLike(found))
            | (Sought::Name { kind: NameKind::Function, fqn }, Decl::Function(found)) => {
                fqn_eq(NameKind::ClassLike, fqn, found)
            }
            (Sought::Name { kind: NameKind::Constant, fqn }, Decl::Constant(found)) => {
                fqn_eq(NameKind::Constant, fqn, found)
            }
            (Sought::Member { .. }, Decl::Member(member)) => self.member_matches(sought, member),
            (Sought::Parameter { owner, name }, Decl::Parameter { owner: found, name: found_name }) => {
                name == found_name && self.decl_matches(owner, found)
            }
            (Sought::Alias { of, .. }, Decl::Magic(magic)) => {
                magic.method(self.lookup.resolver).is_some_and(|method| self.member_matches(of, &method))
            }
            _ => false,
        }
    }

    fn member_matches(&self, sought: &Sought, member: &Member) -> bool {
        let Sought::Member { kind, name, declaring, private } = sought else { return false };
        if *kind != member.kind || !same_member_name(*kind, name, &member.name) {
            return false;
        }
        let Some(info) = member.info() else { return false };
        let found = &info.declaring.fqn;
        if fqn_eq(NameKind::ClassLike, found, declaring) {
            return true;
        }
        if *private || info.visibility == Visibility::Private {
            return false;
        }
        // Overriding in either direction: a call through an interface or a
        // parent, or through a subclass that overrides the member.
        let resolver = self.lookup.resolver;
        resolver.class_model(found).is_some_and(|model| model.is_subclass_of(declaring))
            || resolver.class_model(declaring).is_some_and(|model| model.is_subclass_of(found))
    }

    fn names_sought(&self) -> impl Iterator<Item = (NameKind, &str)> {
        self.sought.iter().filter_map(|sought| match sought {
            Sought::Name { kind, fqn } => Some((*kind, fqn.as_str())),
            _ => None,
        })
    }

    /// Class-like, function and constant names (declarations, imports,
    /// references).
    fn names(&mut self) {
        let wanted: Vec<(NameKind, String)> = self.names_sought().map(|(kind, fqn)| (kind, fqn.to_owned())).collect();
        if wanted.is_empty() {
            return;
        }
        let names = self.lookup.names;
        for name in names.names() {
            if name.role == NameRole::Alias
                || !wanted.iter().any(|(kind, fqn)| *kind == name.kind && name.resolution.matches(*kind, fqn))
            {
                continue;
            }
            let Some(found) = self.lookup.name(name) else { continue };
            let Subject::Decls(decls) = &found.subject else { continue };
            if decls.iter().any(|decl| self.matches(decl)) {
                let kind = if name.role == NameRole::Declaration { UsageKind::Declaration } else { UsageKind::Code };
                self.add_bytes(name.start, name.end, kind);
            }
        }
    }

    /// Class names in the types of PHPDoc tags.
    fn doc_comments(&mut self) {
        let classes: Vec<String> = self
            .names_sought()
            .filter(|(kind, _)| *kind == NameKind::ClassLike)
            .map(|(_, fqn)| fqn.to_owned())
            .collect();
        if classes.is_empty() {
            return;
        }
        let program = self.lookup.parsed.program();
        for trivia in program.trivia.iter().filter(|trivia| trivia.kind == TriviaKind::DocBlockComment) {
            let text = String::from_utf8_lossy(trivia.value);
            let base = trivia.span.start.offset;
            let scope = self.lookup.names.scope_at(base);
            for (start, end) in doc_type_names(&text) {
                let written = &text[start..end];
                let resolved = scope.resolve(NameKind::ClassLike, written);
                if classes.iter().any(|fqn| resolved.resolution.matches(NameKind::ClassLike, fqn)) {
                    self.add_bytes(base + start as u32, base + end as u32, UsageKind::Doc);
                }
            }
        }
    }

    /// A string literal naming a sought class.
    fn string(&mut self, string: &LiteralString<'_>) {
        if self.possible {
            return;
        }
        let Some(value) = string.value else { return };
        let value = String::from_utf8_lossy(value);
        let value = value.trim_start_matches('\\');
        if value.is_empty() || !value.contains('\\') && !value.chars().next().is_some_and(char::is_alphabetic) {
            return;
        }
        let named = self
            .names_sought()
            .any(|(kind, fqn)| kind == NameKind::ClassLike && fqn_eq(NameKind::ClassLike, fqn, value));
        if named && string.raw.len() >= 2 {
            let span = string.span;
            self.add_bytes(span.start.offset + 1, span.end.offset - 1, UsageKind::String);
        }
    }

    fn members_sought(&self) -> bool {
        self.sought.iter().any(|sought| matches!(sought, Sought::Member { .. } | Sought::Alias { .. }))
    }

    fn member_name_sought(&self, kind: MemberKind, name: &[u8]) -> bool {
        let name = String::from_utf8_lossy(name);
        self.sought.iter().any(|sought| match sought {
            Sought::Member { kind: k, name: n, .. } | Sought::Alias { kind: k, name: n, .. } => {
                *k == kind && same_member_name(kind, n, &name)
            }
            _ => false,
        })
    }

    fn parameter_name_sought(&self, name: &[u8]) -> bool {
        self.sought.iter().any(|sought| match sought {
            Sought::Parameter { name: n, .. } => n.as_bytes() == name,
            _ => false,
        })
    }

    /// Resolves the name at `span` in `expr` and keeps it when it matches.
    fn check(&mut self, expr: &'a Expression<'a>, span: Span) {
        let Some(found) = self.lookup.expression(expr, &self.frames, span.start.offset) else { return };
        let Subject::Decls(decls) = &found.subject else { return };
        if decls.iter().any(|decl| self.matches(decl)) {
            self.add(span, UsageKind::Code);
        }
    }

    fn selector(&mut self, expr: &'a Expression<'a>, kind: MemberKind, selector: &ClassLikeMemberSelector<'_>) {
        if let ClassLikeMemberSelector::Identifier(name) = selector
            && self.member_name_sought(kind, name.value)
        {
            self.check(expr, name.span);
        }
    }

    fn arguments(&mut self, expr: &'a Expression<'a>, list: &ArgumentList<'_>) {
        for argument in list.arguments.iter() {
            if let Argument::Named(argument) = argument
                && self.parameter_name_sought(argument.name.value)
            {
                self.check(expr, argument.name.span);
            }
        }
    }

    /// A constant named in `define('X')`, `defined('X')` or `constant('X')`.
    fn constant_string(&mut self, function: &Expression<'_>, list: &'a ArgumentList<'a>) {
        let Some((string, name)) = constant_name_argument(function, list) else { return };
        if self.names_sought().any(|(kind, fqn)| kind == NameKind::Constant && fqn_eq(kind, fqn, &name)) {
            let (start, end) = inside_quotes(string);
            self.add_bytes(start, end, UsageKind::String);
        }
    }

    fn functions_sought(&self) -> bool {
        self.names_sought().any(|(kind, _)| kind == NameKind::Function)
    }

    fn member_kind_sought(&self, kind: MemberKind) -> bool {
        self.sought.iter().any(|sought| matches!(sought, Sought::Member { kind: k, .. } if *k == kind))
    }

    /// A possible usage at `span`.
    fn possible_at(&mut self, span: Span) {
        self.add(span, UsageKind::Possible);
    }

    /// Possible usages: dynamic calls and accesses, and string callables
    /// passed as arguments.
    fn dynamic(&mut self, expr: &'a Expression<'a>) {
        let dynamic_selector = |selector: &ClassLikeMemberSelector<'_>| {
            !matches!(selector, ClassLikeMemberSelector::Identifier(_) | ClassLikeMemberSelector::Missing(_))
        };
        let methods = self.member_kind_sought(MemberKind::Method);
        let properties = self.member_kind_sought(MemberKind::Property);
        match expr {
            Expression::Call(Call::Function(call)) => {
                if !matches!(call.function, Expression::Identifier(_)) && self.functions_sought() {
                    self.possible_at(call.function.span());
                }
                self.callable_arguments(expr, &call.argument_list);
            }
            Expression::Call(Call::Method(call)) => {
                if methods && dynamic_selector(&call.method) {
                    self.possible_at(call.method.span());
                }
                self.callable_arguments(expr, &call.argument_list);
            }
            Expression::Call(Call::NullSafeMethod(call)) => {
                if methods && dynamic_selector(&call.method) {
                    self.possible_at(call.method.span());
                }
                self.callable_arguments(expr, &call.argument_list);
            }
            Expression::Call(Call::StaticMethod(call)) => {
                if methods && dynamic_selector(&call.method) {
                    self.possible_at(call.method.span());
                }
                self.callable_arguments(expr, &call.argument_list);
            }
            Expression::Instantiation(instantiation) => {
                if let Some(list) = &instantiation.argument_list {
                    self.callable_arguments(expr, list);
                }
            }
            Expression::Access(Access::Property(access)) if properties && dynamic_selector(&access.property) => {
                self.possible_at(access.property.span());
            }
            Expression::Access(Access::NullSafeProperty(access))
                if properties && dynamic_selector(&access.property) =>
            {
                self.possible_at(access.property.span());
            }
            Expression::Access(Access::StaticProperty(access))
                if properties && !matches!(access.property, Variable::Direct(_)) =>
            {
                self.possible_at(access.property.span());
            }
            _ => {}
        }
    }

    /// String callables naming a sought function or method (`'f'`,
    /// `'Foo::m'`, `[$o, 'm']`) passed to a `callable` parameter of `call`.
    fn callable_arguments(&mut self, call: &'a Expression<'a>, list: &'a ArgumentList<'a>) {
        let functions: Vec<String> = self
            .names_sought()
            .filter(|(kind, _)| *kind == NameKind::Function)
            .map(|(_, fqn)| fqn.trim_start_matches('\\').to_owned())
            .collect();
        let methods: Vec<String> = self
            .sought
            .iter()
            .filter_map(|sought| match sought {
                Sought::Member { kind: MemberKind::Method, name, .. } => Some(name.clone()),
                _ => None,
            })
            .collect();
        if functions.is_empty() && methods.is_empty() {
            return;
        }
        let method_named = |name: &str| methods.iter().any(|method| method.eq_ignore_ascii_case(name));
        let mut candidates: Vec<(usize, &LiteralString<'_>)> = Vec::new();
        for (index, argument) in list.arguments.iter().enumerate() {
            let value = match argument {
                Argument::Positional(argument) => argument.value,
                Argument::Named(argument) => argument.value,
            };
            if let Some((string, text)) = literal_string(value) {
                let text = text.strip_prefix('\\').unwrap_or(&text);
                let named = match text.split_once("::") {
                    Some((_, method)) => method_named(method),
                    None => functions.iter().any(|fqn| fqn_eq(NameKind::Function, fqn, text)),
                };
                if named {
                    candidates.push((index, string));
                }
                continue;
            }
            let elements = match value {
                Expression::Array(array) => &array.elements,
                Expression::LegacyArray(array) => &array.elements,
                _ => continue,
            };
            let values: Vec<&Expression<'_>> = elements
                .iter()
                .filter_map(|element| match element {
                    ArrayElement::Value(element) => Some(element.value),
                    _ => None,
                })
                .collect();
            if let [_, method] = values.as_slice()
                && elements.len() == 2
                && let Some((string, text)) = literal_string(method)
                && method_named(&text)
            {
                candidates.push((index, string));
            }
        }
        if candidates.is_empty() {
            return;
        }
        let lookup = &self.lookup;
        let Some(callee) = crate::signature::callee(lookup.types, lookup.names, lookup.resolver, call, &self.frames)
        else {
            return;
        };
        let context = lookup.types.context(&self.frames);
        let params = crate::signature::callee_params(lookup.resolver, lookup.here, &callee, &context);
        for (index, string) in candidates {
            let Some(param) = crate::signature::parameter_index(&params, list, index) else { continue };
            let callable = params[param]
                .ty
                .members()
                .iter()
                .any(|member| matches!(member, Type::Callable(_) | Type::String(StringKind::Callable)));
            if callable {
                let (start, end) = inside_quotes(string);
                self.add_bytes(start, end, UsageKind::Possible);
            }
        }
    }

    fn expression(&mut self, expr: &'a Expression<'a>) {
        if self.possible {
            self.dynamic(expr);
            return;
        }
        let members = self.members_sought();
        match expr {
            Expression::Call(Call::Method(call)) => {
                if members {
                    self.selector(expr, MemberKind::Method, &call.method);
                }
                self.arguments(expr, &call.argument_list);
            }
            Expression::Call(Call::NullSafeMethod(call)) => {
                if members {
                    self.selector(expr, MemberKind::Method, &call.method);
                }
                self.arguments(expr, &call.argument_list);
            }
            Expression::Call(Call::StaticMethod(call)) => {
                if members {
                    self.selector(expr, MemberKind::Method, &call.method);
                }
                self.arguments(expr, &call.argument_list);
            }
            Expression::Call(Call::Function(call)) => {
                self.constant_string(call.function, &call.argument_list);
                self.arguments(expr, &call.argument_list);
            }
            Expression::Instantiation(instantiation) => {
                if let Some(list) = &instantiation.argument_list {
                    self.arguments(expr, list);
                }
            }
            Expression::PartialApplication(PartialApplication::Method(partial)) if members => {
                self.selector(expr, MemberKind::Method, &partial.method)
            }
            Expression::PartialApplication(PartialApplication::StaticMethod(partial)) if members => {
                self.selector(expr, MemberKind::Method, &partial.method)
            }
            Expression::Access(Access::Property(access)) if members => {
                self.selector(expr, MemberKind::Property, &access.property)
            }
            Expression::Access(Access::NullSafeProperty(access)) if members => {
                self.selector(expr, MemberKind::Property, &access.property)
            }
            Expression::Access(Access::StaticProperty(access)) if members => {
                if let Variable::Direct(variable) = &access.property
                    && self.member_name_sought(MemberKind::Property, variable.name)
                {
                    self.check(expr, variable.span);
                }
            }
            Expression::Access(Access::ClassConstant(access)) if members => {
                if let ClassLikeConstantSelector::Identifier(name) = &access.constant
                    && self.member_name_sought(MemberKind::Constant, name.value)
                {
                    self.check(expr, name.span);
                }
            }
            _ => {}
        }
    }

    fn variable(&mut self, variable: &DirectVariable<'_>) {
        if self.possible {
            return;
        }
        let name = variable.name.strip_prefix(b"$").unwrap_or(variable.name);
        let wanted: Vec<Range> = self
            .sought
            .iter()
            .filter_map(|sought| match sought {
                Sought::Variable { file, name: n, declaration } if file == self.file && n.as_bytes() == name => {
                    Some(*declaration)
                }
                _ => None,
            })
            .collect();
        if wanted.is_empty() {
            return;
        }
        let Some(declared) = self.lookup.variable_declaration(name, &self.frames) else { return };
        let line_index = self.lookup.parsed.line_index();
        let declared = line_index.span_range(declared);
        if wanted.contains(&declared) {
            if let Some(probe) = self.probe
                && !self.taken
                && self.lookup.variable_declaration(probe, &self.frames).is_some()
            {
                self.taken = true;
            }
            let range = line_index.span_range(variable.span);
            let kind = if range == declared { UsageKind::Declaration } else { UsageKind::Code };
            self.found.push((range, kind));
        }
    }

    fn class(&mut self, name_start: u32) {
        let here = self.lookup.here;
        let fqn = here.class_likes.iter().find(|class| class.name_loc.start == name_start).map(|c| c.fqn.clone());
        self.frames.push(Frame::Class(fqn));
    }
}

/// The byte ranges of the class-like names in the types of a docblock's
/// tags: the first type after each `@tag` (after `static` for `@method`),
/// split into names (`list<Foo|Bar>` gives `Foo` and `Bar`, `\A\Foo` stays
/// whole). Keywords and lower-case scalar names are left to the resolver to
/// not match.
pub(crate) fn doc_type_names(text: &str) -> Vec<(usize, usize)> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'@' || (i > 0 && !matches!(bytes[i - 1], b' ' | b'\t' | b'*' | b'{' | b'\n' | b'\r')) {
            i += 1;
            continue;
        }
        // The tag name.
        i += 1;
        while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || matches!(bytes[i], b'-' | b'_' | b'\\')) {
            i += 1;
        }
        let mut start = skip_blanks(bytes, i);
        if bytes[start..].starts_with(b"static ") {
            start = skip_blanks(bytes, start + b"static".len());
        }
        // The type: up to a blank, `$` or end of line outside brackets.
        let mut depth = 0i32;
        let mut end = start;
        while end < bytes.len() {
            match bytes[end] {
                b'<' | b'(' | b'{' | b'[' => depth += 1,
                b'>' | b')' | b'}' | b']' => {
                    if depth == 0 {
                        break;
                    }
                    depth -= 1;
                }
                b'\n' | b'\r' => break,
                b' ' | b'\t' | b'$' | b'*' if depth == 0 => break,
                _ => {}
            }
            end += 1;
        }
        let mut j = start;
        while j < end {
            let is_name = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'\\' || b >= 0x80;
            if !is_name(bytes[j]) {
                j += 1;
                continue;
            }
            let name_start = j;
            while j < end && is_name(bytes[j]) {
                j += 1;
            }
            // Not a member (`Foo::BAR`'s `BAR`), a variable or a number.
            let member = name_start >= 2 && &bytes[name_start - 2..name_start] == b"::";
            let variable = name_start >= 1 && bytes[name_start - 1] == b'$';
            if !member && !variable && !bytes[name_start].is_ascii_digit() {
                out.push((name_start, j));
            }
        }
        i = end.max(i);
    }
    out
}

fn skip_blanks(bytes: &[u8], mut i: usize) -> usize {
    while i < bytes.len() && matches!(bytes[i], b' ' | b'\t') {
        i += 1;
    }
    i
}

struct ScanWalker;

impl<'a, 'r, 's> Walker<'a, 'a, Scan<'a, 'r, 's>> for ScanWalker {
    fn walk_in_expression(&self, expr: &'a Expression<'a>, cx: &mut Scan<'a, 'r, 's>) {
        cx.expression(expr);
    }

    fn walk_in_direct_variable(&self, variable: &'a DirectVariable<'a>, cx: &mut Scan<'a, 'r, 's>) {
        cx.variable(variable);
    }

    fn walk_in_literal_string(&self, string: &'a LiteralString<'a>, cx: &mut Scan<'a, 'r, 's>) {
        cx.string(string);
    }

    fn walk_in_class(&self, node: &'a Class<'a>, cx: &mut Scan<'a, 'r, 's>) {
        cx.class(node.name.span.start.offset);
    }
    fn walk_out_class(&self, _: &'a Class<'a>, cx: &mut Scan<'a, 'r, 's>) {
        cx.frames.pop();
    }
    fn walk_in_interface(&self, node: &'a Interface<'a>, cx: &mut Scan<'a, 'r, 's>) {
        cx.class(node.name.span.start.offset);
    }
    fn walk_out_interface(&self, _: &'a Interface<'a>, cx: &mut Scan<'a, 'r, 's>) {
        cx.frames.pop();
    }
    fn walk_in_trait(&self, node: &'a Trait<'a>, cx: &mut Scan<'a, 'r, 's>) {
        cx.class(node.name.span.start.offset);
    }
    fn walk_out_trait(&self, _: &'a Trait<'a>, cx: &mut Scan<'a, 'r, 's>) {
        cx.frames.pop();
    }
    fn walk_in_enum(&self, node: &'a Enum<'a>, cx: &mut Scan<'a, 'r, 's>) {
        cx.class(node.name.span.start.offset);
    }
    fn walk_out_enum(&self, _: &'a Enum<'a>, cx: &mut Scan<'a, 'r, 's>) {
        cx.frames.pop();
    }
    fn walk_in_anonymous_class(&self, _: &'a AnonymousClass<'a>, cx: &mut Scan<'a, 'r, 's>) {
        cx.frames.push(Frame::Class(None));
    }
    fn walk_out_anonymous_class(&self, _: &'a AnonymousClass<'a>, cx: &mut Scan<'a, 'r, 's>) {
        cx.frames.pop();
    }
    fn walk_in_function(&self, node: &'a Function<'a>, cx: &mut Scan<'a, 'r, 's>) {
        cx.frames.push(Frame::Function(node));
    }
    fn walk_out_function(&self, _: &'a Function<'a>, cx: &mut Scan<'a, 'r, 's>) {
        cx.frames.pop();
    }
    fn walk_in_method(&self, node: &'a Method<'a>, cx: &mut Scan<'a, 'r, 's>) {
        cx.frames.push(Frame::Method(node));
    }
    fn walk_out_method(&self, _: &'a Method<'a>, cx: &mut Scan<'a, 'r, 's>) {
        cx.frames.pop();
    }
    fn walk_in_closure(&self, node: &'a Closure<'a>, cx: &mut Scan<'a, 'r, 's>) {
        cx.frames.push(Frame::Closure(node));
    }
    fn walk_out_closure(&self, _: &'a Closure<'a>, cx: &mut Scan<'a, 'r, 's>) {
        cx.frames.pop();
    }
    fn walk_in_arrow_function(&self, node: &'a ArrowFunction<'a>, cx: &mut Scan<'a, 'r, 's>) {
        cx.frames.push(Frame::Arrow(node));
    }
    fn walk_out_arrow_function(&self, _: &'a ArrowFunction<'a>, cx: &mut Scan<'a, 'r, 's>) {
        cx.frames.pop();
    }
}

#[cfg(test)]
mod scan_tests {
    use super::doc_type_names;

    fn names(text: &str) -> Vec<&str> {
        doc_type_names(text).into_iter().map(|(start, end)| &text[start..end]).collect()
    }

    #[test]
    fn doc_type_names_take_the_type_of_each_tag() {
        let doc = "/**\n * Adds a Book.\n * @param list<Book|\\App\\Shelf> $books the Book list\n * @return static\n * @throws BookMissing when Book is gone\n * @method static Book make(Shelf $s)\n * @var array{a: Foo::BAR} */";
        assert_eq!(names(doc), ["list", "Book", "\\App\\Shelf", "static", "BookMissing", "Book", "array", "a", "Foo"]);
    }
}
