//! What a caret is on, for hover and goto: a class-like, function or
//! constant name; a method, property, class constant or enum case (where it
//! is used: `$o->m()`, `$o?->p`, `Foo::m()`, `parent::m()`, `self::C`,
//! `Foo::$p`, `$o->m(...)`; or where it is declared); a parameter, through a
//! named argument (`f(name: 1)`, `new Foo(name: 1)`); or a variable.
//!
//! Members are looked up on the class models of the receiver's type (every
//! class of a union), so inherited, trait, magic and enum members are found
//! where they are declared. A variable's declaration is the parameter, the
//! closure `use` capture, or else the first write of the variable in its
//! function-like (the file's top level outside of one), as the flow records
//! writes: assignments, destructuring, `foreach`, `catch`, `global`,
//! `static`. Inside an arrow function a variable that is not one of its
//! parameters is looked up in the enclosing scope.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use mago_span::{HasSpan, Span};
use mago_syntax::cst::{
    Access, AnonymousClass, Argument, ArgumentList, ArrowFunction, Call, Class, ClassLikeConstantSelector,
    ClassLikeMemberSelector, Closure, DirectVariable, Enum, Expression, Function, FunctionLikeParameterList, Interface,
    PartialApplication, Trait, Variable,
};
use mago_syntax::walker::Walker;

use super::{Target, enclosing_class, find_declaration};
use crate::engine::PhpEngine;
use crate::index::path_key;
use crate::names::{FileNames, NameKind, RelativeClass, Resolution, ResolvedName};
use crate::summary::{FileSummary, Loc};
use crate::syntax::ParsedFile;
use crate::types::model::MemberInfo;
use crate::types::{ClassModel, Context, ExprTypes, Frame, Resolver, Type};

/// The kinds of class members.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MemberKind {
    Method,
    Property,
    /// A class constant or an enum case.
    Constant,
}

/// A declaration the caret refers to.
#[derive(Clone, Debug)]
pub(crate) enum Decl {
    ClassLike(String),
    Function(String),
    Constant(String),
    Member(Member),
    /// A parameter, named by a named argument.
    Parameter {
        owner: Box<Decl>,
        name: String,
    },
}

/// A member of a class model, as reached from a receiver.
#[derive(Clone, Debug)]
pub(crate) struct Member {
    pub kind: MemberKind,
    pub model: Arc<ClassModel>,
    /// As written (without `$` for properties).
    pub name: String,
    /// The type the member was reached through, and what `self`, `static`
    /// and `$this` mean there.
    pub receiver: Type,
    pub context: Context,
    /// The member's type there: what the call or access gives (templates
    /// bound and inferred), or the declared type at a declaration.
    pub ty: Type,
}

impl Member {
    pub fn info(&self) -> Option<&MemberInfo> {
        match self.kind {
            MemberKind::Method => self.model.method(&self.name).map(|m| &m.info),
            MemberKind::Property => self.model.property(&self.name).map(|p| &p.info),
            MemberKind::Constant => self.model.constant(&self.name).map(|c| &c.info),
        }
    }

    /// Where the member is declared in its declaring class-like's file.
    pub fn loc(&self) -> Option<Loc> {
        match self.kind {
            MemberKind::Method => {
                let method = self.model.method(&self.name)?;
                Some(
                    method
                        .declared()
                        .map(|m| m.name_loc)
                        .or_else(|| method.magic().map(|m| m.name_loc))
                        .unwrap_or(method.declaring.name_loc),
                )
            }
            MemberKind::Property => {
                let property = self.model.property(&self.name)?;
                Some(
                    property
                        .declared()
                        .map(|p| p.name_loc)
                        .or_else(|| property.magic().map(|p| p.name_loc))
                        .unwrap_or(property.declaring.name_loc),
                )
            }
            MemberKind::Constant => {
                let constant = self.model.constant(&self.name)?;
                Some(
                    constant
                        .declared()
                        .map(|c| c.name_loc)
                        .or_else(|| constant.case().map(|c| c.name_loc))
                        .unwrap_or(constant.declaring.name_loc),
                )
            }
        }
    }
}

/// What the caret is on.
#[derive(Clone, Debug)]
pub(crate) enum Subject {
    /// Declarations (several for a member of a union receiver; none when
    /// the name is declared nowhere).
    Decls(Vec<Decl>),
    /// A local variable, its type at the caret, and where it is declared in
    /// this file.
    Variable { name: String, ty: Type, declarations: Vec<Loc> },
}

/// What [`PhpEngine::at_caret`] finds.
#[derive(Clone, Debug)]
pub(crate) struct AtCaret {
    /// The name under the caret.
    pub range: ide_core::Range,
    pub subject: Subject,
    /// What `self`, `static` and `$this` mean at the caret.
    pub context: Context,
}

impl PhpEngine {
    /// What the caret at byte `offset` of `parsed` (whose summary is
    /// `here`) is on. A caret right after a name counts too.
    pub(crate) fn at_caret(
        &self,
        parsed: &ParsedFile,
        here: &FileSummary,
        resolver: &Resolver<'_>,
        offset: u32,
    ) -> Option<AtCaret> {
        let names = FileNames::resolve(parsed);
        let types = ExprTypes::new(parsed, &names, here, resolver);
        let lookup = Lookup { parsed, names: &names, here, resolver, types: &types };
        let name_at = |offset: u32| names.at_offset(offset).filter(|name| name.kind != NameKind::Namespace);
        if let Some(name) = name_at(offset) {
            return lookup.name(name);
        }
        if let Some(found) = lookup.syntax(offset) {
            return Some(found);
        }
        let before = offset.checked_sub(1)?;
        match name_at(before) {
            Some(name) => lookup.name(name),
            None => lookup.syntax(before),
        }
    }

    /// Where `decl` is declared. `here` is the file the request is about
    /// (its buffer's summary `summary`).
    pub(crate) fn decl_targets(&self, decl: &Decl, here: &Path, summary: &FileSummary) -> Vec<Target> {
        match decl {
            Decl::ClassLike(fqn) => self.declarations_of(NameKind::ClassLike, fqn, here, summary),
            Decl::Function(fqn) => self.declarations_of(NameKind::Function, fqn, here, summary),
            Decl::Constant(fqn) => self.declarations_of(NameKind::Constant, fqn, here, summary),
            Decl::Member(member) => {
                let (Some(info), Some(loc)) = (member.info(), member.loc()) else { return Vec::new() };
                self.class_path(&info.declaring, here, summary)
                    .map(|path| Target { path, range: loc.range })
                    .into_iter()
                    .collect()
            }
            Decl::Parameter { owner, name } => self.parameter_target(owner, name, here, summary).into_iter().collect(),
        }
    }

    fn parameter_target(&self, owner: &Decl, name: &str, here: &Path, summary: &FileSummary) -> Option<Target> {
        match owner {
            Decl::Function(fqn) => {
                let (path, function) = self.function_source(fqn, here, summary)?;
                let param = function.params.iter().find(|param| param.name == name)?;
                Some(Target { path, range: param.name_loc.range })
            }
            Decl::Member(member) if member.kind == MemberKind::Method => {
                let method = member.model.method(&member.name)?;
                let param = method.declared()?.params.iter().find(|param| param.name == name)?;
                let path = self.class_path(&method.declaring, here, summary)?;
                Some(Target { path, range: param.name_loc.range })
            }
            _ => None,
        }
    }

    /// The file declaring `class` (this one, the index's, or a stub's).
    pub(crate) fn class_path(
        &self,
        class: &crate::summary::ClassLike,
        here: &Path,
        summary: &FileSummary,
    ) -> Option<PathBuf> {
        self.source_path(NameKind::ClassLike, &class.fqn, class.name_loc, here, summary)
    }

    /// The function `fqn` and the file declaring it.
    pub(crate) fn function_source(
        &self,
        fqn: &str,
        here: &Path,
        summary: &FileSummary,
    ) -> Option<(PathBuf, crate::summary::FunctionDecl)> {
        if let Some(function) = summary.function(fqn) {
            return Some((here.to_path_buf(), function.clone()));
        }
        let function = crate::types::Declarations::function(self, fqn)?;
        let path = self.source_path(NameKind::Function, fqn, function.name_loc, here, summary)?;
        Some((path, function))
    }

    /// The file whose `kind` declaration `fqn` has its name at `name_loc`;
    /// the first one declaring it when none matches exactly.
    pub(crate) fn source_path(
        &self,
        kind: NameKind,
        fqn: &str,
        name_loc: Loc,
        here: &Path,
        summary: &FileSummary,
    ) -> Option<PathBuf> {
        if find_declaration(summary, kind, fqn).is_some_and(|(_, loc)| loc == name_loc) {
            return Some(here.to_path_buf());
        }
        let here_key = path_key(here);
        let mut first = None;
        if let Some(index) = self.index() {
            for decl in index.declarations(kind, fqn).unwrap_or_default() {
                if decl.file == here_key {
                    continue;
                }
                let path = decl.path();
                let Ok(Some(summary)) = self.summary(&path) else { continue };
                match find_declaration(&summary, kind, fqn) {
                    Some((_, loc)) if loc == name_loc => return Some(path),
                    Some(_) if first.is_none() => first = Some(path),
                    _ => {}
                }
            }
        }
        first.or_else(|| self.stub_declaration(kind, fqn).map(|target| target.path))
    }
}

/// The text of a file: its open buffer, else the file on disk.
pub(crate) fn file_text(engine: &PhpEngine, path: &Path) -> Option<String> {
    match engine.open_document(path) {
        Some(document) => Some(document.text.to_string()),
        None => std::fs::read_to_string(path).ok(),
    }
}

/// Looks up what names, members and variables of one file refer to.
pub(super) struct Lookup<'a, 'r> {
    pub parsed: &'a ParsedFile,
    pub names: &'a FileNames,
    pub here: &'a FileSummary,
    pub resolver: &'r Resolver<'r>,
    pub types: &'r ExprTypes<'a, 'r>,
}

fn contains(span: Span, offset: u32) -> bool {
    span.start.offset <= offset && offset <= span.end.offset
}

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

impl<'a> Lookup<'a, '_> {
    fn range(&self, span: Span) -> ide_core::Range {
        self.parsed.line_index().span_range(span)
    }

    /// A resolved class-like, function or constant name.
    pub(super) fn name(&self, name: &ResolvedName) -> Option<AtCaret> {
        let class = enclosing_class(self.here, name.start);
        let context = class.map(|class| Context::in_class(&class.fqn)).unwrap_or_default();
        let fqn = match &name.resolution {
            Resolution::Relative(relative) => {
                let class = class?;
                match relative {
                    RelativeClass::Self_ | RelativeClass::Static => class.fqn.clone(),
                    RelativeClass::Parent => class.extends.first()?.clone(),
                }
            }
            resolution => {
                // An unqualified function or constant: the namespaced one
                // when it exists anywhere, else the global one.
                let candidates: Vec<&str> = resolution.candidates().collect();
                let declared = candidates.iter().find(|fqn| self.exists(name.kind, fqn));
                declared.or(candidates.first())?.to_string()
            }
        };
        let decl = match name.kind {
            NameKind::ClassLike => Decl::ClassLike(fqn),
            NameKind::Function => Decl::Function(fqn),
            NameKind::Constant => Decl::Constant(fqn),
            NameKind::Namespace => return None,
        };
        Some(AtCaret { range: name.range, subject: Subject::Decls(vec![decl]), context })
    }

    fn exists(&self, kind: NameKind, fqn: &str) -> bool {
        if find_declaration(self.here, kind, fqn).is_some() {
            return true;
        }
        let decls = self.resolver.declarations();
        match kind {
            NameKind::ClassLike => decls.class_like(fqn).is_some(),
            NameKind::Function => decls.function(fqn).is_some(),
            NameKind::Constant => decls.constant(fqn).is_some(),
            NameKind::Namespace => false,
        }
    }

    /// Members, named arguments and variables at `offset`.
    fn syntax(&self, offset: u32) -> Option<AtCaret> {
        if let Some(found) = self.member_declaration(offset) {
            return Some(found);
        }
        let located = self.types.locate(offset);
        if let Some((expr, frames)) = &located.expression
            && let Some(found) = self.expression(expr, frames, offset)
        {
            return Some(found);
        }
        let (variable, frames) = located.variable?;
        self.variable(variable, &frames)
    }

    /// The name of a member where its class-like in this file declares it.
    fn member_declaration(&self, offset: u32) -> Option<AtCaret> {
        let class = enclosing_class(self.here, offset)?;
        let hit = |loc: &Loc| loc.start <= offset && offset <= loc.end;
        let doc = class.doc.as_deref();
        let (kind, name, loc) = None
            .or_else(|| {
                class.methods.iter().find(|m| hit(&m.name_loc)).map(|m| (MemberKind::Method, &m.name, m.name_loc))
            })
            .or_else(|| {
                class.properties.iter().find(|p| hit(&p.name_loc)).map(|p| (MemberKind::Property, &p.name, p.name_loc))
            })
            .or_else(|| {
                class.constants.iter().find(|c| hit(&c.name_loc)).map(|c| (MemberKind::Constant, &c.name, c.name_loc))
            })
            .or_else(|| {
                class.cases.iter().find(|c| hit(&c.name_loc)).map(|c| (MemberKind::Constant, &c.name, c.name_loc))
            })
            .or_else(|| {
                doc?.methods.iter().find(|m| hit(&m.name_loc)).map(|m| (MemberKind::Method, &m.name, m.name_loc))
            })
            .or_else(|| {
                doc?.properties.iter().find(|p| hit(&p.name_loc)).map(|p| (MemberKind::Property, &p.name, p.name_loc))
            })?;
        let receiver = Type::named(&class.fqn);
        let context = Context::in_class(&class.fqn);
        Some(self.member(kind, receiver, context, name, loc.range, None))
    }

    /// Members of the classes of `receiver` called `name`.
    fn members(
        &self,
        kind: MemberKind,
        receiver: &Type,
        context: &Context,
        name: &str,
        ty: Option<&Type>,
    ) -> Vec<Decl> {
        let name = name.trim_start_matches('$');
        let ty = ty.cloned().unwrap_or_else(|| match kind {
            MemberKind::Method => self.resolver.method_return(receiver, name, context),
            MemberKind::Property => self.resolver.property_type(receiver, name, context),
            MemberKind::Constant => self.resolver.class_constant_type(receiver, name, context),
        });
        self.resolver
            .class_models(receiver, context)
            .into_iter()
            .filter(|model| match kind {
                MemberKind::Method => model.method(name).is_some(),
                MemberKind::Property => model.property(name).is_some(),
                MemberKind::Constant => model.constant(name).is_some(),
            })
            .map(|model| {
                Decl::Member(Member {
                    kind,
                    model,
                    name: name.to_owned(),
                    receiver: receiver.clone(),
                    context: context.clone(),
                    ty: ty.clone(),
                })
            })
            .collect()
    }

    fn member(
        &self,
        kind: MemberKind,
        receiver: Type,
        context: Context,
        name: &str,
        range: ide_core::Range,
        ty: Option<Type>,
    ) -> AtCaret {
        let decls = self.members(kind, &receiver, &context, name, ty.as_ref());
        AtCaret { range, subject: Subject::Decls(decls), context }
    }

    /// A member selector, or a named argument, of the innermost expression.
    pub(super) fn expression(&self, expr: &'a Expression<'a>, frames: &[Frame<'a>], offset: u32) -> Option<AtCaret> {
        let context = self.types.context(frames);
        let selector = |selector: &ClassLikeMemberSelector<'_>| match selector {
            ClassLikeMemberSelector::Identifier(name) if contains(name.span, offset) => {
                Some((lossy(name.value), name.span))
            }
            _ => None,
        };
        let shown = || Some(self.types.type_of(expr, frames).widen());
        match expr {
            Expression::Call(Call::Method(call)) => {
                if let Some((name, span)) = selector(&call.method) {
                    let receiver = self.types.type_of(call.object, frames);
                    return Some(self.member(MemberKind::Method, receiver, context, &name, self.range(span), shown()));
                }
                let owner = || self.method_owner(&call.method, self.types.type_of(call.object, frames), &context);
                self.named_argument(&call.argument_list, owner, &context, offset)
            }
            Expression::Call(Call::NullSafeMethod(call)) => {
                if let Some((name, span)) = selector(&call.method) {
                    let receiver = self.types.type_of(call.object, frames).without_null();
                    return Some(self.member(MemberKind::Method, receiver, context, &name, self.range(span), shown()));
                }
                let owner = || {
                    self.method_owner(&call.method, self.types.type_of(call.object, frames).without_null(), &context)
                };
                self.named_argument(&call.argument_list, owner, &context, offset)
            }
            Expression::Call(Call::StaticMethod(call)) => {
                if let Some((name, span)) = selector(&call.method) {
                    let class = self.types.class_ref(call.class, frames);
                    return Some(self.member(MemberKind::Method, class, context, &name, self.range(span), shown()));
                }
                let owner = || self.method_owner(&call.method, self.types.class_ref(call.class, frames), &context);
                self.named_argument(&call.argument_list, owner, &context, offset)
            }
            Expression::Call(Call::Function(call)) => {
                let owner = || match call.function {
                    Expression::Identifier(identifier) => {
                        let name = lossy(identifier.value());
                        let scope = self.names.scope_at(identifier.span().start.offset);
                        let resolved = scope.resolve(NameKind::Function, &name);
                        let candidates: Vec<&str> = resolved.resolution.candidates().collect();
                        let fqn = candidates
                            .iter()
                            .find(|fqn| self.exists(NameKind::Function, fqn))
                            .or(candidates.first())
                            .map(|fqn| fqn.to_string());
                        fqn.map(Decl::Function).into_iter().collect()
                    }
                    _ => Vec::new(),
                };
                self.named_argument(&call.argument_list, owner, &context, offset)
            }
            Expression::Instantiation(instantiation) => {
                let list = instantiation.argument_list.as_ref()?;
                let owner = || {
                    let class = self.types.class_ref(instantiation.class, frames);
                    self.members(MemberKind::Method, &class, &context, "__construct", None)
                };
                self.named_argument(list, owner, &context, offset)
            }
            Expression::PartialApplication(PartialApplication::Method(partial)) => {
                let (name, span) = selector(&partial.method)?;
                let receiver = self.types.type_of(partial.object, frames);
                Some(self.member(MemberKind::Method, receiver, context, &name, self.range(span), None))
            }
            Expression::PartialApplication(PartialApplication::StaticMethod(partial)) => {
                let (name, span) = selector(&partial.method)?;
                let class = self.types.class_ref(partial.class, frames);
                Some(self.member(MemberKind::Method, class, context, &name, self.range(span), None))
            }
            Expression::Access(Access::Property(access)) => {
                let (name, span) = selector(&access.property)?;
                let receiver = self.types.type_of(access.object, frames);
                Some(self.member(MemberKind::Property, receiver, context, &name, self.range(span), shown()))
            }
            Expression::Access(Access::NullSafeProperty(access)) => {
                let (name, span) = selector(&access.property)?;
                let receiver = self.types.type_of(access.object, frames).without_null();
                Some(self.member(MemberKind::Property, receiver, context, &name, self.range(span), shown()))
            }
            Expression::Access(Access::StaticProperty(access)) => {
                let Variable::Direct(variable) = &access.property else { return None };
                if !contains(variable.span, offset) {
                    return None;
                }
                let class = self.types.class_ref(access.class, frames);
                let name = lossy(variable.name);
                Some(self.member(MemberKind::Property, class, context, &name, self.range(variable.span), shown()))
            }
            Expression::Access(Access::ClassConstant(access)) => {
                let ClassLikeConstantSelector::Identifier(name) = &access.constant else { return None };
                if !contains(name.span, offset) || name.value.eq_ignore_ascii_case(b"class") {
                    return None;
                }
                let class = self.types.class_ref(access.class, frames);
                let span = name.span;
                Some(self.member(MemberKind::Constant, class, context, &lossy(name.value), self.range(span), shown()))
            }
            _ => None,
        }
    }

    fn method_owner(&self, selector: &ClassLikeMemberSelector<'_>, receiver: Type, context: &Context) -> Vec<Decl> {
        match selector {
            ClassLikeMemberSelector::Identifier(name) => {
                self.members(MemberKind::Method, &receiver, context, &lossy(name.value), None)
            }
            _ => Vec::new(),
        }
    }

    /// The parameter a named argument at `offset` names.
    fn named_argument(
        &self,
        list: &ArgumentList<'_>,
        owner: impl FnOnce() -> Vec<Decl>,
        context: &Context,
        offset: u32,
    ) -> Option<AtCaret> {
        let argument = list.arguments.iter().find_map(|argument| match argument {
            Argument::Named(argument) if contains(argument.name.span, offset) => Some(argument),
            _ => None,
        })?;
        let name = lossy(argument.name.value);
        let decls =
            owner().into_iter().map(|owner| Decl::Parameter { owner: Box::new(owner), name: name.clone() }).collect();
        Some(AtCaret {
            range: self.range(argument.name.span),
            subject: Subject::Decls(decls),
            context: context.clone(),
        })
    }

    fn variable(&self, variable: &'a DirectVariable<'a>, frames: &[Frame<'a>]) -> Option<AtCaret> {
        let name = variable.name.strip_prefix(b"$").unwrap_or(variable.name);
        let range = self.range(variable.span);
        let context = self.types.context(frames);
        if name == b"this" {
            // `$this`: the class it is.
            let class = frames.iter().rev().find_map(|frame| match frame {
                Frame::Class(fqn) => Some(fqn.clone()),
                _ => None,
            })?;
            let decls = class.map(Decl::ClassLike).into_iter().collect();
            return Some(AtCaret { range, subject: Subject::Decls(decls), context });
        }
        let ty = self.types.variable_type(name, variable.span.start.offset, frames).widen();
        let declarations = self
            .variable_declaration(name, frames)
            .map(|span| {
                let line_index = self.parsed.line_index();
                Loc { start: span.start.offset, end: span.end.offset, range: line_index.span_range(span) }
            })
            .into_iter()
            .collect();
        Some(AtCaret { range, subject: Subject::Variable { name: lossy(name), ty, declarations }, context })
    }

    /// Where `$name` is declared in the scope `frames` end in.
    pub(super) fn variable_declaration(&self, name: &[u8], frames: &[Frame<'a>]) -> Option<Span> {
        let end = frames.iter().rposition(|frame| !matches!(frame, Frame::Class(_))).map_or(0, |i| i + 1);
        let scope = &frames[..end];
        let parameter = |list: &'a FunctionLikeParameterList<'a>| {
            list.parameters.iter().find(|p| p.variable.name.strip_prefix(b"$") == Some(name)).map(|p| p.variable.span)
        };
        let mut walker = Occurrences { name, found: Vec::new() };
        match scope.last() {
            Some(Frame::Function(function)) => {
                if let Some(span) = parameter(&function.parameter_list) {
                    return Some(span);
                }
                OccurrenceWalker.walk_block(&function.body, &mut walker);
            }
            Some(Frame::Method(method)) => {
                if let Some(span) = parameter(&method.parameter_list) {
                    return Some(span);
                }
                OccurrenceWalker.walk_method_body(&method.body, &mut walker);
            }
            Some(Frame::Closure(closure)) => {
                if let Some(span) = parameter(&closure.parameter_list) {
                    return Some(span);
                }
                let captured = closure
                    .use_clause
                    .iter()
                    .flat_map(|clause| clause.variables.iter())
                    .find(|capture| capture.variable.name.strip_prefix(b"$") == Some(name));
                if let Some(capture) = captured {
                    return Some(capture.variable.span);
                }
                OccurrenceWalker.walk_block(&closure.body, &mut walker);
            }
            Some(Frame::Arrow(arrow)) => {
                if let Some(span) = parameter(&arrow.parameter_list) {
                    return Some(span);
                }
                return self.variable_declaration(name, &scope[..scope.len() - 1]);
            }
            Some(Frame::Class(_)) => return None,
            None => OccurrenceWalker.walk_program(self.parsed.program(), &mut walker),
        }
        let flow = self.types.flow(scope);
        walker.found.into_iter().find(|span| flow.written_at(span.start.offset).is_some())
    }
}

/// The occurrences of one variable in a scope, not looking into nested
/// function-likes and classes.
struct Occurrences<'n> {
    name: &'n [u8],
    found: Vec<Span>,
}

struct OccurrenceWalker;

impl<'a> Walker<'a, 'a, Occurrences<'_>> for OccurrenceWalker {
    fn walk_in_direct_variable(&self, variable: &'a DirectVariable<'a>, cx: &mut Occurrences<'_>) {
        if variable.name.strip_prefix(b"$") == Some(cx.name) {
            cx.found.push(variable.span);
        }
    }

    fn walk_closure(&self, _: &'a Closure<'a>, _: &mut Occurrences<'_>) {}
    fn walk_arrow_function(&self, _: &'a ArrowFunction<'a>, _: &mut Occurrences<'_>) {}
    fn walk_anonymous_class(&self, _: &'a AnonymousClass<'a>, _: &mut Occurrences<'_>) {}
    fn walk_function(&self, _: &'a Function<'a>, _: &mut Occurrences<'_>) {}
    fn walk_class(&self, _: &'a Class<'a>, _: &mut Occurrences<'_>) {}
    fn walk_interface(&self, _: &'a Interface<'a>, _: &mut Occurrences<'_>) {}
    fn walk_trait(&self, _: &'a Trait<'a>, _: &mut Occurrences<'_>) {}
    fn walk_enum(&self, _: &'a Enum<'a>, _: &mut Occurrences<'_>) {}
}
