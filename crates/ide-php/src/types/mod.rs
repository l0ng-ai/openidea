//! The type model: what a PHP expression, parameter or return can be.
//!
//! [`Type`] covers native type hints and the PHPDoc dialect that PHPStan,
//! Psalm and PhpStorm share:
//!
//! - scalars with their refinements (`positive-int`, `int<0, 10>`,
//!   `non-empty-string`, `numeric-string`, …) and literals (`1`, `'a'`,
//!   `true`);
//! - `array<K, V>`, `list<V>`, shapes (`array{a: int, b?: string}`,
//!   `list{int, string}`) and `iterable<K, V>`;
//! - class-likes with generic arguments, `self`/`static`/`parent`/`$this`,
//!   `class-string<T>` and template parameters;
//! - unions, intersections and nullable types (a union with `null`);
//! - `callable` and `Closure` with optional signatures;
//! - `mixed`, `never`, `void`, `null`, `object`, `resource`, `scalar`,
//!   `numeric` and `array-key`.
//!
//! Types come from native hints ([`Type::from_hint`]) and from the PHPDoc
//! type expressions stored in summaries ([`Type::from_doc`],
//! [`parse_doc_type`]). They print as PHP/PHPDoc syntax ([`fmt::Display`]),
//! and [`Type::is_subtype_of`] answers subtyping against a class
//! [`Hierarchy`]. [`Type::union`] and [`Type::intersection`] build
//! simplified compound types.
//!
//! Written in-house rather than reusing Mago's `codex` types: those are tied
//! to Mago's own codebase metadata and interner (and `mago-codex` would pull
//! in the analyzer's dependencies), whereas this engine resolves types lazily
//! against its own indexes (phase 2.2). The PHPDoc parser is Mago's
//! (`mago_phpdoc_syntax::parse_type`). The subtyping rules follow the public
//! PHPStan and Psalm documentation of these types.
//!
//! A few PHPDoc forms are kept only approximately, since nothing later needs
//! more: `key-of`, `value-of`, `properties-of`, index access, `int-mask` and
//! object shapes widen to their base type (`mixed`, `int`, `object`), and a
//! conditional return type `(T is X ? A : B)` becomes `A|B`.

mod display;
mod lazy;
mod parse;
pub mod resolve;
mod subtype;

use serde::{Deserialize, Serialize};

pub use lazy::LazyType;
pub use parse::{TypeParseError, parse_doc_type};
pub use resolve::{Context, Declarations, Resolver, SummarySet, TypeCache};
pub use subtype::{Hierarchy, NoHierarchy};

/// A PHP type.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Type {
    Mixed,
    Never,
    Void,
    Null,
    Bool,
    /// `true` or `false`.
    LiteralBool(bool),
    Int,
    /// `int<min, max>`; `None` is unbounded. Never both `None` (that is
    /// [`Type::Int`]); `positive-int` is `int<1, max>`.
    IntRange {
        min: Option<i64>,
        max: Option<i64>,
    },
    LiteralInt(i64),
    Float,
    /// A float literal, as written.
    LiteralFloat(String),
    String(StringKind),
    LiteralString(String),
    /// `class-string`, or `class-string<T>` (also `interface-string`,
    /// `enum-string`, `trait-string`).
    ClassString(Option<Box<Type>>),
    /// `int|string`.
    ArrayKey,
    /// `int|float|numeric-string`.
    Numeric,
    /// `bool|int|float|string`.
    Scalar,
    Resource,
    /// Any object.
    Object,
    /// `array<K, V>`; a plain `array` is `array<array-key, mixed>`.
    Array {
        key: Box<Type>,
        value: Box<Type>,
        non_empty: bool,
    },
    /// `list<V>`: an array with keys `0..n`.
    List {
        value: Box<Type>,
        non_empty: bool,
    },
    /// `array{…}` or `list{…}`.
    Shape(Box<Shape>),
    /// `iterable<K, V>`.
    Iterable {
        key: Box<Type>,
        value: Box<Type>,
    },
    /// A class, interface or enum, by fully qualified name without the
    /// leading `\`, with its generic arguments.
    Named {
        fqn: String,
        args: Vec<Type>,
    },
    /// `self`, `static`, `parent` or `$this`, completed in context.
    Relative(Relative),
    /// A template parameter in scope (`@template T`).
    Template(String),
    /// `Foo::BAR` in PHPDoc: an enum case or a class constant's value.
    ClassConstant {
        class: String,
        name: String,
    },
    /// `callable`, with an optional signature.
    Callable(Option<Box<Signature>>),
    /// `Closure` (the class), with an optional signature.
    Closure(Option<Box<Signature>>),
    /// Flat, simplified, at least two members ([`Type::union`]).
    Union(Vec<Type>),
    /// Flat, at least two members ([`Type::intersection`]).
    Intersection(Vec<Type>),
}

/// Refinements of `string`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum StringKind {
    Any,
    NonEmpty,
    /// `non-falsy-string` / `truthy-string`: neither `''` nor `'0'`.
    NonFalsy,
    Numeric,
    Lowercase,
    NonEmptyLowercase,
    Uppercase,
    NonEmptyUppercase,
    Callable,
}

impl StringKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Any => "string",
            Self::NonEmpty => "non-empty-string",
            Self::NonFalsy => "non-falsy-string",
            Self::Numeric => "numeric-string",
            Self::Lowercase => "lowercase-string",
            Self::NonEmptyLowercase => "non-empty-lowercase-string",
            Self::Uppercase => "uppercase-string",
            Self::NonEmptyUppercase => "non-empty-uppercase-string",
            Self::Callable => "callable-string",
        }
    }
}

/// A class named relative to the code it appears in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Relative {
    Self_,
    Static,
    Parent,
    /// `$this`: the object itself, a subtype of `static`.
    This,
}

impl Relative {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Self_ => "self",
            Self::Static => "static",
            Self::Parent => "parent",
            Self::This => "$this",
        }
    }
}

impl From<crate::names::RelativeClass> for Relative {
    fn from(relative: crate::names::RelativeClass) -> Self {
        use crate::names::RelativeClass;
        match relative {
            RelativeClass::Self_ => Self::Self_,
            RelativeClass::Static => Self::Static,
            RelativeClass::Parent => Self::Parent,
        }
    }
}

/// An array shape.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Shape {
    /// `list{…}` rather than `array{…}`.
    pub list: bool,
    pub fields: Vec<ShapeField>,
    /// The type of keys and values beyond the listed fields (`...<K, V>`,
    /// or `...` for `array-key, mixed`); `None` when sealed.
    pub rest: Option<(Type, Type)>,
}

impl Shape {
    pub fn field(&self, key: &ShapeKey) -> Option<&ShapeField> {
        self.fields.iter().find(|field| &field.key == key)
    }

    /// True when some field is required.
    pub fn is_non_empty(&self) -> bool {
        self.fields.iter().any(|field| !field.optional)
    }

    /// The union of the key types.
    pub fn key_type(&self) -> Type {
        let mut keys: Vec<Type> = self.fields.iter().map(|field| field.key.as_type()).collect();
        keys.extend(self.rest.as_ref().map(|(key, _)| key.clone()));
        Type::union(keys)
    }

    /// The union of the value types.
    pub fn value_type(&self) -> Type {
        let mut values: Vec<Type> = self.fields.iter().map(|field| field.ty.clone()).collect();
        values.extend(self.rest.as_ref().map(|(_, value)| value.clone()));
        Type::union(values)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ShapeField {
    pub key: ShapeKey,
    pub ty: Type,
    /// `key?: T`.
    pub optional: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ShapeKey {
    Int(i64),
    String(String),
}

impl ShapeKey {
    /// The literal type of the key.
    pub fn as_type(&self) -> Type {
        match self {
            Self::Int(value) => Type::LiteralInt(*value),
            Self::String(value) => Type::LiteralString(value.clone()),
        }
    }
}

/// The signature of a `callable(…): T` or `Closure(…): T`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Signature {
    pub params: Vec<SignatureParam>,
    /// `None` when not written.
    pub return_type: Option<Type>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SignatureParam {
    /// `mixed` when not written.
    pub ty: Type,
    /// Without the `$`.
    pub name: Option<String>,
    pub by_ref: bool,
    /// `T=`.
    pub optional: bool,
    pub variadic: bool,
}

impl SignatureParam {
    /// A parameter a caller must pass.
    pub fn is_required(&self) -> bool {
        !self.optional && !self.variadic
    }
}

impl Type {
    /// `array` as a plain native hint: `array<array-key, mixed>`.
    pub fn array() -> Self {
        Self::Array { key: Box::new(Self::ArrayKey), value: Box::new(Self::Mixed), non_empty: false }
    }

    /// `array<K, V>`.
    pub fn array_of(key: Self, value: Self) -> Self {
        Self::Array { key: Box::new(key), value: Box::new(value), non_empty: false }
    }

    /// `list<V>`.
    pub fn list_of(value: Self) -> Self {
        Self::List { value: Box::new(value), non_empty: false }
    }

    /// `iterable` as a plain native hint.
    pub fn iterable() -> Self {
        Self::Iterable { key: Box::new(Self::Mixed), value: Box::new(Self::Mixed) }
    }

    pub fn string() -> Self {
        Self::String(StringKind::Any)
    }

    /// A class-like without generic arguments (FQN with or without `\`).
    pub fn named(fqn: &str) -> Self {
        Self::Named { fqn: fqn.trim_start_matches('\\').to_owned(), args: Vec::new() }
    }

    /// A generic class-like.
    pub fn generic(fqn: &str, args: Vec<Self>) -> Self {
        Self::Named { fqn: fqn.trim_start_matches('\\').to_owned(), args }
    }

    /// `int<min, max>`, normalised: unbounded on both sides is `int`, a
    /// one-value range is that literal.
    pub fn int_range(min: Option<i64>, max: Option<i64>) -> Self {
        match (min, max) {
            (None, None) => Self::Int,
            (Some(min), Some(max)) if min == max => Self::LiteralInt(min),
            _ => Self::IntRange { min, max },
        }
    }

    /// `?T`: `T|null`.
    pub fn nullable(self) -> Self {
        Self::union([self, Self::Null])
    }

    /// The simplified union of some types:
    ///
    /// - nested unions are flattened and duplicates dropped (first wins);
    /// - `mixed` absorbs everything, `never` disappears;
    /// - `true|false` is `bool`;
    /// - a member that is a subtype of another member is dropped
    ///   (`1|int` is `int`, `non-empty-string|string` is `string`), using
    ///   only what is known without the class hierarchy;
    /// - no member gives `never`, one member gives itself.
    pub fn union(members: impl IntoIterator<Item = Self>) -> Self {
        let mut flat = Vec::new();
        for member in members {
            match member {
                Self::Union(inner) => flat.extend(inner),
                Self::Never => {}
                other => flat.push(other),
            }
        }
        if flat.contains(&Self::Mixed) {
            return Self::Mixed;
        }
        dedup(&mut flat);
        if let (Some(t), Some(f)) = (
            flat.iter().position(|ty| ty == &Self::LiteralBool(true)),
            flat.iter().position(|ty| ty == &Self::LiteralBool(false)),
        ) {
            let first = t.min(f);
            flat[first] = Self::Bool;
            flat.remove(t.max(f));
        }
        let flat = drop_subsumed(flat, |a, b| a.is_subtype_of(b, &NoHierarchy));
        match flat.len() {
            0 => Self::Never,
            1 => flat.into_iter().next().unwrap_or(Self::Never),
            _ => Self::Union(flat),
        }
    }

    /// The simplified intersection of some types: flattened, duplicates and
    /// `mixed` dropped, `never` absorbing everything, and a member that is a
    /// supertype of another member dropped. No member gives `mixed`.
    pub fn intersection(members: impl IntoIterator<Item = Self>) -> Self {
        let mut flat = Vec::new();
        for member in members {
            match member {
                Self::Intersection(inner) => flat.extend(inner),
                Self::Mixed => {}
                other => flat.push(other),
            }
        }
        if flat.contains(&Self::Never) {
            return Self::Never;
        }
        dedup(&mut flat);
        let flat = drop_subsumed(flat, |a, b| b.is_subtype_of(a, &NoHierarchy));
        match flat.len() {
            0 => Self::Mixed,
            1 => flat.into_iter().next().unwrap_or(Self::Mixed),
            _ => Self::Intersection(flat),
        }
    }

    /// The members of a union, or the type itself.
    pub fn members(&self) -> &[Self] {
        match self {
            Self::Union(members) => members,
            other => std::slice::from_ref(other),
        }
    }

    /// True when `null` is one of the values.
    pub fn is_nullable(&self) -> bool {
        matches!(self, Self::Mixed | Self::Null) || self.members().contains(&Self::Null)
    }

    /// The type without `null`.
    pub fn without_null(&self) -> Self {
        match self {
            Self::Null => Self::Never,
            Self::Union(members) => Self::union(members.iter().filter(|ty| **ty != Self::Null).cloned()),
            other => other.clone(),
        }
    }

    /// The type with literals widened to their base type (`1` → `int`,
    /// `'a'` → `string`, `true` → `bool`), everywhere inside it.
    pub fn widen(&self) -> Self {
        self.map(&mut |ty| match ty {
            Self::LiteralInt(_) => Some(Self::Int),
            Self::LiteralFloat(_) => Some(Self::Float),
            Self::LiteralString(_) => Some(Self::string()),
            Self::LiteralBool(_) => Some(Self::Bool),
            _ => None,
        })
    }

    /// Rebuilds the type top-down: where `replace` answers, its type takes
    /// the place of that part; elsewhere the children are mapped. Unions and
    /// intersections are simplified again.
    pub fn map(&self, replace: &mut dyn FnMut(&Self) -> Option<Self>) -> Self {
        if let Some(ty) = replace(self) {
            return ty;
        }
        let mut sub = |ty: &Self| Box::new(ty.map(replace));
        match self {
            Self::ClassString(Some(inner)) => Self::ClassString(Some(sub(inner))),
            Self::Array { key, value, non_empty } => {
                Self::Array { key: sub(key), value: sub(value), non_empty: *non_empty }
            }
            Self::List { value, non_empty } => Self::List { value: sub(value), non_empty: *non_empty },
            Self::Iterable { key, value } => Self::Iterable { key: sub(key), value: sub(value) },
            Self::Shape(shape) => Self::Shape(Box::new(Shape {
                list: shape.list,
                fields: shape
                    .fields
                    .iter()
                    .map(|field| ShapeField {
                        key: field.key.clone(),
                        ty: field.ty.map(replace),
                        optional: field.optional,
                    })
                    .collect(),
                rest: shape.rest.as_ref().map(|(key, value)| (key.map(replace), value.map(replace))),
            })),
            Self::Named { fqn, args } => {
                Self::Named { fqn: fqn.clone(), args: args.iter().map(|arg| arg.map(replace)).collect() }
            }
            Self::Callable(Some(signature)) => Self::Callable(Some(Box::new(signature.map(replace)))),
            Self::Closure(Some(signature)) => Self::Closure(Some(Box::new(signature.map(replace)))),
            Self::Union(members) => Self::union(members.iter().map(|member| member.map(replace))),
            Self::Intersection(members) => Self::intersection(members.iter().map(|member| member.map(replace))),
            other => other.clone(),
        }
    }
}

impl Signature {
    fn map(&self, replace: &mut dyn FnMut(&Type) -> Option<Type>) -> Self {
        Self {
            params: self
                .params
                .iter()
                .map(|param| SignatureParam { ty: param.ty.map(replace), ..param.clone() })
                .collect(),
            return_type: self.return_type.as_ref().map(|ty| ty.map(replace)),
        }
    }
}

fn dedup(types: &mut Vec<Type>) {
    let mut seen = std::collections::HashSet::new();
    types.retain(|ty| seen.insert(ty.clone()));
}

/// Drops each member that `covered(member, other)` by another member; of two
/// members covering each other, the first stays.
fn drop_subsumed(types: Vec<Type>, covered: impl Fn(&Type, &Type) -> bool) -> Vec<Type> {
    let keep: Vec<bool> = (0..types.len())
        .map(|i| {
            !types
                .iter()
                .enumerate()
                .any(|(j, other)| j != i && covered(&types[i], other) && (j < i || !covered(other, &types[i])))
        })
        .collect();
    types.into_iter().zip(keep).filter_map(|(ty, keep)| keep.then_some(ty)).collect()
}

#[cfg(test)]
mod tests;
