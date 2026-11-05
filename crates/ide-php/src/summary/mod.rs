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
//!   completes them.
//! - The docblock in front of a declaration becomes a [`DocBlock`]: the
//!   `@var`, `@param`, `@return`, `@throws`, `@deprecated`, `@property*`,
//!   `@method`, `@mixin`, `@template*`, `@extends`, `@implements`, `@use`
//!   and type-alias tags. Their types are [`DocType`]s: unresolved PHPDoc
//!   type expressions in which every class name is already fully qualified,
//!   so they can be parsed later without this file's imports. A
//!   `@psalm-*` / `@phpstan-*` tag wins over the plain tag it duplicates, and
//!   a tag whose type fails to parse keeps its name with the type `mixed`.
//! - Default values and constant values are kept as source text. Where no
//!   type is declared, the type of a default or constant value and what a
//!   function-like body returns are kept as [`LazyType`]s: known when the file
//!   alone says (`= []`, `return new Foo`), else a recipe the resolver
//!   completes against other files (`return $this->find()`, `= Foo::BAR`).
//! - Every declaration has a [`Loc`] for its name and one for the whole
//!   declaration, as byte offsets and as IDE ranges (0-based lines, UTF-16
//!   columns).
//!
//! Summaries are serialized with postcard ([`FileSummary::to_bytes`]). The
//! first field is [`SCHEMA_VERSION`], read on its own before the rest, so a
//! stored summary from an older engine is rejected instead of misread.

mod extract;
mod render;

pub(crate) use extract::type_hint;

use std::fmt;

use ide_core::Range;
use serde::{Deserialize, Serialize};

use crate::names::RelativeClass;
use crate::syntax::ParsedFile;
use crate::types::LazyType;

/// Bump whenever a type in this module changes shape.
pub const SCHEMA_VERSION: u32 = 3;

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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
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
    /// The docblock in front of the declaration, when it says anything.
    pub doc: Option<Box<DocBlock>>,
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
    /// The type of the value, for a constant with no type hint and no
    /// `@var`.
    pub value_type: Option<LazyType>,
    pub attributes: Vec<String>,
    /// The docblock in front of the declaration, when it says anything.
    pub doc: Option<Box<DocBlock>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnumCase {
    pub name: String,
    pub name_loc: Loc,
    pub loc: Loc,
    /// The value of a backed case, as written.
    pub value: Option<String>,
    pub attributes: Vec<String>,
    /// The docblock in front of the declaration, when it says anything.
    pub doc: Option<Box<DocBlock>>,
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
    /// The type of the default value, for a property with a default but no
    /// type hint and no `@var`.
    pub default_type: Option<LazyType>,
    pub attributes: Vec<String>,
    /// The docblock in front of the declaration, when it says anything.
    pub doc: Option<Box<DocBlock>>,
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
    /// What the body returns, for a function-like with a body and neither a
    /// return type nor `@return`.
    pub inferred_return: Option<LazyType>,
    pub attributes: Vec<String>,
    /// The docblock in front of the declaration, when it says anything.
    pub doc: Option<Box<DocBlock>>,
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
    /// What the body returns, for a function-like with a body and neither a
    /// return type nor `@return`.
    pub inferred_return: Option<LazyType>,
    pub attributes: Vec<String>,
    /// The docblock in front of the declaration, when it says anything.
    pub doc: Option<Box<DocBlock>>,
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
    /// The type of the value.
    pub value_type: Option<LazyType>,
    pub attributes: Vec<String>,
    /// The docblock in front of the declaration, when it says anything.
    pub doc: Option<Box<DocBlock>>,
}

/// A PHPDoc type expression, not yet resolved: the text as written (joined
/// onto one line when it spans several), except that every class name is
/// fully qualified with a leading `\`. Template parameters and type aliases
/// in scope, keywords and `self`/`static`/`parent` stay as written. Phase 2.1
/// parses it into a type.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct DocType(pub String);

impl DocType {
    /// The type of a tag whose type expression does not parse.
    pub fn mixed() -> Self {
        Self("mixed".to_owned())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for DocType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// The tags of one docblock that matter to other files.
///
/// When a `@psalm-*` or `@phpstan-*` tag and a plain tag describe the same
/// thing (the return type, the same parameter, template, property, …), only
/// the prefixed one is kept, in the position of the first.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocBlock {
    /// `@deprecated`, with its description (possibly empty).
    pub deprecated: Option<String>,
    /// `@var`, with or without a variable name.
    pub vars: Vec<DocVar>,
    pub params: Vec<DocParam>,
    pub return_type: Option<DocType>,
    pub throws: Vec<DocType>,
    pub templates: Vec<DocTemplate>,
    /// `@extends`, `@implements` and `@use` with their generic arguments.
    pub extends: Vec<DocType>,
    pub implements: Vec<DocType>,
    pub uses: Vec<DocType>,
    pub mixins: Vec<DocType>,
    /// `@property`, `@property-read` and `@property-write`.
    pub properties: Vec<DocProperty>,
    pub methods: Vec<DocMethod>,
    /// `@psalm-type` / `@phpstan-type` and their `import-type` tags.
    pub type_aliases: Vec<DocTypeAlias>,
}

impl DocBlock {
    /// True when no tag was kept.
    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }

    /// The `@var` type for a variable or property name (without `$`): one
    /// naming it, else one without a name.
    pub fn var_type(&self, name: &str) -> Option<&DocType> {
        let name = name.trim_start_matches('$');
        self.vars
            .iter()
            .find(|var| var.name.as_deref() == Some(name))
            .or_else(|| self.vars.iter().find(|var| var.name.is_none()))
            .map(|var| &var.ty)
    }

    /// The `@param` type of a parameter (name without `$`).
    pub fn param_type(&self, name: &str) -> Option<&DocType> {
        let name = name.trim_start_matches('$');
        self.params.iter().find(|param| param.name == name).map(|param| &param.ty)
    }

    /// Names that a type in this docblock (or in the declarations under it)
    /// uses as template parameters or type aliases rather than classes.
    pub fn local_type_names(&self) -> impl Iterator<Item = &str> {
        self.templates
            .iter()
            .map(|template| template.name.as_str())
            .chain(self.type_aliases.iter().map(|alias| alias.name.as_str()))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocVar {
    /// Without the `$`.
    pub name: Option<String>,
    pub ty: DocType,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocParam {
    /// Without the `$`.
    pub name: String,
    pub ty: DocType,
    pub by_ref: bool,
    pub variadic: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Variance {
    #[default]
    Invariant,
    Covariant,
    Contravariant,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocTemplate {
    pub name: String,
    pub variance: Variance,
    /// `of T` (or `as T`).
    pub bound: Option<DocType>,
    /// `= T`.
    pub default: Option<DocType>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PropertyAccess {
    #[default]
    ReadWrite,
    Read,
    Write,
}

/// A magic property declared with `@property`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocProperty {
    /// Without the `$`.
    pub name: String,
    pub name_loc: Loc,
    pub ty: Option<DocType>,
    pub access: PropertyAccess,
}

/// A magic method declared with `@method`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocMethod {
    pub name: String,
    pub name_loc: Loc,
    pub is_static: bool,
    pub templates: Vec<DocTemplate>,
    pub params: Vec<DocMethodParam>,
    pub return_type: Option<DocType>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocMethodParam {
    /// Without the `$`.
    pub name: String,
    pub ty: Option<DocType>,
    /// The default value as written.
    pub default: Option<String>,
    pub by_ref: bool,
    pub variadic: bool,
}

/// `@psalm-type Name = T`, or `@psalm-import-type Name from Class [as Local]`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocTypeAlias {
    /// The name the alias has in this class.
    pub name: String,
    /// The aliased type, for a local alias.
    pub ty: Option<DocType>,
    /// The class (fully qualified) and the alias name there, for an import.
    pub imported_from: Option<(String, String)>,
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
