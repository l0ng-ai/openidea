//! Type operators: `key-of<T>`, `value-of<T>`, `T[K]`, `int-mask<…>`,
//! `int-mask-of<T>` and conditional types (`(T is X ? A : B)`,
//! `($param is X ? A : B)`).
//!
//! An operator is evaluated as soon as its arguments are known
//! ([`Type::operator`]): `key-of<array{a: int, b: string}>` is `'a'|'b'`.
//! While an argument still mentions a template parameter, a call's
//! parameter, a class constant (`value-of<Foo::STATUSES>`) or a class
//! hierarchy question, it stays a [`Type::Operator`]; substituting the
//! templates ([`Type::map`]) evaluates it again, and the resolver evaluates
//! what needs class constants, enums, subclass checks or the arguments of a
//! call. What is still open once a type leaves the resolver widens to what
//! the operator can be at most ([`Type::settle`]): `array-key`, `mixed`,
//! `int`, or both branches of a conditional.
//!
//! The rules follow the public PHPStan and Psalm documentation of these
//! types (PHPStan's "PHPDoc Types" page, Psalm's "Utility types" and
//! "Conditional types").

use serde::{Deserialize, Serialize};

use super::{Hierarchy, ShapeKey, Type};

/// The most values an `int-mask` lists exactly; with more bits it is an
/// `int<0, all bits>` range.
const MAX_MASK_BITS: usize = 6;

/// A type operator whose arguments don't let it be evaluated yet.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Operator {
    /// `key-of<T>`.
    KeyOf(Type),
    /// `value-of<T>`.
    ValueOf(Type),
    /// `T[K]`.
    Index { base: Type, index: Type },
    /// `int-mask<1, 2, 4>`: any bitwise or of the values.
    IntMask(Vec<Type>),
    /// `int-mask-of<T>`: any bitwise or of the values of `T`.
    IntMaskOf(Type),
    /// `(T is X ? A : B)`.
    Conditional(Box<Conditional>),
}

/// `(subject is [not] target ? then : otherwise)`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Conditional {
    pub subject: Subject,
    pub target: Type,
    /// `is not`.
    pub negated: bool,
    pub then: Type,
    pub otherwise: Type,
}

/// What a conditional type tests.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Subject {
    /// A type, usually a template parameter.
    Type(Type),
    /// A parameter of the function (without the `$`), known at a call.
    Param(String),
}

impl Type {
    /// The operator evaluated when its arguments allow it without knowing
    /// any class, else kept as a [`Type::Operator`].
    pub fn operator(operator: Operator) -> Self {
        operator.evaluate(None).unwrap_or_else(|| Self::Operator(Box::new(operator)))
    }

    /// The type with each operator still open widened to what it can be at
    /// most (`key-of<T>` → `array-key`, a conditional → both branches).
    pub fn settle(&self) -> Self {
        if !self.has_operator() {
            return self.clone();
        }
        self.map(&mut |ty| match ty {
            Self::Operator(operator) => Some(operator.widened().settle()),
            _ => None,
        })
    }

    /// True when an operator is still open somewhere in the type.
    pub fn has_operator(&self) -> bool {
        self.any(&|ty| matches!(ty, Self::Operator(_)))
    }

    /// True when `pred` holds for the type or a part of it (without
    /// rebuilding it, unlike [`Type::map`]).
    pub fn any(&self, pred: &dyn Fn(&Self) -> bool) -> bool {
        if pred(self) {
            return true;
        }
        let fields = |fields: &[super::ShapeField]| fields.iter().any(|field| field.ty.any(pred));
        let signature = |signature: &super::Signature| {
            signature.params.iter().any(|param| param.ty.any(pred))
                || signature.return_type.as_ref().is_some_and(|ty| ty.any(pred))
        };
        match self {
            Self::ClassString(Some(inner)) => inner.any(pred),
            Self::Array { key, value, .. } | Self::Iterable { key, value } => key.any(pred) || value.any(pred),
            Self::List { value, .. } => value.any(pred),
            Self::Shape(shape) => {
                fields(&shape.fields)
                    || shape.rest.as_ref().is_some_and(|(key, value)| key.any(pred) || value.any(pred))
            }
            Self::ObjectShape(shape) => fields(shape),
            Self::Named { args, .. } | Self::GenericRelative { args, .. } => args.iter().any(|arg| arg.any(pred)),
            Self::Callable(Some(sig)) | Self::Closure(Some(sig)) => signature(sig),
            Self::Union(members) | Self::Intersection(members) => members.iter().any(|member| member.any(pred)),
            Self::Operator(operator) => match operator.as_ref() {
                Operator::KeyOf(ty) | Operator::ValueOf(ty) | Operator::IntMaskOf(ty) => ty.any(pred),
                Operator::Index { base, index } => base.any(pred) || index.any(pred),
                Operator::IntMask(values) => values.iter().any(|value| value.any(pred)),
                Operator::Conditional(conditional) => {
                    matches!(&conditional.subject, Subject::Type(ty) if ty.any(pred))
                        || conditional.target.any(pred)
                        || conditional.then.any(pred)
                        || conditional.otherwise.any(pred)
                }
            },
            _ => false,
        }
    }
}

impl Operator {
    /// The operator's children mapped by `f`.
    pub(super) fn map_children(&self, f: &mut dyn FnMut(&Type) -> Type) -> Self {
        match self {
            Self::KeyOf(ty) => Self::KeyOf(f(ty)),
            Self::ValueOf(ty) => Self::ValueOf(f(ty)),
            Self::Index { base, index } => Self::Index { base: f(base), index: f(index) },
            Self::IntMask(values) => Self::IntMask(values.iter().map(&mut *f).collect()),
            Self::IntMaskOf(ty) => Self::IntMaskOf(f(ty)),
            Self::Conditional(conditional) => Self::Conditional(Box::new(Conditional {
                subject: match &conditional.subject {
                    Subject::Type(ty) => Subject::Type(f(ty)),
                    Subject::Param(name) => Subject::Param(name.clone()),
                },
                target: f(&conditional.target),
                negated: conditional.negated,
                then: f(&conditional.then),
                otherwise: f(&conditional.otherwise),
            })),
        }
    }

    /// What the operator can be at most, whatever its arguments.
    pub fn widened(&self) -> Type {
        match self {
            Self::KeyOf(_) => Type::ArrayKey,
            Self::ValueOf(_) | Self::Index { .. } => Type::Mixed,
            Self::IntMask(_) | Self::IntMaskOf(_) => Type::Int,
            Self::Conditional(conditional) => Type::union([conditional.then.clone(), conditional.otherwise.clone()]),
        }
    }

    /// The operator's value, when its arguments are known; `hierarchy`
    /// answers subclass questions (without one, a conditional about classes
    /// stays open).
    pub fn evaluate(&self, hierarchy: Option<&dyn Hierarchy>) -> Option<Type> {
        match self {
            Self::KeyOf(ty) => each_member(ty, &key_of),
            Self::ValueOf(ty) => each_member(ty, &value_of),
            Self::Index { base, index } => each_member(base, &|base| index_of(base, index)),
            Self::IntMask(values) => {
                let mut ints = Vec::new();
                for value in values {
                    ints.extend(literal_ints(value)?);
                }
                Some(int_mask(&ints))
            }
            Self::IntMaskOf(ty) => Some(int_mask(&literal_ints(ty)?)),
            Self::Conditional(conditional) => conditional.evaluate(hierarchy),
        }
    }
}

impl Conditional {
    fn evaluate(&self, hierarchy: Option<&dyn Hierarchy>) -> Option<Type> {
        let Subject::Type(subject) = &self.subject else { return None };
        self.decide(subject, hierarchy)
    }

    /// The branch for a subject of type `subject`: `then` when it is a
    /// `target`, `otherwise` when it can't be one, both when it may be.
    /// `None` while the subject or the target is still open, or needs a
    /// class hierarchy that isn't given.
    pub fn decide(&self, subject: &Type, hierarchy: Option<&dyn Hierarchy>) -> Option<Type> {
        if is_open(subject) || is_open(&self.target) {
            return None;
        }
        let no_classes;
        let hierarchy = match hierarchy {
            Some(hierarchy) => hierarchy,
            None if mentions_classes(subject) || mentions_classes(&self.target) => return None,
            None => {
                no_classes = super::NoHierarchy;
                &no_classes
            }
        };
        let is = if subject.is_subtype_of(&self.target, hierarchy) {
            Some(true)
        } else if subject.members().iter().all(|member| !overlaps(member, &self.target, hierarchy)) {
            Some(false)
        } else {
            None
        };
        Some(match is.map(|is| is != self.negated) {
            Some(true) => self.then.clone(),
            Some(false) => self.otherwise.clone(),
            None => Type::union([self.then.clone(), self.otherwise.clone()]),
        })
    }
}

/// True when some value of `member` may be a `target`.
fn overlaps(member: &Type, target: &Type, hierarchy: &dyn Hierarchy) -> bool {
    member.is_subtype_of(target, hierarchy)
        || target.members().iter().any(|part| {
            part.is_subtype_of(member, hierarchy)
                // Two classes may share a subclass unless both are known
                // classes on separate branches; only a subclass relation
                // counts here, as PHPStan does for `is` on class types.
                || matches!((member, part), (Type::Object, Type::Named { .. }) | (Type::Named { .. }, Type::Object))
        })
}

/// True when the type mentions something only a later step knows: a
/// template, an open operator or a class constant.
fn is_open(ty: &Type) -> bool {
    ty.any(&|ty| matches!(ty, Type::Template(_) | Type::Operator(_) | Type::ClassConstant { .. }))
}

/// True when subtyping on the type needs to know the class hierarchy.
fn mentions_classes(ty: &Type) -> bool {
    ty.any(&|ty| {
        matches!(
            ty,
            Type::Named { .. }
                | Type::Relative(_)
                | Type::GenericRelative { .. }
                | Type::Closure(_)
                | Type::Callable(_)
                | Type::ClassString(Some(_))
                | Type::Iterable { .. }
        )
    })
}

/// `f` on each member of a union, joined; `None` when one isn't known.
fn each_member(ty: &Type, f: &dyn Fn(&Type) -> Option<Type>) -> Option<Type> {
    let mut out = Vec::new();
    for member in ty.members() {
        out.push(f(member)?);
    }
    Some(Type::union(out))
}

fn key_of(ty: &Type) -> Option<Type> {
    match ty {
        Type::Shape(shape) => Some(shape.key_type()),
        Type::Array { key, .. } | Type::Iterable { key, .. } => Some((**key).clone()),
        Type::List { .. } => Some(Type::int_range(Some(0), None)),
        _ => None,
    }
}

fn value_of(ty: &Type) -> Option<Type> {
    match ty {
        Type::Shape(shape) => Some(shape.value_type()),
        Type::Array { value, .. } | Type::List { value, .. } | Type::Iterable { value, .. } => Some((**value).clone()),
        _ => None,
    }
}

/// `base[index]` for one member of the base.
fn index_of(base: &Type, index: &Type) -> Option<Type> {
    if is_open(index) {
        return None;
    }
    match base {
        Type::Shape(shape) => {
            let mut out = Vec::new();
            for key in index.members() {
                let key = match key {
                    Type::LiteralString(value) => match value.parse::<i64>() {
                        // PHP turns `'1'` into the integer key `1`.
                        Ok(int) if int.to_string() == *value => ShapeKey::Int(int),
                        _ => ShapeKey::String(value.clone()),
                    },
                    Type::LiteralInt(value) => ShapeKey::Int(*value),
                    // Any key: any value.
                    _ => return Some(shape.value_type()),
                };
                match (shape.field(&key), &shape.rest) {
                    (Some(field), _) => out.push(field.ty.clone()),
                    (None, Some((_, value))) => out.push(value.clone()),
                    (None, None) => return None,
                }
            }
            Some(Type::union(out))
        }
        Type::ObjectShape(fields) => {
            let mut out = Vec::new();
            for key in index.members() {
                let Type::LiteralString(name) = key else { return None };
                out.push(fields.iter().find(|field| field.key == ShapeKey::String(name.clone()))?.ty.clone());
            }
            Some(Type::union(out))
        }
        Type::Array { value, .. } | Type::List { value, .. } | Type::Iterable { value, .. } => Some((**value).clone()),
        _ => None,
    }
}

/// The integer literals a mask is built from; `None` while they aren't all
/// known non-negative integers.
fn literal_ints(ty: &Type) -> Option<Vec<i64>> {
    ty.members()
        .iter()
        .map(|member| match member {
            Type::LiteralInt(value) if *value >= 0 => Some(*value),
            _ => None,
        })
        .collect()
}

/// Any bitwise or of `values`: each one exactly while there are few, else
/// the range up to all of them.
fn int_mask(values: &[i64]) -> Type {
    let mut values: Vec<i64> = values.to_vec();
    values.sort_unstable();
    values.dedup();
    if values.len() > MAX_MASK_BITS {
        let all = values.iter().fold(0, |all, value| all | value);
        return Type::int_range(Some(0), Some(all));
    }
    let mut out: Vec<i64> = (0..1usize << values.len())
        .map(|subset| {
            values.iter().enumerate().filter(|(bit, _)| subset & (1 << bit) != 0).fold(0, |all, (_, value)| all | value)
        })
        .collect();
    out.sort_unstable();
    out.dedup();
    Type::union(out.into_iter().map(Type::LiteralInt))
}
