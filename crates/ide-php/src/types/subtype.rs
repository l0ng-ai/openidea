//! Subtyping: is every value of one type a value of another?
//!
//! The rules follow the public PHPStan and Psalm documentation of these
//! types. Where the answer depends on something this layer cannot know yet,
//! it answers yes, so that later inspections don't report false errors:
//!
//! - a `callable` without a signature against one with a signature, and a
//!   missing return type;
//! - generic arguments between two different classes (binding them through
//!   `@extends` is phase 2.6), and a class used without its arguments;
//! - `self`, `static` and `parent` only relate to each other and to
//!   `object` (they are completed in context before they meet a class).
//!
//! A template parameter is only a subtype of itself, `mixed` and unions
//! containing it: its bound is resolved before comparing.

use super::{Relative, Shape, Signature, StringKind, Type};

/// What subtyping needs to know about classes.
pub trait Hierarchy {
    /// True when class-like `sub` is `sup` or extends or implements it,
    /// directly or not. Names are fully qualified without the leading `\`
    /// and compared case-insensitively.
    fn is_subclass(&self, sub: &str, sup: &str) -> bool;
}

/// No class knowledge: a class is only a subclass of itself.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoHierarchy;

impl Hierarchy for NoHierarchy {
    fn is_subclass(&self, sub: &str, sup: &str) -> bool {
        sub.eq_ignore_ascii_case(sup)
    }
}

impl Type {
    /// True when every value of `self` is a value of `other`.
    pub fn is_subtype_of(&self, other: &Type, hierarchy: &dyn Hierarchy) -> bool {
        sub(self, other, hierarchy)
    }
}

fn sub(a: &Type, b: &Type, h: &dyn Hierarchy) -> bool {
    if a == b {
        return true;
    }
    match (a, b) {
        (_, Type::Mixed) | (Type::Never, _) => true,
        (Type::Union(members), _) => members.iter().all(|member| sub(member, b, h)),
        (_, Type::Intersection(members)) => members.iter().all(|member| sub(a, member, h)),
        (Type::Intersection(members), _) => members.iter().any(|member| sub(member, b, h)),
        (_, Type::Union(members)) => {
            members.iter().any(|member| sub(a, member, h))
                || (*a == Type::Bool
                    && members.contains(&Type::LiteralBool(true))
                    && members.contains(&Type::LiteralBool(false)))
                // `int|string` covers `array-key`, `scalar` and `numeric`
                // when they are spelled out.
                || match a {
                    Type::ArrayKey => [Type::Int, Type::string()].iter().all(|part| sub(part, b, h)),
                    Type::Numeric => {
                        [Type::Int, Type::Float, Type::String(StringKind::Numeric)].iter().all(|part| sub(part, b, h))
                    }
                    Type::Scalar => {
                        [Type::Bool, Type::Int, Type::Float, Type::string()].iter().all(|part| sub(part, b, h))
                    }
                    _ => false,
                }
        }
        (Type::Mixed, _) => false,
        _ => atomic(a, b, h),
    }
}

/// `a` and `b` are neither unions, intersections, `mixed` nor `never` (as `a`).
fn atomic(a: &Type, b: &Type, h: &dyn Hierarchy) -> bool {
    match b {
        Type::Bool => matches!(a, Type::LiteralBool(_)),
        Type::Int => matches!(a, Type::IntRange { .. } | Type::LiteralInt(_)),
        Type::IntRange { min, max } => {
            let within = |low: Option<i64>, high: Option<i64>| {
                min.is_none_or(|min| low.is_some_and(|low| low >= min))
                    && max.is_none_or(|max| high.is_some_and(|high| high <= max))
            };
            match a {
                Type::LiteralInt(value) => within(Some(*value), Some(*value)),
                Type::IntRange { min: low, max: high } => within(*low, *high),
                _ => false,
            }
        }
        Type::Float => matches!(a, Type::LiteralFloat(_)),
        Type::String(kind) => match a {
            Type::String(other) => string_kind_within(*other, *kind),
            Type::LiteralString(value) => literal_is(value, *kind),
            Type::ClassString(_) => matches!(kind, StringKind::Any | StringKind::NonEmpty | StringKind::NonFalsy),
            _ => false,
        },
        Type::ClassString(None) => matches!(a, Type::ClassString(_)),
        Type::ClassString(Some(target)) => match a {
            Type::ClassString(Some(inner)) => sub(inner, target, h),
            _ => false,
        },
        Type::ArrayKey => sub(a, &Type::Int, h) || sub(a, &Type::string(), h),
        Type::Numeric => {
            sub(a, &Type::Int, h) || sub(a, &Type::Float, h) || sub(a, &Type::String(StringKind::Numeric), h)
        }
        Type::Scalar => {
            matches!(a, Type::ArrayKey | Type::Numeric)
                || [Type::Bool, Type::Int, Type::Float, Type::string()].iter().any(|scalar| sub(a, scalar, h))
        }
        Type::Object => {
            matches!(a, Type::Named { .. } | Type::Relative(_) | Type::Closure(_) | Type::Object)
        }
        Type::Named { fqn, args } => match a {
            Type::Named { fqn: sub_fqn, args: sub_args } => {
                h.is_subclass(sub_fqn, fqn)
                    && (args.is_empty()
                        || sub_args.is_empty()
                        || !sub_fqn.eq_ignore_ascii_case(fqn)
                        || (args.len() == sub_args.len()
                            && sub_args.iter().zip(args).all(|(inner, outer)| sub(inner, outer, h))))
            }
            Type::Closure(_) => args.is_empty() && fqn.eq_ignore_ascii_case("Closure"),
            _ => false,
        },
        Type::Relative(relative) => match a {
            // `$this` is a `static`, which is a `self`.
            Type::Relative(inner) => {
                matches!((inner, relative), (Relative::This, Relative::Static | Relative::Self_))
                    || matches!((inner, relative), (Relative::Static, Relative::Self_))
            }
            _ => false,
        },
        Type::Array { key, value, non_empty } => match a {
            Type::Array { key: sub_key, value: sub_value, non_empty: sub_non_empty } => {
                sub(sub_key, key, h) && sub(sub_value, value, h) && (*sub_non_empty || !non_empty)
            }
            Type::List { value: sub_value, non_empty: sub_non_empty } => {
                sub(&Type::int_range(Some(0), None), key, h)
                    && sub(sub_value, value, h)
                    && (*sub_non_empty || !non_empty)
            }
            Type::Shape(shape) => {
                sub(&shape.key_type(), key, h)
                    && sub(&shape.value_type(), value, h)
                    && (shape.is_non_empty() || !non_empty)
            }
            _ => false,
        },
        Type::List { value, non_empty } => match a {
            Type::List { value: sub_value, non_empty: sub_non_empty } => {
                sub(sub_value, value, h) && (*sub_non_empty || !non_empty)
            }
            Type::Shape(shape) if shape.list => {
                sub(&shape.value_type(), value, h) && (shape.is_non_empty() || !non_empty)
            }
            _ => false,
        },
        Type::Shape(shape) => match a {
            Type::Shape(inner) => shape_within(inner, shape, h),
            _ => false,
        },
        Type::Iterable { key, value } => {
            let (sub_key, sub_value) = match a {
                Type::Array { key, value, .. } => (key.as_ref().clone(), value.as_ref().clone()),
                Type::List { value, .. } => (Type::int_range(Some(0), None), value.as_ref().clone()),
                Type::Shape(shape) => (shape.key_type(), shape.value_type()),
                Type::Iterable { key, value } => (key.as_ref().clone(), value.as_ref().clone()),
                // The arguments of a Traversable need generics (phase 2.6).
                Type::Named { fqn, .. } => return h.is_subclass(fqn, "Traversable"),
                _ => return false,
            };
            sub(&sub_key, key, h) && sub(&sub_value, value, h)
        }
        Type::Callable(signature) => match a {
            Type::Callable(inner) | Type::Closure(inner) => signature_within(inner.as_deref(), signature.as_deref(), h),
            Type::String(StringKind::Callable) => true,
            Type::Named { fqn, .. } => signature.is_none() && h.is_subclass(fqn, "Closure"),
            _ => false,
        },
        Type::Closure(signature) => match a {
            Type::Closure(inner) => signature_within(inner.as_deref(), signature.as_deref(), h),
            _ => false,
        },
        Type::Void | Type::Null | Type::LiteralBool(_) | Type::LiteralInt(_) => false,
        Type::LiteralFloat(_) | Type::LiteralString(_) | Type::Resource | Type::Template(_) => false,
        Type::ClassConstant { .. } | Type::Never | Type::Mixed | Type::Union(_) | Type::Intersection(_) => false,
    }
}

/// `inner ⊆ outer` between string refinements.
fn string_kind_within(inner: StringKind, outer: StringKind) -> bool {
    use StringKind::*;
    inner == outer
        || match outer {
            Any => true,
            NonEmpty => matches!(inner, NonFalsy | Numeric | NonEmptyLowercase | NonEmptyUppercase | Callable),
            Lowercase => inner == NonEmptyLowercase,
            Uppercase => inner == NonEmptyUppercase,
            NonFalsy | Numeric | NonEmptyLowercase | NonEmptyUppercase | Callable => false,
        }
}

/// Whether a literal string has a refinement.
fn literal_is(value: &str, kind: StringKind) -> bool {
    let lower = value.to_lowercase() == value;
    let upper = value.to_uppercase() == value;
    match kind {
        StringKind::Any => true,
        StringKind::NonEmpty => !value.is_empty(),
        StringKind::NonFalsy => !value.is_empty() && value != "0",
        StringKind::Numeric => is_numeric(value),
        StringKind::Lowercase => lower,
        StringKind::NonEmptyLowercase => lower && !value.is_empty(),
        StringKind::Uppercase => upper,
        StringKind::NonEmptyUppercase => upper && !value.is_empty(),
        // Whether a name is callable depends on what is declared.
        StringKind::Callable => false,
    }
}

/// PHP's `is_numeric` for strings: optional leading whitespace, a sign, digits
/// with an optional fraction and exponent, optional trailing whitespace.
fn is_numeric(value: &str) -> bool {
    let trimmed = value.trim_matches([' ', '\t', '\n', '\r', '\x0B', '\x0C']);
    let body = trimmed.strip_prefix(['+', '-']).unwrap_or(trimmed);
    let (mantissa, exponent) = match body.find(['e', 'E']) {
        Some(at) => (&body[..at], Some(&body[at + 1..])),
        None => (body, None),
    };
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    let mantissa_ok = digits(whole) && digits(fraction) && !(whole.is_empty() && fraction.is_empty());
    let exponent_ok = exponent.is_none_or(|exponent| {
        let exponent = exponent.strip_prefix(['+', '-']).unwrap_or(exponent);
        !exponent.is_empty() && digits(exponent)
    });
    mantissa_ok && exponent_ok
}

fn shape_within(inner: &Shape, outer: &Shape, h: &dyn Hierarchy) -> bool {
    if outer.list && !inner.list {
        return false;
    }
    for field in &outer.fields {
        let ok = match inner.field(&field.key) {
            Some(other) => sub(&other.ty, &field.ty, h) && (field.optional || !other.optional),
            None => field.optional && inner.rest.as_ref().is_none_or(|(_, value)| sub(value, &field.ty, h)),
        };
        if !ok {
            return false;
        }
    }
    for field in &inner.fields {
        if outer.field(&field.key).is_none() {
            let Some((key, value)) = &outer.rest else { return false };
            if !sub(&field.key.as_type(), key, h) || !sub(&field.ty, value, h) {
                return false;
            }
        }
    }
    match (&inner.rest, &outer.rest) {
        (None, _) => true,
        (Some(_), None) => false,
        (Some((inner_key, inner_value)), Some((key, value))) => sub(inner_key, key, h) && sub(inner_value, value, h),
    }
}

/// Whether a callable with signature `inner` can be used where `outer` is
/// expected: it accepts what callers pass (parameters are contravariant and
/// it requires no more arguments than they give) and returns what they
/// expect (covariant; anything goes for `void`). A missing signature is
/// compatible either way.
fn signature_within(inner: Option<&Signature>, outer: Option<&Signature>, h: &dyn Hierarchy) -> bool {
    let (Some(inner), Some(outer)) = (inner, outer) else { return true };
    // Callers may pass only the arguments `outer` requires.
    let required = |signature: &Signature| signature.params.iter().filter(|param| param.is_required()).count();
    if required(inner) > required(outer) {
        return false;
    }
    for (i, param) in outer.params.iter().enumerate() {
        let accepting = inner.params.get(i).or_else(|| inner.params.last().filter(|last| last.variadic));
        if let Some(accepting) = accepting
            && !sub(&param.ty, &accepting.ty, h)
        {
            return false;
        }
    }
    match (&inner.return_type, &outer.return_type) {
        (_, None | Some(Type::Void)) | (None, _) => true,
        (Some(inner), Some(outer)) => sub(inner, outer, h),
    }
}
