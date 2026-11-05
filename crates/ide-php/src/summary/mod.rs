//! File summaries: the declarations of one file that other files can see.
//!
//! PhpStorm calls these stubs. A [`FileSummary`] holds every class-like
//! (class, interface, trait, enum), function and constant a file declares,
//! with their members and signatures, as owned data: the arena and the AST are
//! dropped once [`FileSummary::extract`] returns, which is what lets the
//! indexes (phase 1.5) keep summaries for a whole project.
//!
//! - Names are fully qualified at extraction time, through the namespace and
//!   imports in force at the declaration ([`crate::names::NameScope`]); FQNs
//!   are stored without the leading `\`.
//! - Native type hints become [`TypeHint`]s with their class names resolved.
//!   `self`, `static` and `parent` stay markers; the type layer (phase 2.x)
//!   completes them, and PHPDoc types are added in phase 1.4.
//! - Default values and constant values are kept as source text; phase 2.2
//!   turns them into lazy types.
//! - Every declaration has a [`Loc`] for its name and one for the whole
//!   declaration, as byte offsets and as IDE ranges (0-based lines, UTF-16
//!   columns).
//!
//! Summaries are serialized with postcard ([`FileSummary::to_bytes`]). The
//! first field is [`SCHEMA_VERSION`], read on its own before the rest, so a
//! stored summary from an older engine is rejected instead of misread.

mod extract;
mod render;

use std::fmt;

use ide_core::Range;
use serde::{Deserialize, Serialize};

use crate::names::RelativeClass;
use crate::syntax::ParsedFile;

/// Bump whenever a type in this module changes shape.
pub const SCHEMA_VERSION: u32 = 1;

/// A source location: byte offsets (end exclusive) and the IDE range.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Loc {
    pub start: u32,
    pub end: u32,
    pub range: Range,
}

/// Everything one file declares for other files.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileSummary {
    /// Always [`SCHEMA_VERSION`] for a summary built by this engine.
    pub schema: u32,
    /// The parse had errors, so the summary may be missing declarations
    /// (an editor can prefer the last summary without errors).
    pub has_errors: bool,
    /// In source order.
    pub class_likes: Vec<ClassLike>,
    pub functions: Vec<FunctionDecl>,
    /// `const` statements and `define('NAME', …)` calls.
    pub constants: Vec<ConstantDecl>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ClassKind {
    Class,
    Interface,
    Trait,
    Enum,
}

impl ClassKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Class => "class",
            Self::Interface => "interface",
            Self::Trait => "trait",
            Self::Enum => "enum",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Visibility {
    #[default]
    Public,
    Protected,
    Private,
}

impl Visibility {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Public => "public",
            Self::Protected => "protected",
            Self::Private => "private",
        }
    }
}

/// A native type hint, with class names resolved.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TypeHint {
    /// A class-like, by fully qualified name.
    Named(String),
    /// A built-in type keyword, lower case: `int`, `string`, `array`,
    /// `callable`, `null`, `void`, `mixed`, ….
    Builtin(String),
    /// `self`, `static` or `parent`.
    Relative(RelativeClass),
    /// `?T`.
    Nullable(Box<TypeHint>),
    /// `A|B`, flattened (a parenthesised union inside a union is merged).
    Union(Vec<TypeHint>),
    /// `A&B`.
    Intersection(Vec<TypeHint>),
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClassModifiers {
    pub is_abstract: bool,
    pub is_final: bool,
    pub is_readonly: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClassLike {
    pub kind: ClassKind,
    /// The fully qualified name.
    pub fqn: String,
    /// The name as declared.
    pub name: String,
    pub name_loc: Loc,
    /// The whole declaration, attributes included.
    pub loc: Loc,
    pub modifiers: ClassModifiers,
    /// The parent class, or the parent interfaces of an interface.
    pub extends: Vec<String>,
    pub implements: Vec<String>,
    /// The backing type of a backed enum (`int` or `string`).
    pub backing_type: Option<TypeHint>,
    pub trait_uses: Vec<TraitUse>,
    pub constants: Vec<ClassConstant>,
    pub cases: Vec<EnumCase>,
    /// Declared properties, then promoted constructor parameters, in source
    /// order.
    pub properties: Vec<Property>,
    pub methods: Vec<Method>,
    /// Attribute class names, fully qualified.
    pub attributes: Vec<String>,
}

/// One `use A, B { … }` inside a class-like.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TraitUse {
    /// Fully qualified trait names.
    pub traits: Vec<String>,
    pub rules: Vec<TraitRule>,
    pub loc: Loc,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TraitRule {
    /// `A::method insteadof B, C;`
    Insteadof { trait_name: String, method: String, instead_of: Vec<String> },
    /// `[A::]method as [visibility] [alias];`
    Alias { trait_name: Option<String>, method: String, visibility: Option<Visibility>, alias: Option<String> },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClassConstant {
    pub name: String,
    pub name_loc: Loc,
    /// The whole `const` statement (shared by its items).
    pub loc: Loc,
    pub visibility: Visibility,
    pub is_final: bool,
    /// The type of a typed class constant (PHP 8.3).
    pub type_hint: Option<TypeHint>,
    /// The value expression as written.
    pub value: String,
    pub attributes: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnumCase {
    pub name: String,
    pub name_loc: Loc,
    pub loc: Loc,
    /// The value of a backed case, as written.
    pub value: Option<String>,
    pub attributes: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Property {
    /// Without the `$`.
    pub name: String,
    pub name_loc: Loc,
    /// The property statement, or the parameter of a promoted property.
    pub loc: Loc,
    pub visibility: Visibility,
    /// The asymmetric write visibility (`private(set)`, PHP 8.4).
    pub set_visibility: Option<Visibility>,
    pub is_static: bool,
    /// Declared `readonly`, or inside a `readonly` class.
    pub is_readonly: bool,
    pub is_abstract: bool,
    pub is_final: bool,
    /// Declared with property hooks (PHP 8.4).
    pub has_hooks: bool,
    /// A promoted constructor parameter.
    pub is_promoted: bool,
    pub type_hint: Option<TypeHint>,
    pub default: Option<String>,
    pub attributes: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Method {
    pub name: String,
    pub name_loc: Loc,
    pub loc: Loc,
    pub visibility: Visibility,
    pub is_static: bool,
    /// Declared `abstract`, or an interface method.
    pub is_abstract: bool,
    pub is_final: bool,
    pub by_ref_return: bool,
    pub params: Vec<Param>,
    pub return_type: Option<TypeHint>,
    pub attributes: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Param {
    /// Without the `$`.
    pub name: String,
    pub name_loc: Loc,
    /// The whole parameter, attributes and modifiers included.
    pub loc: Loc,
    pub type_hint: Option<TypeHint>,
    /// The default value as written.
    pub default: Option<String>,
    pub by_ref: bool,
    pub variadic: bool,
    /// Set for a promoted constructor parameter.
    pub promoted: Option<Promotion>,
    pub attributes: Vec<String>,
}

/// The property part of a promoted constructor parameter.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Promotion {
    pub visibility: Visibility,
    pub set_visibility: Option<Visibility>,
    pub is_readonly: bool,
    /// Declared with property hooks (PHP 8.4).
    pub has_hooks: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FunctionDecl {
    pub fqn: String,
    pub name: String,
    pub name_loc: Loc,
    pub loc: Loc,
    pub by_ref_return: bool,
    pub params: Vec<Param>,
    pub return_type: Option<TypeHint>,
    pub attributes: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ConstantKind {
    /// `const NAME = …;`
    Const,
    /// `define('NAME', …)`.
    Define,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConstantDecl {
    pub kind: ConstantKind,
    /// The fully qualified name. A `define()` name is taken as written: it
    /// is never relative to the namespace.
    pub fqn: String,
    pub name_loc: Loc,
    /// The `const` statement or the `define` call.
    pub loc: Loc,
    pub value: String,
    pub attributes: Vec<String>,
}

/// A summary could not be decoded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DecodeError {
    /// Written by an engine with another [`SCHEMA_VERSION`].
    Schema {
        found: u32,
    },
    Corrupt(String),
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Schema { found } => {
                write!(f, "summary schema {found} does not match the engine's schema {SCHEMA_VERSION}")
            }
            Self::Corrupt(message) => write!(f, "corrupt summary: {message}"),
        }
    }
}

impl std::error::Error for DecodeError {}

impl FileSummary {
    /// Extracts the declarations of a parsed file.
    pub fn extract(file: &ParsedFile) -> Self {
        extract::extract(file)
    }

    /// Serializes the summary with postcard.
    pub fn to_bytes(&self) -> Vec<u8> {
        postcard::to_allocvec(self).expect("summaries only contain serializable data")
    }

    /// Decodes a summary written by [`to_bytes`](Self::to_bytes), checking
    /// the schema version first.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, DecodeError> {
        let (found, _) = postcard::take_from_bytes::<u32>(bytes).map_err(|e| DecodeError::Corrupt(e.to_string()))?;
        if found != SCHEMA_VERSION {
            return Err(DecodeError::Schema { found });
        }
        postcard::from_bytes(bytes).map_err(|e| DecodeError::Corrupt(e.to_string()))
    }

    /// The class-like with this fully qualified name (case-insensitive).
    pub fn class_like(&self, fqn: &str) -> Option<&ClassLike> {
        let fqn = fqn.trim_start_matches('\\');
        self.class_likes.iter().find(|class| class.fqn.eq_ignore_ascii_case(fqn))
    }

    /// The function with this fully qualified name (case-insensitive).
    pub fn function(&self, fqn: &str) -> Option<&FunctionDecl> {
        let fqn = fqn.trim_start_matches('\\');
        self.functions.iter().find(|function| function.fqn.eq_ignore_ascii_case(fqn))
    }

    /// A readable, stable rendering used by the golden tests.
    pub fn render(&self) -> String {
        render::render(self)
    }
}

impl ClassLike {
    /// The method with this name (case-insensitive, as PHP compares them).
    pub fn method(&self, name: &str) -> Option<&Method> {
        self.methods.iter().find(|method| method.name.eq_ignore_ascii_case(name))
    }

    /// The property with this name (case-sensitive, without `$`).
    pub fn property(&self, name: &str) -> Option<&Property> {
        let name = name.trim_start_matches('$');
        self.properties.iter().find(|property| property.name == name)
    }

    /// The constant with this name (case-sensitive).
    pub fn constant(&self, name: &str) -> Option<&ClassConstant> {
        self.constants.iter().find(|constant| constant.name == name)
    }
}

impl fmt::Display for TypeHint {
    /// PHP syntax, class names without the leading `\`.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Named(name) | Self::Builtin(name) => f.write_str(name),
            Self::Relative(relative) => f.write_str(relative.as_str()),
            Self::Nullable(inner) => write!(f, "?{inner}"),
            Self::Union(members) => {
                for (i, member) in members.iter().enumerate() {
                    if i > 0 {
                        f.write_str("|")?;
                    }
                    match member {
                        Self::Intersection(_) => write!(f, "({member})")?,
                        _ => write!(f, "{member}")?,
                    }
                }
                Ok(())
            }
            Self::Intersection(members) => {
                for (i, member) in members.iter().enumerate() {
                    if i > 0 {
                        f.write_str("&")?;
                    }
                    match member {
                        Self::Union(_) => write!(f, "({member})")?,
                        _ => write!(f, "{member}")?,
                    }
                }
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests;
