//! The class model: every member a class-like has, its own and the ones it
//! gets from its parents, interfaces and traits, combined by PHP's rules.
//!
//! [`Resolver::class_model`](super::Resolver::class_model) builds a
//! [`ClassModel`] from the class-like's summary and the models of the
//! class-likes it names (built the same way, cached per modification
//! counter in the [`TypeCache`](super::TypeCache)). The steps, in order of
//! precedence (a name already present is not replaced, except where noted):
//!
//! 1. **Own members:** methods, properties, constants and enum cases.
//! 2. **Traits:** the members of each used trait (traits using traits
//!    included) are copied into the class: `self` in them is the class, and
//!    their own `private` members stay accessible. `A::m insteadof B` drops
//!    `B::m`; `[A::]m as [visibility] alias` adds a copy named `alias`
//!    (aliases apply to excluded methods too), and without an alias changes
//!    the visibility of `m` itself. Two traits giving the same unresolved
//!    name: the first concrete one wins (PHP refuses the class). An abstract
//!    trait method gives way to a concrete one, from a later trait or from
//!    the parent.
//! 3. **Enum built-ins:** `cases()`, and `from()`/`tryFrom()` for a backed
//!    enum, as static methods, and the `name` (and `value`) readonly
//!    properties. Enums also implement `UnitEnum` (and `BackedEnum`).
//! 4. **Parent class:** its members except the `private` ones; a member
//!    redeclared here records what it [overrides](ModelMethod::overrides).
//! 5. **Interfaces** (all of them, an interface reached twice through a
//!    diamond counted once): methods and constants not yet present. An
//!    interface's parents are its `extends`.
//! 6. **Magic members:** `@method` and `@property` of the class, its traits,
//!    its parents and its interfaces, for names no real member has.
//! 7. **`@mixin`:** the public members of each mixin class (and of the
//!    parents' mixins), for names nothing else has. In them `static` and
//!    `$this` are the mixin, not the receiver.
//!
//! [`ClassModel::is_accessible`] applies PHP's visibility rules for a
//! calling scope. A cycle in the hierarchy (`class A extends B`, `class B
//! extends A`) is cut where it closes, the class meeting itself again
//! contributing nothing.
//!
//! The rules are PHP's own (the language reference on traits, visibility,
//! object inheritance and enumerations); `@mixin` follows the public
//! PHPStan and Psalm documentation.

use std::collections::HashMap;
use std::sync::Arc;

use super::Type;
use crate::names::{NameKind, fqn_eq};
use crate::summary::{
    ClassConstant, ClassKind, ClassLike, DocMethod, DocProperty, EnumCase, Method, Property, PropertyAccess, TraitRule,
    Visibility,
};

/// Where a member of a model comes from, seen from the class that has it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Origin {
    /// Declared in a class-like body (this class's or an ancestor's).
    Declared,
    /// Copied from a trait (the declaring class-like is the trait).
    Trait,
    /// `@method` / `@property`.
    Magic,
    /// From a `@mixin` class.
    Mixin,
    /// Provided by PHP itself (enum `cases()`, `from()`, `tryFrom()`,
    /// `name`, `value`).
    Builtin,
}

/// An enum method PHP provides.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum EnumMethod {
    /// `static cases(): list<static>`.
    Cases,
    /// `static from(int|string $value): static`.
    From,
    /// `static tryFrom(int|string $value): ?static`.
    TryFrom,
}

/// An enum property PHP provides.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum EnumProperty {
    /// `readonly string $name`.
    Name,
    /// `readonly int|string $value` of a backed enum.
    Value,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MethodSource {
    /// Index into the declaring class-like's `methods`.
    Declared(usize),
    /// Index into the declaring class-like's docblock `methods`.
    Magic(usize),
    Enum(EnumMethod),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PropertySource {
    /// Index into the declaring class-like's `properties`.
    Declared(usize),
    /// Index into the declaring class-like's docblock `properties`.
    Magic(usize),
    Enum(EnumProperty),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ConstantSource {
    /// Index into the declaring class-like's `constants`.
    Constant(usize),
    /// Index into the declaring class-like's `cases`.
    Case(usize),
}

/// What all members have in common.
#[derive(Clone, Debug)]
pub struct MemberInfo {
    /// The name the member has on this class (a trait alias for an aliased
    /// method).
    pub name: String,
    /// The class-like whose summary holds the declaration (the trait for a
    /// trait member, the interface for an interface method).
    pub declaring: Arc<ClassLike>,
    /// The class `self` means in the member, and the class private and
    /// protected access is checked against: the class using a trait for a
    /// trait member, otherwise the declaring class-like.
    pub self_class: String,
    pub visibility: Visibility,
    pub is_static: bool,
    pub origin: Origin,
    /// The member of a parent class or interface this one overrides or
    /// implements, by its `self_class`.
    pub overrides: Option<String>,
    /// The `@mixin` class a [`Origin::Mixin`] member comes from: what
    /// `static` and `$this` mean in it.
    pub mixin: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ModelMethod {
    pub info: MemberInfo,
    pub is_abstract: bool,
    pub is_final: bool,
    pub source: MethodSource,
}

#[derive(Clone, Debug)]
pub struct ModelProperty {
    pub info: MemberInfo,
    pub is_readonly: bool,
    pub source: PropertySource,
}

#[derive(Clone, Debug)]
pub struct ModelConstant {
    pub info: MemberInfo,
    pub source: ConstantSource,
}

impl std::ops::Deref for ModelMethod {
    type Target = MemberInfo;
    fn deref(&self) -> &MemberInfo {
        &self.info
    }
}

impl std::ops::Deref for ModelProperty {
    type Target = MemberInfo;
    fn deref(&self) -> &MemberInfo {
        &self.info
    }
}

impl std::ops::Deref for ModelConstant {
    type Target = MemberInfo;
    fn deref(&self) -> &MemberInfo {
        &self.info
    }
}

impl ModelMethod {
    /// The declaration, for a method declared in a class-like body.
    pub fn declared(&self) -> Option<&Method> {
        match self.source {
            MethodSource::Declared(i) => self.declaring.methods.get(i),
            _ => None,
        }
    }

    /// The `@method` tag, for a magic method.
    pub fn magic(&self) -> Option<&DocMethod> {
        match self.source {
            MethodSource::Magic(i) => self.declaring.doc.as_ref()?.methods.get(i),
            _ => None,
        }
    }
}

impl ModelProperty {
    /// The declaration, for a property declared in a class-like body.
    pub fn declared(&self) -> Option<&Property> {
        match self.source {
            PropertySource::Declared(i) => self.declaring.properties.get(i),
            _ => None,
        }
    }

    /// The `@property` tag, for a magic property.
    pub fn magic(&self) -> Option<&DocProperty> {
        match self.source {
            PropertySource::Magic(i) => self.declaring.doc.as_ref()?.properties.get(i),
            _ => None,
        }
    }
}

impl ModelConstant {
    /// The declaration, for a class constant.
    pub fn declared(&self) -> Option<&ClassConstant> {
        match self.source {
            ConstantSource::Constant(i) => self.declaring.constants.get(i),
            ConstantSource::Case(_) => None,
        }
    }

    /// The case, for an enum case.
    pub fn case(&self) -> Option<&EnumCase> {
        match self.source {
            ConstantSource::Case(i) => self.declaring.cases.get(i),
            ConstantSource::Constant(_) => None,
        }
    }
}

/// Members by name, in the order they were added.
#[derive(Clone, Debug)]
pub struct Members<T> {
    items: Vec<T>,
    by_name: HashMap<String, usize>,
    /// Method names compare case-insensitively.
    fold_case: bool,
}

impl<T: std::ops::Deref<Target = MemberInfo>> Members<T> {
    fn new(fold_case: bool) -> Self {
        Self { items: Vec::new(), by_name: HashMap::new(), fold_case }
    }

    fn key(&self, name: &str) -> String {
        if self.fold_case { name.to_ascii_lowercase() } else { name.to_owned() }
    }

    pub fn get(&self, name: &str) -> Option<&T> {
        self.by_name.get(&self.key(name.trim_start_matches('$'))).map(|&i| &self.items[i])
    }

    fn get_mut(&mut self, name: &str) -> Option<&mut T> {
        let i = *self.by_name.get(&self.key(name))?;
        Some(&mut self.items[i])
    }

    pub fn contains(&self, name: &str) -> bool {
        self.get(name).is_some()
    }

    pub fn iter(&self) -> std::slice::Iter<'_, T> {
        self.items.iter()
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// Adds `item` unless its name is taken; true when added.
    fn add(&mut self, item: T) -> bool {
        let key = self.key(&item.name);
        if self.by_name.contains_key(&key) {
            return false;
        }
        self.by_name.insert(key, self.items.len());
        self.items.push(item);
        true
    }

    fn replace(&mut self, item: T) {
        let key = self.key(&item.name);
        match self.by_name.get(&key) {
            Some(&i) => self.items[i] = item,
            None => {
                self.by_name.insert(key, self.items.len());
                self.items.push(item);
            }
        }
    }
}

/// A class-like with all its members.
#[derive(Clone, Debug)]
pub struct ClassModel {
    pub class: Arc<ClassLike>,
    /// Parent classes, nearest first.
    pub parents: Vec<String>,
    /// Every interface implemented (or extended, for an interface),
    /// directly or not, once each.
    pub interfaces: Vec<String>,
    /// Every trait used, directly, by a used trait or by a parent.
    pub traits: Vec<String>,
    /// `@mixin` classes, the parents' included.
    pub mixins: Vec<String>,
    pub methods: Members<ModelMethod>,
    /// By name without `$`.
    pub properties: Members<ModelProperty>,
    /// Class constants and enum cases.
    pub constants: Members<ModelConstant>,
}

impl ClassModel {
    pub fn fqn(&self) -> &str {
        &self.class.fqn
    }

    pub fn kind(&self) -> ClassKind {
        self.class.kind
    }

    /// The method with this name (case-insensitive).
    pub fn method(&self, name: &str) -> Option<&ModelMethod> {
        self.methods.get(name)
    }

    /// The property with this name (with or without `$`).
    pub fn property(&self, name: &str) -> Option<&ModelProperty> {
        self.properties.get(name)
    }

    /// The class constant or enum case with this name.
    pub fn constant(&self, name: &str) -> Option<&ModelConstant> {
        self.constants.get(name)
    }

    /// True when this class-like is `fqn` or extends or implements it,
    /// directly or not (traits don't count: they aren't types).
    pub fn is_subclass_of(&self, fqn: &str) -> bool {
        let fqn = fqn.trim_start_matches('\\');
        let same = |name: &String| fqn_eq(NameKind::ClassLike, name, fqn);
        fqn_eq(NameKind::ClassLike, &self.class.fqn, fqn)
            || self.parents.iter().any(same)
            || self.interfaces.iter().any(same)
    }

    /// True when code in class `scope` (`None` outside any class) may use
    /// a member with this visibility and `self_class` on an object of this
    /// class: public always, private only inside `self_class`, protected
    /// inside a class related to `self_class` by inheritance.
    pub fn is_accessible(&self, member: &MemberInfo, scope: Option<&ClassModel>) -> bool {
        match member.visibility {
            Visibility::Public => true,
            Visibility::Private => {
                scope.is_some_and(|scope| fqn_eq(NameKind::ClassLike, scope.fqn(), &member.self_class))
            }
            Visibility::Protected => scope.is_some_and(|scope| {
                scope.is_subclass_of(&member.self_class)
                    || (self.is_subclass_of(scope.fqn()) && self.is_subclass_of(&member.self_class))
            }),
        }
    }

    /// The methods code in `scope` may call.
    pub fn accessible_methods<'m>(&'m self, scope: Option<&'m ClassModel>) -> impl Iterator<Item = &'m ModelMethod> {
        self.methods.iter().filter(move |method| self.is_accessible(method, scope))
    }

    /// The properties code in `scope` may use.
    pub fn accessible_properties<'m>(
        &'m self,
        scope: Option<&'m ClassModel>,
    ) -> impl Iterator<Item = &'m ModelProperty> {
        self.properties.iter().filter(move |property| self.is_accessible(property, scope))
    }
}

/// Builds the model of `class`, getting the models of the class-likes it
/// names from `model` (which returns `None` for unknown ones and for those
/// whose model is being built, cutting cycles).
pub(super) fn build(class: ClassLike, model: &mut dyn FnMut(&str) -> Option<Arc<ClassModel>>) -> ClassModel {
    let class = Arc::new(class);
    let me = class.fqn.clone();
    let mut b = Builder {
        model: ClassModel {
            class: class.clone(),
            parents: Vec::new(),
            interfaces: Vec::new(),
            traits: Vec::new(),
            mixins: Vec::new(),
            methods: Members::new(true),
            properties: Members::new(false),
            constants: Members::new(false),
        },
        magic_methods: Vec::new(),
        magic_properties: Vec::new(),
    };

    // 1. Own members.
    let own = |name: &str, visibility, is_static| MemberInfo {
        name: name.to_owned(),
        declaring: class.clone(),
        self_class: me.clone(),
        visibility,
        is_static,
        origin: Origin::Declared,
        overrides: None,
        mixin: None,
    };
    for (i, method) in class.methods.iter().enumerate() {
        b.model.methods.add(ModelMethod {
            info: own(&method.name, method.visibility, method.is_static),
            is_abstract: method.is_abstract,
            is_final: method.is_final,
            source: MethodSource::Declared(i),
        });
    }
    for (i, property) in class.properties.iter().enumerate() {
        b.model.properties.add(ModelProperty {
            info: own(&property.name, property.visibility, property.is_static),
            is_readonly: property.is_readonly,
            source: PropertySource::Declared(i),
        });
    }
    for (i, case) in class.cases.iter().enumerate() {
        b.model
            .constants
            .add(ModelConstant { info: own(&case.name, Visibility::Public, true), source: ConstantSource::Case(i) });
    }
    for (i, constant) in class.constants.iter().enumerate() {
        b.model.constants.add(ModelConstant {
            info: own(&constant.name, constant.visibility, true),
            source: ConstantSource::Constant(i),
        });
    }
    if let Some(doc) = &class.doc {
        for (i, method) in doc.methods.iter().enumerate() {
            b.magic_methods.push(ModelMethod {
                info: MemberInfo { origin: Origin::Magic, ..own(&method.name, Visibility::Public, method.is_static) },
                is_abstract: false,
                is_final: false,
                source: MethodSource::Magic(i),
            });
        }
        for (i, property) in doc.properties.iter().enumerate() {
            b.magic_properties.push(ModelProperty {
                info: MemberInfo { origin: Origin::Magic, ..own(&property.name, Visibility::Public, false) },
                is_readonly: property.access == PropertyAccess::Read,
                source: PropertySource::Magic(i),
            });
        }
    }

    // 2. Traits.
    b.traits(&class, model);

    // 3. Enum built-ins.
    if class.kind == ClassKind::Enum {
        let builtin =
            |name: &str, is_static| MemberInfo { origin: Origin::Builtin, ..own(name, Visibility::Public, is_static) };
        let mut methods = vec![("cases", EnumMethod::Cases)];
        if class.backing_type.is_some() {
            methods.extend([("from", EnumMethod::From), ("tryFrom", EnumMethod::TryFrom)]);
        }
        for (name, kind) in methods {
            b.model.methods.add(ModelMethod {
                info: builtin(name, true),
                is_abstract: false,
                is_final: false,
                source: MethodSource::Enum(kind),
            });
        }
        let mut properties = vec![("name", EnumProperty::Name)];
        if class.backing_type.is_some() {
            properties.push(("value", EnumProperty::Value));
        }
        for (name, kind) in properties {
            b.model.properties.add(ModelProperty {
                info: builtin(name, false),
                is_readonly: true,
                source: PropertySource::Enum(kind),
            });
        }
    }

    // 4. Parent class.
    let mut ancestors = Vec::new();
    if class.kind != ClassKind::Interface
        && let Some(parent) = class.extends.first()
    {
        b.model.parents.push(trim(parent));
        if let Some(parent) = model(parent) {
            b.model.parents.extend(parent.parents.iter().cloned());
            b.add_interfaces(&parent.interfaces);
            b.model.traits.extend(parent.traits.iter().cloned());
            b.inherit(&parent);
            ancestors.push(parent);
        }
    }

    // 5. Interfaces.
    let mut interfaces: Vec<String> =
        if class.kind == ClassKind::Interface { class.extends.clone() } else { class.implements.clone() };
    if class.kind == ClassKind::Enum {
        interfaces.push("UnitEnum".to_owned());
        if class.backing_type.is_some() {
            interfaces.push("BackedEnum".to_owned());
        }
    }
    for name in &interfaces {
        b.add_interfaces(std::slice::from_ref(&trim(name)));
        if let Some(interface) = model(name) {
            b.add_interfaces(&interface.interfaces);
            b.inherit(&interface);
            ancestors.push(interface);
        }
    }

    // 6. Magic members: own and the traits' first, then the ancestors'.
    for method in std::mem::take(&mut b.magic_methods) {
        b.model.methods.add(method);
    }
    for property in std::mem::take(&mut b.magic_properties) {
        b.model.properties.add(property);
    }
    for ancestor in &ancestors {
        for method in ancestor.methods.iter().filter(|m| m.origin == Origin::Magic) {
            b.model.methods.add(method.clone());
        }
        for property in ancestor.properties.iter().filter(|p| p.origin == Origin::Magic) {
            b.model.properties.add(property.clone());
        }
    }

    // 7. Mixins.
    let templates: Vec<&str> = class.doc.iter().flat_map(|doc| doc.local_type_names()).collect();
    let mut mixins: Vec<String> = class
        .doc
        .iter()
        .flat_map(|doc| &doc.mixins)
        .flat_map(|ty| Type::from_doc(ty, &templates).members().to_vec())
        .filter_map(|ty| match ty {
            Type::Named { fqn, .. } => Some(fqn),
            _ => None,
        })
        .collect();
    for ancestor in &ancestors {
        mixins.extend(ancestor.mixins.iter().cloned());
    }
    for fqn in mixins {
        if b.model.mixins.iter().any(|known| fqn_eq(NameKind::ClassLike, known, &fqn))
            || fqn_eq(NameKind::ClassLike, &fqn, &me)
        {
            continue;
        }
        if let Some(mixin) = model(&fqn) {
            for method in mixin.methods.iter().filter(|m| m.visibility == Visibility::Public) {
                b.model.methods.add(ModelMethod {
                    info: MemberInfo {
                        origin: Origin::Mixin,
                        overrides: None,
                        mixin: Some(mixin.fqn().to_owned()),
                        ..method.info.clone()
                    },
                    ..method.clone()
                });
            }
            for property in mixin.properties.iter().filter(|p| p.visibility == Visibility::Public) {
                b.model.properties.add(ModelProperty {
                    info: MemberInfo {
                        origin: Origin::Mixin,
                        overrides: None,
                        mixin: Some(mixin.fqn().to_owned()),
                        ..property.info.clone()
                    },
                    ..property.clone()
                });
            }
        }
        b.model.mixins.push(fqn);
    }

    dedupe(&mut b.model.traits);
    b.model
}

struct Builder {
    model: ClassModel,
    /// Magic members of the class and its traits, added after every real
    /// member of the hierarchy.
    magic_methods: Vec<ModelMethod>,
    magic_properties: Vec<ModelProperty>,
}

impl Builder {
    fn traits(&mut self, class: &Arc<ClassLike>, model: &mut dyn FnMut(&str) -> Option<Arc<ClassModel>>) {
        let me = class.fqn.as_str();
        let rules: Vec<&TraitRule> = class.trait_uses.iter().flat_map(|trait_use| &trait_use.rules).collect();
        let names: Vec<&String> = class.trait_uses.iter().flat_map(|trait_use| &trait_use.traits).collect();
        // Methods from traits, before the class's own ones are consulted.
        let mut imported: Members<ModelMethod> = Members::new(true);
        for name in names {
            self.model.traits.push(trim(name));
            let Some(tr) = model(name) else { continue };
            self.model.traits.extend(tr.traits.iter().cloned());
            let into_class = |info: &MemberInfo| MemberInfo {
                self_class: me.to_owned(),
                origin: if info.origin == Origin::Declared { Origin::Trait } else { info.origin },
                overrides: None,
                ..info.clone()
            };
            for method in tr.methods.iter() {
                if matches!(method.origin, Origin::Mixin) {
                    continue;
                }
                let names_this = |trait_name: &str, method_name: &str| {
                    fqn_eq(NameKind::ClassLike, trait_name, tr.fqn()) && method_name.eq_ignore_ascii_case(&method.name)
                };
                let mut copy = ModelMethod { info: into_class(&method.info), ..method.clone() };
                if copy.origin == Origin::Magic {
                    self.magic_methods.push(copy);
                    continue;
                }
                // Aliases, which apply to excluded methods as well.
                for rule in &rules {
                    if let TraitRule::Alias { trait_name, method: name, visibility, alias } = rule {
                        let matches = match trait_name {
                            Some(trait_name) => names_this(trait_name, name),
                            None => name.eq_ignore_ascii_case(&method.name),
                        };
                        if !matches {
                            continue;
                        }
                        match alias {
                            Some(alias) => {
                                let mut aliased = copy.clone();
                                aliased.info.name = alias.clone();
                                if let Some(visibility) = visibility {
                                    aliased.info.visibility = *visibility;
                                }
                                add_trait_method(&mut imported, aliased);
                            }
                            None => {
                                if let Some(visibility) = visibility {
                                    copy.info.visibility = *visibility;
                                }
                            }
                        }
                    }
                }
                let excluded = rules.iter().any(|rule| match rule {
                    TraitRule::Insteadof { trait_name, method: name, instead_of } => {
                        name.eq_ignore_ascii_case(&method.name)
                            && !fqn_eq(NameKind::ClassLike, trait_name, tr.fqn())
                            && instead_of.iter().any(|other| fqn_eq(NameKind::ClassLike, other, tr.fqn()))
                    }
                    TraitRule::Alias { .. } => false,
                });
                if !excluded {
                    add_trait_method(&mut imported, copy);
                }
            }
            for property in tr.properties.iter() {
                let copy = ModelProperty { info: into_class(&property.info), ..property.clone() };
                match copy.origin {
                    Origin::Magic => self.magic_properties.push(copy),
                    Origin::Mixin => {}
                    _ => {
                        self.model.properties.add(copy);
                    }
                }
            }
            for constant in tr.constants.iter() {
                self.model.constants.add(ModelConstant { info: into_class(&constant.info), ..constant.clone() });
            }
        }
        for method in imported.items {
            // The class's own method (the only ones present yet) wins.
            self.model.methods.add(method);
        }
    }

    /// Takes the members of a parent class or interface that this class
    /// doesn't have (`private` ones are not inherited), recording overrides.
    fn inherit(&mut self, ancestor: &ClassModel) {
        let inherited = |member: &MemberInfo| {
            member.visibility != Visibility::Private && !matches!(member.origin, Origin::Magic | Origin::Mixin)
        };
        for method in ancestor.methods.iter().filter(|m| inherited(m)) {
            match self.model.methods.get_mut(&method.name) {
                None => {
                    self.model.methods.add(method.clone());
                }
                // An abstract trait method is satisfied by an inherited one.
                Some(existing) if existing.origin == Origin::Trait && existing.is_abstract && !method.is_abstract => {
                    let overrides = Some(method.self_class.clone());
                    *existing = ModelMethod { info: MemberInfo { overrides, ..method.info.clone() }, ..method.clone() };
                }
                Some(existing) => {
                    if existing.overrides.is_none() && existing.origin != Origin::Builtin {
                        existing.info.overrides = Some(method.self_class.clone());
                    }
                }
            }
        }
        for property in ancestor.properties.iter().filter(|p| inherited(p)) {
            match self.model.properties.get_mut(&property.name) {
                None => {
                    self.model.properties.add(property.clone());
                }
                Some(existing) => {
                    if existing.overrides.is_none() && existing.origin != Origin::Builtin {
                        existing.info.overrides = Some(property.self_class.clone());
                    }
                }
            }
        }
        for constant in ancestor.constants.iter().filter(|c| inherited(c)) {
            match self.model.constants.get_mut(&constant.name) {
                None => {
                    self.model.constants.add(constant.clone());
                }
                Some(existing) => {
                    if existing.overrides.is_none() {
                        existing.info.overrides = Some(constant.self_class.clone());
                    }
                }
            }
        }
    }

    fn add_interfaces(&mut self, names: &[String]) {
        for name in names {
            if !self.model.interfaces.iter().any(|known| fqn_eq(NameKind::ClassLike, known, name)) {
                self.model.interfaces.push(trim(name));
            }
        }
    }
}

/// Adds a method coming from a trait: a concrete one replaces an abstract
/// one, otherwise the first wins.
fn add_trait_method(imported: &mut Members<ModelMethod>, method: ModelMethod) {
    match imported.get(&method.name) {
        Some(existing) if existing.is_abstract && !method.is_abstract => imported.replace(method),
        Some(_) => {}
        None => {
            imported.add(method);
        }
    }
}

fn trim(name: &str) -> String {
    name.trim_start_matches('\\').to_owned()
}

fn dedupe(names: &mut Vec<String>) {
    let mut seen = Vec::<String>::new();
    names.retain(|name| {
        let lower = name.to_ascii_lowercase();
        if seen.contains(&lower) {
            false
        } else {
            seen.push(lower);
            true
        }
    });
}

#[cfg(test)]
mod tests;
