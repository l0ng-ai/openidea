//! PhpStorm advanced metadata: the directives of `.phpstorm.meta.php`.
//!
//! Any PHP file that declares the namespace `PHPSTORM_META` (a
//! `.phpstorm.meta.php` file, or any file inside a `.phpstorm.meta.php`
//! directory) holds directives, written as calls, that the public
//! [Advanced metadata](https://www.jetbrains.com/help/phpstorm/ide-advanced-metadata.html)
//! documentation describes:
//!
//! - `override(\Foo::make(0), map(['key' => \Bar::class, '' => '@']))`:
//!   the return type of a call depends on the value of one argument. A key
//!   is matched against the argument's string value (or the class a
//!   `::class` argument names); `''` is the default entry; `@` in a value
//!   stands for the argument's value (`'@'`, `'@Repository'`, `'@[]'`).
//! - `override(\f(0), type(0))`: the call returns the type of argument 0
//!   (the class itself when the argument names one, as `Foo::class` does).
//! - `override(\f(0), elementType(0))`: the call returns the element type
//!   of argument 0.
//! - `expectedArguments(\f(), 0, 'a', 'b')`, `expectedReturnValues(\f(),
//!   'a')`, `registerArgumentsSet('name', 'a', 'b')` / `argumentsSet('name')`:
//!   values offered by completion.
//! - `exitPoint(\f())`: the call never returns.
//!
//! The directives are extracted into each file's summary
//! ([`MetaDirectives`], [`FileSummary::meta`](crate::summary::FileSummary));
//! [`PhpStormMeta`] merges those of the whole project (the
//! [`Declarations`](crate::types::Declarations) say which files have them)
//! and answers lookups. Overrides and exit points apply through
//! [`MetaProvider`], a built-in type provider that runs before the others.
//!
//! A method target (`\Foo::make()`) applies to `Foo` and its subclasses,
//! static and instance calls alike. `override(new \Foo, …)` (array access
//! on objects) is not supported yet.

mod extract;
#[cfg(test)]
mod tests;

pub(crate) use extract::directive;

use std::collections::HashMap;
use std::fmt;

use serde::{Deserialize, Serialize};

use crate::names::{NameKind, fqn_eq};
use crate::types::provider::{CallKind, CallSite, provided};
use crate::types::{Context, LazyType, Resolver, Type, TypeProvider, parse_doc_type};

/// The function or method a directive is about.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Callee {
    /// A function, by FQN without the leading `\`.
    Function(String),
    /// A method of a class-like (FQN without the leading `\`) or its
    /// subclasses.
    Method { class: String, name: String },
}

impl fmt::Display for Callee {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Function(fqn) => write!(f, "\\{fqn}()"),
            Self::Method { class, name } => write!(f, "\\{class}::{name}()"),
        }
    }
}

/// A value of `expectedArguments`, `expectedReturnValues` and
/// `registerArgumentsSet`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum MetaValue {
    /// A string literal (its value).
    String(String),
    Int(i64),
    /// `Foo::class`: the class FQN.
    Class(String),
    /// `Foo::BAR`.
    ClassConstant {
        class: String,
        name: String,
    },
    /// A global constant, by FQN.
    Constant(String),
    /// `argumentsSet('name')`, expanded by the lookups.
    ArgumentsSet(String),
    /// Anything else (bit masks such as `A | B`, floats), as source text.
    Other(String),
}

impl fmt::Display for MetaValue {
    /// As PHP source: `'books'`, `1`, `\Foo::class`, `\Foo::BAR`, `\BAR`.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::String(value) => write!(f, "'{}'", value.replace('\\', "\\\\").replace('\'', "\\'")),
            Self::Int(value) => write!(f, "{value}"),
            Self::Class(class) => write!(f, "\\{class}::class"),
            Self::ClassConstant { class, name } => write!(f, "\\{class}::{name}"),
            Self::Constant(fqn) => write!(f, "\\{fqn}"),
            Self::ArgumentsSet(name) => write!(f, "argumentsSet('{name}')"),
            Self::Other(text) => f.write_str(text),
        }
    }
}

/// What an `override` says the call returns.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum OverrideKind {
    /// `map([key => value, …])`, keys and values as strings: class names
    /// from `::class` without the leading `\`, `''` for the default entry.
    Map(Vec<(String, String)>),
    /// `type(n)`.
    Type(u32),
    /// `elementType(n)`.
    ElementType(u32),
}

/// `override(callee(arg), kind)`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Override {
    pub callee: Callee,
    /// The argument index written in the callee (`make(0)`): the argument
    /// `map` looks at. 0 when none is written.
    pub arg: u32,
    pub kind: OverrideKind,
}

/// `expectedArguments(callee, index, values…)`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ExpectedArguments {
    pub callee: Callee,
    pub index: u32,
    pub values: Vec<MetaValue>,
}

/// `expectedReturnValues(callee, values…)`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ExpectedReturnValues {
    pub callee: Callee,
    pub values: Vec<MetaValue>,
}

/// The directives of one file, in source order.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MetaDirectives {
    pub overrides: Vec<Override>,
    pub expected_arguments: Vec<ExpectedArguments>,
    pub expected_return_values: Vec<ExpectedReturnValues>,
    /// `registerArgumentsSet(name, values…)`.
    pub arguments_sets: Vec<(String, Vec<MetaValue>)>,
    pub exit_points: Vec<Callee>,
}

impl MetaDirectives {
    pub fn is_empty(&self) -> bool {
        self.overrides.is_empty()
            && self.expected_arguments.is_empty()
            && self.expected_return_values.is_empty()
            && self.arguments_sets.is_empty()
            && self.exit_points.is_empty()
    }
}

/// The call a lookup is about.
#[derive(Clone, Copy, Debug)]
pub enum CallTarget<'t> {
    /// A function call, by the FQN it resolves to (an unqualified call in a
    /// namespace: the namespaced candidate; the global name is tried when no
    /// such function exists).
    Function(&'t str),
    /// `$receiver->name()` or `Receiver::name()`.
    Method { receiver: &'t Type, name: &'t str },
}

/// The directives of a whole project, merged.
#[derive(Clone, Debug, Default)]
pub struct PhpStormMeta {
    directives: MetaDirectives,
    /// Overrides by lower-case method name or function FQN.
    method_overrides: HashMap<String, Vec<usize>>,
    function_overrides: HashMap<String, Vec<usize>>,
}

/// How deep `argumentsSet` references are followed.
const MAX_SET_DEPTH: usize = 8;

impl PhpStormMeta {
    /// Merges the directives of several files (later files after earlier
    /// ones; an arguments set registered twice takes both values).
    pub fn merge<'d>(files: impl IntoIterator<Item = &'d MetaDirectives>) -> Self {
        let mut directives = MetaDirectives::default();
        for file in files {
            directives.overrides.extend(file.overrides.iter().cloned());
            directives.expected_arguments.extend(file.expected_arguments.iter().cloned());
            directives.expected_return_values.extend(file.expected_return_values.iter().cloned());
            directives.arguments_sets.extend(file.arguments_sets.iter().cloned());
            directives.exit_points.extend(file.exit_points.iter().cloned());
        }
        let mut method_overrides: HashMap<String, Vec<usize>> = HashMap::new();
        let mut function_overrides: HashMap<String, Vec<usize>> = HashMap::new();
        for (i, item) in directives.overrides.iter().enumerate() {
            match &item.callee {
                Callee::Function(fqn) => function_overrides.entry(fqn.to_ascii_lowercase()).or_default().push(i),
                Callee::Method { name, .. } => method_overrides.entry(name.to_ascii_lowercase()).or_default().push(i),
            }
        }
        Self { directives, method_overrides, function_overrides }
    }

    pub fn is_empty(&self) -> bool {
        self.directives.is_empty()
    }

    /// Every directive.
    pub fn directives(&self) -> &MetaDirectives {
        &self.directives
    }

    /// The overrides that apply to a call.
    pub fn overrides_for(&self, target: CallTarget<'_>, resolver: &Resolver<'_>, context: &Context) -> Vec<&Override> {
        let candidates = match target {
            CallTarget::Function(fqn) => {
                let mut found = Vec::new();
                for name in function_candidates(fqn, resolver) {
                    if let Some(indexes) = self.function_overrides.get(&name.to_ascii_lowercase()) {
                        found.extend(indexes.iter().copied());
                    }
                }
                found
            }
            CallTarget::Method { name, .. } => {
                self.method_overrides.get(&name.to_ascii_lowercase()).cloned().unwrap_or_default()
            }
        };
        candidates
            .into_iter()
            .map(|i| &self.directives.overrides[i])
            .filter(|item| applies(&item.callee, target, resolver, context))
            .collect()
    }

    /// The values `expectedArguments` gives for argument `index` of a call,
    /// arguments sets expanded, duplicates dropped.
    pub fn expected_arguments(
        &self,
        target: CallTarget<'_>,
        index: u32,
        resolver: &Resolver<'_>,
        context: &Context,
    ) -> Vec<MetaValue> {
        let values = self
            .directives
            .expected_arguments
            .iter()
            .filter(|item| item.index == index && applies(&item.callee, target, resolver, context))
            .flat_map(|item| &item.values);
        self.expand(values)
    }

    /// The values `expectedReturnValues` gives for a call, arguments sets
    /// expanded, duplicates dropped.
    pub fn expected_return_values(
        &self,
        target: CallTarget<'_>,
        resolver: &Resolver<'_>,
        context: &Context,
    ) -> Vec<MetaValue> {
        let values = self
            .directives
            .expected_return_values
            .iter()
            .filter(|item| applies(&item.callee, target, resolver, context))
            .flat_map(|item| &item.values);
        self.expand(values)
    }

    /// The values of arguments set `name`, nested sets expanded.
    pub fn arguments_set(&self, name: &str) -> Vec<MetaValue> {
        self.expand(std::iter::once(&MetaValue::ArgumentsSet(name.to_owned())))
    }

    /// Whether the call is an `exitPoint`.
    pub fn is_exit_point(&self, target: CallTarget<'_>, resolver: &Resolver<'_>, context: &Context) -> bool {
        self.directives.exit_points.iter().any(|callee| applies(callee, target, resolver, context))
    }

    fn expand<'v>(&self, values: impl IntoIterator<Item = &'v MetaValue>) -> Vec<MetaValue> {
        let mut out = Vec::new();
        for value in values {
            self.expand_into(value, 0, &mut out);
        }
        out
    }

    fn expand_into(&self, value: &MetaValue, depth: usize, out: &mut Vec<MetaValue>) {
        match value {
            MetaValue::ArgumentsSet(name) => {
                if depth >= MAX_SET_DEPTH {
                    return;
                }
                for (_, values) in self.directives.arguments_sets.iter().filter(|(set, _)| set == name) {
                    for value in values {
                        self.expand_into(value, depth + 1, out);
                    }
                }
            }
            other => {
                if !out.contains(other) {
                    out.push(other.clone());
                }
            }
        }
    }
}

/// `fqn`, then its global name when `fqn` is a namespaced candidate that
/// doesn't exist (PHP's fallback for unqualified calls).
fn function_candidates<'f>(fqn: &'f str, resolver: &Resolver<'_>) -> Vec<&'f str> {
    let fqn = fqn.trim_start_matches('\\');
    let mut out = vec![fqn];
    if let Some((_, global)) = fqn.rsplit_once('\\')
        && resolver.declarations().function(fqn).is_none()
    {
        out.push(global);
    }
    out
}

/// Whether a directive about `callee` applies to the call.
fn applies(callee: &Callee, target: CallTarget<'_>, resolver: &Resolver<'_>, context: &Context) -> bool {
    match (callee, target) {
        (Callee::Function(wanted), CallTarget::Function(fqn)) => {
            function_candidates(fqn, resolver).iter().any(|fqn| fqn_eq(NameKind::Function, wanted, fqn))
        }
        (Callee::Method { class, name }, CallTarget::Method { receiver, name: called }) => {
            name.eq_ignore_ascii_case(called)
                && resolver.class_models(receiver, context).iter().any(|model| model.is_subclass_of(class))
        }
        _ => false,
    }
}

/// The class a string names, when it looks like a class name.
fn class_name_of(value: &str) -> Option<&str> {
    let name = value.trim_start_matches('\\');
    let valid = !name.is_empty()
        && name.split('\\').all(|segment| {
            let mut chars = segment.chars();
            chars.next().is_some_and(|c| c == '_' || c.is_alphabetic() || !c.is_ascii())
                && chars.all(|c| c == '_' || c.is_alphanumeric() || !c.is_ascii())
        });
    valid.then_some(name)
}

/// The string an argument stands for in a `map`: a literal string's value,
/// or the class a class-string names.
fn argument_value(arg: &Type) -> Option<String> {
    match arg {
        Type::LiteralString(value) => Some(value.clone()),
        Type::ClassString(Some(class)) => match &**class {
            Type::Named { fqn, .. } => Some(fqn.clone()),
            _ => None,
        },
        _ => None,
    }
}

/// The type a `map` value (with `@` already replaced) names: a class, or a
/// PHPDoc type (`Foo[]`, `Foo|null`) whose class names are fully qualified.
fn type_of_text(text: &str) -> Option<Type> {
    let text = text.trim();
    match class_name_of(text) {
        Some(class) => Some(Type::named(class)),
        None => parse_doc_type(text, &[]).ok(),
    }
}

impl Override {
    /// The type this override gives a call with these arguments (resolved,
    /// receiver excluded); `None` when it can't say.
    pub fn apply(&self, args: &[Type], resolver: &Resolver<'_>) -> Option<Type> {
        match &self.kind {
            OverrideKind::Map(entries) => {
                let value = args.get(self.arg as usize).and_then(argument_value);
                let entry = value
                    .as_deref()
                    .and_then(|value| {
                        let value = value.trim_start_matches('\\');
                        entries.iter().find(|(key, _)| !key.is_empty() && key.trim_start_matches('\\') == value)
                    })
                    .or_else(|| entries.iter().find(|(key, _)| key.is_empty()))?;
                let target = &entry.1;
                let text = if target.contains('@') {
                    target.replace('@', value?.trim_start_matches('\\'))
                } else {
                    target.clone()
                };
                type_of_text(&text)
            }
            OverrideKind::Type(index) => {
                let arg = args.get(*index as usize)?;
                if *arg == Type::Mixed {
                    return None;
                }
                let classes: Vec<Type> = arg
                    .members()
                    .iter()
                    .map(|member| match member {
                        Type::ClassString(Some(class)) => Some((**class).clone()),
                        Type::LiteralString(value) => {
                            class_name_of(value).filter(|name| resolver.class_model(name).is_some()).map(Type::named)
                        }
                        _ => None,
                    })
                    .collect::<Option<_>>()
                    .unwrap_or_default();
                Some(if classes.is_empty() { arg.widen() } else { Type::union(classes) })
            }
            OverrideKind::ElementType(index) => {
                let arg = args.get(*index as usize)?;
                let elements: Vec<Type> = arg
                    .members()
                    .iter()
                    .map(|member| match member {
                        Type::Array { value, .. } | Type::List { value, .. } | Type::Iterable { value, .. } => {
                            (**value).clone()
                        }
                        Type::Shape(shape) => shape.value_type(),
                        Type::Named { .. } => {
                            resolver.iteration_args(member).map(|(_, value)| value).unwrap_or(Type::Mixed)
                        }
                        _ => Type::Mixed,
                    })
                    .collect();
                let ty = Type::union(elements);
                (ty != Type::Mixed).then_some(ty)
            }
        }
    }
}

/// Applies `.phpstorm.meta.php` overrides and exit points to calls.
///
/// Its local step answers with a payload (`f:<fqn>` or `m:<name>`, the
/// receiver and the arguments' types) whose fallback is what the providers
/// after it say; the resolve step looks the call up in the project's
/// [`PhpStormMeta`]. In a summary, where every payload is stored, it only
/// answers for calls with a string or `::class` argument (what `map` needs)
/// that no other provider answers; when typing expressions it answers for
/// every call.
pub struct MetaProvider;

/// The key of [`MetaProvider`]'s payloads.
pub const META_KEY: &str = "meta";

impl TypeProvider for MetaProvider {
    fn key(&self) -> &'static str {
        META_KEY
    }

    fn call(&self, site: &CallSite<'_>) -> Option<LazyType> {
        if site.stored && !site.args.iter().any(|arg| arg.string.is_some() || arg.class.is_some()) {
            return None;
        }
        let payload = match site.kind {
            CallKind::Function => format!("f:{}", site.name),
            CallKind::Method | CallKind::StaticMethod => format!("m:{}", site.name),
        };
        let next = (site.next)();
        if site.stored && matches!(next, LazyType::Provided { .. }) {
            // Another provider knows this call better; keep summaries small.
            return Some(next);
        }
        let mut args = vec![site.receiver.cloned().unwrap_or_else(LazyType::mixed)];
        args.extend((site.arg_types)());
        Some(provided(self.key(), payload, args, next))
    }

    fn resolve(&self, payload: &str, args: &[Type], resolver: &Resolver<'_>, context: &Context) -> Option<Type> {
        let meta = resolver.meta();
        if meta.is_empty() {
            return None;
        }
        let (receiver, args) = args.split_first()?;
        let target = match payload.split_once(':')? {
            ("f", fqn) => CallTarget::Function(fqn),
            ("m", name) => CallTarget::Method { receiver, name },
            _ => return None,
        };
        if meta.is_exit_point(target, resolver, context) {
            return Some(Type::Never);
        }
        meta.overrides_for(target, resolver, context).into_iter().find_map(|item| item.apply(args, resolver))
    }
}
