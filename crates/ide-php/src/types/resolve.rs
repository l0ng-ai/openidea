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
//! interfaces, then `@method`/`@property`, then `@mixin` classes. Generics
//! are not bound here (phase 2.6).

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;

use super::model::{self, ClassModel, EnumMethod, EnumProperty, MethodSource, PropertySource};
use super::{Hierarchy, LazyType, Relative, Type};
use crate::names::{NameKind, fqn_eq};
use crate::summary::{ClassLike, ConstantDecl, FileSummary, FunctionDecl, TypeHint};

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
            stack: RefCell::new(Vec::new()),
            cuts: RefCell::new(Vec::new()),
            building: RefCell::new(Vec::new()),
        }
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
    pub fn function_return(&self, fqn: &str) -> Option<Type> {
        self.function_at(fqn, 0)
    }

    /// The type of global constant `fqn`; `None` when it doesn't exist.
    pub fn constant_type(&self, fqn: &str) -> Option<Type> {
        self.constant_at(fqn, 0)
    }

    /// What `$receiver->name()` returns (per member of a union receiver).
    pub fn method_return(&self, receiver: &Type, name: &str, context: &Context) -> Type {
        let ty = self.on_members(receiver, context, &mut |class, this| self.method_at(class, name, this, 0));
        self.bind(&ty, context)
    }

    /// The type of `$receiver->name` / `Receiver::$name` (name without `$`).
    pub fn property_type(&self, receiver: &Type, name: &str, context: &Context) -> Type {
        let ty = self.on_members(receiver, context, &mut |class, this| self.property_at(class, name, this, 0));
        self.bind(&ty, context)
    }

    /// The type of `Class::NAME`: the constant's value, or the enum of a
    /// case.
    pub fn class_constant_type(&self, class: &Type, name: &str, context: &Context) -> Type {
        let ty = self.on_members(class, context, &mut |class, this| self.class_constant_at(class, name, this, 0));
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
            Type::Relative(Relative::Self_) => push(context.self_class.as_deref()),
            Type::Relative(Relative::Parent) => {
                push(context.self_class.as_deref().and_then(|class| self.parent_of(class)).as_deref())
            }
            Type::Relative(Relative::Static | Relative::This) => match &context.static_type {
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
            LazyType::FunctionReturn { fqn, fallback } => self
                .function_at(fqn, next)
                .or_else(|| fallback.as_deref().and_then(|global| self.function_at(global, next)))
                .unwrap_or(Type::Mixed),
            LazyType::Constant { fqn, fallback } => self
                .constant_at(fqn, next)
                .or_else(|| fallback.as_deref().and_then(|global| self.constant_at(global, next)))
                .unwrap_or(Type::Mixed),
            LazyType::MethodReturn { receiver, name } => {
                let receiver = self.lazy(receiver, context, next);
                self.on_members(&receiver, context, &mut |class, this| self.method_at(class, name, this, next))
            }
            LazyType::Property { receiver, name } => {
                let receiver = self.lazy(receiver, context, next);
                self.on_members(&receiver, context, &mut |class, this| self.property_at(class, name, this, next))
            }
            LazyType::ClassConstant { class, name } => {
                let class = self.lazy(class, context, next);
                self.on_members(&class, context, &mut |class, this| self.class_constant_at(class, name, this, next))
            }
            LazyType::Union(members) => Type::union(members.iter().map(|member| self.lazy(member, context, next))),
        }
    }

    /// Asks `member` for each class among the members of `receiver`
    /// (`member(class, what static/$this is)`), joining the answers; `mixed`
    /// when none answers.
    fn on_members(
        &self,
        receiver: &Type,
        context: &Context,
        member: &mut dyn FnMut(&str, &Type) -> Option<Type>,
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
        member: &mut dyn FnMut(&str, &Type) -> Option<Type>,
    ) -> Option<Type> {
        // What `static` means when the receiver is `self`/`parent`: the
        // caller's late static binding.
        let late = || context.static_type.clone().unwrap_or(Type::Relative(Relative::Static));
        match ty {
            Type::Named { fqn, .. } => member(fqn, ty),
            Type::Closure(_) => member("Closure", &Type::named("Closure")),
            Type::Relative(Relative::Self_) => member(context.self_class.as_deref()?, &late()),
            Type::Relative(Relative::Parent) => {
                let parent = self.parent_of(context.self_class.as_deref()?)?;
                member(&parent, &late())
            }
            Type::Relative(relative @ (Relative::Static | Relative::This)) => match &context.static_type {
                Some(static_type) => {
                    let answer = self.on_members(static_type, &Context::default(), member);
                    (answer != Type::Mixed).then_some(answer)
                }
                None => member(context.self_class.as_deref()?, &Type::Relative(*relative)),
            },
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

    /// A method's return type on `class`, with `static`/`$this` bound to
    /// `this`.
    fn method_at(&self, class: &str, name: &str, this: &Type, depth: usize) -> Option<Type> {
        let key = Key::Method(class.to_ascii_lowercase(), name.to_ascii_lowercase());
        let ty = self.cached(key, || {
            let model = self.class_model(class)?;
            let method = model.method(name)?;
            let context = Context::in_class(&method.self_class);
            let ty = if let Some(declared) = method.declared() {
                let doc = declared.doc.as_deref();
                let templates = templates(&method.declaring, doc.into_iter().flat_map(|doc| doc.local_type_names()));
                match (doc.and_then(|doc| doc.return_type.as_ref()), &declared.return_type) {
                    (Some(ty), _) => Type::from_doc(ty, &templates),
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
        })?;
        Some(bind_static(&ty, this))
    }

    fn property_at(&self, class: &str, name: &str, this: &Type, depth: usize) -> Option<Type> {
        let name = name.trim_start_matches('$');
        let key = Key::Property(class.to_ascii_lowercase(), name.to_owned());
        let ty = self.cached(key, || {
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
        Some(bind_static(&ty, this))
    }

    fn class_constant_at(&self, class: &str, name: &str, this: &Type, depth: usize) -> Option<Type> {
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
        Some(bind_static(&ty, this))
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
}

/// `static` and `$this` replaced by the receiver (left alone when the
/// receiver is itself one of them).
fn bind_static(ty: &Type, this: &Type) -> Type {
    if matches!(this, Type::Relative(Relative::Static | Relative::This)) {
        return ty.clone();
    }
    ty.map(&mut |ty| match ty {
        Type::Relative(Relative::Static | Relative::This) => Some(this.clone()),
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
