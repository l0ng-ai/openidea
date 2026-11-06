//! The resolve step of the two-phase types: completes [`LazyType`]s against
//! the declarations of the whole project.
//!
//! A [`Resolver`] looks declarations up through [`Declarations`] (the engine
//! answers from the open buffers, the indexes and the bundled stubs;
//! [`SummarySet`] from a fixed list of summaries, for tests). For each member
//! it takes the declared type when there is one (`@return`/`@var` first,
//! then the native hint) and otherwise resolves the lazy type the summary
//! inferred, recursively.
//!
//! - **Per-member unions:** a member access on `A|B|null` is looked up on `A`
//!   and on `B`, and the answers are joined; members that aren't classes (or
//!   don't have the member) contribute nothing. When nothing answers, the
//!   type is `mixed`.
//! - **Guards:** a declaration being resolved is on a stack; meeting it again
//!   (`function f() { return f(); }`, two methods returning each other) cuts
//!   the cycle, the cut path contributing nothing. A chain deeper than
//!   [`MAX_DEPTH`] stops with `mixed`. A cycle with nothing else to say is
//!   `mixed`.
//! - **Literals:** an inferred return or property default is widened
//!   (`return 'a';` is `string`), a constant keeps its literal value type.
//! - **`self`/`static`/`$this`:** a member's type is first completed in its
//!   declaring class (`self` is that class, `parent` its parent; inside a
//!   trait, the class using it), keeping `static`/`$this`, which are bound to
//!   the receiver on each access. So `$child->fluent()` with `fluent()`
//!   declared in the parent as `return $this;` is the child.
//! - **Cache:** the type of each declaration (function return, method return,
//!   property, class constant, constant) is cached in a [`TypeCache`] under
//!   the engine's modification counter: the first resolve after the counter
//!   moved (a document edit, a watcher batch) starts from an empty cache.
//!   Results that depended on a cycle still being resolved are not cached.
//!
//! Members are looked up in the class's [`ClassModel`] (built by
//! [`Resolver::class_model`], cached alongside the types): own members, then
//! traits with their `insteadof`/`as` rules, enum built-ins, parents and
//! interfaces, then `@method`/`@property`, then `@mixin` classes.
//!
//! Generics ([`generics`]): a member's type has its declaring class's
//! templates bound from the receiver's generic arguments (through
//! `@extends`/`@implements`/`@use`), and a call's own templates inferred from
//! its arguments ([`Resolver::method_call`], [`Resolver::function_call`],
//! [`Resolver::instantiate`]). The cache holds the unbound types.
//!
//! Type provider payloads ([`LazyType::Provided`]) are completed by the
//! resolve step of their provider in the resolver's [`TypeProviders`]
//! (the built-in ones unless [`Resolver::with_providers`] says otherwise).

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;

use super::model::{self, ClassModel, EnumMethod, EnumProperty, MethodSource, ModelMethod, PropertySource};
use super::provider::TypeProviders;
use super::{Hierarchy, LazyType, Relative, SignatureParam, Type};
use crate::names::{NameKind, fqn_eq};
use crate::summary::{ClassLike, ConstantDecl, FileSummary, FunctionDecl, TypeHint};

mod generics;

pub(crate) use generics::declared_params;
pub use generics::{Bindings, CallArg, TemplateParam, bind_args, class_template_params, substitute, template_params};
use generics::{is_generic, with_args};

/// The arguments of a call, computed only when a template needs them.
pub type Args<'f> = &'f dyn Fn() -> Vec<CallArg>;

/// What a member is looked up on.
pub(super) struct Receiver<'t> {
    /// The class-like the member is looked up in.
    class: &'t str,
    /// What `static` and `$this` are in the member's type.
    this: &'t Type,
    /// Where the class's generic arguments come from.
    start: Start<'t>,
}

#[derive(Clone, Copy)]
enum Start<'t> {
    /// A class type `class<args>` (raw when `args` is empty: its templates
    /// take their fallbacks).
    Args(&'t str, &'t [Type]),
    /// Code inside this class: its own templates stay templates.
    Own(&'t str),
}

/// How many lazy steps one resolve follows before giving up with `mixed`.
pub const MAX_DEPTH: usize = 32;

/// Class models built at most at once (nested through parents, interfaces,
/// traits and mixins) before the next one is treated as unknown.
const MAX_MODEL_DEPTH: usize = 64;

/// Where declarations come from.
pub trait Declarations {
    /// The class-like with this fully qualified name (case-insensitive).
    fn class_like(&self, fqn: &str) -> Option<ClassLike>;
    /// The function with this fully qualified name (case-insensitive).
    fn function(&self, fqn: &str) -> Option<FunctionDecl>;
    /// The constant with this fully qualified name (case-sensitive name).
    fn constant(&self, fqn: &str) -> Option<ConstantDecl>;
}

/// [`Declarations`] over a fixed set of summaries, the first declaration
/// winning.
#[derive(Clone, Debug, Default)]
pub struct SummarySet {
    pub summaries: Vec<FileSummary>,
}

impl SummarySet {
    pub fn new(summaries: Vec<FileSummary>) -> Self {
        Self { summaries }
    }
}

impl Declarations for SummarySet {
    fn class_like(&self, fqn: &str) -> Option<ClassLike> {
        self.summaries.iter().find_map(|summary| summary.class_like(fqn)).cloned()
    }

    fn function(&self, fqn: &str) -> Option<FunctionDecl> {
        self.summaries.iter().find_map(|summary| summary.function(fqn)).cloned()
    }

    fn constant(&self, fqn: &str) -> Option<ConstantDecl> {
        let fqn = fqn.trim_start_matches('\\');
        self.summaries
            .iter()
            .flat_map(|summary| &summary.constants)
            .find(|constant| fqn_eq(NameKind::Constant, &constant.fqn, fqn))
            .cloned()
    }
}

/// A cached declaration.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Key {
    Function(String),
    Constant(String),
    /// Lower-case class and method.
    Method(String, String),
    /// Lower-case class, property name as declared.
    Property(String, String),
    /// Lower-case class, constant name as declared.
    ClassConstant(String, String),
    /// Not a declaration: marks a chain cut by [`MAX_DEPTH`], so nothing
    /// above it is cached.
    Depth,
}

/// Resolved declaration types, valid for one value of the modification
/// counter. `None` entries record declarations that don't exist.
#[derive(Default)]
pub struct TypeCache {
    state: Mutex<CacheState>,
}

#[derive(Default)]
struct CacheState {
    generation: u64,
    entries: HashMap<Key, Option<Type>>,
    /// Class models by lower-case FQN; `None` for unknown class-likes.
    models: HashMap<String, Option<Arc<ClassModel>>>,
}

impl CacheState {
    /// The state for `generation`, emptied when the counter moved on.
    fn at(&mut self, generation: u64) -> &mut Self {
        if self.generation != generation {
            self.entries.clear();
            self.models.clear();
            self.generation = generation;
        }
        self
    }
}

impl TypeCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Entries cached for `generation` (0 once the counter moved on).
    pub fn len(&self, generation: u64) -> usize {
        let state = self.state.lock();
        if state.generation == generation { state.entries.len() } else { 0 }
    }

    pub fn is_empty(&self, generation: u64) -> bool {
        self.len(generation) == 0
    }

    fn get(&self, generation: u64, key: &Key) -> Option<Option<Type>> {
        let state = self.state.lock();
        if state.generation != generation {
            return None;
        }
        state.entries.get(key).cloned()
    }

    fn insert(&self, generation: u64, key: Key, value: Option<Type>) {
        self.state.lock().at(generation).entries.insert(key, value);
    }

    fn model(&self, generation: u64, key: &str) -> Option<Option<Arc<ClassModel>>> {
        let state = self.state.lock();
        if state.generation != generation {
            return None;
        }
        state.models.get(key).cloned()
    }

    fn insert_model(&self, generation: u64, key: String, value: Option<Arc<ClassModel>>) {
        self.state.lock().at(generation).models.insert(key, value);
    }
}

/// Where a type is used: what `self`, `parent`, `static` and `$this` mean.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Context {
    /// The class `self` names (and `parent` is the parent of).
    pub self_class: Option<String>,
    /// What `static` and `$this` are. `None` keeps them as markers and looks
    /// their members up on `self_class`.
    pub static_type: Option<Type>,
}

impl Context {
    /// Code inside class `fqn`, `static` and `$this` kept as markers.
    pub fn in_class(fqn: &str) -> Self {
        Self { self_class: Some(fqn.trim_start_matches('\\').to_owned()), static_type: None }
    }
}

/// Completes lazy types. Cheap to create; create one per request.
pub struct Resolver<'a> {
    decls: &'a dyn Declarations,
    cache: &'a TypeCache,
    generation: u64,
    providers: &'a TypeProviders,
    /// The declarations being resolved.
    stack: RefCell<Vec<Key>>,
    /// Declarations a cycle was cut at (or [`Key::Depth`]), not yet
    /// finished resolving.
    cuts: RefCell<Vec<Key>>,
    /// Class models being built (lower-case FQNs).
    building: RefCell<Vec<String>>,
}

impl<'a> Resolver<'a> {
    /// A resolver over `decls`, caching in `cache` for modification counter
    /// value `generation`.
    pub fn new(decls: &'a dyn Declarations, cache: &'a TypeCache, generation: u64) -> Self {
        Self {
            decls,
            cache,
            generation,
            providers: TypeProviders::builtin(),
            stack: RefCell::new(Vec::new()),
            cuts: RefCell::new(Vec::new()),
            building: RefCell::new(Vec::new()),
        }
    }

    /// This resolver with other type providers. The cache must only be
    /// shared between resolvers with the same providers.
    pub fn with_providers(mut self, providers: &'a TypeProviders) -> Self {
        self.providers = providers;
        self
    }

    /// The type providers asked for calls and completing payloads.
    pub fn providers(&self) -> &'a TypeProviders {
        self.providers
    }

    /// Where this resolver looks declarations up.
    pub fn declarations(&self) -> &'a dyn Declarations {
        self.decls
    }

    /// The type a lazy type stands for, `self`/`parent` (and `static`/
    /// `$this` when the context knows them) bound by `context`.
    pub fn resolve(&self, lazy: &LazyType, context: &Context) -> Type {
        let ty = self.lazy(lazy, context, 0);
        self.bind(&ty, context)
    }

    /// What calling function `fqn` returns; `None` when it doesn't exist.
    /// Its templates take their fallbacks.
    pub fn function_return(&self, fqn: &str) -> Option<Type> {
        let ty = self.function_at(fqn, 0)?;
        Some(self.function_generics(fqn, ty, None))
    }

    /// What calling function `fqn` with `args` returns, its templates
    /// inferred from the arguments; `None` when it doesn't exist.
    pub fn function_call(&self, fqn: &str, args: Args<'_>) -> Option<Type> {
        let ty = self.function_at(fqn, 0)?;
        Some(self.function_generics(fqn, ty, Some(args)))
    }

    /// The type of global constant `fqn`; `None` when it doesn't exist.
    pub fn constant_type(&self, fqn: &str) -> Option<Type> {
        self.constant_at(fqn, 0)
    }

    /// What `$receiver->name()` returns (per member of a union receiver).
    pub fn method_return(&self, receiver: &Type, name: &str, context: &Context) -> Type {
        let ty = self.on_members(receiver, context, &mut |receiver| self.method_at(receiver, name, None, 0));
        self.bind(&ty, context)
    }

    /// What `$receiver->name(…args)` returns, the method's templates
    /// inferred from the arguments.
    pub fn method_call(&self, receiver: &Type, name: &str, args: Args<'_>, context: &Context) -> Type {
        let ty = self.on_members(receiver, context, &mut |receiver| self.method_at(receiver, name, Some(args), 0));
        self.bind(&ty, context)
    }

    /// The parameters of method `name` on the first class among the members
    /// of `receiver` that has it, the class's templates bound from the
    /// receiver.
    pub fn method_params_on(&self, receiver: &Type, name: &str, context: &Context) -> Option<Vec<SignatureParam>> {
        let mut found = None;
        self.on_members(receiver, context, &mut |receiver| {
            if found.is_none() {
                let model = self.class_model(receiver.class)?;
                let method = model.method(name)?;
                let bindings = self.receiver_bindings(receiver, &method.declaring);
                found = Some(self.method_params(method, &bindings));
            }
            None
        });
        found
    }

    /// The type of `$receiver->name` / `Receiver::$name` (name without `$`).
    pub fn property_type(&self, receiver: &Type, name: &str, context: &Context) -> Type {
        let ty = self.on_members(receiver, context, &mut |receiver| self.property_at(receiver, name, 0));
        self.bind(&ty, context)
    }

    /// The type of `Class::NAME`: the constant's value, or the enum of a
    /// case.
    pub fn class_constant_type(&self, class: &Type, name: &str, context: &Context) -> Type {
        let ty = self.on_members(class, context, &mut |receiver| self.class_constant_at(receiver, name, 0));
        self.bind(&ty, context)
    }

    /// The model of class-like `fqn`: all its members, inherited ones
    /// included. `None` when it doesn't exist.
    pub fn class_model(&self, fqn: &str) -> Option<Arc<ClassModel>> {
        let fqn = fqn.trim_start_matches('\\');
        let key = fqn.to_ascii_lowercase();
        if let Some(hit) = self.cache.model(self.generation, &key) {
            return hit;
        }
        {
            let building = self.building.borrow();
            if building.contains(&key) || building.len() >= MAX_MODEL_DEPTH {
                // A cycle in the hierarchy: this path contributes nothing.
                return None;
            }
        }
        let built = self.decls.class_like(fqn).map(|class| {
            self.building.borrow_mut().push(key.clone());
            let built = model::build(class, &mut |name| self.class_model(name));
            self.building.borrow_mut().pop();
            Arc::new(built)
        });
        self.cache.insert_model(self.generation, key, built.clone());
        built
    }

    /// The models of the classes among the members of `ty`, with `self`,
    /// `parent`, `static` and `$this` taken from `context`.
    pub fn class_models(&self, ty: &Type, context: &Context) -> Vec<Arc<ClassModel>> {
        let mut out = Vec::new();
        for ty in ty.members() {
            self.collect_models(ty, context, &mut out);
        }
        out
    }

    fn collect_models(&self, ty: &Type, context: &Context, out: &mut Vec<Arc<ClassModel>>) {
        let mut push = |fqn: Option<&str>| {
            if let Some(model) = fqn.and_then(|fqn| self.class_model(fqn))
                && !out.iter().any(|known| Arc::ptr_eq(known, &model))
            {
                out.push(model);
            }
        };
        match ty {
            Type::Named { fqn, .. } => push(Some(fqn)),
            Type::Closure(_) => push(Some("Closure")),
            Type::Relative(Relative::Self_) | Type::GenericRelative { relative: Relative::Self_, .. } => {
                push(context.self_class.as_deref())
            }
            Type::Relative(Relative::Parent) => {
                push(context.self_class.as_deref().and_then(|class| self.parent_of(class)).as_deref())
            }
            Type::Relative(Relative::Static | Relative::This)
            | Type::GenericRelative { relative: Relative::Static | Relative::This, .. } => match &context.static_type {
                Some(static_type) => {
                    for ty in static_type.members() {
                        self.collect_models(ty, &Context::default(), out);
                    }
                }
                None => push(context.self_class.as_deref()),
            },
            Type::Intersection(members) => {
                for ty in members {
                    self.collect_models(ty, context, out);
                }
            }
            _ => {}
        }
    }

    // ------------------------------------------------------------ lazy types

    fn lazy(&self, lazy: &LazyType, context: &Context, depth: usize) -> Type {
        if depth > MAX_DEPTH {
            self.cuts.borrow_mut().push(Key::Depth);
            return Type::Mixed;
        }
        let next = depth + 1;
        match lazy {
            LazyType::Known(ty) => ty.clone(),
            LazyType::FunctionReturn { fqn, fallback } => {
                let function = |fqn: &str| Some(self.function_generics(fqn, self.function_at(fqn, next)?, None));
                function(fqn).or_else(|| fallback.as_deref().and_then(function)).unwrap_or(Type::Mixed)
            }
            LazyType::Constant { fqn, fallback } => self
                .constant_at(fqn, next)
                .or_else(|| fallback.as_deref().and_then(|global| self.constant_at(global, next)))
                .unwrap_or(Type::Mixed),
            LazyType::MethodReturn { receiver, name } => {
                let receiver = self.lazy(receiver, context, next);
                self.on_members(&receiver, context, &mut |receiver| self.method_at(receiver, name, None, next))
            }
            LazyType::Property { receiver, name } => {
                let receiver = self.lazy(receiver, context, next);
                self.on_members(&receiver, context, &mut |receiver| self.property_at(receiver, name, next))
            }
            LazyType::ClassConstant { class, name } => {
                let class = self.lazy(class, context, next);
                self.on_members(&class, context, &mut |receiver| self.class_constant_at(receiver, name, next))
            }
            LazyType::Provided { key, payload, args, fallback } => {
                let args: Vec<Type> = args.iter().map(|arg| self.lazy(arg, context, next)).collect();
                self.providers
                    .get(key)
                    .and_then(|provider| provider.resolve(payload, &args, self, context))
                    .unwrap_or_else(|| self.lazy(fallback, context, next))
            }
            LazyType::Union(members) => Type::union(members.iter().map(|member| self.lazy(member, context, next))),
        }
    }

    /// Asks `member` for each class among the members of `receiver`,
    /// joining the answers; `mixed` when none answers.
    fn on_members(
        &self,
        receiver: &Type,
        context: &Context,
        member: &mut dyn FnMut(&Receiver<'_>) -> Option<Type>,
    ) -> Type {
        let mut answers = Vec::new();
        for ty in receiver.members() {
            if let Some(answer) = self.on_member(ty, context, member) {
                answers.push(answer);
            }
        }
        if answers.is_empty() { Type::Mixed } else { Type::union(answers) }
    }

    fn on_member(
        &self,
        ty: &Type,
        context: &Context,
        member: &mut dyn FnMut(&Receiver<'_>) -> Option<Type>,
    ) -> Option<Type> {
        // What `static` means when the receiver is `self`/`parent`: the
        // caller's late static binding.
        let late = context.static_type.clone().unwrap_or(Type::Relative(Relative::Static));
        let none: &[Type] = &[];
        match ty {
            Type::Named { fqn, args } => member(&Receiver { class: fqn, this: ty, start: Start::Args(fqn, args) }),
            Type::Closure(_) => {
                let this = Type::named("Closure");
                member(&Receiver { class: "Closure", this: &this, start: Start::Args("Closure", none) })
            }
            Type::Relative(Relative::Self_) => {
                let class = context.self_class.as_deref()?;
                member(&Receiver { class, this: &late, start: Start::Own(class) })
            }
            Type::GenericRelative { relative: Relative::Self_, args } => {
                let class = context.self_class.as_deref()?;
                member(&Receiver { class, this: &late, start: Start::Args(class, args) })
            }
            Type::Relative(Relative::Parent) => {
                let own = context.self_class.as_deref()?;
                let parent = self.parent_of(own)?;
                member(&Receiver { class: &parent, this: &late, start: Start::Own(own) })
            }
            Type::Relative(Relative::Static | Relative::This)
            | Type::GenericRelative { relative: Relative::Static | Relative::This, .. } => {
                let args = match ty {
                    Type::GenericRelative { args, .. } => args.as_slice(),
                    _ => none,
                };
                match &context.static_type {
                    Some(static_type) => {
                        let static_type =
                            if args.is_empty() { static_type.clone() } else { with_args(static_type, args) };
                        let answer = self.on_members(&static_type, &Context::default(), member);
                        (answer != Type::Mixed).then_some(answer)
                    }
                    None => {
                        let class = context.self_class.as_deref()?;
                        let start = if args.is_empty() { Start::Own(class) } else { Start::Args(class, args) };
                        member(&Receiver { class, this: ty, start })
                    }
                }
            }
            Type::GenericRelative { relative: Relative::Parent, .. } => None,
            Type::Intersection(members) => members.iter().find_map(|ty| self.on_member(ty, context, member)),
            _ => None,
        }
    }

    // ---------------------------------------------------------- declarations

    /// Runs `compute` for `key` once per cache generation, guarding cycles.
    fn cached(&self, key: Key, compute: impl FnOnce() -> Option<Type>) -> Option<Type> {
        if let Some(hit) = self.cache.get(self.generation, &key) {
            return hit;
        }
        if self.stack.borrow().contains(&key) {
            // A cycle: this path contributes nothing.
            self.cuts.borrow_mut().push(key);
            return Some(Type::Never);
        }
        let before = self.cuts.borrow().len();
        self.stack.borrow_mut().push(key.clone());
        let mut result = compute();
        self.stack.borrow_mut().pop();
        let (cut_here, pending) = {
            let mut cuts = self.cuts.borrow_mut();
            let new: Vec<Key> = cuts.drain(before..).collect();
            let cut_here = new.contains(&key);
            let pending: Vec<Key> = new.into_iter().filter(|cut| *cut != key).collect();
            cuts.extend(pending.iter().cloned());
            (cut_here, !pending.is_empty())
        };
        if pending {
            // Depends on a declaration still being resolved further up.
            return result;
        }
        if cut_here && result == Some(Type::Never) {
            result = Some(Type::Mixed);
        }
        self.cache.insert(self.generation, key, result.clone());
        result
    }

    fn function_at(&self, fqn: &str, depth: usize) -> Option<Type> {
        let fqn = fqn.trim_start_matches('\\');
        self.cached(Key::Function(fqn.to_ascii_lowercase()), || {
            let function = self.decls.function(fqn)?;
            let doc = function.doc.as_deref();
            let templates: Vec<&str> = doc.iter().flat_map(|doc| doc.local_type_names()).collect();
            Some(match (doc.and_then(|doc| doc.return_type.as_ref()), &function.return_type) {
                (Some(ty), _) => Type::from_doc(ty, &templates),
                (None, Some(hint)) => Type::from_hint(hint),
                (None, None) => match &function.inferred_return {
                    Some(lazy) => self.lazy(lazy, &Context::default(), depth).widen(),
                    None => Type::Mixed,
                },
            })
        })
    }

    fn constant_at(&self, fqn: &str, depth: usize) -> Option<Type> {
        let fqn = fqn.trim_start_matches('\\');
        self.cached(Key::Constant(fqn.to_owned()), || {
            let constant = self.decls.constant(fqn)?;
            Some(match &constant.value_type {
                Some(lazy) => self.lazy(lazy, &Context::default(), depth),
                None => Type::Mixed,
            })
        })
    }

    /// A method's return type on the receiver: the class's templates bound
    /// from the receiver, the method's from `args` (else their fallbacks),
    /// `static`/`$this` bound to the receiver.
    fn method_at(&self, receiver: &Receiver<'_>, name: &str, args: Option<Args<'_>>, depth: usize) -> Option<Type> {
        let mut ty = self.method_raw(receiver.class, name, depth)?;
        if is_generic(&ty) {
            let model = self.class_model(receiver.class)?;
            let method = model.method(name)?;
            let mut bindings = self.receiver_bindings(receiver, &method.declaring);
            let own = self.method_templates(method);
            if !own.is_empty() {
                let params = match args {
                    Some(_) => self.method_params(method, &bindings),
                    None => Vec::new(),
                };
                self.bind_call(&own, &params, args, &mut bindings);
            }
            ty = substitute(&ty, &bindings);
            // `static<K, V>` on a receiver whose class doesn't take those
            // arguments (a non-generic subclass) is the declaring class
            // with them.
            let arity = class_template_params(&model.class).len();
            ty = ty.map(&mut |ty| match ty {
                Type::GenericRelative { relative: Relative::Static | Relative::This, args } if args.len() != arity => {
                    Some(Type::generic(&method.declaring.fqn, args.clone()))
                }
                _ => None,
            });
        }
        Some(bind_static(&ty, receiver.this))
    }

    /// A method's return type on `class`, templates and `static`/`$this`
    /// unbound (cached).
    fn method_raw(&self, class: &str, name: &str, depth: usize) -> Option<Type> {
        let key = Key::Method(class.to_ascii_lowercase(), name.to_ascii_lowercase());
        self.cached(key, || {
            let model = self.class_model(class)?;
            let method = model.method(name)?;
            let context = Context::in_class(&method.self_class);
            let ty = if let Some(declared) = method.declared() {
                let doc = declared.doc.as_deref();
                let templates = templates(&method.declaring, doc.into_iter().flat_map(|doc| doc.local_type_names()));
                match (doc.and_then(|doc| doc.return_type.as_ref()), &declared.return_type) {
                    (Some(ty), _) => Type::from_doc(ty, &templates),
                    // No `@return`: the overridden method's documented one
                    // (`all(): Collection` implementing `@return Collection<T>`).
                    (None, _) if let Some(inherited) = self.inherited_return(method, name, depth) => {
                        return Some(inherited);
                    }
                    (None, Some(hint)) => Type::from_hint(hint),
                    (None, None) => match &declared.inferred_return {
                        Some(lazy) => self.lazy(lazy, &context, depth).widen(),
                        None => Type::Mixed,
                    },
                }
            } else if let Some(magic) = method.magic() {
                let templates = templates(&method.declaring, magic.templates.iter().map(|t| t.name.as_str()));
                magic.return_type.as_ref().map_or(Type::Mixed, |ty| Type::from_doc(ty, &templates))
            } else {
                match method.source {
                    MethodSource::Enum(EnumMethod::Cases) => Type::list_of(Type::Relative(Relative::Static)),
                    MethodSource::Enum(EnumMethod::From) => Type::Relative(Relative::Static),
                    MethodSource::Enum(EnumMethod::TryFrom) => Type::Relative(Relative::Static).nullable(),
                    _ => Type::Mixed,
                }
            };
            Some(self.bind_member(&ty, &context, method.mixin.as_deref()))
        })
    }

    /// The return type a method without `@return` takes from the method it
    /// overrides or implements, when that one (or one it overrides in turn)
    /// documents it; the overridden class's templates are mapped onto the
    /// overriding class's.
    fn inherited_return(&self, method: &ModelMethod, name: &str, depth: usize) -> Option<Type> {
        let parent = method.overrides.as_deref()?;
        let parent_model = self.class_model(parent)?;
        let overridden = parent_model.method(name)?;
        if !self.documents_return(overridden, name, 0) {
            return None;
        }
        let ty = self.method_raw(parent, name, depth + 1)?;
        let own: Vec<Type> =
            class_template_params(&method.declaring).into_iter().map(|param| Type::Template(param.name)).collect();
        let args = self.ancestor_args(&method.declaring.fqn, &own, &overridden.declaring.fqn);
        let params = class_template_params(&overridden.declaring);
        Some(substitute(&ty, &bind_args(&params, args.as_deref().unwrap_or_default())))
    }

    /// True when the method, or one it overrides, has a `@return`.
    fn documents_return(&self, method: &ModelMethod, name: &str, depth: usize) -> bool {
        if method.magic().is_some_and(|magic| magic.return_type.is_some())
            || method.declared().and_then(|declared| declared.doc.as_ref()).is_some_and(|doc| doc.return_type.is_some())
        {
            return true;
        }
        depth < MAX_DEPTH
            && method.overrides.as_deref().and_then(|parent| self.class_model(parent)).is_some_and(|model| {
                model.method(name).is_some_and(|overridden| self.documents_return(overridden, name, depth + 1))
            })
    }

    fn property_at(&self, receiver: &Receiver<'_>, name: &str, depth: usize) -> Option<Type> {
        let name = name.trim_start_matches('$');
        let class = receiver.class;
        let key = Key::Property(class.to_ascii_lowercase(), name.to_owned());
        let mut ty = self.cached(key, || {
            let model = self.class_model(class)?;
            let property = model.property(name)?;
            let context = Context::in_class(&property.self_class);
            let templates = templates(&property.declaring, []);
            let ty = if let Some(declared) = property.declared() {
                match (declared.doc.as_ref().and_then(|doc| doc.var_type(name)), &declared.type_hint) {
                    (Some(ty), _) => Type::from_doc(ty, &templates),
                    (None, Some(hint)) => Type::from_hint(hint),
                    (None, None) => match &declared.default_type {
                        Some(lazy) => self.lazy(lazy, &context, depth).widen(),
                        None => Type::Mixed,
                    },
                }
            } else if let Some(magic) = property.magic() {
                magic.ty.as_ref().map_or(Type::Mixed, |ty| Type::from_doc(ty, &templates))
            } else {
                match property.source {
                    PropertySource::Enum(EnumProperty::Name) => Type::string(),
                    PropertySource::Enum(EnumProperty::Value) => match &property.declaring.backing_type {
                        Some(TypeHint::Builtin(int)) if int == "int" => Type::Int,
                        Some(TypeHint::Builtin(string)) if string == "string" => Type::string(),
                        _ => Type::union([Type::Int, Type::string()]),
                    },
                    _ => Type::Mixed,
                }
            };
            Some(self.bind_member(&ty, &context, property.mixin.as_deref()))
        })?;
        if is_generic(&ty) {
            let model = self.class_model(class)?;
            let property = model.property(name)?;
            ty = substitute(&ty, &self.receiver_bindings(receiver, &property.declaring));
        }
        Some(bind_static(&ty, receiver.this))
    }

    fn class_constant_at(&self, receiver: &Receiver<'_>, name: &str, depth: usize) -> Option<Type> {
        let class = receiver.class;
        let key = Key::ClassConstant(class.to_ascii_lowercase(), name.to_owned());
        let ty = self.cached(key, || {
            let model = self.class_model(class)?;
            let constant = model.constant(name)?;
            if constant.case().is_some() {
                return Some(Type::named(&constant.declaring.fqn));
            }
            let declared = constant.declared()?;
            let context = Context::in_class(&constant.self_class);
            let templates = templates(&constant.declaring, []);
            let ty = match (declared.doc.as_ref().and_then(|doc| doc.var_type(name)), &declared.type_hint) {
                (Some(ty), _) => Type::from_doc(ty, &templates),
                (None, Some(hint)) => Type::from_hint(hint),
                (None, None) => match &declared.value_type {
                    Some(lazy) => self.lazy(lazy, &context, depth),
                    None => Type::Mixed,
                },
            };
            Some(self.bind(&ty, &context))
        })?;
        Some(bind_static(&ty, receiver.this))
    }

    /// A member's type completed in its class: `self`/`parent` bound, and
    /// `static`/`$this` bound to the mixin class for a `@mixin` member.
    fn bind_member(&self, ty: &Type, context: &Context, mixin: Option<&str>) -> Type {
        let ty = self.bind(ty, context);
        match mixin {
            Some(mixin) => bind_static(&ty, &Type::named(mixin)),
            None => ty,
        }
    }

    // ------------------------------------------------------------ hierarchy

    fn parent_of(&self, class: &str) -> Option<String> {
        self.class_model(class)?.parents.first().cloned()
    }

    /// Binds `self` and `parent` to the context's class, and `static` and
    /// `$this` to its static type when it has one.
    fn bind(&self, ty: &Type, context: &Context) -> Type {
        let Some(self_class) = context.self_class.as_deref() else {
            return match &context.static_type {
                Some(this) => bind_static(ty, this),
                None => ty.clone(),
            };
        };
        let mut parent = None;
        ty.map(&mut |ty| match ty {
            Type::Relative(Relative::Self_) => Some(Type::named(self_class)),
            Type::GenericRelative { relative: Relative::Self_, args } => Some(Type::generic(self_class, args.clone())),
            Type::GenericRelative { relative: Relative::Static | Relative::This, args } => {
                context.static_type.as_ref().map(|this| with_args(this, args))
            }
            Type::Relative(Relative::Parent) => {
                let parent = parent.get_or_insert_with(|| self.parent_of(self_class));
                parent.as_deref().map(Type::named)
            }
            Type::Relative(Relative::Static | Relative::This) => context.static_type.clone(),
            _ => None,
        })
    }
}

/// Subclass checks through the class models.
impl Hierarchy for Resolver<'_> {
    fn is_subclass(&self, sub: &str, sup: &str) -> bool {
        fqn_eq(NameKind::ClassLike, sub, sup) || self.class_model(sub).is_some_and(|model| model.is_subclass_of(sup))
    }

    fn supertype_args(&self, sub: &str, sub_args: &[Type], sup: &str) -> Option<Vec<Type>> {
        self.ancestor_args(sub, sub_args, sup).filter(|args| !args.is_empty())
    }
}

/// `static` and `$this` replaced by the receiver (left alone when the
/// receiver is itself one of them).
fn bind_static(ty: &Type, this: &Type) -> Type {
    if matches!(this, Type::Relative(Relative::Static | Relative::This)) {
        return ty.clone();
    }
    ty.map(&mut |ty| match ty {
        Type::Relative(Relative::Static | Relative::This) => Some(this.clone()),
        Type::GenericRelative { relative: Relative::Static | Relative::This, args } => Some(with_args(this, args)),
        _ => None,
    })
}

/// The template parameters in scope in a member of `class`: the class's and
/// the member's own.
fn templates<'t>(class: &'t ClassLike, member: impl IntoIterator<Item = &'t str>) -> Vec<&'t str> {
    let mut out: Vec<&str> = class.doc.iter().flat_map(|doc| doc.local_type_names()).collect();
    out.extend(member);
    out
}

#[cfg(test)]
mod tests;
