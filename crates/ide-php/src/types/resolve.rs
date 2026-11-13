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

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::RwLock;

use super::model::{
    self, ClassModel, EnumMethod, EnumProperty, MethodSource, ModelMethod, ModelProperty, Origin, PropertySource,
};
use super::provider::TypeProviders;
use super::{Hierarchy, LazyType, Relative, SignatureParam, Type};
use crate::frameworks::laravel::auth::UserModels;
use crate::meta::PhpStormMeta;
use crate::names::{NameKind, fqn_eq};
use crate::summary::{ClassLike, ConstantDecl, FileSummary, FunctionDecl, LaravelFacts, Macro, TypeHint};
use crate::symfony::{SymfonyConfig, SymfonyProject};

mod generics;
mod operators;

pub(crate) use generics::declared_params;
pub use generics::{
    Bindings, CallArg, TemplateParam, bind_args, class_template_params, signature_templates, substitute,
    template_params,
};
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
    /// The `.phpstorm.meta.php` directives of the project, merged. The
    /// [`Resolver`] caches them per modification counter.
    fn meta(&self) -> PhpStormMeta {
        PhpStormMeta::default()
    }
    /// The Laravel bindings, migrations and casts of the project, merged.
    /// The [`Resolver`] caches them per modification counter.
    fn laravel(&self) -> LaravelFacts {
        LaravelFacts::default()
    }
    /// The Laravel macros of the project, with their files: those of
    /// [`Declarations::laravel`], which an implementation can find more
    /// cheaply (class models need them, after every modification).
    fn macros(&self) -> Vec<Macro> {
        self.laravel().macros
    }
    /// The user model of each guard of the Laravel project's
    /// `config/auth.php`.
    fn user_models(&self) -> UserModels {
        UserModels::default()
    }
    /// The types callers outside the asking file pass for parameter `site`
    /// (see [`crate::types::expr::call_site_arguments`]): in the hierarchy of
    /// its class, and for a `public` method in the files naming it. `depth`
    /// is how deep the lookup is already.
    fn call_site_types(&self, _site: &crate::types::expr::CallSiteParam<'_>, _public: bool, _depth: u8) -> Vec<Type> {
        Vec::new()
    }
    /// The class-likes with short name `name` (any case), by FQN.
    fn classes_named(&self, _name: &str) -> Vec<String> {
        Vec::new()
    }
    /// The class-likes that directly extend, implement or (a trait) use
    /// `fqn`, by FQN.
    fn direct_subclasses(&self, _fqn: &str) -> Vec<String> {
        Vec::new()
    }
    /// The Symfony configuration and the `#[Route]` names and repository
    /// entities of the project. The [`Resolver`] caches them per
    /// modification counter.
    fn symfony(&self) -> SymfonyProject {
        SymfonyProject::default()
    }
}

/// [`Declarations`] over a fixed set of summaries, the first declaration
/// winning.
#[derive(Clone, Debug, Default)]
pub struct SummarySet {
    pub summaries: Vec<FileSummary>,
    /// The Symfony configuration the set answers with (none by default).
    pub symfony_config: SymfonyConfig,
}

impl SummarySet {
    pub fn new(summaries: Vec<FileSummary>) -> Self {
        Self { summaries, symfony_config: SymfonyConfig::default() }
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

    fn meta(&self) -> PhpStormMeta {
        PhpStormMeta::merge(self.summaries.iter().map(|summary| &summary.meta))
    }

    fn laravel(&self) -> LaravelFacts {
        LaravelFacts::merge(self.summaries.iter().map(|summary| &summary.laravel))
    }

    fn classes_named(&self, name: &str) -> Vec<String> {
        let classes = self.summaries.iter().flat_map(|summary| &summary.class_likes);
        classes.filter(|class| class.name.eq_ignore_ascii_case(name)).map(|class| class.fqn.clone()).collect()
    }

    fn direct_subclasses(&self, fqn: &str) -> Vec<String> {
        let names = |class: &&ClassLike| {
            let traits = class.trait_uses.iter().flat_map(|uses| &uses.traits);
            class
                .extends
                .iter()
                .chain(&class.implements)
                .chain(traits)
                .any(|parent| fqn_eq(NameKind::ClassLike, parent, fqn))
        };
        let classes = self.summaries.iter().flat_map(|summary| &summary.class_likes);
        classes.filter(names).map(|class| class.fqn.clone()).collect()
    }

    fn symfony(&self) -> SymfonyProject {
        SymfonyProject::new(self.symfony_config.clone(), self.summaries.iter().map(|summary| (None, &summary.symfony)))
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
    /// A shadowed `@property` tag, for callers that can't access the real
    /// property: lower-case class, property name.
    MagicProperty(String, String),
    /// Lower-case class, constant name as declared.
    ClassConstant(String, String),
    /// What callers pass for a parameter: lower-case class and method, the
    /// parameter's position.
    CallSite(String, String, usize),
    /// Not a declaration: marks a chain cut by [`MAX_DEPTH`], so nothing
    /// above it is cached.
    Depth,
}

/// Resolved declaration types, valid for one value of the modification
/// counter. `None` entries record declarations that don't exist.
#[derive(Default)]
pub struct TypeCache {
    /// Read by every lookup of every thread (Inspect Code runs files in
    /// parallel, phase 9.4); written only on a miss.
    state: RwLock<CacheState>,
}

#[derive(Default)]
struct CacheState {
    generation: u64,
    entries: HashMap<Key, Option<Type>>,
    /// Class models by lower-case FQN; `None` for unknown class-likes.
    models: HashMap<String, Option<Arc<ClassModel>>>,
    /// The merged `.phpstorm.meta.php` directives.
    meta: Option<Arc<PhpStormMeta>>,
    /// The merged Laravel facts.
    laravel: Option<Arc<LaravelFacts>>,
    /// The Laravel macros.
    macros: Option<Arc<Vec<Macro>>>,
    /// The Laravel guards' user models.
    user_models: Option<Arc<UserModels>>,
    /// The Symfony configuration and facts.
    symfony: Option<Arc<SymfonyProject>>,
}

impl CacheState {
    /// The state for `generation`, emptied when the counter moved on.
    fn at(&mut self, generation: u64) -> &mut Self {
        if self.generation != generation {
            self.entries.clear();
            self.models.clear();
            self.meta = None;
            self.laravel = None;
            self.macros = None;
            self.user_models = None;
            self.symfony = None;
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
        let state = self.state.read();
        if state.generation == generation { state.entries.len() } else { 0 }
    }

    pub fn is_empty(&self, generation: u64) -> bool {
        self.len(generation) == 0
    }

    fn get(&self, generation: u64, key: &Key) -> Option<Option<Type>> {
        let state = self.state.read();
        if state.generation != generation {
            return None;
        }
        state.entries.get(key).cloned()
    }

    fn insert(&self, generation: u64, key: Key, value: Option<Type>) {
        self.state.write().at(generation).entries.insert(key, value);
    }

    fn model(&self, generation: u64, key: &str) -> Option<Option<Arc<ClassModel>>> {
        let state = self.state.read();
        if state.generation != generation {
            return None;
        }
        state.models.get(key).cloned()
    }

    fn insert_model(&self, generation: u64, key: String, value: Option<Arc<ClassModel>>) {
        self.state.write().at(generation).models.insert(key, value);
    }

    fn meta(&self, generation: u64) -> Option<Arc<PhpStormMeta>> {
        let state = self.state.read();
        if state.generation != generation {
            return None;
        }
        state.meta.clone()
    }

    fn insert_meta(&self, generation: u64, meta: Arc<PhpStormMeta>) {
        self.state.write().at(generation).meta = Some(meta);
    }

    fn laravel(&self, generation: u64) -> Option<Arc<LaravelFacts>> {
        let state = self.state.read();
        if state.generation != generation {
            return None;
        }
        state.laravel.clone()
    }

    fn insert_laravel(&self, generation: u64, facts: Arc<LaravelFacts>) {
        self.state.write().at(generation).laravel = Some(facts);
    }

    fn macros(&self, generation: u64) -> Option<Arc<Vec<Macro>>> {
        let state = self.state.read();
        if state.generation != generation {
            return None;
        }
        state.macros.clone()
    }

    fn insert_macros(&self, generation: u64, macros: Arc<Vec<Macro>>) {
        self.state.write().at(generation).macros = Some(macros);
    }

    fn user_models(&self, generation: u64) -> Option<Arc<UserModels>> {
        let state = self.state.read();
        if state.generation != generation {
            return None;
        }
        state.user_models.clone()
    }

    fn insert_user_models(&self, generation: u64, models: Arc<UserModels>) {
        self.state.write().at(generation).user_models = Some(models);
    }

    fn symfony(&self, generation: u64) -> Option<Arc<SymfonyProject>> {
        let state = self.state.read();
        if state.generation != generation {
            return None;
        }
        state.symfony.clone()
    }

    fn insert_symfony(&self, generation: u64, project: Arc<SymfonyProject>) {
        self.state.write().at(generation).symfony = Some(project);
    }

    /// Drops the models of the class-likes `fqns` and of every class-like
    /// built on them (extending, implementing, using or mixing them in),
    /// keeping the rest of `generation`: an edit inside a body of the file
    /// declaring them moved their members, nothing else.
    pub fn forget_classes(&self, generation: u64, fqns: &[String]) {
        let mut state = self.state.write();
        if state.generation != generation || fqns.is_empty() {
            return;
        }
        let names: Vec<String> = fqns.iter().map(|fqn| fqn.trim_start_matches('\\').to_ascii_lowercase()).collect();
        let named = |fqn: &String| names.iter().any(|name| fqn.trim_start_matches('\\').eq_ignore_ascii_case(name));
        state.models.retain(|key, model| {
            if names.contains(key) {
                return false;
            }
            let Some(model) = model else { return true };
            !(named(&model.class.fqn)
                || model.parents.iter().any(named)
                || model.interfaces.iter().any(named)
                || model.traits.iter().any(named)
                || model.mixins.iter().any(named))
        });
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
    /// The lowest index in `building` a cycle has led back to since the
    /// current model build started (`usize::MAX` for none).
    model_cycle: Cell<usize>,
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
            model_cycle: Cell::new(usize::MAX),
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

    /// The project's `.phpstorm.meta.php` directives, cached for the
    /// modification counter.
    pub fn meta(&self) -> Arc<PhpStormMeta> {
        if let Some(meta) = self.cache.meta(self.generation) {
            return meta;
        }
        let meta = Arc::new(self.decls.meta());
        self.cache.insert_meta(self.generation, meta.clone());
        meta
    }

    /// The project's Laravel bindings, migrations and casts, cached for the
    /// modification counter.
    pub fn laravel(&self) -> Arc<LaravelFacts> {
        if let Some(facts) = self.cache.laravel(self.generation) {
            return facts;
        }
        let facts = Arc::new(self.decls.laravel());
        self.cache.insert_laravel(self.generation, facts.clone());
        facts
    }

    /// The class-likes that directly extend or implement `fqn`, by FQN.
    pub fn direct_subclasses(&self, fqn: &str) -> Vec<String> {
        self.decls.direct_subclasses(fqn)
    }

    /// Whether `found` is the bare container `declared` (see
    /// [`is_bare_container`]) with its element types: lists and arrays of
    /// something known for `array`, the class (or a subclass) with generic
    /// arguments for a class.
    pub(crate) fn refines_container(&self, declared: &Type, found: &Type) -> bool {
        let members = found.members();
        if members.is_empty() {
            return false;
        }
        match declared {
            // An array literal is a shape.
            Type::Array { .. } => members.iter().all(|member| match member {
                Type::List { value, .. } | Type::Array { value, .. } => **value != Type::Mixed,
                Type::Shape(shape) => !shape.fields.is_empty(),
                _ => false,
            }),
            Type::Named { fqn, .. } => members.iter().all(|member| match member {
                Type::Named { fqn: found, args } if !args.is_empty() => {
                    operators::same_class(found, fqn)
                        || self.class_model(found).is_some_and(|class| class.is_subclass_of(fqn))
                }
                _ => false,
            }),
            _ => false,
        }
    }

    /// What callers in other files pass for parameter `site`
    /// ([`Declarations::call_site_types`]), cached for the modification
    /// counter.
    pub fn call_site_types(&self, site: &crate::types::expr::CallSiteParam<'_>, public: bool, depth: u8) -> Vec<Type> {
        let key = Key::CallSite(site.class.to_ascii_lowercase(), site.method.to_ascii_lowercase(), site.index);
        // An empty union is `never`: nothing found.
        let found = self.cached(key, || {
            let types = self.decls.call_site_types(site, public, depth);
            (!types.is_empty()).then(|| Type::union(types))
        });
        match found {
            Some(ty) if ty != Type::Mixed && ty != Type::Never => ty.members().to_vec(),
            _ => Vec::new(),
        }
    }

    /// The class-likes with short name `name` (any case), by FQN.
    pub fn classes_named(&self, name: &str) -> Vec<String> {
        self.decls.classes_named(name)
    }

    /// The classes using trait `fqn` (at most [`MAX_TRAIT_HOSTS`], in name
    /// order): what `$this` is in the trait's methods, beside the trait.
    pub fn trait_hosts(&self, fqn: &str) -> Vec<String> {
        // Through the traits using the trait, a few levels.
        let mut hosts: Vec<String> = Vec::new();
        let mut traits = vec![fqn.to_owned()];
        for _ in 0..MAX_TRAIT_HOSTS {
            let mut next = Vec::new();
            for used in &traits {
                for host in self.direct_subclasses(used) {
                    match self.class_model(&host).map(|model| model.class.kind) {
                        Some(crate::summary::ClassKind::Class) => hosts.push(host),
                        Some(crate::summary::ClassKind::Trait) => next.push(host),
                        _ => {}
                    }
                }
            }
            if next.is_empty() {
                break;
            }
            traits = next;
        }
        hosts.sort();
        hosts.dedup();
        hosts.truncate(MAX_TRAIT_HOSTS);
        hosts
    }

    /// The project's Laravel macros, cached for the modification counter.
    pub fn macros(&self) -> Arc<Vec<Macro>> {
        if let Some(macros) = self.cache.macros(self.generation) {
            return macros;
        }
        let macros = Arc::new(self.decls.macros());
        self.cache.insert_macros(self.generation, macros.clone());
        macros
    }

    /// The class Pest binds the test closures of the file at `path` to: the
    /// first class (not trait) the file's own `uses(…)` names, else that of
    /// the `uses(…)->in(…)` (or `pest()->extend(…)->in(…)`) whose folder
    /// holds the file most closely, else PHPUnit's `TestCase`.
    pub fn pest_test_case(&self, path: &std::path::Path) -> Option<String> {
        let facts = self.laravel();
        let mut candidates: Vec<(usize, &crate::summary::PestUses)> = Vec::new();
        for uses in &facts.pest {
            let Some(file) = uses.file.as_deref() else { continue };
            if uses.dirs.is_empty() {
                if file == path {
                    candidates.push((usize::MAX, uses));
                }
                continue;
            }
            let Some(base) = file.parent() else { continue };
            let depth = uses
                .dirs
                .iter()
                .map(|dir| lexical(&base.join(dir)))
                .filter(|dir| path.starts_with(dir))
                .map(|dir| dir.components().count())
                .max();
            if let Some(depth) = depth {
                candidates.push((depth, uses));
            }
        }
        candidates.sort_by_key(|(depth, _)| std::cmp::Reverse(*depth));
        let is_class = |fqn: &&String| {
            self.class_model(fqn).is_some_and(|model| model.class.kind == crate::summary::ClassKind::Class)
        };
        candidates
            .iter()
            .find_map(|(_, uses)| uses.classes.iter().find(is_class).cloned())
            .or_else(|| self.class_model(PHPUNIT_TEST_CASE).map(|model| model.fqn().to_owned()))
    }

    /// The user model of each guard of the Laravel project, cached for the
    /// modification counter.
    pub fn user_models(&self) -> Arc<UserModels> {
        if let Some(models) = self.cache.user_models(self.generation) {
            return models;
        }
        let models = Arc::new(self.decls.user_models());
        self.cache.insert_user_models(self.generation, models.clone());
        models
    }

    /// The project's Symfony configuration, `#[Route]` names and
    /// repository entities, cached for the modification counter.
    pub fn symfony(&self) -> Arc<SymfonyProject> {
        if let Some(project) = self.cache.symfony(self.generation) {
            return project;
        }
        let project = Arc::new(self.decls.symfony());
        self.cache.insert_symfony(self.generation, project.clone());
        project
    }

    /// The type a lazy type stands for, `self`/`parent` (and `static`/
    /// `$this` when the context knows them) bound by `context`.
    pub fn resolve(&self, lazy: &LazyType, context: &Context) -> Type {
        let ty = self.lazy(lazy, context, 0);
        self.finish(&ty, context)
    }

    /// What calling function `fqn` returns; `None` when it doesn't exist.
    /// Its templates take their fallbacks.
    pub fn function_return(&self, fqn: &str) -> Option<Type> {
        let ty = self.function_at(fqn, 0)?;
        Some(self.finish(&self.function_generics(fqn, ty, None), &Context::default()))
    }

    /// What calling function `fqn` with `args` returns, its templates
    /// inferred from the arguments; `None` when it doesn't exist.
    pub fn function_call(&self, fqn: &str, args: Args<'_>) -> Option<Type> {
        let ty = self.function_at(fqn, 0)?;
        if let Some(ty) = element_call(fqn, args) {
            return Some(ty);
        }
        Some(self.finish(&self.function_generics(fqn, ty, Some(args)), &Context::default()))
    }

    /// The type of global constant `fqn`; `None` when it doesn't exist.
    pub fn constant_type(&self, fqn: &str) -> Option<Type> {
        self.constant_at(fqn, 0)
    }

    /// What `$receiver->name()` returns (per member of a union receiver).
    pub fn method_return(&self, receiver: &Type, name: &str, context: &Context) -> Type {
        let ty = self.on_members(receiver, context, &mut |receiver| self.method_at(receiver, name, None, 0));
        self.finish(&ty, context)
    }

    /// What `$receiver->name(…args)` returns, the method's templates
    /// inferred from the arguments.
    pub fn method_call(&self, receiver: &Type, name: &str, args: Args<'_>, context: &Context) -> Type {
        let ty = self.on_members(receiver, context, &mut |receiver| self.method_at(receiver, name, Some(args), 0));
        self.finish(&ty, context)
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

    /// The method's own `@template`s on a call of `name` on `receiver`:
    /// inferred from `args`, else their fallbacks (the default, the `of`
    /// bound, else `mixed`).
    pub fn method_call_bindings(&self, receiver: &Type, name: &str, args: Args<'_>, context: &Context) -> Bindings {
        let mut found = None;
        self.on_members(receiver, context, &mut |receiver| {
            if found.is_none() {
                let model = self.class_model(receiver.class)?;
                let method = model.method(name)?;
                let own = self.method_templates(method);
                let mut bindings = self.receiver_bindings(receiver, &method.declaring);
                if !own.is_empty() {
                    let params = self.method_params(method, &bindings);
                    self.bind_call(&own, &params, Some(args), &mut bindings);
                }
                bindings.retain(|template, _| own.iter().any(|param| param.name == *template));
                found = Some(bindings);
            }
            None
        });
        found.unwrap_or_default()
    }

    /// Function `fqn`'s own `@template`s on a call: inferred from `args`,
    /// else their fallbacks.
    pub fn function_call_bindings(&self, fqn: &str, args: Args<'_>) -> Bindings {
        let Some(function) = self.decls.function(fqn) else { return Bindings::new() };
        let doc = function.doc.as_deref();
        let scope: Vec<&str> = doc.iter().flat_map(|doc| doc.local_type_names()).collect();
        let own = template_params(doc, &scope);
        let params = generics::declared_params(&function.params, doc, &scope);
        let mut bindings = Bindings::new();
        self.bind_call(&own, &params, Some(args), &mut bindings);
        bindings
    }

    /// The type of `$receiver->name` / `Receiver::$name` (name without `$`).
    pub fn property_type(&self, receiver: &Type, name: &str, context: &Context) -> Type {
        let ty = self.property_on(receiver, name, context, 0);
        self.finish(&ty, context)
    }

    /// The type of `Class::NAME`: the constant's value, or the enum of a
    /// case.
    pub fn class_constant_type(&self, class: &Type, name: &str, context: &Context) -> Type {
        let ty = self.on_members(class, context, &mut |receiver| self.class_constant_at(receiver, name, 0));
        self.finish(&ty, context)
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
            if let Some(at) = building.iter().position(|known| *known == key) {
                // A cycle in the hierarchy: this path contributes nothing.
                self.model_cycle.set(self.model_cycle.get().min(at));
                return None;
            }
            if building.len() >= MAX_MODEL_DEPTH {
                return None;
            }
        }
        let Some(class) = self.decls.class_like(fqn) else {
            self.cache.insert_model(self.generation, key, None);
            return None;
        };
        let depth = self.building.borrow().len();
        let outer_cycle = self.model_cycle.replace(usize::MAX);
        self.building.borrow_mut().push(key.clone());
        let mut built = model::build(class, &mut |name| self.class_model(name));
        let macros = self.macros_of(&built);
        model::add_macros(&mut built, macros);
        let built = Some(Arc::new(built));
        self.building.borrow_mut().pop();
        let cycle = self.model_cycle.get();
        self.model_cycle.set(outer_cycle.min(cycle));
        // A cycle back to a class still being built below this one left out
        // that class's members (two classes that `@mixin` each other, as
        // Pest's expectations do): only that class's model is complete, so
        // this one is built again when asked for on its own.
        if cycle >= depth {
            self.cache.insert_model(self.generation, key, built.clone());
        }
        built
    }

    /// The Laravel macros registered on the class of `model` (one using
    /// `Macroable`), or on one of Laravel's facades standing for it
    /// ([`FACADE_ROOTS`]), as methods.
    fn macros_of(&self, model: &ClassModel) -> Vec<crate::summary::Method> {
        let extendable = model.method("macro").is_some()
            || (fqn_eq(NameKind::ClassLike, model.fqn(), PEST_EXPECTATION) && model.method("extend").is_some());
        if model.class.kind != crate::summary::ClassKind::Class || !extendable {
            return Vec::new();
        }
        let named = |class: &str| fqn_eq(NameKind::ClassLike, class, model.fqn());
        let macros = self.macros();
        macros
            .iter()
            .filter(|found| {
                named(&found.class)
                    || FACADE_ROOTS
                        .iter()
                        .any(|(facade, root)| fqn_eq(NameKind::ClassLike, &found.class, facade) && named(root))
            })
            .map(|found| found.method.clone())
            .collect()
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
                self.property_on(&receiver, name, context, next)
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

    /// Property `name` on each member of `receiver`: a class's, or an object
    /// shape's; `mixed` when none has it. A class type with an object shape
    /// argument (what the Laravel provider gives a model whose query counted
    /// relations: `Post<object{tags_count: int}>`) has the shape's
    /// properties too, after the class's own.
    fn property_on(&self, receiver: &Type, name: &str, context: &Context, depth: usize) -> Type {
        let mut answers = Vec::new();
        for ty in receiver.members() {
            let answer = match ty {
                Type::ObjectShape(fields) => operators::shape_property(fields, name),
                ty => {
                    let own =
                        self.on_member(ty, context, &mut |receiver| self.property_at(receiver, name, context, depth));
                    match (own, ty) {
                        (Some(own), _) if own != Type::Mixed => Some(own),
                        (own, Type::Named { args, .. }) => args
                            .iter()
                            .find_map(|arg| match arg {
                                Type::ObjectShape(fields) => operators::shape_property(fields, name),
                                _ => None,
                            })
                            .or(own),
                        (own, _) => own,
                    }
                }
            };
            answers.extend(answer);
        }
        if answers.is_empty() { Type::Mixed } else { Type::union(answers) }
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
                (Some(ty), hint) => documented(Type::from_doc(ty, &templates), hint.as_ref()),
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
            if let Some(args) = args {
                let params = self.method_params(method, &bindings);
                ty = self.apply_args(&ty, &params, args);
            }
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
        // `static`/`$this` in a member lent by `@mixin Foo<T>` are the mixin
        // with its arguments (the raw type has the bare mixin class).
        if let Start::Args(class, args) = receiver.start
            && let Some(model) = self.class_model(receiver.class)
            && let Some(mixin) = model.method(name).and_then(|method| method.mixin.clone())
            && let Some(this) = self.mixin_this(class, args, &mixin)
        {
            ty = ty.map(&mut |ty| match ty {
                Type::Named { fqn, args } if args.is_empty() && operators::same_class(fqn, &mixin) => {
                    Some(this.clone())
                }
                _ => None,
            });
        }
        // A class whose `__call` forwards to the object its mixin stands
        // for and returns itself instead of that object (Laravel's
        // relations and Eloquent builder): what the lent method returns as
        // that object is the receiver (`$relation->whereNull('x')` is the
        // relation).
        // Only the objects down to the declaring class count (its `$this`
        // is the nearer one once lent): `toBase()`, declared by the
        // Eloquent builder, returns another object, a query builder, as is.
        if let Some(model) = self.class_model(receiver.class)
            && let Some(method) = model.method(name).filter(|method| method.mixin.is_some())
            && let Some(forwarded) = DECORATING.iter().find_map(|(class, forwarded)| {
                (operators::same_class(model.fqn(), class) || model.is_subclass_of(class)).then_some(*forwarded)
            })
            && let Some(depth) = forwarded.iter().position(|class| operators::same_class(&method.declaring.fqn, class))
        {
            let objects = &forwarded[..=depth];
            ty = ty.map(&mut |ty| match ty {
                Type::Named { fqn, .. } if objects.iter().any(|class| operators::same_class(fqn, class)) => {
                    Some(receiver.this.clone())
                }
                Type::Relative(Relative::Static | Relative::This)
                | Type::GenericRelative { relative: Relative::Static | Relative::This, .. } => {
                    Some(receiver.this.clone())
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
                    (Some(ty), hint) => documented(Type::from_doc(ty, &templates), hint.as_ref()),
                    // No `@return`: the overridden method's documented one
                    // (`all(): Collection` implementing `@return Collection<T>`).
                    (None, _) if let Some(inherited) = self.inherited_return(method, name, depth) => {
                        return Some(inherited);
                    }
                    (None, Some(hint)) => {
                        // A bare container: what the body returns, when it
                        // is that container with its element types.
                        let hinted = Type::from_hint(hint);
                        let inferred = declared
                            .inferred_return
                            .as_ref()
                            .filter(|_| is_bare_container(&hinted))
                            .map(|lazy| self.lazy(lazy, &context, depth).widen())
                            .filter(|inferred| self.refines_container(&hinted, inferred));
                        inferred.unwrap_or(hinted)
                    }
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
            let ty = self.expand_aliases(&ty, &method.declaring);
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

    /// The type of property `name` on `receiver`, as code in `scope`'s
    /// class reaches it ([`ClassModel::property_from`]).
    fn property_at(&self, receiver: &Receiver<'_>, name: &str, scope: &Context, depth: usize) -> Option<Type> {
        let name = name.trim_start_matches('$');
        let class = receiver.class;
        let magic = self.magic_wins(class, name, scope);
        let key = if magic {
            Key::MagicProperty(class.to_ascii_lowercase(), name.to_owned())
        } else {
            Key::Property(class.to_ascii_lowercase(), name.to_owned())
        };
        fn pick<'m>(model: &'m ClassModel, name: &str, magic: bool) -> Option<&'m ModelProperty> {
            if magic { model.shadowed_magic.get(name) } else { model.property(name) }
        }
        let mut ty = self.cached(key, || {
            let model = self.class_model(class)?;
            let Some(property) = pick(&model, name, magic) else {
                // Not declared: what a type provider says (Eloquent
                // relation properties).
                let ty = self.providers.magic_property(model.fqn(), name, self)?;
                return Some(self.bind(&ty, &Context::in_class(model.fqn())));
            };
            let context = Context::in_class(&property.self_class);
            let templates = templates(&property.declaring, []);
            let ty = if let Some(declared) = property.declared() {
                // Declared `array` and no more: the elements its class adds.
                let elements = declared.default_type.as_ref().filter(|lazy| super::provider::has_elements(lazy));
                let bare = |ty: Type| match elements {
                    Some(lazy) if ty == Type::array() => self.lazy(lazy, &context, depth).widen(),
                    _ => ty,
                };
                match (declared.doc.as_ref().and_then(|doc| doc.var_type(name)), &declared.type_hint) {
                    (Some(ty), _) => bare(Type::from_doc(ty, &templates)),
                    (None, Some(hint)) => bare(Type::from_hint(hint)),
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
            let ty = self.expand_aliases(&ty, &property.declaring);
            Some(self.bind_member(&ty, &context, property.mixin.as_deref()))
        })?;
        if is_generic(&ty) {
            let model = self.class_model(class)?;
            let property = pick(&model, name, magic)?;
            ty = substitute(&ty, &self.receiver_bindings(receiver, &property.declaring));
        }
        Some(bind_static(&ty, receiver.this))
    }

    /// True when a `@property` tag shadowed by a real property of `class`
    /// applies from `scope`, the real one being inaccessible there.
    fn magic_wins(&self, class: &str, name: &str, scope: &Context) -> bool {
        let Some(model) = self.class_model(class) else { return false };
        if model.shadowed_magic.get(name).is_none() {
            return false;
        }
        let scope = scope.self_class.as_deref().and_then(|fqn| self.class_model(fqn));
        model.property_from(name, scope.as_deref()).is_some_and(|property| property.origin == Origin::Magic)
            && model.property(name).is_some_and(|property| property.origin != Origin::Magic)
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
            let ty = self.expand_aliases(&ty, &constant.declaring);
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
                // `static<int, static>`: the arguments are bound too.
                context.static_type.as_ref().map(|this| {
                    let args: Vec<Type> = args.iter().map(|arg| self.bind(arg, context)).collect();
                    with_args(this, &args)
                })
            }
            Type::Relative(Relative::Parent) => {
                let parent = parent.get_or_insert_with(|| self.parent_of(self_class));
                parent.as_deref().map(Type::named)
            }
            Type::Relative(Relative::Static | Relative::This) => context.static_type.clone(),
            // `self::FLAGS` in an operator.
            Type::ClassConstant { class, name }
                if ["self", "static"].contains(&class.to_ascii_lowercase().as_str()) =>
            {
                Some(Type::ClassConstant { class: self_class.to_owned(), name: name.clone() })
            }
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
/// The functions phpstorm-stubs mark `@meta` because what they return is an
/// element of the array passed first, which PhpStorm reads from the
/// argument; and what they return when there is none.
const ELEMENT_FUNCTIONS: [(&str, bool); 7] = [
    ("reset", false),
    ("end", false),
    ("prev", false),
    ("next", false),
    ("current", false),
    ("array_pop", true),
    ("array_shift", true),
];

/// What a call of one of the [`ELEMENT_FUNCTIONS`] returns: an element of
/// its first argument, or `false` (`null` for `array_pop()`/`array_shift()`);
/// `None` for other functions or an argument whose elements aren't known.
fn element_call(fqn: &str, args: Args<'_>) -> Option<Type> {
    let fqn = fqn.trim_start_matches('\\');
    let (_, null) = ELEMENT_FUNCTIONS.iter().find(|(name, _)| fqn.eq_ignore_ascii_case(name))?;
    let first = args().into_iter().next().filter(|arg| arg.name.is_none() && !arg.spread)?;
    let element = crate::types::expr::iterable_value(&first.ty);
    if element == Type::Mixed || element == Type::Never {
        return None;
    }
    let none = if *null { Type::Null } else { Type::LiteralBool(false) };
    Some(Type::union([element, none]))
}

fn bind_static(ty: &Type, this: &Type) -> Type {
    if matches!(this, Type::Relative(Relative::Static | Relative::This)) {
        return ty.clone();
    }
    ty.map(&mut |ty| match ty {
        Type::Relative(Relative::Static | Relative::This) => Some(this.clone()),
        Type::GenericRelative { relative: Relative::Static | Relative::This, args } => {
            let args: Vec<Type> = args.iter().map(|arg| bind_static(arg, this)).collect();
            Some(with_args(this, &args))
        }
        _ => None,
    })
}

/// A documented type, unless it contradicts the native `hint`: then the
/// hint, which PHP enforces (PHPStan's rule for a PHPDoc type that isn't a
/// subtype of the native one). Bagisto's `getAverageSales(): ?float` still
/// says `@return array`. Types with template parameters or `static` are
/// kept as documented, and any two classes count as related, so only plain
/// contradictions (an array documented on a float) fall back.
fn documented(doc: Type, hint: Option<&TypeHint>) -> Type {
    struct AnyClass;
    impl Hierarchy for AnyClass {
        fn is_subclass(&self, _: &str, _: &str) -> bool {
            true
        }
    }
    let Some(hint) = hint else { return doc };
    let mut generic = false;
    doc.map(&mut |ty| {
        generic |= matches!(ty, Type::Template(_) | Type::Relative(_) | Type::GenericRelative { .. });
        None
    });
    let native = Type::from_hint(hint);
    if generic || doc.is_subtype_of(&native, &AnyClass) { doc } else { native }
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

/// Classes whose `__call` forwards a call to the object their `@mixin`
/// stands for and returns themselves when it returns that object, with the
/// classes that object is (through its own mixins): Laravel's
/// `Relation::forwardDecoratedCallTo()` and Eloquent's `Builder::__call()`.
const DECORATING: &[(&str, &[&str])] = &[
    (
        "Illuminate\\Database\\Eloquent\\Relations\\Relation",
        &["Illuminate\\Database\\Eloquent\\Builder", "Illuminate\\Database\\Query\\Builder"],
    ),
    ("Illuminate\\Database\\Eloquent\\Builder", &["Illuminate\\Database\\Query\\Builder"]),
];

/// Laravel's facades whose service is a `Macroable` class, with that
/// class: a macro registered through the facade (`Request::macro(…)`) is
/// one of the class. Read from a table, not from `getFacadeAccessor()`:
/// class models need the macros, and resolving a facade's service needs
/// the container bindings of the whole project.
const FACADE_ROOTS: &[(&str, &str)] = &[
    ("Illuminate\\Support\\Facades\\Cache", "Illuminate\\Cache\\Repository"),
    ("Illuminate\\Support\\Facades\\Config", "Illuminate\\Config\\Repository"),
    ("Illuminate\\Support\\Facades\\File", "Illuminate\\Filesystem\\Filesystem"),
    ("Illuminate\\Support\\Facades\\Http", "Illuminate\\Http\\Client\\Factory"),
    ("Illuminate\\Support\\Facades\\Lang", "Illuminate\\Translation\\Translator"),
    ("Illuminate\\Support\\Facades\\Process", "Illuminate\\Process\\Factory"),
    ("Illuminate\\Support\\Facades\\Redirect", "Illuminate\\Routing\\Redirector"),
    ("Illuminate\\Support\\Facades\\Request", "Illuminate\\Http\\Request"),
    ("Illuminate\\Support\\Facades\\Response", "Illuminate\\Routing\\ResponseFactory"),
    ("Illuminate\\Support\\Facades\\Route", "Illuminate\\Routing\\Router"),
    ("Illuminate\\Support\\Facades\\URL", "Illuminate\\Routing\\UrlGenerator"),
    ("Illuminate\\Support\\Facades\\View", "Illuminate\\View\\Factory"),
    ("Illuminate\\Support\\Facades\\Vite", "Illuminate\\Foundation\\Vite"),
];

/// PHPUnit's test case: what Pest binds test closures to by default.
const PHPUNIT_TEST_CASE: &str = "PHPUnit\\Framework\\TestCase";

/// `array` with nothing about its elements, or a class without generic
/// arguments: a declaration a more precise type of the same container may
/// stand in for.
pub(crate) fn is_bare_container(ty: &Type) -> bool {
    *ty == Type::array() || matches!(ty, Type::Named { args, .. } if args.is_empty())
}

/// How many classes using a trait type its `$this`.
const MAX_TRAIT_HOSTS: usize = 3;

/// Pest's expectation class, which `expect()->extend()` adds methods to.
pub(crate) const PEST_EXPECTATION: &str = "Pest\\Expectation";

/// `path` with its `.` and `..` segments applied, without touching the disk.
fn lexical(path: &std::path::Path) -> std::path::PathBuf {
    let mut out = std::path::PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}
