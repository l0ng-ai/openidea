//! Types in PHP/PHPDoc syntax, class names without the leading `\`.
//!
//! The output parses back to the same type ([`super::parse_doc_type`]), with
//! two exceptions: a template parameter prints as its bare name, so it parses
//! back as a template only when the caller names it, and a class name prints
//! without its leading `\`.

use std::fmt::{self, Display, Formatter, Write};

use super::{Relative, Shape, ShapeKey, Signature, Type};

impl Display for Type {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Mixed => f.write_str("mixed"),
            Self::Never => f.write_str("never"),
            Self::Void => f.write_str("void"),
            Self::Null => f.write_str("null"),
            Self::Bool => f.write_str("bool"),
            Self::LiteralBool(value) => f.write_str(if *value { "true" } else { "false" }),
            Self::Int => f.write_str("int"),
            Self::IntRange { min, max } => match (min, max) {
                (Some(1), None) => f.write_str("positive-int"),
                (Some(0), None) => f.write_str("non-negative-int"),
                (None, Some(-1)) => f.write_str("negative-int"),
                (None, Some(0)) => f.write_str("non-positive-int"),
                _ => {
                    let bound =
                        |value: &Option<i64>, open: &'static str| value.map_or(open.to_owned(), |v| v.to_string());
                    write!(f, "int<{}, {}>", bound(min, "min"), bound(max, "max"))
                }
            },
            Self::LiteralInt(value) => write!(f, "{value}"),
            Self::Float => f.write_str("float"),
            Self::LiteralFloat(raw) => f.write_str(raw),
            Self::String(kind) => f.write_str(kind.as_str()),
            Self::LiteralString(value) => quoted(f, value),
            Self::ClassString(None) => f.write_str("class-string"),
            Self::ClassString(Some(inner)) => write!(f, "class-string<{inner}>"),
            Self::ArrayKey => f.write_str("array-key"),
            Self::Numeric => f.write_str("numeric"),
            Self::Scalar => f.write_str("scalar"),
            Self::Resource => f.write_str("resource"),
            Self::Object => f.write_str("object"),
            Self::Array { key, value, non_empty } => {
                let keyword = if *non_empty { "non-empty-array" } else { "array" };
                match (key.as_ref(), value.as_ref()) {
                    (Type::ArrayKey, Type::Mixed) => f.write_str(keyword),
                    (Type::ArrayKey, value) if !non_empty && is_simple(value) => write!(f, "{value}[]"),
                    (Type::ArrayKey, value) => write!(f, "{keyword}<{value}>"),
                    (key, value) => write!(f, "{keyword}<{key}, {value}>"),
                }
            }
            Self::List { value, non_empty } => {
                let keyword = if *non_empty { "non-empty-list" } else { "list" };
                match value.as_ref() {
                    Type::Mixed => f.write_str(keyword),
                    value => write!(f, "{keyword}<{value}>"),
                }
            }
            Self::Shape(shape) => shape.fmt(f),
            Self::Iterable { key, value } => match (key.as_ref(), value.as_ref()) {
                (Type::Mixed, Type::Mixed) => f.write_str("iterable"),
                (Type::Mixed, value) => write!(f, "iterable<{value}>"),
                (key, value) => write!(f, "iterable<{key}, {value}>"),
            },
            Self::Named { fqn, args } => {
                f.write_str(fqn)?;
                if !args.is_empty() {
                    f.write_char('<')?;
                    list(f, args)?;
                    f.write_char('>')?;
                }
                Ok(())
            }
            Self::Relative(relative) => f.write_str(relative.as_str()),
            Self::GenericRelative { relative, args } => {
                write!(f, "{}<", relative.as_str())?;
                list(f, args)?;
                f.write_char('>')
            }
            Self::Template(name) => f.write_str(name),
            Self::ClassConstant { class, name } => write!(f, "{class}::{name}"),
            Self::Callable(signature) => callable(f, "callable", signature.as_deref()),
            Self::Closure(signature) => callable(f, "Closure", signature.as_deref()),
            Self::Union(members) => {
                if let [a, b] = members.as_slice() {
                    let other = if *a == Type::Null {
                        Some(b)
                    } else if *b == Type::Null {
                        Some(a)
                    } else {
                        None
                    };
                    if let Some(other) = other.filter(|other| is_simple(other)) {
                        return write!(f, "?{other}");
                    }
                }
                for (i, member) in members.iter().enumerate() {
                    if i > 0 {
                        f.write_char('|')?;
                    }
                    match member {
                        Type::Intersection(_) | Type::Callable(Some(_)) | Type::Closure(Some(_)) => {
                            write!(f, "({member})")?
                        }
                        member => write!(f, "{member}")?,
                    }
                }
                Ok(())
            }
            Self::Intersection(members) => {
                for (i, member) in members.iter().enumerate() {
                    if i > 0 {
                        f.write_char('&')?;
                    }
                    match member {
                        Type::Union(_) | Type::Callable(Some(_)) | Type::Closure(Some(_)) => write!(f, "({member})")?,
                        member => write!(f, "{member}")?,
                    }
                }
                Ok(())
            }
        }
    }
}

/// Prints without brackets in `T[]` and `?T`.
fn is_simple(ty: &Type) -> bool {
    match ty {
        Type::Union(_) | Type::Intersection(_) | Type::Callable(Some(_)) | Type::Closure(Some(_)) => false,
        Type::Relative(Relative::This) => false,
        Type::Named { args, .. } => args.is_empty(),
        Type::GenericRelative { .. } => false,
        Type::Mixed | Type::Null | Type::Never | Type::Void => false,
        _ => true,
    }
}

fn list(f: &mut Formatter<'_>, types: &[Type]) -> fmt::Result {
    for (i, ty) in types.iter().enumerate() {
        if i > 0 {
            f.write_str(", ")?;
        }
        write!(f, "{ty}")?;
    }
    Ok(())
}

fn quoted(f: &mut Formatter<'_>, value: &str) -> fmt::Result {
    f.write_char('\'')?;
    for c in value.chars() {
        if c == '\'' || c == '\\' {
            f.write_char('\\')?;
        }
        f.write_char(c)?;
    }
    f.write_char('\'')
}

fn callable(f: &mut Formatter<'_>, keyword: &str, signature: Option<&Signature>) -> fmt::Result {
    f.write_str(keyword)?;
    let Some(signature) = signature else { return Ok(()) };
    f.write_char('(')?;
    for (i, param) in signature.params.iter().enumerate() {
        if i > 0 {
            f.write_str(", ")?;
        }
        write!(f, "{}", param.ty)?;
        if param.by_ref || param.variadic || param.name.is_some() {
            f.write_char(' ')?;
        }
        if param.by_ref {
            f.write_char('&')?;
        }
        // Mago's grammar: `T &=...$name`.
        if param.optional {
            f.write_char('=')?;
        }
        if param.variadic {
            f.write_str("...")?;
        }
        if let Some(name) = &param.name {
            write!(f, "${name}")?;
        }
    }
    f.write_char(')')?;
    match &signature.return_type {
        Some(ty) => {
            let text = ty.to_string();
            if matches!(ty, Type::Union(_) | Type::Intersection(_)) && !text.starts_with('?') {
                write!(f, ": ({text})")
            } else {
                write!(f, ": {text}")
            }
        }
        None => Ok(()),
    }
}

impl Display for Shape {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        f.write_str(if self.list { "list{" } else { "array{" })?;
        let positional =
            self.fields.iter().enumerate().all(|(i, field)| !field.optional && field.key == ShapeKey::Int(i as i64));
        for (i, field) in self.fields.iter().enumerate() {
            if i > 0 {
                f.write_str(", ")?;
            }
            if !positional {
                match &field.key {
                    ShapeKey::Int(value) => write!(f, "{value}")?,
                    ShapeKey::String(value) if is_identifier(value) => f.write_str(value)?,
                    ShapeKey::String(value) => quoted(f, value)?,
                }
                f.write_str(if field.optional { "?: " } else { ": " })?;
            }
            write!(f, "{}", field.ty)?;
        }
        if let Some((key, value)) = &self.rest {
            if !self.fields.is_empty() {
                f.write_str(", ")?;
            }
            f.write_str("...")?;
            // The keys of a list are implied.
            let implied_key = self.list || *key == Type::ArrayKey;
            match value {
                Type::Mixed if implied_key => {}
                value if implied_key => write!(f, "<{value}>")?,
                value => write!(f, "<{key}, {value}>")?,
            }
        }
        f.write_char('}')
    }
}

/// A key that prints without quotes (and does not read as an integer).
fn is_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    chars.next().is_some_and(|c| c.is_alphabetic() || c == '_') && chars.all(|c| c.is_alphanumeric() || c == '_')
}
