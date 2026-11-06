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
//! ([`PhpUnitProvider`]) and the core; summaries are always extracted with
//! it.

use std::sync::{Arc, LazyLock};

use mago_syntax::cst::{Access, Argument, ArgumentList, ClassLikeConstantSelector, Expression};

use super::ops::literal_type;
use super::{Context, LazyType, Resolver, Type};
use crate::meta::MetaProvider;
use crate::names::{NameKind, NameScope, Resolution, fqn_eq};

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
    /// The value of a string literal argument.
    pub string: Option<String>,
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
                    }
                }
                Expression::Literal(literal) => {
                    if let Type::LiteralString(string) = literal_type(literal) {
                        if is_class_name(&string) {
                            arg.class = Some(string.trim_start_matches('\\').to_owned());
                        }
                        arg.string = Some(string);
                    }
                }
                _ => {}
            }
            arg
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
    /// `.phpstorm.meta.php` ([`MetaProvider`], first: its fallback is what
    /// the others say), PHPUnit and the core.
    fn default() -> Self {
        let mut providers = Self::empty();
        providers.register(CORE_ORDER, Arc::new(CoreProvider));
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
}

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
        BUILDER_DOUBLES
            .iter()
            .any(|name| name.eq_ignore_ascii_case(site.name))
            .then(|| provided(self.key(), "built", vec![receiver], (site.core)()))
    }

    fn property(&self, site: &PropertySite<'_>) -> Option<LazyType> {
        let assigned: Vec<LazyType> = site
            .assigned
            .iter()
            .filter(|assigned| assigned.method.eq_ignore_ascii_case("setUp"))
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
}

#[cfg(test)]
mod tests;
