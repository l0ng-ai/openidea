//! Lazy types: what a summary can say about a type that depends on other
//! files.
//!
//! At summary time a file only knows itself. The return type of
//! `function f() { return g(); }`, the type of `public $x = Foo::BAR;` or of
//! `const A = B;` can only be completed once `g`, `Foo::BAR` and `B` are
//! known, so the summary stores a [`LazyType`] recipe instead
//! (`FunctionReturn("g")`, `ClassConstant { Foo, BAR }`, `Constant("B")`).
//! The [`Resolver`](super::Resolver) completes them against the indexes.
//!
//! This follows the two-phase scheme of PhpStorm's type providers (a local
//! step that may answer with a signature to be completed later, then a
//! global step), as the public plugin documentation describes it.

use std::fmt;

use serde::{Deserialize, Serialize};

use super::Type;

/// A type that may still need other files to be known.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum LazyType {
    /// Known from the file alone. May contain `self`/`static`/`parent`/
    /// `$this` markers, completed in the context of the declaring class.
    Known(Type),
    /// What calling a function returns. `fallback` is the global name of an
    /// unqualified call inside a namespace, used when `fqn` doesn't exist.
    FunctionReturn { fqn: String, fallback: Option<String> },
    /// What `$receiver->name()` or `Receiver::name()` returns.
    MethodReturn { receiver: Box<LazyType>, name: String },
    /// The type of `$receiver->name` or `Receiver::$name` (name without `$`).
    Property { receiver: Box<LazyType>, name: String },
    /// The type of `Class::NAME`: a class constant's value, or the enum of a
    /// case.
    ClassConstant { class: Box<LazyType>, name: String },
    /// The type of a global constant's value, with the global `fallback` of
    /// an unqualified name inside a namespace.
    Constant { fqn: String, fallback: Option<String> },
    /// A type provider's payload (see [`super::provider`]): completed by
    /// the resolve step of provider `key` from `payload` and the resolved
    /// `args`; `fallback` when that step has no answer.
    Provided { key: String, payload: String, args: Vec<LazyType>, fallback: Box<LazyType> },
    /// Any of these; at least two members, none of them `Known` only when
    /// all are (those fold into one `Known`).
    Union(Vec<LazyType>),
}

impl LazyType {
    pub fn mixed() -> Self {
        Self::Known(Type::Mixed)
    }

    /// The type when it is already known.
    pub fn known(&self) -> Option<&Type> {
        match self {
            Self::Known(ty) => Some(ty),
            _ => None,
        }
    }

    /// The union of some lazy types: nested unions are flattened, the known
    /// members merged into one, duplicates dropped; all known gives a known
    /// type.
    pub fn union(members: impl IntoIterator<Item = Self>) -> Self {
        let mut known = Vec::new();
        let mut lazy: Vec<Self> = Vec::new();
        let push = |member: Self, known: &mut Vec<Type>, lazy: &mut Vec<Self>| match member {
            Self::Known(ty) => known.push(ty),
            other => {
                if !lazy.contains(&other) {
                    lazy.push(other);
                }
            }
        };
        for member in members {
            match member {
                Self::Union(inner) => {
                    for member in inner {
                        push(member, &mut known, &mut lazy);
                    }
                }
                other => push(other, &mut known, &mut lazy),
            }
        }
        if lazy.is_empty() {
            return Self::Known(Type::union(known));
        }
        if !known.is_empty() {
            let known = Type::union(known);
            if known == Type::Mixed {
                return Self::mixed();
            }
            if known != Type::Never {
                lazy.insert(0, Self::Known(known));
            }
        }
        if lazy.len() == 1 { lazy.pop().unwrap_or_else(Self::mixed) } else { Self::Union(lazy) }
    }
}

impl From<Type> for LazyType {
    fn from(ty: Type) -> Self {
        Self::Known(ty)
    }
}

impl fmt::Display for LazyType {
    /// `int`, `App\f()`, `App\f() ?? f()`, `$this->m()`, `Foo->$p`,
    /// `Foo::BAR`, `const(App\A ?? A)`, `int | g()`,
    /// `phpunit:double:…($this) ?? $this->createMock()`.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Known(ty) => write!(f, "{ty}"),
            Self::FunctionReturn { fqn, fallback } => {
                write!(f, "{fqn}()")?;
                if let Some(fallback) = fallback {
                    write!(f, " ?? {fallback}()")?;
                }
                Ok(())
            }
            Self::MethodReturn { receiver, name } => {
                receiver_fmt(f, receiver)?;
                write!(f, "->{name}()")
            }
            Self::Property { receiver, name } => {
                receiver_fmt(f, receiver)?;
                write!(f, "->${name}")
            }
            Self::ClassConstant { class, name } => {
                receiver_fmt(f, class)?;
                write!(f, "::{name}")
            }
            Self::Constant { fqn, fallback } => match fallback {
                Some(fallback) => write!(f, "const({fqn} ?? {fallback})"),
                None => write!(f, "const({fqn})"),
            },
            Self::Provided { key, payload, args, fallback } => {
                write!(f, "{key}:{payload}(")?;
                for (i, arg) in args.iter().enumerate() {
                    if i > 0 {
                        f.write_str(", ")?;
                    }
                    write!(f, "{arg}")?;
                }
                f.write_str(")")?;
                if **fallback != Self::mixed() {
                    write!(f, " ?? {fallback}")?;
                }
                Ok(())
            }
            Self::Union(members) => {
                for (i, member) in members.iter().enumerate() {
                    if i > 0 {
                        f.write_str(" | ")?;
                    }
                    write!(f, "{member}")?;
                }
                Ok(())
            }
        }
    }
}

fn receiver_fmt(f: &mut fmt::Formatter<'_>, receiver: &LazyType) -> fmt::Result {
    match receiver {
        LazyType::Union(_) => write!(f, "({receiver})"),
        other => write!(f, "{other}"),
    }
}
