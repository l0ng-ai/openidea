//! Semantic tokens: what each name of a file is, for semantic highlighting.
//!
//! Token types (the names the editor's `src/editor/lsp/semantic.ts` maps):
//!
//! - `class`, `interface`, `enum` for class-like names (traits as `class`),
//!   wherever the name resolution sees them: declarations, `use` imports,
//!   type hints, `new`, `extends`, `Foo::`, `instanceof`, attributes.
//! - `function` for function names, `method` for methods (declarations,
//!   calls, first-class callables).
//! - `property` for properties (declarations, `->p`, `?->p`, `Foo::$p`).
//! - Constants (global ones and class constants) as `variable` with
//!   `readonly` and `static`, which the editor colours as constants; enum
//!   cases as `enumMember`.
//! - `parameter` for parameters (in the parameter list, in the body, and
//!   named arguments), `variable` for other variables. `$this` and the
//!   superglobals are left to the syntax highlighting.
//!
//! Modifiers: `declaration` where a name is declared, `static`, `readonly`
//! (readonly properties, `@property-read`), `deprecated` (`@deprecated` or
//! `#[Deprecated]`) and `defaultLibrary` for what only the bundled stubs
//! declare (`strlen`, `ArrayIterator`, their members).
//!
//! Members are looked up on the class models of the receiver's type, as
//! hover does; a member the models don't have still gets its syntactic type.

#[cfg(test)]
mod tests;

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};

use ide_core::{DocId, Pos};
use mago_span::{HasSpan, Span};
use mago_syntax::cst::{
    Access, AnonymousClass, ArrowFunction, Call, Class, ClassLikeConstantSelector, ClassLikeMemberSelector, Closure,
    DirectVariable, Enum, Expression, Function, FunctionLikeParameterList, Interface, Method, NamedArgument,
    PartialApplication, Trait, Variable,
};
use mago_syntax::walker::Walker;

use crate::engine::PhpEngine;
use crate::names::{FileNames, NameKind, NameRole, Resolution};
use crate::navigate::find_declaration;
use crate::summary::{ClassKind, DocBlock, FileSummary, Loc, PropertyAccess};
use crate::syntax::ParsedFile;
use crate::types::expr::{MAX_CHAIN, chain_depth};
use crate::types::{Context, ExprTypes, Frame, Resolver, Type};

/// The token types, in legend order.
pub const TOKEN_TYPES: &[&str] =
    &["class", "interface", "enum", "function", "method", "property", "enumMember", "parameter", "variable"];

/// The token modifiers, in legend order (bit `i` is `TOKEN_MODIFIERS[i]`).
pub const TOKEN_MODIFIERS: &[&str] = &["declaration", "static", "readonly", "deprecated", "defaultLibrary"];

/// What a token is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TokenType {
    Class,
    Interface,
    Enum,
    Function,
    Method,
    Property,
    EnumMember,
    Parameter,
    Variable,
}

impl TokenType {
    /// The index in [`TOKEN_TYPES`].
    pub fn index(self) -> u32 {
        self as u32
    }

    pub fn as_str(self) -> &'static str {
        TOKEN_TYPES[self as usize]
    }
}

/// Modifier bits, as in [`TOKEN_MODIFIERS`].
pub mod modifier {
    pub const DECLARATION: u32 = 1;
    pub const STATIC: u32 = 1 << 1;
    pub const READONLY: u32 = 1 << 2;
    pub const DEPRECATED: u32 = 1 << 3;
    pub const DEFAULT_LIBRARY: u32 = 1 << 4;
    /// How constants are marked.
    pub const CONSTANT: u32 = STATIC | READONLY;
}

/// One semantic token, on one line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SemanticToken {
    pub start: Pos,
    /// In UTF-16 code units.
    pub len: u32,
    pub ty: TokenType,
    /// [`modifier`] bits.
    pub modifiers: u32,
}

impl PhpEngine {
    /// The semantic tokens of an open document, in document order; `None`
    /// when the engine doesn't hold it.
    pub fn semantic_tokens(&self, doc: DocId) -> Option<Vec<SemanticToken>> {
        let parsed = self.parsed_document(doc)?;
        let names = FileNames::resolve(&parsed);
        let here = FileSummary::extract(&parsed);
        Some(finish(&parsed, self.semantic_spans(&parsed, &names, &here)))
    }

    /// The semantic tokens of a parsed file by start byte: end byte, type
    /// and [`modifier`] bits (the deprecation inspection reads them too).
    pub(crate) fn semantic_spans(
        &self,
        parsed: &ParsedFile,
        names: &FileNames,
        here: &FileSummary,
    ) -> BTreeMap<u32, (u32, TokenType, u32)> {
        let resolver = self.resolver();
        let types = ExprTypes::new(parsed, names, here, &resolver);
        let mut tokens = Tokens {
            engine: self,
            here,
            resolver: &resolver,
            types: &types,
            frames: Vec::new(),
            found: BTreeMap::new(),
            builtin: RefCell::new(HashMap::new()),
            deep: false,
            names: HashMap::new(),
        };
        tokens.declarations();
        tokens.names(names);
        TokenWalker.walk_program(parsed.program(), &mut tokens);
        tokens.found
    }
}

/// Tokens on one line each (a name never spans lines), in order.
fn finish(parsed: &ParsedFile, found: BTreeMap<u32, (u32, TokenType, u32)>) -> Vec<SemanticToken> {
    let lines = parsed.line_index();
    found
        .into_iter()
        .filter_map(|(start, (end, ty, modifiers))| {
            let range = lines.range(start, end);
            (range.start.line == range.end.line && range.end.col > range.start.col).then_some(SemanticToken {
                start: range.start,
                len: range.end.col - range.start.col,
                ty,
                modifiers,
            })
        })
        .collect()
}

/// Whether a docblock or attribute list marks a declaration deprecated.
fn deprecated(doc: Option<&DocBlock>, attributes: &[String]) -> bool {
    doc.is_some_and(|doc| doc.deprecated.is_some())
        || attributes.iter().any(|attribute| {
            let attribute = attribute.trim_start_matches('\\');
            attribute.eq_ignore_ascii_case("Deprecated")
                || attribute.eq_ignore_ascii_case("JetBrains\\PhpStorm\\Deprecated")
        })
}

fn flag(on: bool, bit: u32) -> u32 {
    if on { bit } else { 0 }
}

const SUPERGLOBALS: &[&[u8]] =
    &[b"$GLOBALS", b"$_SERVER", b"$_GET", b"$_POST", b"$_FILES", b"$_COOKIE", b"$_SESSION", b"$_REQUEST", b"$_ENV"];

struct Tokens<'a, 'r> {
    engine: &'r PhpEngine,
    here: &'a FileSummary,
    resolver: &'r Resolver<'r>,
    types: &'r ExprTypes<'a, 'r>,
    frames: Vec<Frame<'a>>,
    /// By start byte; the first token found for a place wins.
    found: BTreeMap<u32, (u32, TokenType, u32)>,
    /// Whether only the stubs declare a name.
    builtin: RefCell<HashMap<(NameKind, String), bool>>,
    /// Class-like, function and constant names already looked up.
    names: HashMap<(NameKind, String), (TokenType, u32)>,
    /// The expression being visited ends a chain over [`MAX_CHAIN`] links:
    /// its receiver isn't typed.
    deep: bool,
}

impl<'a> Tokens<'a, '_> {
    fn add(&mut self, start: u32, end: u32, ty: TokenType, modifiers: u32) {
        if end > start {
            self.found.entry(start).or_insert((end, ty, modifiers));
        }
    }

    fn add_loc(&mut self, loc: Loc, ty: TokenType, modifiers: u32) {
        self.add(loc.start, loc.end, ty, modifiers);
    }

    fn add_span(&mut self, span: Span, ty: TokenType, modifiers: u32) {
        self.add(span.start.offset, span.end.offset, ty, modifiers);
    }

    /// Whether only the bundled stubs declare `fqn`.
    fn is_builtin(&self, kind: NameKind, fqn: &str) -> bool {
        let key = (kind, fqn.to_ascii_lowercase());
        if let Some(&builtin) = self.builtin.borrow().get(&key) {
            return builtin;
        }
        let builtin = find_declaration(self.here, kind, fqn).is_none() && self.engine.only_stubs_declare(kind, fqn);
        self.builtin.borrow_mut().insert(key, builtin);
        builtin
    }

    /// The members this file declares (methods, properties, class
    /// constants, enum cases); the class-like names come with the names.
    fn declarations(&mut self) {
        let here = self.here;
        for class in &here.class_likes {
            for method in &class.methods {
                let modifiers = modifier::DECLARATION
                    | flag(method.is_static, modifier::STATIC)
                    | flag(deprecated(method.doc.as_deref(), &method.attributes), modifier::DEPRECATED);
                self.add_loc(method.name_loc, TokenType::Method, modifiers);
            }
            for property in class.properties.iter().filter(|property| !property.is_promoted) {
                let modifiers = modifier::DECLARATION
                    | flag(property.is_static, modifier::STATIC)
                    | flag(property.is_readonly, modifier::READONLY)
                    | flag(deprecated(property.doc.as_deref(), &property.attributes), modifier::DEPRECATED);
                self.add_loc(property.name_loc, TokenType::Property, modifiers);
            }
            for constant in &class.constants {
                let modifiers = modifier::DECLARATION
                    | modifier::CONSTANT
                    | flag(deprecated(constant.doc.as_deref(), &constant.attributes), modifier::DEPRECATED);
                self.add_loc(constant.name_loc, TokenType::Variable, modifiers);
            }
            for case in &class.cases {
                let modifiers = modifier::DECLARATION
                    | flag(deprecated(case.doc.as_deref(), &case.attributes), modifier::DEPRECATED);
                self.add_loc(case.name_loc, TokenType::EnumMember, modifiers);
            }
        }
    }

    /// Class-like, function and constant names.
    fn names(&mut self, names: &FileNames) {
        for name in names.names() {
            if name.kind == NameKind::Namespace {
                continue;
            }
            let fqn = match &name.resolution {
                Resolution::Relative(_) => continue,
                resolution => {
                    let candidates: Vec<&str> = resolution.candidates().collect();
                    let declared = candidates.iter().find(|fqn| self.exists(name.kind, fqn));
                    match declared.or(candidates.first()) {
                        Some(fqn) => fqn.to_string(),
                        None => continue,
                    }
                }
            };
            if name.kind == NameKind::Constant
                && ["true", "false", "null"].iter().any(|word| name.text.eq_ignore_ascii_case(word))
            {
                continue;
            }
            let key = (name.kind, fqn.to_ascii_lowercase());
            let (ty, mut modifiers) = match self.names.get(&key) {
                Some(&found) => found,
                None => {
                    let found = self.name(name.kind, &fqn);
                    self.names.insert(key, found);
                    found
                }
            };
            if name.role == NameRole::Declaration {
                modifiers |= modifier::DECLARATION;
                modifiers &= !modifier::DEFAULT_LIBRARY;
            }
            self.add(name.start, name.end, ty, modifiers);
        }
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

    /// The token of a class-like, function or constant `fqn`.
    fn name(&self, kind: NameKind, fqn: &str) -> (TokenType, u32) {
        let decls = self.resolver.declarations();
        let builtin = || flag(self.is_builtin(kind, fqn), modifier::DEFAULT_LIBRARY);
        match kind {
            NameKind::ClassLike => {
                let class = self.here.class_like(fqn).cloned().or_else(|| decls.class_like(fqn));
                let Some(class) = class else { return (TokenType::Class, 0) };
                let ty = match class.kind {
                    ClassKind::Interface => TokenType::Interface,
                    ClassKind::Enum => TokenType::Enum,
                    ClassKind::Class | ClassKind::Trait => TokenType::Class,
                };
                (ty, flag(deprecated(class.doc.as_deref(), &class.attributes), modifier::DEPRECATED) | builtin())
            }
            NameKind::Function => {
                let function = self.here.function(fqn).cloned().or_else(|| decls.function(fqn));
                let Some(function) = function else { return (TokenType::Function, 0) };
                (
                    TokenType::Function,
                    flag(deprecated(function.doc.as_deref(), &function.attributes), modifier::DEPRECATED) | builtin(),
                )
            }
            NameKind::Constant => {
                let wanted = fqn.trim_start_matches('\\');
                let local = self.here.constants.iter().find(|c| crate::names::fqn_eq(kind, &c.fqn, wanted)).cloned();
                let Some(constant) = local.or_else(|| decls.constant(fqn)) else {
                    return (TokenType::Variable, modifier::CONSTANT);
                };
                (
                    TokenType::Variable,
                    modifier::CONSTANT
                        | flag(deprecated(constant.doc.as_deref(), &constant.attributes), modifier::DEPRECATED)
                        | builtin(),
                )
            }
            NameKind::Namespace => (TokenType::Class, 0),
        }
    }

    /// A member `name` of `receiver`.
    fn member(&mut self, kind: Member, receiver: &Type, context: &Context, name: &str, span: Span) {
        let name = name.trim_start_matches('$');
        let models = self.resolver.class_models(receiver, context);
        let mut found = None;
        for model in &models {
            found = match kind {
                Member::Method => model.method(name).map(|method| {
                    let declared = method.declared();
                    let deprecated = declared.is_some_and(|m| deprecated(m.doc.as_deref(), &m.attributes));
                    let modifiers = flag(method.is_static, modifier::STATIC) | flag(deprecated, modifier::DEPRECATED);
                    (TokenType::Method, modifiers, method.declaring.fqn.clone())
                }),
                Member::Property => model.property(name).map(|property| {
                    let declared = property.declared();
                    let deprecated = declared.is_some_and(|p| deprecated(p.doc.as_deref(), &p.attributes));
                    let read_only = property.is_readonly
                        || property.magic().is_some_and(|magic| magic.access == PropertyAccess::Read);
                    let modifiers = flag(property.is_static, modifier::STATIC)
                        | flag(read_only, modifier::READONLY)
                        | flag(deprecated, modifier::DEPRECATED);
                    (TokenType::Property, modifiers, property.declaring.fqn.clone())
                }),
                Member::Constant => model.constant(name).map(|constant| match constant.case() {
                    Some(case) => (
                        TokenType::EnumMember,
                        flag(deprecated(case.doc.as_deref(), &case.attributes), modifier::DEPRECATED),
                        constant.declaring.fqn.clone(),
                    ),
                    None => {
                        let deprecated =
                            constant.declared().is_some_and(|c| deprecated(c.doc.as_deref(), &c.attributes));
                        (
                            TokenType::Variable,
                            modifier::CONSTANT | flag(deprecated, modifier::DEPRECATED),
                            constant.declaring.fqn.clone(),
                        )
                    }
                }),
            };
            if found.is_some() {
                break;
            }
        }
        let (ty, modifiers) = match found {
            Some((ty, modifiers, declaring)) => {
                (ty, modifiers | flag(self.is_builtin(NameKind::ClassLike, &declaring), modifier::DEFAULT_LIBRARY))
            }
            None => match kind {
                Member::Method => (TokenType::Method, 0),
                Member::Property => (TokenType::Property, 0),
                Member::Constant => (TokenType::Variable, modifier::CONSTANT),
            },
        };
        self.add_span(span, ty, modifiers);
    }

    fn selector(&mut self, kind: Member, selector: &ClassLikeMemberSelector<'_>, receiver: impl FnOnce(&Self) -> Type) {
        if let ClassLikeMemberSelector::Identifier(name) = selector {
            // Typing a long chain goes through every link recursively (the
            // stack of a debug build ends a few hundred links in).
            let receiver = if self.deep { Type::Mixed } else { receiver(self) };
            let context = self.types.context(&self.frames);
            self.member(kind, &receiver, &context, &String::from_utf8_lossy(name.value), name.span);
        }
    }

    fn expression(&mut self, expr: &'a Expression<'a>) {
        self.deep = chain_depth(expr) > MAX_CHAIN;
        match expr {
            Expression::Call(Call::Method(call)) => {
                self.selector(Member::Method, &call.method, |cx| cx.types.type_of(call.object, &cx.frames))
            }
            Expression::Call(Call::NullSafeMethod(call)) => self
                .selector(Member::Method, &call.method, |cx| cx.types.type_of(call.object, &cx.frames).without_null()),
            Expression::Call(Call::StaticMethod(call)) => {
                self.selector(Member::Method, &call.method, |cx| cx.types.class_ref(call.class, &cx.frames))
            }
            Expression::PartialApplication(PartialApplication::Method(partial)) => {
                self.selector(Member::Method, &partial.method, |cx| cx.types.type_of(partial.object, &cx.frames))
            }
            Expression::PartialApplication(PartialApplication::StaticMethod(partial)) => {
                self.selector(Member::Method, &partial.method, |cx| cx.types.class_ref(partial.class, &cx.frames))
            }
            Expression::Access(Access::Property(access)) => {
                self.selector(Member::Property, &access.property, |cx| cx.types.type_of(access.object, &cx.frames))
            }
            Expression::Access(Access::NullSafeProperty(access)) => {
                self.selector(Member::Property, &access.property, |cx| {
                    cx.types.type_of(access.object, &cx.frames).without_null()
                })
            }
            Expression::Access(Access::StaticProperty(access)) => {
                if let Variable::Direct(variable) = &access.property {
                    let class = self.types.class_ref(access.class, &self.frames);
                    let context = self.types.context(&self.frames);
                    let name = String::from_utf8_lossy(variable.name).into_owned();
                    self.member(Member::Property, &class, &context, &name, variable.span);
                }
            }
            Expression::Access(Access::ClassConstant(access)) => {
                if let ClassLikeConstantSelector::Identifier(name) = &access.constant
                    && !name.value.eq_ignore_ascii_case(b"class")
                {
                    let class = self.types.class_ref(access.class, &self.frames);
                    let context = self.types.context(&self.frames);
                    self.member(Member::Constant, &class, &context, &String::from_utf8_lossy(name.value), name.span);
                }
            }
            _ => {}
        }
    }

    /// Whether `$name` is a parameter where it is used: of the innermost
    /// function-like, or of one around an arrow function.
    fn is_parameter(&self, name: &[u8]) -> bool {
        let has = |list: &FunctionLikeParameterList<'_>| list.parameters.iter().any(|p| p.variable.name == name);
        for frame in self.frames.iter().rev() {
            match frame {
                Frame::Class(_) => return false,
                Frame::Function(function) => return has(&function.parameter_list),
                Frame::Method(method) => return has(&method.parameter_list),
                Frame::Closure(closure) => return has(&closure.parameter_list),
                Frame::Arrow(arrow) => {
                    if has(&arrow.parameter_list) {
                        return true;
                    }
                }
            }
        }
        false
    }

    fn variable(&mut self, variable: &DirectVariable<'_>) {
        let name = variable.name;
        if name == b"$this" || SUPERGLOBALS.contains(&name) {
            return;
        }
        let ty = if self.is_parameter(name) { TokenType::Parameter } else { TokenType::Variable };
        self.add_span(variable.span, ty, 0);
    }

    fn parameters(&mut self, list: &FunctionLikeParameterList<'_>) {
        for parameter in list.parameters.iter() {
            self.add_span(parameter.variable.span, TokenType::Parameter, modifier::DECLARATION);
        }
    }

    fn class(&mut self, name_start: u32) {
        let fqn = self.here.class_likes.iter().find(|class| class.name_loc.start == name_start).map(|c| c.fqn.clone());
        self.frames.push(Frame::Class(fqn));
    }
}

#[derive(Clone, Copy)]
enum Member {
    Method,
    Property,
    Constant,
}

struct TokenWalker;

impl<'a, 'r> Walker<'a, 'a, Tokens<'a, 'r>> for TokenWalker {
    fn walk_in_expression(&self, expr: &'a Expression<'a>, cx: &mut Tokens<'a, 'r>) {
        cx.expression(expr);
    }

    fn walk_in_direct_variable(&self, variable: &'a DirectVariable<'a>, cx: &mut Tokens<'a, 'r>) {
        cx.variable(variable);
    }

    fn walk_in_named_argument(&self, argument: &'a NamedArgument<'a>, cx: &mut Tokens<'a, 'r>) {
        cx.add_span(argument.name.span(), TokenType::Parameter, 0);
    }

    fn walk_in_class(&self, node: &'a Class<'a>, cx: &mut Tokens<'a, 'r>) {
        cx.class(node.name.span.start.offset);
    }
    fn walk_out_class(&self, _: &'a Class<'a>, cx: &mut Tokens<'a, 'r>) {
        cx.frames.pop();
    }
    fn walk_in_interface(&self, node: &'a Interface<'a>, cx: &mut Tokens<'a, 'r>) {
        cx.class(node.name.span.start.offset);
    }
    fn walk_out_interface(&self, _: &'a Interface<'a>, cx: &mut Tokens<'a, 'r>) {
        cx.frames.pop();
    }
    fn walk_in_trait(&self, node: &'a Trait<'a>, cx: &mut Tokens<'a, 'r>) {
        cx.class(node.name.span.start.offset);
    }
    fn walk_out_trait(&self, _: &'a Trait<'a>, cx: &mut Tokens<'a, 'r>) {
        cx.frames.pop();
    }
    fn walk_in_enum(&self, node: &'a Enum<'a>, cx: &mut Tokens<'a, 'r>) {
        cx.class(node.name.span.start.offset);
    }
    fn walk_out_enum(&self, _: &'a Enum<'a>, cx: &mut Tokens<'a, 'r>) {
        cx.frames.pop();
    }
    fn walk_in_anonymous_class(&self, _: &'a AnonymousClass<'a>, cx: &mut Tokens<'a, 'r>) {
        cx.frames.push(Frame::Class(None));
    }
    fn walk_out_anonymous_class(&self, _: &'a AnonymousClass<'a>, cx: &mut Tokens<'a, 'r>) {
        cx.frames.pop();
    }
    fn walk_in_function(&self, node: &'a Function<'a>, cx: &mut Tokens<'a, 'r>) {
        cx.frames.push(Frame::Function(node));
        cx.parameters(&node.parameter_list);
    }
    fn walk_out_function(&self, _: &'a Function<'a>, cx: &mut Tokens<'a, 'r>) {
        cx.frames.pop();
    }
    fn walk_in_method(&self, node: &'a Method<'a>, cx: &mut Tokens<'a, 'r>) {
        cx.frames.push(Frame::Method(node));
        cx.parameters(&node.parameter_list);
    }
    fn walk_out_method(&self, _: &'a Method<'a>, cx: &mut Tokens<'a, 'r>) {
        cx.frames.pop();
    }
    fn walk_in_closure(&self, node: &'a Closure<'a>, cx: &mut Tokens<'a, 'r>) {
        cx.frames.push(Frame::Closure(node));
        cx.parameters(&node.parameter_list);
    }
    fn walk_out_closure(&self, _: &'a Closure<'a>, cx: &mut Tokens<'a, 'r>) {
        cx.frames.pop();
    }
    fn walk_in_arrow_function(&self, node: &'a ArrowFunction<'a>, cx: &mut Tokens<'a, 'r>) {
        cx.frames.push(Frame::Arrow(node));
        cx.parameters(&node.parameter_list);
    }
    fn walk_out_arrow_function(&self, _: &'a ArrowFunction<'a>, cx: &mut Tokens<'a, 'r>) {
        cx.frames.pop();
    }
}
