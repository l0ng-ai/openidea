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
//! Members are found by walking the class, the traits it uses, its parents
//! and its interfaces, with real members before `@method`/`@property` ones.
//! Trait conflict rules, visibility and generics are not applied here (the
//! class model and generics phases do that).

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use parking_lot::Mutex;

use super::{LazyType, Relative, Type};
use crate::names::{NameKind, fqn_eq};
use crate::summary::{ClassLike, ConstantDecl, FileSummary, FunctionDecl};

/// How many lazy steps one resolve follows before giving up with `mixed`.
pub const MAX_DEPTH: usize = 32;

/// Classes visited at most when looking a member up through a hierarchy.
const MAX_CLASSES: usize = 64;

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
        let mut state = self.state.lock();
        if state.generation != generation {
            state.entries.clear();
            state.generation = generation;
        }
        state.entries.insert(key, value);
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
}

/// A member found in a hierarchy: the class `self` means for it (the class
/// using a trait for a trait's member), the declaring class-like, and what
/// the lookup picked.
struct Found<T> {
    self_class: String,
    declaring: ClassLike,
    item: T,
}

impl<'a> Resolver<'a> {
    /// A resolver over `decls`, caching in `cache` for modification counter
    /// value `generation`.
    pub fn new(decls: &'a dyn Declarations, cache: &'a TypeCache, generation: u64) -> Self {
        Self { decls, cache, generation, stack: RefCell::new(Vec::new()), cuts: RefCell::new(Vec::new()) }
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
            if let Some(found) = self.find(class, &mut |c: &ClassLike| c.method(name).cloned()) {
                let method = &found.item;
                let doc = method.doc.as_deref();
                let templates = templates(&found.declaring, doc.into_iter().flat_map(|doc| doc.local_type_names()));
                let ty = match (doc.and_then(|doc| doc.return_type.as_ref()), &method.return_type) {
                    (Some(ty), _) => Type::from_doc(ty, &templates),
                    (None, Some(hint)) => Type::from_hint(hint),
                    (None, None) => match &method.inferred_return {
                        Some(lazy) => self.lazy(lazy, &Context::in_class(&found.self_class), depth).widen(),
                        None => Type::Mixed,
                    },
                };
                return Some(self.bind(&ty, &Context::in_class(&found.self_class)));
            }
            let found = self.find(class, &mut |c: &ClassLike| {
                c.doc.as_ref()?.methods.iter().find(|method| method.name.eq_ignore_ascii_case(name)).cloned()
            })?;
            let templates = templates(&found.declaring, found.item.templates.iter().map(|t| t.name.as_str()));
            let ty = found.item.return_type.as_ref().map_or(Type::Mixed, |ty| Type::from_doc(ty, &templates));
            Some(self.bind(&ty, &Context::in_class(&found.self_class)))
        })?;
        Some(bind_static(&ty, this))
    }

    fn property_at(&self, class: &str, name: &str, this: &Type, depth: usize) -> Option<Type> {
        let name = name.trim_start_matches('$');
        let key = Key::Property(class.to_ascii_lowercase(), name.to_owned());
        let ty = self.cached(key, || {
            if let Some(found) = self.find(class, &mut |c: &ClassLike| c.property(name).cloned()) {
                let property = &found.item;
                let templates = templates(&found.declaring, []);
                let ty = match (property.doc.as_ref().and_then(|doc| doc.var_type(name)), &property.type_hint) {
                    (Some(ty), _) => Type::from_doc(ty, &templates),
                    (None, Some(hint)) => Type::from_hint(hint),
                    (None, None) => match &property.default_type {
                        Some(lazy) => self.lazy(lazy, &Context::in_class(&found.self_class), depth).widen(),
                        None => Type::Mixed,
                    },
                };
                return Some(self.bind(&ty, &Context::in_class(&found.self_class)));
            }
            let found = self.find(class, &mut |c: &ClassLike| {
                c.doc.as_ref()?.properties.iter().find(|property| property.name == name).cloned()
            })?;
            let templates = templates(&found.declaring, []);
            let ty = found.item.ty.as_ref().map_or(Type::Mixed, |ty| Type::from_doc(ty, &templates));
            Some(self.bind(&ty, &Context::in_class(&found.self_class)))
        })?;
        Some(bind_static(&ty, this))
    }

    fn class_constant_at(&self, class: &str, name: &str, this: &Type, depth: usize) -> Option<Type> {
        let key = Key::ClassConstant(class.to_ascii_lowercase(), name.to_owned());
        let ty = self.cached(key, || {
            if let Some(found) =
                self.find(class, &mut |c: &ClassLike| c.cases.iter().any(|case| case.name == name).then_some(()))
            {
                return Some(Type::named(&found.declaring.fqn));
            }
            let found = self.find(class, &mut |c: &ClassLike| c.constant(name).cloned())?;
            let constant = &found.item;
            let templates = templates(&found.declaring, []);
            let ty = match (constant.doc.as_ref().and_then(|doc| doc.var_type(name)), &constant.type_hint) {
                (Some(ty), _) => Type::from_doc(ty, &templates),
                (None, Some(hint)) => Type::from_hint(hint),
                (None, None) => match &constant.value_type {
                    Some(lazy) => self.lazy(lazy, &Context::in_class(&found.self_class), depth),
                    None => Type::Mixed,
                },
            };
            Some(self.bind(&ty, &Context::in_class(&found.self_class)))
        })?;
        Some(bind_static(&ty, this))
    }

    // ------------------------------------------------------------ hierarchy

    /// Looks a member up on `class`, then the traits it uses, its parents and
    /// its interfaces, depth first.
    fn find<T>(&self, class: &str, pick: &mut dyn FnMut(&ClassLike) -> Option<T>) -> Option<Found<T>> {
        let mut visited = HashSet::new();
        self.find_in(class, None, &mut visited, pick)
    }

    fn find_in<T>(
        &self,
        fqn: &str,
        using: Option<&str>,
        visited: &mut HashSet<String>,
        pick: &mut dyn FnMut(&ClassLike) -> Option<T>,
    ) -> Option<Found<T>> {
        if visited.len() >= MAX_CLASSES || !visited.insert(fqn.trim_start_matches('\\').to_ascii_lowercase()) {
            return None;
        }
        let class = self.decls.class_like(fqn)?;
        let self_class = using.unwrap_or(&class.fqn).to_owned();
        if let Some(item) = pick(&class) {
            return Some(Found { self_class, declaring: class, item });
        }
        for name in class.trait_uses.iter().flat_map(|trait_use| &trait_use.traits) {
            if let Some(found) = self.find_in(name, Some(&self_class), visited, pick) {
                return Some(found);
            }
        }
        for name in class.extends.iter().chain(&class.implements) {
            if let Some(found) = self.find_in(name, None, visited, pick) {
                return Some(found);
            }
        }
        None
    }

    fn parent_of(&self, class: &str) -> Option<String> {
        self.decls.class_like(class)?.extends.into_iter().next()
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
