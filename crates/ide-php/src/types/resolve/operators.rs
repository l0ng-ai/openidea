//! What the resolver adds to the type operators, type aliases and mixins:
//!
//! - **Operators** ([`crate::types::operator`]) whose arguments are class
//!   constants (`value-of<Foo::STATUSES>`, `int-mask-of<self::FLAG_*>`), a
//!   backed enum (`value-of<Suit>`) or classes (`(T is Foo ? A : B)`) are
//!   evaluated here; a conditional on a parameter (`($id is int ? A : B)`)
//!   takes the type of the argument passed for it. What stays open widens
//!   when the type leaves the resolver ([`Resolver::finish`]).
//! - **Type aliases** (`@phpstan-type`/`@psalm-type`, and their
//!   `import-type` tags) are expanded in the types of the class's members.
//! - **`@mixin Foo<T>`**: a mixin's arguments bind the mixin class's
//!   templates in the members it lends, as `@extends` arguments do for a
//!   parent.

use super::generics::{MAX_EDGE_DEPTH, class_scope, edges};
use super::{Args, CallArg, Context, Resolver, bind_args, class_template_params, substitute};
use crate::names::{NameKind, fqn_eq};
use crate::summary::{ClassLike, DocTypeAlias};
use crate::types::{Operator, ShapeKey, SignatureParam, Subject, Type};

/// How many aliases deep an alias expands (aliases naming aliases).
const MAX_ALIAS_DEPTH: usize = 8;

impl Resolver<'_> {
    /// A type leaving the resolver: `self`/`parent` (and `static`/`$this`
    /// when the context knows them) bound, the operators evaluated, and the
    /// ones still open widened.
    pub(crate) fn finish(&self, ty: &Type, context: &Context) -> Type {
        let ty = self.bind(ty, context);
        self.evaluate(&ty, context).settle()
    }

    /// Evaluates the operators in `ty` that class constants, enums and the
    /// class hierarchy decide; the others stay open.
    pub fn evaluate(&self, ty: &Type, context: &Context) -> Type {
        if !ty.has_operator() {
            return ty.clone();
        }
        ty.map(&mut |ty| match ty {
            Type::Operator(operator) => Some(self.evaluate_operator(operator, context)),
            _ => None,
        })
    }

    fn evaluate_operator(&self, operator: &Operator, context: &Context) -> Type {
        let operand = |ty: &Type| self.operand(ty, context);
        let operator = match operator {
            // The branches are results, not arguments: an enum case there
            // stays a case.
            Operator::Conditional(conditional) => {
                let mut conditional = (**conditional).clone();
                if let Subject::Type(subject) = &conditional.subject {
                    conditional.subject = Subject::Type(operand(subject));
                }
                conditional.target = operand(&conditional.target);
                conditional.then = self.evaluate(&conditional.then, context);
                conditional.otherwise = self.evaluate(&conditional.otherwise, context);
                Operator::Conditional(Box::new(conditional))
            }
            other => other.map_children(&mut |ty| operand(ty)),
        };
        if let Some(ty) = operator.evaluate(Some(self)) {
            return ty;
        }
        match &operator {
            Operator::ValueOf(ty) if let Some(values) = self.enum_values(ty) => values,
            _ => Type::Operator(Box::new(operator)),
        }
    }

    /// An operator's argument: evaluated, its class constants replaced by
    /// their values.
    fn operand(&self, ty: &Type, context: &Context) -> Type {
        let ty = self.evaluate(ty, context);
        ty.map(&mut |ty| match ty {
            Type::ClassConstant { class, name } => self.constant_values(class, name, context),
            _ => None,
        })
    }

    /// The type of `class::name`, or of every constant `name` matches when
    /// it has a `*`; `None` when unknown.
    fn constant_values(&self, class: &str, name: &str, context: &Context) -> Option<Type> {
        let class = match class.to_ascii_lowercase().as_str() {
            "self" | "static" => context.self_class.clone()?,
            _ => class.to_owned(),
        };
        let receiver = Type::named(&class);
        let value = |name: &str| {
            let ty = self.class_constant_type(&receiver, name, &Context::default());
            (ty != Type::Mixed).then_some(ty)
        };
        if !name.contains('*') {
            return value(name);
        }
        let (prefix, suffix) = name.split_once('*').unwrap_or((name, ""));
        let model = self.class_model(&class)?;
        let mut values = Vec::new();
        for constant in model.constants.iter() {
            if constant.name.starts_with(prefix) && constant.name.ends_with(suffix) && constant.case().is_none() {
                values.push(value(&constant.name)?);
            }
        }
        (!values.is_empty()).then(|| Type::union(values))
    }

    /// `value-of<Suit>`: the values of a backed enum's cases.
    fn enum_values(&self, ty: &Type) -> Option<Type> {
        let mut out = Vec::new();
        for member in ty.members() {
            let Type::Named { fqn, .. } = member else { return None };
            let model = self.class_model(fqn)?;
            let cases = &model.class.cases;
            if cases.is_empty() {
                return None;
            }
            for case in cases {
                let value = case.value.as_deref()?;
                out.push(crate::types::parse_doc_type(value, &[]).ok()?);
            }
        }
        Some(Type::union(out))
    }

    /// `ty` with each conditional on a parameter decided by the argument a
    /// call passes for it (`params` are the callee's). Conditionals on a
    /// parameter the call leaves out stay open.
    pub(super) fn apply_args(&self, ty: &Type, params: &[SignatureParam], args: Args<'_>) -> Type {
        if !has_param_conditional(ty) {
            return ty.clone();
        }
        let args = args();
        self.apply_arg_list(ty, params, &args, 0)
    }

    fn apply_arg_list(&self, ty: &Type, params: &[SignatureParam], args: &[CallArg], depth: usize) -> Type {
        if depth > MAX_ALIAS_DEPTH {
            return ty.clone();
        }
        ty.map(&mut |ty| {
            let Type::Operator(operator) = ty else { return None };
            let Operator::Conditional(conditional) = operator.as_ref() else { return None };
            let Subject::Param(name) = &conditional.subject else { return None };
            let arg = argument_for(params, args, name).or_else(|| default_for(params, args, name))?;
            let target = self.evaluate(&conditional.target, &Context::default());
            let decided = crate::types::Conditional { target, ..(**conditional).clone() }.decide(&arg, Some(self))?;
            Some(self.apply_arg_list(&decided, params, args, depth + 1))
        })
    }

    // ------------------------------------------------------------ aliases

    /// `ty`, a type written in a docblock of `class` or one of its members,
    /// with `class`'s type aliases expanded.
    pub fn expand_aliases(&self, ty: &Type, class: &ClassLike) -> Type {
        self.aliases_at(ty, class, 0)
    }

    fn aliases_at(&self, ty: &Type, class: &ClassLike, depth: usize) -> Type {
        let Some(doc) = class.doc.as_deref() else { return ty.clone() };
        if doc.type_aliases.is_empty() || depth > MAX_ALIAS_DEPTH {
            return ty.clone();
        }
        ty.map(&mut |ty| match ty {
            // A template of the same name wins.
            Type::Template(name) if !doc.templates.iter().any(|template| template.name == *name) => {
                let alias = doc.type_aliases.iter().find(|alias| alias.name == *name)?;
                Some(self.alias_type(alias, class, depth + 1))
            }
            _ => None,
        })
    }

    /// What alias `alias` of `class` stands for, `mixed` when unknown.
    fn alias_type(&self, alias: &DocTypeAlias, class: &ClassLike, depth: usize) -> Type {
        if depth > MAX_ALIAS_DEPTH {
            return Type::Mixed;
        }
        match (&alias.ty, &alias.imported_from) {
            (Some(ty), _) => self.aliases_at(&Type::from_doc(ty, &class_scope(class)), class, depth),
            (None, Some((from, name))) => {
                let Some(other) = self.decls.class_like(from) else { return Type::Mixed };
                let found = other.doc.as_deref().and_then(|doc| doc.type_aliases.iter().find(|a| a.name == *name));
                match found {
                    Some(found) => self.alias_type(found, &other, depth + 1),
                    None => Type::Mixed,
                }
            }
            (None, None) => Type::Mixed,
        }
    }

    // ------------------------------------------------------------- mixins

    /// The generic arguments `class<args>` passes, through a `@mixin Foo<…>`
    /// of its own or of an ancestor, to `target` (the mixin class or one of
    /// its ancestors). `None` when no mixin leads there.
    pub(super) fn mixin_args(&self, class: &str, args: &[Type], target: &str) -> Option<Vec<Type>> {
        self.mixin_args_at(class, args, target, 0)
    }

    fn mixin_args_at(&self, class: &str, args: &[Type], target: &str, depth: usize) -> Option<Vec<Type>> {
        if depth >= MAX_EDGE_DEPTH {
            return None;
        }
        let model = self.class_model(class)?;
        if model.mixins.is_empty() {
            return None;
        }
        let bindings = bind_args(&class_template_params(&model.class), args);
        let scope = class_scope(&model.class);
        for tag in model.class.doc.iter().flat_map(|doc| &doc.mixins) {
            for ty in Type::from_doc(tag, &scope).members() {
                if let Type::Named { fqn, args: mixin_args } = ty {
                    let mixin_args: Vec<Type> = mixin_args.iter().map(|arg| substitute(arg, &bindings)).collect();
                    if let Some(found) = self.ancestor_args(fqn, &mixin_args, target) {
                        return Some(found);
                    }
                }
            }
        }
        edges(&model.class).into_iter().find_map(|(edge, edge_args)| {
            let edge_args: Vec<Type> = edge_args.iter().map(|arg| substitute(arg, &bindings)).collect();
            self.mixin_args_at(&edge, &edge_args, target, depth + 1)
        })
    }

    /// The mixin class `mixin` with the arguments `class<args>` passes it,
    /// for what `static` and `$this` are in the members it lends; `None`
    /// when it passes none.
    pub(super) fn mixin_this(&self, class: &str, args: &[Type], mixin: &str) -> Option<Type> {
        let args = self.mixin_args(class, args, mixin).filter(|args| !args.is_empty())?;
        Some(Type::generic(mixin, args))
    }
}

/// The type of property `name` of an object shape.
pub(super) fn shape_property(fields: &[crate::types::ShapeField], name: &str) -> Option<Type> {
    let key = ShapeKey::String(name.trim_start_matches('$').to_owned());
    fields.iter().find(|field| field.key == key).map(|field| field.ty.clone())
}

/// True when `ty` has a conditional on a parameter.
fn has_param_conditional(ty: &Type) -> bool {
    ty.any(&|ty| {
        matches!(ty, Type::Operator(operator)
            if matches!(operator.as_ref(), Operator::Conditional(conditional)
                if matches!(conditional.subject, Subject::Param(_))))
    })
}

/// The type of the argument a call passes for parameter `name`: by name,
/// else by position. `None` when the call leaves it out or spreads into it.
fn argument_for(params: &[SignatureParam], args: &[CallArg], name: &str) -> Option<Type> {
    if let Some(named) = args.iter().find(|arg| arg.name.as_deref() == Some(name)) {
        return Some(named.ty.clone());
    }
    let position = params.iter().position(|param| param.name.as_deref() == Some(name))?;
    if params[position].variadic {
        return None;
    }
    let positional: Vec<&CallArg> = args.iter().take_while(|arg| arg.name.is_none()).collect();
    if positional.iter().take(position + 1).any(|arg| arg.spread) {
        return None;
    }
    positional.get(position).map(|arg| arg.ty.clone())
}

/// The default value of parameter `name` when `args` leave it out (not
/// passed by name, and fewer positional arguments without a spread).
fn default_for(params: &[SignatureParam], args: &[CallArg], name: &str) -> Option<Type> {
    if args.iter().any(|arg| arg.name.as_deref() == Some(name)) {
        return None;
    }
    let position = params.iter().position(|param| param.name.as_deref() == Some(name))?;
    let positional: Vec<&CallArg> = args.iter().take_while(|arg| arg.name.is_none()).collect();
    if positional.len() > position || positional.iter().any(|arg| arg.spread) {
        return None;
    }
    params[position].default.clone()
}

/// True when two class names are the same class.
pub(super) fn same_class(a: &str, b: &str) -> bool {
    fqn_eq(NameKind::ClassLike, a, b)
}
