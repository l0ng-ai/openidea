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
//!   (`'App\\Foo'`), marked [`UsageKind::Doc`] and [`UsageKind::String`].

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use ide_core::{CancellationToken, DocId, IdeError, IdeResult, Pos, Range};
use mago_span::Span;
use mago_syntax::cst::{
    Access, AnonymousClass, Argument, ArgumentList, ArrowFunction, Call, Class, ClassLikeConstantSelector,
    ClassLikeMemberSelector, Closure, DirectVariable, Enum, Expression, Function, Interface, LiteralString, Method,
    PartialApplication, Trait, TriviaKind, Variable,
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
use crate::types::{ExprTypes, Frame};

/// How a usage refers to the declaration.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum UsageKind {
    /// The declaration itself.
    Declaration,
    /// Code: a name, member access, named argument or variable.
    Code,
    /// A type in a PHPDoc comment.
    Doc,
    /// A string literal naming the class.
    String,
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
enum Sought {
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
}

impl Sought {
    /// The word every file mentioning this contains; `None` when only one
    /// file can.
    fn word(&self) -> Option<&str> {
        match self {
            Sought::Name { fqn, .. } => Some(short_name(fqn)),
            Sought::Member { name, .. } | Sought::Parameter { name, .. } => Some(name.as_str()),
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
        Some(self.find_usages(&sought, &path, &here, include_declaration, cancel))
    }

    fn sought(&self, subject: Subject, path: &Path, here: &FileSummary) -> Vec<Sought> {
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

    fn find_usages(
        &self,
        sought: &[Sought],
        path: &Path,
        here: &FileSummary,
        include_declaration: bool,
        cancel: &CancellationToken,
    ) -> IdeResult<Vec<Usage>> {
        let here_key = path_key(path);
        let mut files: Vec<String> = vec![here_key.clone()];
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
        let found: Vec<IdeResult<Vec<Usage>>> = files
            .par_iter()
            .filter(|file| !file.starts_with(&stub_dir))
            .map(|file| {
                if cancel.is_cancelled() {
                    return Err(IdeError::cancelled());
                }
                Ok(self.usages_in(file, &documents, sought).unwrap_or_default())
            })
            .collect();
        let mut out = Vec::new();
        for usages in found {
            out.extend(usages?);
        }
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

    /// The indexed files and open buffers containing `word`.
    fn files_with_word(&self, word: &str) -> IdeResult<Vec<PathBuf>> {
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

    /// The usages in one file (its open buffer, else the file on disk).
    fn usages_in(&self, file: &str, documents: &[OpenDocument], sought: &[Sought]) -> Option<Vec<Usage>> {
        let path = crate::index::key_path(file);
        let open = documents.iter().find(|document| path_key(&document.path) == file);
        let parsed = match open {
            Some(document) => self.parse_open(document),
            None => {
                let text = std::fs::read_to_string(&path).ok()?;
                std::sync::Arc::new(ParsedFile::parse(file, text.as_str()))
            }
        };
        let path = open.map_or(path, |document| document.path.clone());
        let resolver = self.resolver();
        let names = FileNames::resolve(&parsed);
        let here = FileSummary::extract(&parsed);
        let types = ExprTypes::new(&parsed, &names, &here, &resolver);
        let lookup = Lookup { parsed: &parsed, names: &names, here: &here, resolver: &resolver, types: &types };
        let mut scan = Scan { lookup, file, sought, frames: Vec::new(), found: Vec::new() };
        scan.names();
        scan.doc_comments();
        ScanWalker.walk_program(parsed.program(), &mut scan);
        let found = scan.found;
        Some(found.into_iter().map(|(range, kind)| Usage { path: path.clone(), range, kind }).collect())
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

fn sought_decl(decl: &Decl) -> Option<Sought> {
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
        Decl::Parameter { .. } => return None,
    })
}

/// Whether two member names are the same (methods ignore case).
fn same_member_name(kind: MemberKind, a: &str, b: &str) -> bool {
    match kind {
        MemberKind::Method => a.eq_ignore_ascii_case(b),
        MemberKind::Property | MemberKind::Constant => a.trim_start_matches('$') == b.trim_start_matches('$'),
    }
}

/// The occurrences of the sought declarations in one file.
struct Scan<'a, 'r, 's> {
    lookup: Lookup<'a, 'r>,
    file: &'s str,
    sought: &'s [Sought],
    frames: Vec<Frame<'a>>,
    found: Vec<(Range, UsageKind)>,
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
        self.sought.iter().any(|sought| matches!(sought, Sought::Member { .. }))
    }

    fn member_name_sought(&self, kind: MemberKind, name: &[u8]) -> bool {
        let name = String::from_utf8_lossy(name);
        self.sought.iter().any(|sought| match sought {
            Sought::Member { kind: k, name: n, .. } => *k == kind && same_member_name(kind, n, &name),
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

    fn expression(&mut self, expr: &'a Expression<'a>) {
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
            Expression::Call(Call::Function(call)) => self.arguments(expr, &call.argument_list),
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
fn doc_type_names(text: &str) -> Vec<(usize, usize)> {
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
