//! Type providers: pluggable sources of types for calls and properties.
//!
//! A [`TypeProvider`] follows the two steps of the lazy types (and of
//! PhpStorm's type providers, as the public plugin documentation describes
//! them):
//!
//! - **Local step** ([`TypeProvider::call`], [`TypeProvider::property`]):
//!   sees what one file says about a call or an untyped property (the call's
//!   name, receiver, class-name arguments; the values assigned to the
//!   property) and answers with a type, or with a lazy payload
//!   ([`LazyType::Provided`], built by [`provided`]) when other files are
//!   needed. It runs at summary time (the answer is stored in the summary)
//!   and when typing expressions.
//! - **Resolve step** ([`TypeProvider::resolve`]): completes the provider's
//!   own payload against the project through the [`Resolver`]. When it
//!   can't, the payload's fallback (what the providers after it said) is
//!   used.
//!
//! [`TypeProviders`] is the ordered registry: the local steps are asked in
//! order and the first answer wins. The built-in [`CoreProvider`] is what
//! the resolver does on its own (declared and inferred returns, generics);
//! providers ordered before it override it, those after it only answer when
//! it doesn't know (`mixed`). A provider can wrap the ones after it through
//! [`CallSite::next`]. [`TypeProviders::builtin`] holds the
//! `.phpstorm.meta.php` provider ([`MetaProvider`]), the PHPUnit provider
//! ([`PhpUnitProvider`]), the Laravel provider ([`LaravelProvider`]), the
//! Symfony provider ([`SymfonyProvider`]) and the core; summaries are
//! always extracted with it.
//!
//! Providers also type properties a class doesn't declare
//! ([`TypeProvider::magic_property`], asked by the resolver), such as
//! Eloquent relation properties, and list the members a class only has
//! through `__call`, `__callStatic` or `__get`
//! ([`TypeProvider::magic_members`]) for completion, hover and goto, and
//! the values a string argument accepts ([`TypeProvider::known_strings`]:
//! Symfony's route names) for completion and the `PhpUndefinedRoute`
//! inspection.

use std::path::PathBuf;
use std::sync::{Arc, LazyLock};

use mago_syntax::cst::{
    Access, Argument, ArgumentList, ArrayElement, Call, ClassLikeConstantSelector, ClassLikeMemberSelector, Expression,
};

pub use self::laravel::LaravelProvider;
pub use self::symfony::SymfonyProvider;
use super::ops::literal_type;
use super::{Context, LazyType, Resolver, Type};
use crate::meta::MetaProvider;
use crate::names::{NameKind, NameScope, Resolution, fqn_eq};
use crate::summary::Loc;

/// Builds the lazy payload of provider `key`: `payload` and `args` are
/// handed back to its resolve step (the args resolved), `fallback` is used
/// when that step has no answer.
pub fn provided(key: &str, payload: impl Into<String>, args: Vec<LazyType>, fallback: LazyType) -> LazyType {
    LazyType::Provided { key: key.to_owned(), payload: payload.into(), args, fallback: Box::new(fallback) }
}

/// What kind of call a [`CallSite`] is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallKind {
    /// `f()`: the name is the function's FQN (the namespaced candidate of
    /// an unqualified name).
    Function,
    /// `$o->m()` or `$o?->m()`.
    Method,
    /// `Foo::m()`.
    StaticMethod,
}

/// One argument of a call, as far as the file alone says.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SiteArg {
    /// The parameter name of a named argument.
    pub name: Option<String>,
    /// The class the argument names: `Foo::class` or a class-name string
    /// literal (`'App\Foo'`), fully qualified without the leading `\`.
    pub class: Option<String>,
    /// The argument is `self::class` or `static::class`.
    pub own_class: bool,
    /// The value of a string literal argument.
    pub string: Option<String>,
    /// The value of an integer literal argument.
    pub int: Option<i64>,
    /// The string literals of an array literal argument: its values, and
    /// its string keys (`['posts', 'tags' => fn ($q) => …]`).
    pub strings: Vec<String>,
}

/// The [`SiteArg`]s of a call's arguments, from the syntax alone: `Foo::class`
/// (resolved in `scope`) and string literals.
pub(crate) fn site_args(scope: &NameScope, list: &ArgumentList<'_>) -> Vec<SiteArg> {
    list.arguments
        .iter()
        .map(|argument| {
            let (name, value) = match argument {
                Argument::Positional(argument) => (None, argument.value),
                Argument::Named(argument) => {
                    (Some(String::from_utf8_lossy(argument.name.value).into_owned()), argument.value)
                }
            };
            let mut arg = SiteArg { name, ..SiteArg::default() };
            match value {
                Expression::Access(Access::ClassConstant(access)) => {
                    if let (ClassLikeConstantSelector::Identifier(constant), Expression::Identifier(class)) =
                        (&access.constant, access.class)
                        && constant.value.eq_ignore_ascii_case(b"class")
                    {
                        let name = String::from_utf8_lossy(class.value());
                        arg.class = match scope.resolve(NameKind::ClassLike, &name).resolution {
                            Resolution::Fqn(fqn) | Resolution::Fallback { namespaced: fqn, .. } => Some(fqn),
                            Resolution::Relative(_) => None,
                        };
                    } else if let ClassLikeConstantSelector::Identifier(constant) = &access.constant
                        && constant.value.eq_ignore_ascii_case(b"class")
                        && matches!(access.class, Expression::Self_(_) | Expression::Static(_))
                    {
                        arg.own_class = true;
                    }
                }
                Expression::Literal(literal) => match literal_type(literal) {
                    Type::LiteralString(string) => {
                        if is_class_name(&string) {
                            arg.class = Some(string.trim_start_matches('\\').to_owned());
                        }
                        arg.string = Some(string);
                    }
                    Type::LiteralInt(value) => arg.int = Some(value),
                    _ => {}
                },
                Expression::Array(array) => arg.strings = array_strings(array.elements.iter()),
                Expression::LegacyArray(array) => arg.strings = array_strings(array.elements.iter()),
                // A Concord model proxy: `ProductProxy::modelClass()` is the
                // model `Product` beside it (by Concord's convention).
                Expression::Call(Call::StaticMethod(call)) => {
                    if let (ClassLikeMemberSelector::Identifier(method), Expression::Identifier(class)) =
                        (&call.method, call.class)
                        && method.value.eq_ignore_ascii_case(b"modelClass")
                    {
                        let name = String::from_utf8_lossy(class.value());
                        let proxy = match scope.resolve(NameKind::ClassLike, &name).resolution {
                            Resolution::Fqn(fqn) | Resolution::Fallback { namespaced: fqn, .. } => Some(fqn),
                            Resolution::Relative(_) => None,
                        };
                        arg.class = proxy
                            .and_then(|proxy| proxy.strip_suffix("Proxy").map(str::to_owned))
                            .filter(|model| !model.is_empty() && !model.ends_with('\\'));
                    }
                }
                _ => {}
            }
            arg
        })
        .collect()
}

/// The string literal values and keys of array elements.
fn array_strings<'e>(elements: impl Iterator<Item = &'e ArrayElement<'e>>) -> Vec<String> {
    let string = |expr: &Expression<'_>| match expr {
        Expression::Literal(literal) => match literal_type(literal) {
            Type::LiteralString(string) => Some(string),
            _ => None,
        },
        _ => None,
    };
    elements
        .filter_map(|element| match element {
            ArrayElement::Value(element) => string(element.value),
            ArrayElement::KeyValue(element) => string(element.key),
            _ => None,
        })
        .collect()
}

/// `Foo`, `App\Foo`, `\App\Foo`: segments of PHP identifier characters.
fn is_class_name(text: &str) -> bool {
    let text = text.strip_prefix('\\').unwrap_or(text);
    !text.is_empty()
        && text.split('\\').all(|segment| {
            let mut chars = segment.chars();
            chars.next().is_some_and(|c| c == '_' || c.is_alphabetic() || !c.is_ascii())
                && chars.all(|c| c == '_' || c.is_alphanumeric() || !c.is_ascii())
        })
}

/// A call, for the local step.
#[derive(Clone, Copy)]
pub struct CallSite<'s> {
    pub kind: CallKind,
    /// The method name, or the function's FQN.
    pub name: &'s str,
    /// The receiver of a method call (`$this`, the object, the class).
    pub receiver: Option<&'s LazyType>,
    pub args: &'s [SiteArg],
    /// The types of the arguments, positional ones in order (computed on
    /// demand).
    pub arg_types: &'s dyn Fn() -> Vec<LazyType>,
    /// The answer is stored in a file summary (rather than used at once to
    /// type an expression): providers that would answer for many calls
    /// should only answer where they are likely to matter.
    pub stored: bool,
    /// What the core inference says about the call (computed on demand).
    pub core: &'s dyn Fn() -> LazyType,
    /// What the providers after this one say (computed on demand; set by
    /// [`TypeProviders::call`], `mixed` before).
    pub next: &'s dyn Fn() -> LazyType,
}

/// The `next` of a [`CallSite`] before the registry sets it.
pub const NO_NEXT: &dyn Fn() -> LazyType = &LazyType::mixed;

impl CallSite<'_> {
    /// The class named by the first argument, else by the first named
    /// argument that names one (parameter names differ between versions of
    /// a library).
    pub fn class_arg(&self) -> Option<&str> {
        match self.args.first() {
            Some(SiteArg { name: None, class, .. }) => class.as_deref(),
            _ => self.args.iter().find_map(|arg| arg.class.as_deref()),
        }
    }
}

/// A value assigned to `$this->property` in a method of the class.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Assigned {
    /// The method the assignment is in.
    pub method: String,
    pub ty: LazyType,
    /// `$this->property[] = value` (`Some(false)`) or
    /// `$this->property[$key] = value` (`Some(true)`): the value is an
    /// element; `None` for `$this->property = value`.
    pub element: Option<bool>,
}

/// A property with neither a type hint nor `@var`, for the local step.
pub struct PropertySite<'s> {
    /// The class declaring it (FQN).
    pub class: &'s str,
    /// The classes it extends, as written (FQNs).
    pub extends: &'s [String],
    /// The property name, without `$`.
    pub name: &'s str,
    /// What the class's own methods assign to it.
    pub assigned: &'s [Assigned],
}

/// A parameter of a method, for [`TypeProvider::parameter`].
pub struct ParameterSite<'s> {
    /// The class declaring the method (FQN).
    pub class: &'s str,
    pub method: &'s crate::summary::Method,
    /// The parameter's position.
    pub index: usize,
    /// What its hint or PHPDoc declares.
    pub declared: &'s Type,
}

/// A member a class only has through magic methods
/// ([`TypeProvider::magic_members`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MagicMember {
    /// As written in code (without `$`).
    pub name: String,
    /// Called or read statically (`Facade::method()`, `Model::where()`).
    pub is_static: bool,
    pub target: MagicTarget,
}

impl MagicMember {
    pub fn is_method(&self) -> bool {
        matches!(self.target, MagicTarget::Method { .. })
    }
}

/// What a [`MagicMember`] stands for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MagicTarget {
    /// A call forwarded to the method `method` of class `class` (FQN): a
    /// facade's service, a query builder, a model's local scope.
    Method { class: String, method: String },
    /// A property of model `class` (FQN), of type `ty`.
    Attribute { class: String, ty: Type, origin: AttributeOrigin },
}

/// Where a magic property comes from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AttributeOrigin {
    /// The relation method of that name (`posts()`).
    Relation { method: String },
    /// The count of a relation's models (`posts_count`, after
    /// `withCount('posts')`), from relation method `method`.
    Count { method: String },
    /// An accessor (`getFullNameAttribute()`, `fullName(): Attribute`).
    Accessor { method: String },
    /// A cast (`'boolean'`, `\App\Casts\Money`), in the casts of the class.
    Cast { cast: String, source: Option<Source> },
    /// A column a migration or the live database gives the model's table
    /// (`from`: where it comes from, "a migration" or "the database
    /// `app`").
    Column { table: String, ty: String, nullable: bool, from: String, source: Option<Source> },
    /// A field a Form Request's `rules()` validates (`rules`: the rule
    /// names, pipe-joined).
    Rule { rules: String, source: Option<Source> },
}

/// A call whose string argument a provider may know the values of.
#[derive(Clone, Copy, Debug)]
pub enum ArgumentOf<'a> {
    /// A function, by FQN (the namespaced candidate of an unqualified name
    /// that no file declares).
    Function(&'a str),
    /// A method, by the type of its receiver.
    Method { receiver: &'a Type, name: &'a str },
}

impl ArgumentOf<'_> {
    /// The function's short name or the method's name.
    pub fn name(&self) -> &str {
        match self {
            Self::Function(fqn) => fqn.rsplit('\\').next().unwrap_or(fqn),
            Self::Method { name, .. } => name,
        }
    }
}

/// What the values of a [`KnownStrings`] are.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KnownKind {
    /// Route names.
    Route,
}

/// The values a string argument accepts: any other value is an error.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KnownStrings {
    pub kind: KnownKind,
    pub values: Vec<KnownString>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KnownString {
    pub value: String,
    /// Shown next to the value in completion (a route's path).
    pub detail: Option<String>,
}

/// A place in another file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Source {
    pub file: PathBuf,
    pub loc: Loc,
}

/// A source of types; see the module documentation.
pub trait TypeProvider: Send + Sync {
    /// Identifies the provider's payloads ([`LazyType::Provided`]'s `key`).
    fn key(&self) -> &'static str;

    /// Local step for a call: `None` lets the next provider answer.
    fn call(&self, _site: &CallSite<'_>) -> Option<LazyType> {
        None
    }

    /// Local step for an untyped property: `None` lets the next provider
    /// answer (and else the property's default value types it).
    fn property(&self, _site: &PropertySite<'_>) -> Option<LazyType> {
        None
    }

    /// Resolve step for one of this provider's payloads, `args` already
    /// resolved in `context`. `None` uses the payload's fallback.
    fn resolve(&self, _payload: &str, _args: &[Type], _resolver: &Resolver<'_>, _context: &Context) -> Option<Type> {
        None
    }

    /// Resolve step for a property class `class` (FQN) neither declares,
    /// documents nor inherits (one its `__get` answers): its type, or
    /// `None` to let the next provider answer. `self`/`parent` in the
    /// answer mean `class`.
    fn magic_property(&self, _class: &str, _name: &str, _resolver: &Resolver<'_>) -> Option<Type> {
        None
    }

    /// The members the classes of `receiver` only have through magic
    /// methods, for completion, hover and goto (not their types: those
    /// come from the call and property steps). Members the classes declare
    /// or document may be listed too; callers prefer those.
    fn magic_members(&self, _receiver: &Type, _resolver: &Resolver<'_>, _context: &Context) -> Vec<MagicMember> {
        Vec::new()
    }

    /// The parameter types of a closure passed to method `method` of
    /// `receiver` along with the string `key` (the string argument before
    /// it, or its key in an array argument): `whereHas('posts', fn ($q) =>
    /// …)` gives `$q` the related model's builder. `None` lets the next
    /// provider answer.
    fn closure_parameters(
        &self,
        _receiver: &Type,
        _method: &str,
        _key: &str,
        _resolver: &Resolver<'_>,
        _context: &Context,
    ) -> Option<Vec<Type>> {
        None
    }

    /// The method names (any case) [`TypeProvider::refines_receiver`] may
    /// answer `true` for.
    fn receiver_refining_methods(&self) -> &'static [&'static str] {
        &[]
    }

    /// Whether method `method` of `receiver` returns the receiver itself,
    /// with a more precise type that holds for the object from then on
    /// (Eloquent's `$post->loadCount('tags')`): called as a statement on a
    /// variable, the variable takes the call's type.
    fn refines_receiver(&self, _receiver: &Type, _method: &str, _resolver: &Resolver<'_>, _context: &Context) -> bool {
        false
    }

    /// The type of a method's parameter, given what its hint or PHPDoc
    /// declares: `None` keeps the declared type. (Eloquent: the raw
    /// `Builder $query` of a model's local scope is the model's builder.)
    fn parameter(&self, _site: &ParameterSite<'_>, _resolver: &Resolver<'_>) -> Option<Type> {
        None
    }

    /// The function and method names (any case) whose arguments
    /// [`TypeProvider::known_strings`] may know: inspections only ask about
    /// calls of these names.
    fn known_string_calls(&self) -> &'static [&'static str] {
        &[]
    }

    /// The values argument `index` of `call` accepts, when they form a
    /// known, closed set; `None` lets the next provider answer.
    fn known_strings(
        &self,
        _call: ArgumentOf<'_>,
        _index: usize,
        _resolver: &Resolver<'_>,
        _context: &Context,
    ) -> Option<KnownStrings> {
        None
    }
}

/// The order of the core provider; built-in providers that override it use
/// a smaller one.
pub const CORE_ORDER: i32 = 0;

/// The ordered providers.
#[derive(Clone)]
pub struct TypeProviders {
    /// Sorted by order, stable for equal orders.
    providers: Vec<(i32, Arc<dyn TypeProvider>)>,
}

impl Default for TypeProviders {
    /// Laravel ([`LaravelProvider`], first: it only overrides what the
    /// others say where they say `mixed` or for container calls, and
    /// `.phpstorm.meta.php` overrides stay in its stored fallbacks),
    /// Symfony ([`SymfonyProvider`]: container and repository calls, its
    /// fallback what the others say), `.phpstorm.meta.php`
    /// ([`MetaProvider`]: its fallback is what the others say), PHPUnit and
    /// the core.
    fn default() -> Self {
        let mut providers = Self::empty();
        providers.register(CORE_ORDER, Arc::new(CoreProvider));
        providers.register(CORE_ORDER - 30, Arc::new(LaravelProvider));
        providers.register(CORE_ORDER - 25, Arc::new(SymfonyProvider));
        providers.register(CORE_ORDER - 10, Arc::new(PhpUnitProvider));
        providers.register(CORE_ORDER - 20, Arc::new(MetaProvider));
        providers
    }
}

static BUILTIN: LazyLock<TypeProviders> = LazyLock::new(TypeProviders::default);

impl TypeProviders {
    /// No providers at all (not even the core).
    pub fn empty() -> Self {
        Self { providers: Vec::new() }
    }

    /// The built-in providers ([`TypeProviders::default`]), shared.
    pub fn builtin() -> &'static Self {
        &BUILTIN
    }

    /// Adds `provider` at `order` (smaller first; after the providers
    /// already registered at the same order).
    pub fn register(&mut self, order: i32, provider: Arc<dyn TypeProvider>) {
        let at = self.providers.partition_point(|(known, _)| *known <= order);
        self.providers.insert(at, (order, provider));
    }

    /// The provider keys in order.
    pub fn keys(&self) -> Vec<&'static str> {
        self.providers.iter().map(|(_, provider)| provider.key()).collect()
    }

    /// The provider with this key.
    pub fn get(&self, key: &str) -> Option<&dyn TypeProvider> {
        self.providers.iter().map(|(_, provider)| provider.as_ref()).find(|provider| provider.key() == key)
    }

    /// The first local answer for a call; `mixed` when none. Each provider
    /// sees what the ones after it say as [`CallSite::next`].
    pub fn call(&self, site: &CallSite<'_>) -> LazyType {
        self.call_from(0, site)
    }

    fn call_from(&self, start: usize, site: &CallSite<'_>) -> LazyType {
        for (i, (_, provider)) in self.providers.iter().enumerate().skip(start) {
            let next = || self.call_from(i + 1, site);
            let local = CallSite { next: &next, ..*site };
            if let Some(answer) = provider.call(&local) {
                return answer;
            }
        }
        LazyType::mixed()
    }

    /// The first local answer for an untyped property.
    pub fn property(&self, site: &PropertySite<'_>) -> Option<LazyType> {
        self.providers.iter().find_map(|(_, provider)| provider.property(site))
    }

    /// The first answer for the parameters of a closure passed to `method`
    /// of `receiver` with the string `key`; see
    /// [`TypeProvider::closure_parameters`].
    pub fn closure_parameters(
        &self,
        receiver: &Type,
        method: &str,
        key: &str,
        resolver: &Resolver<'_>,
        context: &Context,
    ) -> Option<Vec<Type>> {
        self.providers
            .iter()
            .find_map(|(_, provider)| provider.closure_parameters(receiver, method, key, resolver, context))
    }

    /// Whether some provider may refine a receiver through method `method`
    /// (a cheap check before typing the receiver).
    pub fn may_refine_receiver(&self, method: &str) -> bool {
        self.providers.iter().any(|(_, provider)| {
            provider.receiver_refining_methods().iter().any(|name| name.eq_ignore_ascii_case(method))
        })
    }

    /// Whether some provider says method `method` refines `receiver`; see
    /// [`TypeProvider::refines_receiver`].
    pub fn refines_receiver(&self, receiver: &Type, method: &str, resolver: &Resolver<'_>, context: &Context) -> bool {
        self.providers.iter().any(|(_, provider)| provider.refines_receiver(receiver, method, resolver, context))
    }

    /// The first answer for a method parameter's type; see
    /// [`TypeProvider::parameter`].
    pub fn parameter(&self, site: &ParameterSite<'_>, resolver: &Resolver<'_>) -> Option<Type> {
        self.providers.iter().find_map(|(_, provider)| provider.parameter(site, resolver))
    }

    /// The first answer for an undeclared property of `class`.
    pub fn magic_property(&self, class: &str, name: &str, resolver: &Resolver<'_>) -> Option<Type> {
        self.providers.iter().find_map(|(_, provider)| provider.magic_property(class, name, resolver))
    }

    /// The magic members of `receiver` from every provider, the first one
    /// of a name (and kind) winning.
    pub fn magic_members(&self, receiver: &Type, resolver: &Resolver<'_>, context: &Context) -> Vec<MagicMember> {
        let mut out: Vec<MagicMember> = Vec::new();
        for (_, provider) in &self.providers {
            for member in provider.magic_members(receiver, resolver, context) {
                let known = out.iter().any(|known| {
                    known.is_method() == member.is_method()
                        && same_magic_name(&known.name, &member.name, member.is_method())
                });
                if !known {
                    out.push(member);
                }
            }
        }
        out
    }

    /// Whether some provider may know the string arguments of calls named
    /// `name`.
    pub fn has_known_strings(&self, name: &str) -> bool {
        self.providers
            .iter()
            .any(|(_, provider)| provider.known_string_calls().iter().any(|known| known.eq_ignore_ascii_case(name)))
    }

    /// The first provider's answer for the values argument `index` of
    /// `call` accepts.
    pub fn known_strings(
        &self,
        call: ArgumentOf<'_>,
        index: usize,
        resolver: &Resolver<'_>,
        context: &Context,
    ) -> Option<KnownStrings> {
        if !self.has_known_strings(call.name()) {
            return None;
        }
        self.providers.iter().find_map(|(_, provider)| provider.known_strings(call, index, resolver, context))
    }

    /// The magic member `name` of `receiver` (a method when `method`).
    pub fn magic_member(
        &self,
        receiver: &Type,
        name: &str,
        method: bool,
        resolver: &Resolver<'_>,
        context: &Context,
    ) -> Option<MagicMember> {
        self.magic_members(receiver, resolver, context)
            .into_iter()
            .find(|member| member.is_method() == method && same_magic_name(&member.name, name, method))
    }
}

/// Method names ignore case, property names don't.
fn same_magic_name(a: &str, b: &str, method: bool) -> bool {
    if method { a.eq_ignore_ascii_case(b) } else { a == b }
}

/// What the resolver does on its own: the declared, documented or inferred
/// return of the callee, generics included. Answers whenever that is more
/// than `mixed`.
pub struct CoreProvider;

impl TypeProvider for CoreProvider {
    fn key(&self) -> &'static str {
        "core"
    }

    fn call(&self, site: &CallSite<'_>) -> Option<LazyType> {
        let core = (site.core)();
        (core != LazyType::mixed()).then_some(core)
    }

    /// A property without a type or `@var`: what the methods of its class
    /// assign to it (`$this->reader = IOFactory::load($path);`), when it is
    /// few different things.
    fn property(&self, site: &PropertySite<'_>) -> Option<LazyType> {
        let mut assigned: Vec<LazyType> = Vec::new();
        let mut elements: Vec<LazyType> = Vec::new();
        let mut keyed = false;
        for value in site.assigned {
            let into = match value.element {
                None => &mut assigned,
                Some(with_key) => {
                    keyed |= with_key;
                    &mut elements
                }
            };
            if !into.contains(&value.ty) {
                into.push(value.ty.clone());
            }
        }
        // Nothing known, or too many to mean one thing.
        let unusable = |types: &[LazyType]| types.len() > MAX_ASSIGNED || types.contains(&LazyType::mixed());
        if unusable(&assigned) || unusable(&elements) {
            return None;
        }
        // `$this->items[] = $item;`: a list of what is added (an array
        // when some are added under a key).
        if !elements.is_empty() {
            let payload = if keyed { ENTRIES } else { ELEMENTS };
            let fallback = LazyType::Known(Type::array());
            assigned.push(provided(self.key(), payload, vec![LazyType::union(elements)], fallback));
        }
        (!assigned.is_empty()).then(|| LazyType::union(assigned))
    }

    fn resolve(&self, payload: &str, args: &[Type], _resolver: &Resolver<'_>, _context: &Context) -> Option<Type> {
        let element = args.first().filter(|element| **element != Type::Mixed)?.widen();
        match payload {
            ELEMENTS => Some(Type::list_of(element)),
            ENTRIES => Some(Type::array_of(Type::ArrayKey, element)),
            _ => None,
        }
    }
}

/// The core's payloads for a property filled element by element.
const ELEMENTS: &str = "elements";
const ENTRIES: &str = "entries";

/// Whether `lazy` is (or has among its members) the elements added to a
/// property ([`CoreProvider::property`]).
pub(crate) fn has_elements(lazy: &LazyType) -> bool {
    match lazy {
        LazyType::Provided { key, payload, .. } => key == "core" && (payload == ELEMENTS || payload == ENTRIES),
        LazyType::Union(members) => members.iter().any(has_elements),
        _ => false,
    }
}

/// How many different values assigned to an untyped property still type it.
const MAX_ASSIGNED: usize = 4;

/// PHPUnit: test doubles and fixtures set up in `setUp()`.
///
/// - `createMock(X::class)`, `createConfiguredMock`, `createPartialMock`,
///   `createTestProxy`, `getMockForAbstractClass` and `getMockForTrait`
///   are `X&MockObject`; `createStub(X::class)`
///   and `createConfiguredStub` are `X&Stub`; `getMockBuilder(X::class)` is
///   `MockBuilder<X>`, whose `getMock()` (and `getMockForAbstractClass()`,
///   `getMockForTrait()`) is `X&MockObject` again.
/// - A property without a type that `setUp()` assigns has the assigned
///   type.
///
/// Only on test cases (subclasses of `PHPUnit\Framework\TestCase`, which
/// need not be installed); elsewhere the core answers.
pub struct PhpUnitProvider;

const TEST_CASE: &str = "PHPUnit\\Framework\\TestCase";
const LEGACY_TEST_CASE: &str = "PHPUnit_Framework_TestCase";
const MOCK_OBJECT: &str = "PHPUnit\\Framework\\MockObject\\MockObject";
const STUB: &str = "PHPUnit\\Framework\\MockObject\\Stub";
const PEST_MIXIN: &str = "Pest\\Mixins\\Expectation";
const MOCKERY_MOCK: &str = "Mockery\\MockInterface";
const MOCK_BUILDER: &str = "PHPUnit\\Framework\\MockObject\\MockBuilder";

/// Test-case methods creating a double of the class named by their first
/// argument, and the interface the double adds.
const DOUBLES: &[(&str, &str)] = &[
    ("createMock", MOCK_OBJECT),
    ("createConfiguredMock", MOCK_OBJECT),
    ("createPartialMock", MOCK_OBJECT),
    ("createTestProxy", MOCK_OBJECT),
    ("getMockForAbstractClass", MOCK_OBJECT),
    ("getMockForTrait", MOCK_OBJECT),
    ("createStub", STUB),
    ("createConfiguredStub", STUB),
];

/// `MockBuilder` methods returning the double.
const BUILDER_DOUBLES: &[&str] = &["getMock", "getMockForAbstractClass", "getMockForTrait"];

/// Pest's expectation class, or the mixin declaring its assertions (whose
/// `self` return types name the mixin).
fn is_expectation(fqn: &str) -> bool {
    fqn_eq(NameKind::ClassLike, fqn, super::resolve::PEST_EXPECTATION) || fqn_eq(NameKind::ClassLike, fqn, PEST_MIXIN)
}

impl PhpUnitProvider {
    fn is_test_case(resolver: &Resolver<'_>, ty: &Type, context: &Context) -> bool {
        resolver
            .class_models(ty, context)
            .iter()
            .any(|model| model.is_subclass_of(TEST_CASE) || model.is_subclass_of(LEGACY_TEST_CASE))
    }
}

impl TypeProvider for PhpUnitProvider {
    fn key(&self) -> &'static str {
        "phpunit"
    }

    fn call(&self, site: &CallSite<'_>) -> Option<LazyType> {
        if site.kind == CallKind::Function {
            return None;
        }
        let receiver = site.receiver?.clone();
        let builder = site.name.eq_ignore_ascii_case("getMockBuilder");
        let double = DOUBLES.iter().find(|(name, _)| name.eq_ignore_ascii_case(site.name));
        if (builder || double.is_some())
            && let Some(class) = site.class_arg()
        {
            let payload = match double {
                Some((_, adds)) => format!("double:{adds}:{class}"),
                None => format!("builder:{class}"),
            };
            return Some(provided(self.key(), payload, vec![receiver], (site.core)()));
        }
        // `MockBuilder::getMock()` and friends (no class argument).
        if BUILDER_DOUBLES.iter().any(|name| name.eq_ignore_ascii_case(site.name)) {
            return Some(provided(self.key(), "built", vec![receiver], (site.core)()));
        }
        // A method of the value a Pest expectation forwards to
        // (`expect($order)->canRefund()->toBeFalse()`): an expectation.
        (site.kind == CallKind::Method && !site.stored)
            .then(|| provided(self.key(), format!("expectation:{}", site.name), vec![receiver], (site.core)()))
    }

    fn property(&self, site: &PropertySite<'_>) -> Option<LazyType> {
        let assigned: Vec<LazyType> = site
            .assigned
            .iter()
            .filter(|assigned| assigned.element.is_none() && assigned.method.eq_ignore_ascii_case("setUp"))
            .map(|assigned| assigned.ty.clone())
            .collect();
        if assigned.is_empty() || site.extends.is_empty() {
            return None;
        }
        let this = LazyType::Known(Type::named(site.class));
        Some(provided(self.key(), "setUp", vec![this, LazyType::union(assigned)], LazyType::mixed()))
    }

    fn resolve(&self, payload: &str, args: &[Type], resolver: &Resolver<'_>, context: &Context) -> Option<Type> {
        let receiver = args.first()?;
        if payload == "built" {
            // `getMockBuilder(X::class)->getMock()`.
            let built = receiver.members().iter().find_map(|member| match member {
                Type::Named { fqn, args } if fqn_eq(NameKind::ClassLike, fqn, MOCK_BUILDER) => args.first().cloned(),
                _ => None,
            })?;
            return Some(Type::intersection([built, Type::named(MOCK_OBJECT)]));
        }
        if let Some(method) = payload.strip_prefix("expectation:") {
            let expectation = super::resolve::PEST_EXPECTATION;
            let on_expectation = receiver
                .members()
                .iter()
                .find(|member| matches!(member, Type::Named { fqn, .. } if is_expectation(fqn)))?;
            let Type::Named { args, .. } = on_expectation else { return None };
            let model = resolver.class_model(expectation)?;
            let declared = model.method(method).is_some();
            return (!declared).then(|| Type::generic(model.fqn(), args.clone()));
        }
        if !Self::is_test_case(resolver, receiver, context) {
            return None;
        }
        if payload == "setUp" {
            return args.get(1).cloned();
        }
        if let Some(class) = payload.strip_prefix("builder:") {
            return Some(Type::generic(MOCK_BUILDER, vec![Type::named(class)]));
        }
        let (adds, class) = payload.strip_prefix("double:")?.split_once(':')?;
        Some(Type::intersection([Type::named(class), Type::named(adds)]))
    }

    /// `$this->mock(Foo::class, function ($mock) { … })` (Laravel's
    /// `mock()`, `partialMock()` and `spy()`): the closure gets the mock.
    fn closure_parameters(
        &self,
        _receiver: &Type,
        method: &str,
        _key: &str,
        resolver: &Resolver<'_>,
        _context: &Context,
    ) -> Option<Vec<Type>> {
        if !["mock", "partialMock", "spy"].iter().any(|name| name.eq_ignore_ascii_case(method)) {
            return None;
        }
        let mock = resolver.class_model(MOCKERY_MOCK)?;
        Some(vec![Type::named(mock.fqn())])
    }

    /// Pest's higher-order expectations: a property of the expected value
    /// read on the expectation (`expect($order)->state->toBe('paid')`) is
    /// an expectation again.
    fn magic_property(&self, class: &str, _name: &str, resolver: &Resolver<'_>) -> Option<Type> {
        if !is_expectation(class) {
            return None;
        }
        resolver.class_model(super::resolve::PEST_EXPECTATION).map(|model| Type::named(model.fqn()))
    }

    /// The methods of the value an expectation is about
    /// (`expect($order)->canRefund()->toBeFalse()`), which it forwards to.
    fn magic_members(&self, receiver: &Type, resolver: &Resolver<'_>, context: &Context) -> Vec<MagicMember> {
        let mut out = Vec::new();
        for member in receiver.members() {
            let Type::Named { fqn, args } = member else { continue };
            let Some(value) = args.first() else { continue };
            if !is_expectation(fqn) {
                continue;
            }
            for model in resolver.class_models(value, context) {
                for method in model.methods.iter() {
                    if method.visibility == crate::summary::Visibility::Public && !method.name.starts_with("__") {
                        out.push(MagicMember {
                            name: method.name.clone(),
                            is_static: false,
                            target: MagicTarget::Method { class: model.fqn().to_owned(), method: method.name.clone() },
                        });
                    }
                }
            }
        }
        out
    }
}

pub(crate) mod laravel;
pub(crate) mod symfony;

#[cfg(test)]
mod tests;
