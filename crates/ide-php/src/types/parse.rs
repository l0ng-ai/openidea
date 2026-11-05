//! Types from native hints and PHPDoc type expressions.
//!
//! PHPDoc text is parsed with `mago_phpdoc_syntax::parse_type`, then the
//! Mago type tree is mapped onto [`Type`]. The text is a summary's
//! [`DocType`]: every class name is already fully qualified with a leading
//! `\`, so a bare name is a template parameter or type alias in scope (or a
//! PHPDoc pseudo-type such as `number`). Callers name the template parameters
//! they know; any other bare name is taken as a class name.

use std::fmt;

use mago_allocator::LocalArena;
use mago_phpdoc_syntax::cst::r#type::{
    CallableType, CallableTypeKind, GenericParameters, IntOrKeyword, MemberReferenceSelector, ReferenceKind,
    ShapeKey as DocShapeKey, ShapeType, ShapeTypeKind, SingleGenericParameter, Type as DocNode,
};
use mago_span::{HasSpan, Span};

use super::{Relative, Shape, ShapeField, ShapeKey, Signature, SignatureParam, StringKind, Type};
use crate::summary::{DocType, TypeHint};

/// A PHPDoc type expression that does not parse.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TypeParseError(pub String);

impl fmt::Display for TypeParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid PHPDoc type: {}", self.0)
    }
}

impl std::error::Error for TypeParseError {}

/// Parses a PHPDoc type expression. `templates` are the template parameter
/// names in scope (matched case-sensitively, as PHPStan does).
pub fn parse_doc_type(text: &str, templates: &[&str]) -> Result<Type, TypeParseError> {
    let text = text.trim();
    if text.is_empty() {
        return Err(TypeParseError("empty type".to_owned()));
    }
    let arena = LocalArena::new();
    let len = u32::try_from(text.len()).map_err(|_| TypeParseError("type too long".to_owned()))?;
    let node = mago_phpdoc_syntax::parse_type(&arena, text.as_bytes(), Span::dummy(0, len))
        .map_err(|error| TypeParseError(format!("{error:?}")))?;
    let end = node.span().end.offset as usize;
    if end < text.len() {
        return Err(TypeParseError(format!("unexpected `{}`", &text[end..])));
    }
    Ok(Converter { templates }.convert(&node))
}

impl Type {
    /// The type a native hint declares.
    pub fn from_hint(hint: &TypeHint) -> Self {
        match hint {
            TypeHint::Named(fqn) => class(fqn),
            TypeHint::Builtin(name) => match name.to_ascii_lowercase().as_str() {
                "int" => Self::Int,
                "float" => Self::Float,
                "string" => Self::string(),
                "bool" => Self::Bool,
                "true" => Self::LiteralBool(true),
                "false" => Self::LiteralBool(false),
                "array" => Self::array(),
                "iterable" => Self::iterable(),
                "callable" => Self::Callable(None),
                "object" => Self::Object,
                "void" => Self::Void,
                "null" => Self::Null,
                "never" => Self::Never,
                _ => Self::Mixed,
            },
            TypeHint::Relative(relative) => Self::Relative((*relative).into()),
            TypeHint::Nullable(inner) => Self::from_hint(inner).nullable(),
            TypeHint::Union(members) => Self::union(members.iter().map(Self::from_hint)),
            TypeHint::Intersection(members) => Self::intersection(members.iter().map(Self::from_hint)),
        }
    }

    /// The type a summary's PHPDoc type stands for, `mixed` when it does not
    /// parse. `templates` are the template parameter names in scope.
    pub fn from_doc(doc: &DocType, templates: &[&str]) -> Self {
        parse_doc_type(doc.as_str(), templates).unwrap_or(Self::Mixed)
    }
}

/// A class name, `Closure` being the closure type.
fn class(name: &str) -> Type {
    let fqn = name.trim_start_matches('\\');
    if fqn.eq_ignore_ascii_case("Closure") { Type::Closure(None) } else { Type::named(fqn) }
}

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// Undoes `\'` and `\\` in a quoted literal.
fn unescape(bytes: &[u8]) -> String {
    let text = lossy(bytes);
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some(next @ ('\'' | '"' | '\\')) => out.push(next),
                Some(next) => {
                    out.push('\\');
                    out.push(next);
                }
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

struct Converter<'t> {
    templates: &'t [&'t str],
}

impl Converter<'_> {
    fn convert(&self, node: &DocNode<'_>) -> Type {
        match node {
            DocNode::Parenthesized(ty) => self.convert(ty.inner),
            DocNode::TrailingPipe(ty) => self.convert(ty.inner),
            DocNode::Union(ty) => Type::union([self.convert(ty.left), self.convert(ty.right)]),
            DocNode::Intersection(ty) => Type::intersection([self.convert(ty.left), self.convert(ty.right)]),
            DocNode::Nullable(ty) => self.convert(ty.inner).nullable(),

            DocNode::Array(ty) => self.array(ty.parameters.as_ref(), false),
            DocNode::NonEmptyArray(ty) => self.array(ty.parameters.as_ref(), true),
            DocNode::AssociativeArray(ty) => self.array(ty.parameters.as_ref(), false),
            DocNode::List(ty) => self.list(ty.parameters.as_ref(), false),
            DocNode::NonEmptyList(ty) => self.list(ty.parameters.as_ref(), true),
            DocNode::Iterable(ty) => match self.generics(ty.parameters.as_ref()).as_slice() {
                [value] => Type::Iterable { key: Box::new(Type::Mixed), value: Box::new(value.clone()) },
                [key, value, ..] => Type::Iterable { key: Box::new(key.clone()), value: Box::new(value.clone()) },
                [] => Type::iterable(),
            },
            DocNode::Slice(ty) => Type::array_of(Type::ArrayKey, self.convert(ty.inner)),
            DocNode::Shape(ty) => self.shape(ty),

            DocNode::ClassString(ty) => self.class_string(ty.parameter.as_ref()),
            DocNode::ClassLikeString(ty) => self.class_string(ty.parameter.as_ref()),
            DocNode::InterfaceString(ty) => self.class_string(ty.parameter.as_ref()),
            DocNode::EnumString(ty) => self.class_string(ty.parameter.as_ref()),
            DocNode::TraitString(ty) => self.class_string(ty.parameter.as_ref()),

            DocNode::Reference(ty) => {
                let args = self.generics(ty.parameters.as_ref());
                match &ty.kind {
                    ReferenceKind::Identifier(identifier) => self.reference(&lossy(identifier.value), args),
                    ReferenceKind::Self_(_) => Type::relative_with(Relative::Self_, args),
                    ReferenceKind::Static(_) => Type::relative_with(Relative::Static, args),
                    ReferenceKind::Parent(_) => Type::Relative(Relative::Parent),
                }
            }
            DocNode::MemberReference(ty) => match (&ty.kind, &ty.member) {
                (ReferenceKind::Identifier(class), MemberReferenceSelector::Identifier(member)) => {
                    Type::ClassConstant {
                        class: lossy(class.value).trim_start_matches('\\').to_owned(),
                        name: lossy(member.value),
                    }
                }
                _ => Type::Mixed,
            },
            // `!Foo::Alias`: a type alias of another class.
            DocNode::AliasReference(_) => Type::Mixed,
            DocNode::Callable(ty) => self.callable(ty),
            DocNode::ThisVariable(_) => Type::Relative(Relative::This),
            DocNode::Variable(_) => Type::Mixed,

            DocNode::Mixed(_) | DocNode::NonEmptyMixed(_) | DocNode::Empty(_) => Type::Mixed,
            DocNode::Null(_) => Type::Null,
            DocNode::Void(_) => Type::Void,
            DocNode::Never(_) => Type::Never,
            DocNode::Resource(_) | DocNode::ClosedResource(_) | DocNode::OpenResource(_) => Type::Resource,
            DocNode::True(_) => Type::LiteralBool(true),
            DocNode::False(_) => Type::LiteralBool(false),
            DocNode::Bool(_) => Type::Bool,
            DocNode::Float(_) | DocNode::UnspecifiedLiteralFloat(_) => Type::Float,
            DocNode::Int(_) | DocNode::UnspecifiedLiteralInt(_) | DocNode::NonZeroInt(_) => Type::Int,
            DocNode::IntMask(_) | DocNode::IntMaskOf(_) => Type::Int,
            DocNode::PositiveInt(_) => Type::int_range(Some(1), None),
            DocNode::NegativeInt(_) => Type::int_range(None, Some(-1)),
            DocNode::NonPositiveInt(_) => Type::int_range(None, Some(0)),
            DocNode::NonNegativeInt(_) => Type::int_range(Some(0), None),
            DocNode::IntRange(ty) => Type::int_range(bound(&ty.min), bound(&ty.max)),
            DocNode::String(_) | DocNode::UnspecifiedLiteralString(_) => Type::string(),
            DocNode::NonEmptyString(_) | DocNode::NonEmptyUnspecifiedLiteralString(_) => {
                Type::String(StringKind::NonEmpty)
            }
            DocNode::NumericString(_) => Type::String(StringKind::Numeric),
            DocNode::LowercaseString(_) => Type::String(StringKind::Lowercase),
            DocNode::NonEmptyLowercaseString(_) => Type::String(StringKind::NonEmptyLowercase),
            DocNode::UppercaseString(_) => Type::String(StringKind::Uppercase),
            DocNode::NonEmptyUppercaseString(_) => Type::String(StringKind::NonEmptyUppercase),
            DocNode::TruthyString(_) | DocNode::NonFalsyString(_) => Type::String(StringKind::NonFalsy),
            DocNode::CallableString(_) | DocNode::LowercaseCallableString(_) | DocNode::UppercaseCallableString(_) => {
                Type::String(StringKind::Callable)
            }
            DocNode::ArrayKey(_) => Type::ArrayKey,
            DocNode::Numeric(_) => Type::Numeric,
            DocNode::Scalar(_) | DocNode::EmptyScalar(_) => Type::Scalar,
            DocNode::Object(_) | DocNode::StringableObject(_) => Type::Object,
            DocNode::LiteralInt(ty) => Type::LiteralInt(i64::try_from(ty.value).unwrap_or(i64::MAX)),
            DocNode::LiteralFloat(ty) => Type::LiteralFloat(lossy(ty.raw)),
            DocNode::LiteralString(ty) => Type::LiteralString(unescape(ty.value)),
            DocNode::Negated(ty) => match self.convert(ty.operand) {
                Type::LiteralInt(value) => Type::LiteralInt(-value),
                Type::LiteralFloat(raw) => Type::LiteralFloat(format!("-{raw}")),
                Type::Float => Type::Float,
                _ => Type::Int,
            },
            DocNode::Posited(ty) => self.convert(ty.operand),
            // `(T is X ? A : B)`: either branch.
            DocNode::Conditional(ty) => Type::union([self.convert(ty.then), self.convert(ty.r#else)]),
            // `new<class-string<T>>` is a `T`.
            DocNode::New(ty) => match self.convert(&ty.parameter.entry.inner) {
                Type::ClassString(Some(inner)) => *inner,
                Type::LiteralString(name) => class(&name),
                _ => Type::Object,
            },
            DocNode::PropertiesOf(_) => Type::array_of(Type::string(), Type::Mixed),
            DocNode::KeyOf(_) => Type::ArrayKey,
            DocNode::ValueOf(_)
            | DocNode::TemplateType(_)
            | DocNode::IndexAccess(_)
            | DocNode::Wildcard(_)
            | DocNode::GlobalWildcardReference(_) => Type::Mixed,
            _ => Type::Mixed,
        }
    }

    /// A name: a class when fully qualified, else a template parameter in
    /// scope, a PHPDoc pseudo-type, or (unqualified) a class.
    fn reference(&self, name: &str, args: Vec<Type>) -> Type {
        if !name.starts_with('\\') {
            if self.templates.contains(&name) {
                return Type::Template(name.to_owned());
            }
            match name.to_ascii_lowercase().as_str() {
                "noreturn" | "never-return" | "never-returns" | "no-return" => return Type::Never,
                "number" => return Type::union([Type::Int, Type::Float]),
                "callback" => return Type::Callable(None),
                "this" => return Type::Relative(Relative::This),
                "resource" => return Type::Resource,
                "void" => return Type::Void,
                "integer" => return Type::Int,
                "double" => return Type::Float,
                "boolean" => return Type::Bool,
                _ => {}
            }
        }
        if args.is_empty() { class(name) } else { Type::generic(name, args) }
    }

    fn generics(&self, parameters: Option<&GenericParameters<'_>>) -> Vec<Type> {
        parameters
            .into_iter()
            .flat_map(|parameters| parameters.entries.iter())
            .map(|entry| self.convert(&entry.inner))
            .collect()
    }

    fn array(&self, parameters: Option<&GenericParameters<'_>>, non_empty: bool) -> Type {
        let (key, value) = match self.generics(parameters).as_slice() {
            [value] => (Type::ArrayKey, value.clone()),
            [key, value, ..] => (key.clone(), value.clone()),
            [] => (Type::ArrayKey, Type::Mixed),
        };
        Type::Array { key: Box::new(key), value: Box::new(value), non_empty }
    }

    fn list(&self, parameters: Option<&GenericParameters<'_>>, non_empty: bool) -> Type {
        let value = self.generics(parameters).pop().unwrap_or(Type::Mixed);
        Type::List { value: Box::new(value), non_empty }
    }

    fn class_string(&self, parameter: Option<&SingleGenericParameter<'_>>) -> Type {
        Type::ClassString(parameter.map(|parameter| Box::new(self.convert(&parameter.entry.inner))))
    }

    fn shape(&self, shape: &ShapeType<'_>) -> Type {
        let list = matches!(shape.kind, ShapeTypeKind::List | ShapeTypeKind::NonEmptyList);
        let mut fields: Vec<ShapeField> = Vec::new();
        for field in shape.fields.iter() {
            let ty = self.convert(field.value);
            let (key, optional) = match &field.key {
                Some(key) => {
                    let name = match &key.key {
                        DocShapeKey::String { value, .. } => ShapeKey::String(unescape(value)),
                        DocShapeKey::Integer { value, .. } => ShapeKey::Int(*value),
                        DocShapeKey::ClassLikeConstant { class_name, constant_name, .. } => ShapeKey::String(format!(
                            "{}::{}",
                            lossy(class_name.value).trim_start_matches('\\'),
                            lossy(constant_name.value)
                        )),
                    };
                    (name, key.question_mark.is_some())
                }
                // A positional field takes the next integer key, as PHP does.
                None => {
                    let next = fields
                        .iter()
                        .filter_map(|field| match field.key {
                            ShapeKey::Int(value) => Some(value.saturating_add(1)),
                            ShapeKey::String(_) => None,
                        })
                        .max()
                        .unwrap_or(0);
                    (ShapeKey::Int(next), false)
                }
            };
            fields.push(ShapeField { key, ty, optional });
        }
        let rest = shape.additional_fields.as_ref().map(|additional| {
            let implied_key = if list { Type::int_range(Some(0), None) } else { Type::ArrayKey };
            match self.generics(additional.parameters.as_ref()).as_slice() {
                [value] => (implied_key, value.clone()),
                [key, value, ..] => (key.clone(), value.clone()),
                [] => (implied_key, Type::Mixed),
            }
        });
        Type::Shape(Box::new(Shape { list, fields, rest }))
    }

    fn callable(&self, ty: &CallableType<'_>) -> Type {
        let signature = ty.specification.as_ref().map(|specification| {
            Box::new(Signature {
                params: specification
                    .parameters
                    .entries
                    .iter()
                    .map(|param| SignatureParam {
                        ty: param.parameter_type.as_ref().map_or(Type::Mixed, |ty| self.convert(ty)),
                        name: param
                            .variable
                            .as_ref()
                            .map(|variable| lossy(variable.value).trim_start_matches('$').to_owned()),
                        by_ref: param.ampersand.is_some(),
                        optional: param.equals.is_some(),
                        variadic: param.ellipsis.is_some(),
                    })
                    .collect(),
                return_type: specification.return_type.as_ref().map(|ret| self.convert(ret.return_type)),
            })
        });
        match ty.kind {
            CallableTypeKind::Callable | CallableTypeKind::PureCallable => Type::Callable(signature),
            CallableTypeKind::Closure | CallableTypeKind::PureClosure => Type::Closure(signature),
        }
    }
}

fn bound(value: &IntOrKeyword<'_>) -> Option<i64> {
    match value {
        IntOrKeyword::Int(int) => i64::try_from(int.value).ok(),
        IntOrKeyword::NegativeInt { int, .. } => i64::try_from(int.value).ok().map(|value| -value),
        IntOrKeyword::Keyword(_) => None,
    }
}
