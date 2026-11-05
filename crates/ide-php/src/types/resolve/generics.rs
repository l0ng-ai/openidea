//! Generics: binding template parameters (`@template`) to types.
//!
//! One level is supported, as PHPStan and Psalm describe it in their public
//! documentation:
//!
//! - **Class templates** come from the receiver: `Collection<Book>` binds the
//!   `T` of `Collection`. A member declared higher up gets its class's
//!   templates through the `@extends`/`@implements`/`@use` arguments on the
//!   way from the receiver's class to the declaring class-like (an edge
//!   without arguments leaves the ancestor's templates unbound). Inside the
//!   class itself (`$this`, `self`, `static`) its own templates stay
//!   templates.
//! - **Function and method templates** are inferred from the arguments of a
//!   call: a parameter typed `T`, `class-string<T>`, `array<K, T>`,
//!   `list<T>`, `iterable<K, T>`, `Foo<T>` (also through a subclass of
//!   `Foo`), `callable(…): T`, or a union such as `T|null` binds `T` to the
//!   (widened) argument type; several bindings of one template are joined.
//! - **Unbound templates** fall back to their default (`= T`), else their
//!   bound (`of T`), else `mixed`.
//! - `new Foo(…)` infers `Foo`'s templates from the constructor's arguments;
//!   when nothing is inferred the type stays the raw `Foo`.

use std::collections::HashMap;

use super::{Context, Receiver, Resolver, Start};
use crate::names::{NameKind, fqn_eq};
use crate::summary::{ClassLike, DocBlock, Param};
use crate::types::model::ModelMethod;
use crate::types::{Relative, Signature, SignatureParam, Type};

/// How deep a walk up `@extends`/`@implements`/`@use` goes.
const MAX_EDGE_DEPTH: usize = 16;

/// Template parameter name → its type.
pub type Bindings = HashMap<String, Type>;

/// One argument of a call, for inferring templates.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallArg {
    /// A named argument (`name: value`), without the `$`.
    pub name: Option<String>,
    pub ty: Type,
    /// `...$values`.
    pub spread: bool,
}

impl CallArg {
    pub fn positional(ty: Type) -> Self {
        Self { name: None, ty, spread: false }
    }
}

/// A `@template` parameter.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TemplateParam {
    pub name: String,
    /// `of T`.
    pub bound: Option<Type>,
    /// `= T`.
    pub default: Option<Type>,
}

impl TemplateParam {
    /// What the parameter is when nothing binds it.
    pub fn fallback(&self) -> Type {
        self.default.clone().or_else(|| self.bound.clone()).unwrap_or(Type::Mixed)
    }
}

/// The `@template` parameters of a docblock; `scope` is every template and
/// alias name visible in their bounds and defaults.
pub fn template_params(doc: Option<&DocBlock>, scope: &[&str]) -> Vec<TemplateParam> {
    doc.map_or_else(Vec::new, |doc| {
        doc.templates
            .iter()
            .map(|template| TemplateParam {
                name: template.name.clone(),
                bound: template.bound.as_ref().map(|ty| Type::from_doc(ty, scope)),
                default: template.default.as_ref().map(|ty| Type::from_doc(ty, scope)),
            })
            .collect()
    })
}

/// The `@template` parameters of a class-like.
pub fn class_template_params(class: &ClassLike) -> Vec<TemplateParam> {
    let scope = class_scope(class);
    template_params(class.doc.as_deref(), &scope)
}

/// The template and alias names visible in a class-like's docblocks.
pub fn class_scope(class: &ClassLike) -> Vec<&str> {
    class.doc.iter().flat_map(|doc| doc.local_type_names()).collect()
}

/// Binds `params` to `args` in order; missing arguments take the
/// parameter's fallback (whose bound may name earlier parameters).
pub fn bind_args(params: &[TemplateParam], args: &[Type]) -> Bindings {
    let mut bindings = Bindings::new();
    for (i, param) in params.iter().enumerate() {
        let ty = match args.get(i) {
            Some(arg) => arg.clone(),
            None => substitute(&param.fallback(), &bindings),
        };
        bindings.insert(param.name.clone(), ty);
    }
    bindings
}

/// `ty` with the bound templates replaced.
pub fn substitute(ty: &Type, bindings: &Bindings) -> Type {
    if bindings.is_empty() {
        return ty.clone();
    }
    ty.map(&mut |ty| match ty {
        Type::Template(name) => bindings.get(name).cloned(),
        _ => None,
    })
}

/// True when `ty` mentions a template parameter or `static<…>`/`self<…>`.
pub fn is_generic(ty: &Type) -> bool {
    let mut found = false;
    ty.map(&mut |ty| {
        found |= matches!(ty, Type::Template(_) | Type::GenericRelative { .. });
        None
    });
    found
}

/// True when `ty` mentions one of the templates `names`.
fn mentions(ty: &Type, names: &[String]) -> bool {
    let mut found = false;
    ty.map(&mut |ty| {
        if let Type::Template(name) = ty {
            found |= names.contains(name);
        }
        None
    });
    found
}

/// The parameters of a declared function-like as a signature: `@param`
/// types first, then native hints; variadic parameters have their element
/// type.
pub fn declared_params(params: &[Param], doc: Option<&DocBlock>, templates: &[&str]) -> Vec<SignatureParam> {
    params
        .iter()
        .map(|param| SignatureParam {
            ty: match (doc.and_then(|doc| doc.param_type(&param.name)), &param.type_hint) {
                (Some(ty), _) => Type::from_doc(ty, templates),
                (None, Some(hint)) => Type::from_hint(hint),
                (None, None) => Type::Mixed,
            },
            name: Some(param.name.clone()),
            by_ref: param.by_ref,
            optional: param.default.is_some(),
            variadic: param.variadic,
        })
        .collect()
}

/// `ty` (a class type, `static` or `self`) with other generic arguments.
pub fn with_args(ty: &Type, args: &[Type]) -> Type {
    ty.map(&mut |ty| match ty {
        Type::Named { fqn, .. } => Some(Type::Named { fqn: fqn.clone(), args: args.to_vec() }),
        Type::Relative(relative @ (Relative::Self_ | Relative::Static)) => {
            Some(Type::relative_with(*relative, args.to_vec()))
        }
        Type::Relative(Relative::This) => Some(Type::relative_with(Relative::Static, args.to_vec())),
        Type::GenericRelative { relative, .. } => Some(Type::relative_with(*relative, args.to_vec())),
        _ => None,
    })
}

/// The class-likes a class-like extends, implements or uses directly, with
/// the generic arguments its `@extends`/`@implements`/`@use` tags pass
/// (none when no tag names it).
fn edges(class: &ClassLike) -> Vec<(String, Vec<Type>)> {
    let scope = class_scope(class);
    let tagged: Vec<Type> = class
        .doc
        .iter()
        .flat_map(|doc| doc.extends.iter().chain(&doc.implements).chain(&doc.uses))
        .map(|ty| Type::from_doc(ty, &scope))
        .collect();
    class
        .extends
        .iter()
        .chain(&class.implements)
        .chain(class.trait_uses.iter().flat_map(|uses| &uses.traits))
        .map(|fqn| {
            let args = tagged
                .iter()
                .find_map(|ty| match ty {
                    Type::Named { fqn: tagged, args } if fqn_eq(NameKind::ClassLike, tagged, fqn) => Some(args.clone()),
                    _ => None,
                })
                .unwrap_or_default();
            (fqn.clone(), args)
        })
        .collect()
}

impl Resolver<'_> {
    /// The generic arguments `class<args>` passes to its ancestor (or used
    /// trait) `target`; `Some(args)` itself when `class` is `target`. `None`
    /// when `target` isn't reached.
    pub fn ancestor_args(&self, class: &str, args: &[Type], target: &str) -> Option<Vec<Type>> {
        self.ancestor_args_at(class, args, target, 0)
    }

    fn ancestor_args_at(&self, class: &str, args: &[Type], target: &str, depth: usize) -> Option<Vec<Type>> {
        if fqn_eq(NameKind::ClassLike, class, target) {
            return Some(args.to_vec());
        }
        if depth >= MAX_EDGE_DEPTH {
            return None;
        }
        let model = self.class_model(class)?;
        if !model.is_subclass_of(target) && !model.traits.iter().any(|t| fqn_eq(NameKind::ClassLike, t, target)) {
            return None;
        }
        let bindings = bind_args(&class_template_params(&model.class), args);
        edges(&model.class).into_iter().find_map(|(edge, edge_args)| {
            let edge_args: Vec<Type> = edge_args.iter().map(|arg| substitute(arg, &bindings)).collect();
            self.ancestor_args_at(&edge, &edge_args, target, depth + 1)
        })
    }

    /// The bindings of `declaring`'s templates for a member looked up on
    /// `receiver`.
    pub(super) fn receiver_bindings(&self, receiver: &Receiver<'_>, declaring: &ClassLike) -> Bindings {
        let params = class_template_params(declaring);
        if params.is_empty() {
            return Bindings::new();
        }
        let args = match receiver.start {
            Start::Args(class, args) => self.ancestor_args(class, args, &declaring.fqn),
            Start::Own(class) => {
                let own: Vec<Type> = self
                    .class_model(class)
                    .map(|model| {
                        class_template_params(&model.class)
                            .into_iter()
                            .map(|param| Type::Template(param.name))
                            .collect()
                    })
                    .unwrap_or_default();
                self.ancestor_args(class, &own, &declaring.fqn)
            }
        };
        bind_args(&params, args.as_deref().unwrap_or_default())
    }

    /// The parameters of a method with the class templates bound by
    /// `bindings` and `self`/`parent` completed in its class.
    pub(super) fn method_params(&self, method: &ModelMethod, bindings: &Bindings) -> Vec<SignatureParam> {
        let context = Context::in_class(&method.self_class);
        let mut scope = class_scope(&method.declaring);
        let params = if let Some(declared) = method.declared() {
            let doc = declared.doc.as_deref();
            scope.extend(doc.iter().flat_map(|doc| doc.local_type_names()));
            declared_params(&declared.params, doc, &scope)
        } else if let Some(magic) = method.magic() {
            scope.extend(magic.templates.iter().map(|template| template.name.as_str()));
            magic
                .params
                .iter()
                .map(|param| SignatureParam {
                    ty: param.ty.as_ref().map_or(Type::Mixed, |ty| Type::from_doc(ty, &scope)),
                    name: Some(param.name.clone()),
                    by_ref: param.by_ref,
                    optional: param.default.is_some(),
                    variadic: param.variadic,
                })
                .collect()
        } else {
            Vec::new()
        };
        params
            .into_iter()
            .map(|param| SignatureParam { ty: substitute(&self.bind(&param.ty, &context), bindings), ..param })
            .collect()
    }

    /// The method's own `@template` parameters.
    pub(super) fn method_templates(&self, method: &ModelMethod) -> Vec<TemplateParam> {
        let mut scope = class_scope(&method.declaring);
        if let Some(declared) = method.declared() {
            let doc = declared.doc.as_deref();
            scope.extend(doc.iter().flat_map(|doc| doc.local_type_names()));
            template_params(doc, &scope)
        } else if let Some(magic) = method.magic() {
            scope.extend(magic.templates.iter().map(|template| template.name.as_str()));
            let doc = DocBlock { templates: magic.templates.clone(), ..DocBlock::default() };
            template_params(Some(&doc), &scope)
        } else {
            Vec::new()
        }
    }

    /// Binds the templates `own` of a call: inferred from `args` (when the
    /// call has them) against `params`, else their fallbacks. Adds them to
    /// `bindings`.
    pub(super) fn bind_call(
        &self,
        own: &[TemplateParam],
        params: &[SignatureParam],
        args: Option<&dyn Fn() -> Vec<CallArg>>,
        bindings: &mut Bindings,
    ) {
        if own.is_empty() {
            return;
        }
        let names: Vec<String> = own.iter().map(|param| param.name.clone()).collect();
        let mut inferred = Bindings::new();
        if let Some(args) = args {
            self.infer_args(params, &args(), &names, &mut inferred);
        }
        for param in own {
            let ty = match inferred.remove(&param.name) {
                Some(ty) => ty,
                None => substitute(&param.fallback(), bindings),
            };
            bindings.insert(param.name.clone(), ty);
        }
    }

    /// Infers the templates `names` from the arguments of a call.
    pub fn infer_args(&self, params: &[SignatureParam], args: &[CallArg], names: &[String], out: &mut Bindings) {
        for (position, arg) in args.iter().enumerate() {
            let param = match &arg.name {
                Some(name) => params.iter().find(|param| param.name.as_deref() == Some(name.as_str())),
                None => params
                    .get(position)
                    .filter(|param| !param.variadic)
                    .or_else(|| params.last().filter(|param| param.variadic && position + 1 >= params.len())),
            };
            let Some(param) = param else { continue };
            if arg.spread {
                // `...$values` passes the elements.
                if param.variadic {
                    self.infer(&param.ty, &crate::types::expr::iterable_value(&arg.ty), names, out);
                }
                continue;
            }
            self.infer(&param.ty, &arg.ty, names, out);
        }
    }

    /// Matches parameter type `param` against argument type `arg`, binding
    /// the templates `names` it mentions.
    pub fn infer(&self, param: &Type, arg: &Type, names: &[String], out: &mut Bindings) {
        if !mentions(param, names) || matches!(arg, Type::Never) {
            return;
        }
        match param {
            Type::Template(name) => {
                let arg = arg.widen();
                let ty = match out.remove(name) {
                    Some(known) => Type::union([known, arg]),
                    None => arg,
                };
                out.insert(name.clone(), ty);
            }
            Type::ClassString(Some(inner)) => {
                for member in arg.members() {
                    match member {
                        Type::ClassString(Some(class)) => self.infer(inner, class, names, out),
                        Type::LiteralString(class) => self.infer(inner, &Type::named(class), names, out),
                        _ => {}
                    }
                }
            }
            Type::Named { fqn, args: params } => {
                for member in arg.members() {
                    let passed = match member {
                        Type::Named { fqn: class, args } => self.ancestor_args(class, args, fqn),
                        Type::Closure(_) => None,
                        _ => None,
                    };
                    for (param, arg) in params.iter().zip(passed.unwrap_or_default()) {
                        self.infer(param, &arg, names, out);
                    }
                }
            }
            Type::Array { key, value, .. } | Type::Iterable { key, value } => {
                for member in arg.members() {
                    if let Some((arg_key, arg_value)) = self.key_value(member) {
                        self.infer(key, &arg_key, names, out);
                        self.infer(value, &arg_value, names, out);
                    }
                }
            }
            Type::List { value, .. } => {
                for member in arg.members() {
                    if let Some((_, arg_value)) = self.key_value(member) {
                        self.infer(value, &arg_value, names, out);
                    }
                }
            }
            Type::Callable(Some(signature)) | Type::Closure(Some(signature)) => {
                for member in arg.members() {
                    if let Type::Callable(Some(arg_sig)) | Type::Closure(Some(arg_sig)) = member {
                        self.infer_signature(signature, arg_sig, names, out);
                    }
                }
            }
            Type::Union(members) => {
                let generic: Vec<&Type> = members.iter().filter(|member| mentions(member, names)).collect();
                if let [only] = generic.as_slice() {
                    // `T|null` against `Book|null`: `T` is `Book`.
                    let rest: Vec<&Type> = members.iter().filter(|member| !mentions(member, names)).collect();
                    let arg = Type::union(
                        arg.members()
                            .iter()
                            .filter(|member| !rest.iter().any(|other| member.is_subtype_of(other, self)))
                            .cloned(),
                    );
                    self.infer(only, &arg, names, out);
                } else {
                    for member in generic {
                        self.infer(member, arg, names, out);
                    }
                }
            }
            Type::Intersection(members) => {
                for member in members {
                    self.infer(member, arg, names, out);
                }
            }
            _ => {}
        }
    }

    /// `callable(A): R` against a closure: the return binds covariantly;
    /// parameter types (when the closure declares them) only fill templates
    /// nothing else bound.
    fn infer_signature(&self, param: &Signature, arg: &Signature, names: &[String], out: &mut Bindings) {
        if let (Some(param), Some(arg)) = (&param.return_type, &arg.return_type) {
            self.infer(param, arg, names, out);
        }
        let mut from_params = Bindings::new();
        for (param, arg) in param.params.iter().zip(&arg.params) {
            if arg.ty != Type::Mixed {
                self.infer(&param.ty, &arg.ty, names, &mut from_params);
            }
        }
        for (name, ty) in from_params {
            out.entry(name).or_insert(ty);
        }
    }

    /// The key and value types of an iterable value.
    fn key_value(&self, ty: &Type) -> Option<(Type, Type)> {
        match ty {
            Type::Array { key, value, .. } | Type::Iterable { key, value } => {
                Some(((**key).clone(), (**value).clone()))
            }
            Type::List { value, .. } => Some((Type::int_range(Some(0), None), (**value).clone())),
            Type::Shape(shape) => Some((shape.key_type(), shape.value_type())),
            Type::Named { .. } => self.iteration_args(ty),
            _ => None,
        }
    }

    /// The key and value types a generic `Traversable` passes: `Foo<…>`
    /// implementing `IteratorAggregate<K, V>`, `Iterator<K, V>`,
    /// `Traversable<K, V>` or a `Generator<K, V, …>`. `None` when the class
    /// says nothing (or isn't one).
    pub fn iteration_args(&self, ty: &Type) -> Option<(Type, Type)> {
        let Type::Named { fqn, args } = ty else { return None };
        ["Traversable", "Iterator", "IteratorAggregate", "Generator"].iter().find_map(|target| {
            match self.ancestor_args(fqn, args, target)?.as_slice() {
                [] => None,
                [value] => Some((Type::Mixed, value.clone())),
                [key, value, ..] => Some((key.clone(), value.clone())),
            }
        })
    }

    /// `new fqn(…)`: `fqn` with its templates inferred from the constructor
    /// arguments, or the raw class when none could be.
    pub fn instantiate(&self, fqn: &str, args: &dyn Fn() -> Vec<CallArg>) -> Type {
        let raw = Type::named(fqn);
        let Some(model) = self.class_model(fqn) else { return raw };
        let own = class_template_params(&model.class);
        if own.is_empty() {
            return raw;
        }
        let Some(constructor) = model.method("__construct") else { return raw };
        let receiver = Receiver { class: fqn, this: &raw, start: Start::Own(model.fqn()) };
        let bindings = self.receiver_bindings(&receiver, &constructor.declaring);
        let params = self.method_params(constructor, &bindings);
        let names: Vec<String> = own.iter().map(|param| param.name.clone()).collect();
        let mut inferred = Bindings::new();
        self.infer_args(&params, &args(), &names, &mut inferred);
        if inferred.is_empty() {
            return raw;
        }
        let mut bound = Bindings::new();
        let args = own
            .iter()
            .map(|param| {
                let ty = inferred.get(&param.name).cloned().unwrap_or_else(|| substitute(&param.fallback(), &bound));
                bound.insert(param.name.clone(), ty.clone());
                ty
            })
            .collect();
        Type::Named { fqn: model.fqn().to_owned(), args }
    }

    /// Binds the templates of a function's return type: its own, inferred
    /// from `args` when given, else their fallbacks.
    pub(super) fn function_generics(&self, fqn: &str, ty: Type, args: Option<&dyn Fn() -> Vec<CallArg>>) -> Type {
        if !is_generic(&ty) {
            return ty;
        }
        let Some(function) = self.decls.function(fqn) else { return ty };
        let doc = function.doc.as_deref();
        let scope: Vec<&str> = doc.iter().flat_map(|doc| doc.local_type_names()).collect();
        let own = template_params(doc, &scope);
        let params = declared_params(&function.params, doc, &scope);
        let mut bindings = Bindings::new();
        self.bind_call(&own, &params, args, &mut bindings);
        substitute(&ty, &bindings)
    }
}

#[cfg(test)]
mod tests;
