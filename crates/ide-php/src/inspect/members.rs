//! Undefined members: methods, properties and class constants that the
//! receiver's classes don't have.
//!
//! - [`UndefinedMethod`] (`PhpUndefinedMethod`): `$o->m()`, `$o?->m()`,
//!   `Foo::m()`, `parent::m()`, `$o->m(...)`.
//! - [`UndefinedField`] (`PhpUndefinedField`): reads of `$o->p`, `$o?->p`
//!   and `Foo::$p`.
//! - [`UndefinedClassConstant`] (`PhpUndefinedClassConstant`): `Foo::C`
//!   (class constants and enum cases; `Foo::class` is always fine).
//!
//! The receiver's type is inferred as for hover and goto, and every class
//! of it (each member of a union, each part of an intersection) is looked
//! up through its [class model](crate::types::ClassModel), so inherited,
//! trait, `@method`/`@property`, `@mixin` and enum built-in members count.
//! A member is defined when any of the classes has it. Nothing is reported
//! (the check can't be sure) when:
//!
//! - a part of the type isn't a known class: `mixed`, `object`, a
//!   template, a scalar, an unknown class (`null` parts are ignored);
//! - a class is declared in several files (fixtures, polyfills), or its
//!   hierarchy is incomplete: a parent, interface, trait or mixin
//!   that no file or stub declares (a missing `vendor/`);
//! - a class is a trait (its body calls what the using class provides);
//! - polymorphic code: a subtype of one of the classes (from the subclass
//!   index, the open buffers and the stubs, transitively) has the member,
//!   or the magic
//!   method that would answer it. Code calling an implementation's method
//!   through an interface or an abstract base (`ConnectionInterface` →
//!   `Connection::getPdo()`) is common and usually guarded by the program's
//!   own logic; PhpStorm's inspections have a similar "polymorphic code"
//!   leniency;
//! - the receiver ends a call chain longer than [`MAX_CHAIN`] links
//!   (fluent builders: inferring it means going through every link);
//! - the receiver is `$this` inside a closure or arrow function (closures
//!   get bound to other objects: Laravel's macros, `Closure::bind`);
//! - magic: `__call` for method calls (and static calls, which reach it
//!   from an instance context), `__callStatic` for static calls, `__get`
//!   for property reads;
//! - `stdClass`, `FFI` and `FFI\CData` (and their subclasses): anything
//!   goes; properties of classes
//!   marked `#[AllowDynamicProperties]` (or whose parents are);
//! - `$o->p instanceof Foo` / `f() instanceof Foo` (expressions the flow
//!   doesn't narrow) and `is_subclass_of($class, Foo::class)` / `is_a(…)`:
//!   later accesses through the same expression text in the function also
//!   look in `Foo`;
//! - property writes (`$o->p = 1`, `$o->p[] = 1`, `??=`, destructuring),
//!   which create dynamic properties, and checks that tolerate a missing
//!   property (`isset`, `empty`, `unset`, the left side of `??`), and reads
//!   of a property after such a check of it in the same function. A
//!   property name written anywhere in the file isn't reported on reads
//!   either (dynamic properties set in one method, read in another);
//! - after `method_exists(…, 'm')` / `property_exists(…, 'p')` /
//!   `defined('Foo::C')` up to the end of the enclosing function (or the
//!   file at the top level); after `method_exists($o, …)` any method
//!   called on the same receiver text (`$o`) there, as version-compatible
//!   code calls the old method when the new one is missing.
//!
//! A member missing from one project class gets the "Create method /
//! property / constant" quick-fix ([`super::fixes::create_member`]).
//!
//! As with the undefined symbols, nothing is reported in dumb mode or in
//! `.phpstorm.meta.php` files, and `@noinspection` is handled by the
//! framework. The ids follow PhpStorm's documented inspections ("Undefined
//! method", "Undefined field", "Undefined class constant"); the rules above
//! are our own.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use ide_core::Severity;
use mago_span::{HasSpan, Span};
use mago_syntax::cst::{
    Access, AnonymousClass, Argument, ArgumentList, ArrayElement, ArrowFunction, AssignmentOperator, BinaryOperator,
    Call, Class, ClassLikeConstantSelector, ClassLikeMemberSelector, Closure, Construct, Enum, Expression, Function,
    Interface, Literal, Method, PartialApplication, Trait, Unset, Variable,
};
use mago_syntax::walker::Walker;

use super::fixes::{self, MemberKind, NewMember, NewParam};
use super::{Inspection, InspectionContext, Problems};
use crate::engine::{EngineState, is_meta_path};
use crate::names::NameKind;
use crate::navigate::hierarchy::Subtypes;
use crate::summary::ClassKind;
use crate::types::expr::{MAX_CHAIN, chain_depth};
use crate::types::{ClassModel, Context, ExprTypes, Frame, Resolver, Type};

/// `PhpUndefinedMethod`.
pub struct UndefinedMethod;

/// `PhpUndefinedField`.
pub struct UndefinedField;

/// `PhpUndefinedClassConstant`.
pub struct UndefinedClassConstant;

impl Inspection for UndefinedMethod {
    fn id(&self) -> &'static str {
        "PhpUndefinedMethod"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    fn check(&self, cx: &InspectionContext<'_>, out: &mut Problems) {
        report(cx, Kind::Method, out);
    }
}

impl Inspection for UndefinedField {
    fn id(&self) -> &'static str {
        "PhpUndefinedField"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    fn check(&self, cx: &InspectionContext<'_>, out: &mut Problems) {
        report(cx, Kind::Property, out);
    }
}

impl Inspection for UndefinedClassConstant {
    fn id(&self) -> &'static str {
        "PhpUndefinedClassConstant"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    fn check(&self, cx: &InspectionContext<'_>, out: &mut Problems) {
        report(cx, Kind::Constant, out);
    }
}

/// The kinds of members checked.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Kind {
    Method,
    Property,
    Constant,
}

/// An undefined member found in a file.
#[derive(Clone, Debug)]
pub(crate) struct Found {
    kind: Kind,
    start: u32,
    end: u32,
    message: String,
    /// The member to create, when the receiver is one class.
    fix: Option<NewMember>,
}

fn report(cx: &InspectionContext<'_>, kind: Kind, out: &mut Problems) {
    for found in cx.undefined_members().iter().filter(|found| found.kind == kind) {
        let problem = out.report(found.start, found.end, found.message.clone());
        if let Some(fix) = found.fix.as_ref().and_then(|member| fixes::create_member(cx, member)) {
            problem.with_fix(fix);
        }
    }
}

/// Every undefined member of the file (computed once for the three
/// inspections).
pub(crate) fn find(cx: &InspectionContext<'_>) -> Vec<Found> {
    // In dumb mode every class would look incomplete anyway; stay quiet.
    if cx.engine.status().state != EngineState::Ready || is_meta_path(cx.path) {
        return Vec::new();
    }
    let text = cx.text();
    if !(text.contains("->") || text.contains("::")) {
        return Vec::new();
    }
    let resolver = cx.resolver();
    let types = cx.types();
    let mut scan = Scan {
        cx,
        types,
        resolver: &resolver,
        summary: cx.summary(),
        frames: Vec::new(),
        quiet: HashSet::new(),
        written: HashSet::new(),
        guards: Vec::new(),
        probed: Vec::new(),
        complete: HashMap::new(),
        subtypes: None,
        stub_children: None,
        narrowed: Vec::new(),
        subtype_models: HashMap::new(),
        candidates: Vec::new(),
    };
    ScanWalker.walk_program(cx.parsed.program(), &mut scan);
    if cx.is_cancelled() {
        return Vec::new();
    }
    let Scan { candidates, written, guards, .. } = scan;
    candidates
        .into_iter()
        .filter(|found| {
            let name = found.name.to_ascii_lowercase();
            if found.kind == Kind::Property && !found.is_static && written.contains(&found.name) {
                return false;
            }
            !guards.iter().any(|guard| {
                guard.kind == found.kind && guard.name == name && guard.start <= found.start && found.end <= guard.end
            })
        })
        .map(|found| {
            let what = match found.kind {
                Kind::Method => format!("method '{}'", found.name),
                Kind::Property => format!("property '${}'", found.name),
                Kind::Constant => format!("class constant '{}'", found.name),
            };
            let fix = found.target.map(|class| NewMember {
                kind: match found.kind {
                    Kind::Method => MemberKind::Method,
                    Kind::Property => MemberKind::Property,
                    Kind::Constant => MemberKind::Constant,
                },
                class,
                name: found.name.clone(),
                is_static: found.is_static,
                private: found.private,
                params: found.params,
            });
            Found {
                kind: found.kind,
                start: found.start,
                end: found.end,
                message: format!("Undefined {what} in '{}'", found.receiver),
                fix,
            }
        })
        .collect()
}

/// A member not found, before the file-wide filters.
struct Candidate {
    kind: Kind,
    is_static: bool,
    /// As written, without `$`.
    name: String,
    start: u32,
    end: u32,
    /// The classes looked in, `A|B`.
    receiver: String,
    /// The class, when the receiver is one.
    target: Option<String>,
    /// Accessed from inside the target class.
    private: bool,
    /// A method call's arguments as parameters.
    params: Vec<NewParam>,
}

/// A `method_exists`/`property_exists` check: members of `kind` named
/// `name` (lower-case) are fine from `start` to `end`.
struct Guard {
    kind: Kind,
    name: String,
    start: u32,
    end: u32,
}

struct Scan<'a, 'r> {
    cx: &'r InspectionContext<'a>,
    types: &'r ExprTypes<'a, 'r>,
    resolver: &'r Resolver<'r>,
    summary: &'a crate::summary::FileSummary,
    frames: Vec<Frame<'a>>,
    /// `(start, end)` of member accesses that aren't reads (writes,
    /// `isset`, `unset`, `??`).
    quiet: HashSet<(u32, u32)>,
    /// Property names written in the file.
    written: HashSet<String>,
    guards: Vec<Guard>,
    /// Receivers (their text) probed with `method_exists`, and from where
    /// to where: version-compatible code calls one method or another.
    probed: Vec<(String, u32, u32)>,
    /// Lower-case class name → whether its whole hierarchy is known.
    complete: HashMap<String, bool>,
    /// The subtype finder, made on the first miss.
    subtypes: Option<Subtypes>,
    /// Lower-case stub class-like → the stub class-likes extending or
    /// implementing it, made on the first miss.
    stub_children: Option<HashMap<String, Vec<String>>>,
    /// `expr instanceof Foo` for expressions that aren't variables: the
    /// expression's text, the class, and where it applies.
    narrowed: Vec<(String, Type, u32, u32)>,
    /// Lower-case class name → the models of its subtypes.
    subtype_models: HashMap<String, Arc<Vec<Arc<ClassModel>>>>,
    candidates: Vec<Candidate>,
}

/// Classes whose objects take any member: `stdClass`, and FFI's (C
/// functions are methods of an `FFI` instance, C fields properties of a
/// `CData`).
const DYNAMIC_CLASSES: [&str; 3] = ["stdClass", "FFI", r"FFI\CData"];

/// Subtypes looked at for polymorphic code, at most.
const MAX_SUBTYPES: usize = 512;

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn key(span: Span) -> (u32, u32) {
    (span.start.offset, span.end.offset)
}

impl<'a> Scan<'a, '_> {
    fn context(&self) -> Context {
        self.types.context(&self.frames)
    }

    /// The models of the classes `ty` stands for, or `None` when it isn't
    /// only known classes with complete hierarchies.
    fn models(&mut self, ty: &Type, context: &Context) -> Option<Vec<Arc<ClassModel>>> {
        let mut out: Vec<Arc<ClassModel>> = Vec::new();
        for part in ty.members() {
            if matches!(part, Type::Null) {
                continue;
            }
            self.collect(part, context, &mut out)?;
        }
        if out.is_empty() {
            return None;
        }
        for model in &out {
            let dynamic = DYNAMIC_CLASSES.iter().any(|class| model.is_subclass_of(class));
            if model.kind() == ClassKind::Trait || dynamic || !self.is_complete(model) {
                return None;
            }
        }
        Some(out)
    }

    fn collect(&self, part: &Type, context: &Context, out: &mut Vec<Arc<ClassModel>>) -> Option<()> {
        let mut push = |model: Arc<ClassModel>| {
            if !out.iter().any(|known| Arc::ptr_eq(known, &model)) {
                out.push(model);
            }
        };
        match part {
            Type::Named { fqn, .. } => push(self.resolver.class_model(fqn)?),
            Type::Closure(_) => push(self.resolver.class_model("Closure")?),
            Type::Relative(_) | Type::GenericRelative { .. } => {
                let models = self.resolver.class_models(part, context);
                if models.is_empty() {
                    return None;
                }
                models.into_iter().for_each(push);
            }
            Type::Intersection(parts) => {
                for part in parts {
                    self.collect(part, context, out)?;
                }
            }
            _ => return None,
        }
        Some(())
    }

    /// Whether every parent, interface, trait and mixin of the class is
    /// declared somewhere.
    fn is_complete(&mut self, model: &ClassModel) -> bool {
        let key = model.fqn().to_ascii_lowercase();
        if let Some(&known) = self.complete.get(&key) {
            return known;
        }
        let complete = model
            .parents
            .iter()
            .chain(&model.interfaces)
            .chain(&model.traits)
            .chain(&model.mixins)
            .all(|name| self.resolver.class_model(name).is_some());
        // A class declared in several files (fixtures, polyfills, versions
        // picked at runtime): which one is used isn't known.
        let declared_once = |fqn: &str| {
            let Some(index) = self.cx.engine.index() else { return true };
            let decls = index.declarations(NameKind::ClassLike, fqn).unwrap_or_default();
            let files: HashSet<&str> = decls.iter().map(|decl| decl.file.as_str()).collect();
            files.len() <= 1
        };
        let complete =
            complete && std::iter::once(model.fqn()).chain(model.parents.iter().map(String::as_str)).all(declared_once);
        self.complete.insert(key, complete);
        complete
    }

    fn has_method(models: &[Arc<ClassModel>], name: &str) -> bool {
        models.iter().any(|model| model.method(name).is_some())
    }

    /// Whether dynamic properties are fine on the class.
    fn allows_dynamic_properties(&self, model: &ClassModel) -> bool {
        let marked = |attributes: &[String]| {
            attributes.iter().any(|a| a.trim_start_matches('\\').eq_ignore_ascii_case("AllowDynamicProperties"))
        };
        marked(&model.class.attributes)
            || model
                .parents
                .iter()
                .filter_map(|parent| self.resolver.class_model(parent))
                .any(|parent| marked(&parent.class.attributes))
    }

    /// Whether one of `models` has the member, or the magic method that
    /// answers it.
    fn answers(&self, models: &[Arc<ClassModel>], kind: Kind, is_static: bool, name: &str) -> bool {
        let found = models.iter().any(|model| match kind {
            Kind::Method => model.method(name).is_some(),
            Kind::Property => model.property(name).is_some(),
            Kind::Constant => model.constant(name).is_some(),
        });
        found
            || match (kind, is_static) {
                (Kind::Method, false) => Self::has_method(models, "__call"),
                (Kind::Method, true) => Self::has_method(models, "__callStatic") || Self::has_method(models, "__call"),
                (Kind::Property, false) => {
                    Self::has_method(models, "__get") || models.iter().any(|m| self.allows_dynamic_properties(m))
                }
                (Kind::Property, true) | (Kind::Constant, _) => false,
            }
    }

    /// The models of every subtype of the class, directly or not: project
    /// classes (index and open buffers) and stub classes.
    fn subtype_models(&mut self, model: &ClassModel) -> Arc<Vec<Arc<ClassModel>>> {
        let key = model.fqn().to_ascii_lowercase();
        if let Some(found) = self.subtype_models.get(&key) {
            return found.clone();
        }
        let engine = self.cx.engine;
        let subtypes = self.subtypes.get_or_insert_with(|| Subtypes::new(engine));
        let stub_children = self.stub_children.get_or_insert_with(|| {
            let mut map: HashMap<String, Vec<String>> = HashMap::new();
            for file in &engine.stubs().files {
                for class in &file.summary.class_likes {
                    for parent in class.extends.iter().chain(&class.implements) {
                        let parent = parent.trim_start_matches('\\').to_ascii_lowercase();
                        map.entry(parent).or_default().push(class.fqn.clone());
                    }
                }
            }
            map
        });
        let mut seen: HashSet<String> = HashSet::from([key.clone()]);
        let mut queue: Vec<String> = vec![model.fqn().to_owned()];
        let mut next = 0;
        while next < queue.len() && queue.len() <= MAX_SUBTYPES && !self.cx.is_cancelled() {
            let parent = queue[next].clone();
            next += 1;
            let project = subtypes.direct(engine, &parent).unwrap_or_default().into_iter().map(|s| s.class.fqn);
            let stubs = stub_children.get(&parent.to_ascii_lowercase()).cloned().unwrap_or_default();
            for child in project.chain(stubs) {
                if seen.insert(child.to_ascii_lowercase()) {
                    queue.push(child);
                }
            }
        }
        let found: Vec<Arc<ClassModel>> =
            queue.iter().skip(1).filter_map(|fqn| self.resolver.class_model(fqn)).collect();
        let found = Arc::new(found);
        self.subtype_models.insert(key, found.clone());
        found
    }

    /// Checks member `name` of `kind` on `receiver`, at `span`.
    fn check(
        &mut self,
        kind: Kind,
        is_static: bool,
        receiver: &Type,
        name: &str,
        span: Span,
        args: Option<&'a ArgumentList<'a>>,
    ) {
        let context = self.context();
        let Some(models) = self.models(receiver, &context) else { return };
        if self.answers(&models, kind, is_static, name) {
            return;
        }
        // Polymorphic code: a subtype has it.
        for model in &models {
            if self.cx.is_cancelled() {
                return;
            }
            let subtypes = self.subtype_models(model);
            if self.answers(&subtypes, kind, is_static, name) {
                return;
            }
        }
        let receiver = models.iter().map(|model| model.fqn()).collect::<Vec<_>>().join("|");
        let target = match models.as_slice() {
            [model] => Some(model.fqn().to_owned()),
            _ => None,
        };
        let inside = self.frames.iter().rev().find_map(|frame| match frame {
            Frame::Class(fqn) => Some(fqn.clone()),
            _ => None,
        });
        let private =
            matches!((&target, inside), (Some(target), Some(Some(inside))) if target.eq_ignore_ascii_case(&inside));
        let params = match args {
            Some(args) if kind == Kind::Method => {
                fixes::new_params(args, |expr| self.types.type_of(expr, &self.frames))
            }
            _ => Vec::new(),
        };
        self.candidates.push(Candidate {
            kind,
            is_static,
            name: name.trim_start_matches('$').to_owned(),
            start: span.start.offset,
            end: span.end.offset,
            receiver,
            target,
            private,
            params,
        });
    }

    /// Whether `object` is `$this` inside a closure or arrow function.
    fn is_bound_this(&self, object: &Expression<'_>) -> bool {
        let Expression::Variable(Variable::Direct(variable)) = object else { return false };
        if variable.name != b"$this" {
            return false;
        }
        self.frames
            .iter()
            .rev()
            .take_while(|frame| !matches!(frame, Frame::Class(_)))
            .any(|frame| matches!(frame, Frame::Closure(_) | Frame::Arrow(_)))
    }

    fn instance(
        &mut self,
        kind: Kind,
        object: &'a Expression<'a>,
        selector: &ClassLikeMemberSelector<'_>,
        nullsafe: bool,
        args: Option<&'a ArgumentList<'a>>,
    ) {
        let ClassLikeMemberSelector::Identifier(name) = selector else { return };
        if self.is_bound_this(object) || chain_depth(object) > MAX_CHAIN {
            return;
        }
        let mut receiver = self.types.type_of(object, &self.frames);
        if nullsafe {
            receiver = receiver.without_null();
        }
        let at = object.span().start.offset;
        let text = self.source(object.span());
        if kind == Kind::Method
            && self.probed.iter().any(|(probed, start, end)| *probed == text && *start <= at && at <= *end)
        {
            return;
        }
        receiver = self.with_narrowed(receiver, &text, at);
        self.check(kind, false, &receiver, &lossy(name.value), name.span, args);
    }

    fn static_member(
        &mut self,
        kind: Kind,
        class: &'a Expression<'a>,
        name: &str,
        span: Span,
        args: Option<&'a ArgumentList<'a>>,
    ) {
        let receiver = self.types.class_ref(class, &self.frames);
        let receiver = self.with_narrowed(receiver, &self.source(class.span()), class.span().start.offset);
        self.check(kind, true, &receiver, name, span, args);
    }

    /// `receiver` widened by the `instanceof` / `is_a` checks of the
    /// expression `text` in force at byte `at`.
    fn with_narrowed(&self, receiver: Type, text: &str, at: u32) -> Type {
        let narrowed: Vec<Type> = self
            .narrowed
            .iter()
            .filter(|(expr, _, start, end)| expr == text && *start <= at && at <= *end)
            .map(|(_, ty, _, _)| ty.clone())
            .collect();
        if narrowed.is_empty() { receiver } else { Type::union(std::iter::once(receiver).chain(narrowed)) }
    }

    fn expression(&mut self, expr: &'a Expression<'a>) {
        match expr {
            Expression::Assignment(assignment) => {
                self.write(assignment.lhs);
                if matches!(assignment.operator, AssignmentOperator::Coalesce(_)) {
                    self.tolerant(assignment.lhs);
                }
            }
            Expression::Binary(binary) if matches!(binary.operator, BinaryOperator::NullCoalesce(_)) => {
                self.tolerant(binary.lhs);
            }
            Expression::Construct(Construct::Isset(isset)) => {
                for value in isset.values.iter() {
                    self.tolerant(value);
                }
            }
            Expression::Construct(Construct::Empty(empty)) => self.tolerant(empty.value),
            Expression::Binary(binary)
                if matches!(binary.operator, BinaryOperator::Instanceof(_))
                    && !matches!(binary.lhs, Expression::Variable(_)) =>
            {
                let class = self.types.class_ref(binary.rhs, &self.frames);
                if matches!(class, Type::Named { .. }) {
                    let text = self.source(binary.lhs.span());
                    let (start, end) = (binary.lhs.span().start.offset, self.scope_end());
                    self.narrowed.push((text, class, start, end));
                }
            }
            Expression::Call(Call::Function(call)) => self.guard(call),
            _ => {}
        }
        if self.quiet.contains(&key(expr.span())) || self.cx.is_cancelled() {
            return;
        }
        match expr {
            Expression::Call(Call::Method(call)) => {
                self.instance(Kind::Method, call.object, &call.method, false, Some(&call.argument_list))
            }
            Expression::Call(Call::NullSafeMethod(call)) => {
                self.instance(Kind::Method, call.object, &call.method, true, Some(&call.argument_list))
            }
            Expression::PartialApplication(PartialApplication::Method(partial)) => {
                self.instance(Kind::Method, partial.object, &partial.method, false, None)
            }
            Expression::Access(Access::Property(access)) => {
                self.instance(Kind::Property, access.object, &access.property, false, None)
            }
            Expression::Access(Access::NullSafeProperty(access)) => {
                self.instance(Kind::Property, access.object, &access.property, true, None)
            }
            Expression::Call(Call::StaticMethod(call)) => {
                if let ClassLikeMemberSelector::Identifier(name) = &call.method {
                    self.static_member(
                        Kind::Method,
                        call.class,
                        &lossy(name.value),
                        name.span,
                        Some(&call.argument_list),
                    );
                }
            }
            Expression::PartialApplication(PartialApplication::StaticMethod(partial)) => {
                if let ClassLikeMemberSelector::Identifier(name) = &partial.method {
                    self.static_member(Kind::Method, partial.class, &lossy(name.value), name.span, None);
                }
            }
            Expression::Access(Access::StaticProperty(access)) => {
                if let Variable::Direct(variable) = &access.property {
                    self.static_member(Kind::Property, access.class, &lossy(variable.name), variable.span, None);
                }
            }
            Expression::Access(Access::ClassConstant(access)) => {
                if let ClassLikeConstantSelector::Identifier(name) = &access.constant
                    && !name.value.eq_ignore_ascii_case(b"class")
                {
                    self.static_member(Kind::Constant, access.class, &lossy(name.value), name.span, None);
                }
            }
            _ => {}
        }
    }

    /// The target of an assignment: a property written there is not read,
    /// and its name counts as declared in the file.
    fn write(&mut self, target: &'a Expression<'a>) {
        match target {
            Expression::Parenthesized(inner) => self.write(inner.expression),
            Expression::Access(Access::Property(access)) => {
                self.quiet.insert(key(target.span()));
                if let ClassLikeMemberSelector::Identifier(name) = &access.property {
                    self.written.insert(lossy(name.value));
                }
            }
            Expression::Access(Access::StaticProperty(_)) => {}
            Expression::ArrayAccess(access) => self.write(access.array),
            Expression::ArrayAppend(append) => self.write(append.array),
            Expression::Array(array) => array.elements.iter().for_each(|element| self.write_element(element)),
            Expression::LegacyArray(array) => array.elements.iter().for_each(|element| self.write_element(element)),
            Expression::List(list) => list.elements.iter().for_each(|element| self.write_element(element)),
            _ => {}
        }
    }

    fn write_element(&mut self, element: &'a ArrayElement<'a>) {
        match element {
            ArrayElement::KeyValue(element) => self.write(element.value),
            ArrayElement::Value(element) => self.write(element.value),
            _ => {}
        }
    }

    /// An expression a missing property doesn't break (`isset`, `??`):
    /// its whole access chain is quiet, and its properties are checked for
    /// the rest of the function (`isset($o->p) && $o->p`).
    fn tolerant(&mut self, expr: &'a Expression<'a>) {
        match expr {
            Expression::Parenthesized(inner) => self.tolerant(inner.expression),
            Expression::Access(Access::Property(access)) => {
                self.quiet.insert(key(expr.span()));
                self.checked(&access.property, expr.span());
                self.tolerant(access.object);
            }
            Expression::Access(Access::NullSafeProperty(access)) => {
                self.quiet.insert(key(expr.span()));
                self.checked(&access.property, expr.span());
                self.tolerant(access.object);
            }
            Expression::Access(Access::StaticProperty(_)) => {
                self.quiet.insert(key(expr.span()));
            }
            Expression::ArrayAccess(access) => self.tolerant(access.array),
            _ => {}
        }
    }

    fn checked(&mut self, selector: &ClassLikeMemberSelector<'_>, span: Span) {
        if let ClassLikeMemberSelector::Identifier(name) = selector {
            self.guard_from(Kind::Property, lossy(name.value).to_ascii_lowercase(), span.start.offset);
        }
    }

    /// `method_exists($o, 'm')` / `property_exists($o, 'p')`.
    fn guard(&mut self, call: &'a mago_syntax::cst::FunctionCall<'a>) {
        let Expression::Identifier(callee) = call.function else { return };
        let callee = callee.value();
        let callee = callee.strip_prefix(b"\\").unwrap_or(callee);
        if callee.eq_ignore_ascii_case(b"is_subclass_of") || callee.eq_ignore_ascii_case(b"is_a") {
            // `is_subclass_of($class, Foo::class)`: like `instanceof`.
            let mut arguments = call.argument_list.arguments.iter();
            let (Some(Argument::Positional(subject)), Some(Argument::Positional(class))) =
                (arguments.next(), arguments.next())
            else {
                return;
            };
            let class = match class.value {
                Expression::Literal(Literal::String(string)) => match string.value {
                    Some(value) => Type::named(lossy(value).replace(r"\\", r"\").trim_start_matches('\\')),
                    None => return,
                },
                Expression::Access(Access::ClassConstant(_)) => match self.types.type_of(class.value, &self.frames) {
                    Type::ClassString(Some(inner)) => *inner,
                    Type::LiteralString(name) => Type::named(&name),
                    _ => return,
                },
                _ => return,
            };
            if matches!(class, Type::Named { .. }) {
                let text = self.source(subject.value.span());
                let (start, end) = (call.span().start.offset, self.scope_end());
                self.narrowed.push((text, class, start, end));
            }
            return;
        }
        if callee.eq_ignore_ascii_case(b"defined") {
            // `defined('Redis::OPT_X')`.
            let Some(Argument::Positional(argument)) = call.argument_list.arguments.iter().next() else { return };
            let Expression::Literal(Literal::String(string)) = argument.value else { return };
            let Some(value) = string.value.map(lossy) else { return };
            let Some((_, name)) = value.rsplit_once("::") else { return };
            let name = name.to_ascii_lowercase();
            self.guard_from(Kind::Constant, name, call.span().start.offset);
            return;
        }
        let kind = if callee.eq_ignore_ascii_case(b"method_exists") {
            Kind::Method
        } else if callee.eq_ignore_ascii_case(b"property_exists") {
            Kind::Property
        } else {
            return;
        };
        if kind == Kind::Method
            && let Some(Argument::Positional(first)) = call.argument_list.arguments.iter().next()
        {
            let text = self.source(first.value.span());
            self.probed.push((text, call.span().start.offset, self.scope_end()));
        }
        let Some(second) = call.argument_list.arguments.iter().nth(1) else { return };
        let value = match second {
            Argument::Positional(argument) => argument.value,
            Argument::Named(argument) => argument.value,
        };
        let Expression::Literal(Literal::String(string)) = value else { return };
        let Some(name) = string.value else { return };
        let name = lossy(name).trim_start_matches('$').to_ascii_lowercase();
        self.guard_from(kind, name, call.span().start.offset);
    }

    /// Members of `kind` named `name` (lower-case) are fine from `start` to
    /// the end of the enclosing function (or the file).
    fn guard_from(&mut self, kind: Kind, name: String, start: u32) {
        let end = self.scope_end();
        self.guards.push(Guard { kind, name, start, end });
    }

    /// The end of the enclosing function-like, or of the file.
    fn scope_end(&self) -> u32 {
        self.frames
            .iter()
            .rev()
            .find_map(|frame| match frame {
                Frame::Function(node) => Some(node.span().end.offset),
                Frame::Method(node) => Some(node.span().end.offset),
                Frame::Closure(node) => Some(node.span().end.offset),
                Frame::Arrow(node) => Some(node.span().end.offset),
                Frame::Class(_) => None,
            })
            .unwrap_or(u32::MAX)
    }

    fn source(&self, span: Span) -> String {
        let text = self.cx.text();
        let (start, end) = (span.start.offset as usize, span.end.offset as usize);
        text.get(start..end.min(text.len())).unwrap_or_default().to_owned()
    }

    fn unset(&mut self, unset: &'a Unset<'a>) {
        for value in unset.values.iter() {
            self.tolerant(value);
        }
    }

    fn class(&mut self, name_start: u32) {
        let fqn =
            self.summary.class_likes.iter().find(|class| class.name_loc.start == name_start).map(|c| c.fqn.clone());
        self.frames.push(Frame::Class(fqn));
    }
}

struct ScanWalker;

impl<'a, 'r> Walker<'a, 'a, Scan<'a, 'r>> for ScanWalker {
    fn walk_in_expression(&self, expr: &'a Expression<'a>, cx: &mut Scan<'a, 'r>) {
        cx.expression(expr);
    }

    fn walk_in_unset(&self, unset: &'a Unset<'a>, cx: &mut Scan<'a, 'r>) {
        cx.unset(unset);
    }

    fn walk_in_class(&self, node: &'a Class<'a>, cx: &mut Scan<'a, 'r>) {
        cx.class(node.name.span.start.offset);
    }
    fn walk_out_class(&self, _: &'a Class<'a>, cx: &mut Scan<'a, 'r>) {
        cx.frames.pop();
    }
    fn walk_in_interface(&self, node: &'a Interface<'a>, cx: &mut Scan<'a, 'r>) {
        cx.class(node.name.span.start.offset);
    }
    fn walk_out_interface(&self, _: &'a Interface<'a>, cx: &mut Scan<'a, 'r>) {
        cx.frames.pop();
    }
    fn walk_in_trait(&self, node: &'a Trait<'a>, cx: &mut Scan<'a, 'r>) {
        cx.class(node.name.span.start.offset);
    }
    fn walk_out_trait(&self, _: &'a Trait<'a>, cx: &mut Scan<'a, 'r>) {
        cx.frames.pop();
    }
    fn walk_in_enum(&self, node: &'a Enum<'a>, cx: &mut Scan<'a, 'r>) {
        cx.class(node.name.span.start.offset);
    }
    fn walk_out_enum(&self, _: &'a Enum<'a>, cx: &mut Scan<'a, 'r>) {
        cx.frames.pop();
    }
    fn walk_in_anonymous_class(&self, _: &'a AnonymousClass<'a>, cx: &mut Scan<'a, 'r>) {
        cx.frames.push(Frame::Class(None));
    }
    fn walk_out_anonymous_class(&self, _: &'a AnonymousClass<'a>, cx: &mut Scan<'a, 'r>) {
        cx.frames.pop();
    }
    fn walk_in_function(&self, node: &'a Function<'a>, cx: &mut Scan<'a, 'r>) {
        cx.frames.push(Frame::Function(node));
    }
    fn walk_out_function(&self, _: &'a Function<'a>, cx: &mut Scan<'a, 'r>) {
        cx.frames.pop();
    }
    fn walk_in_method(&self, node: &'a Method<'a>, cx: &mut Scan<'a, 'r>) {
        cx.frames.push(Frame::Method(node));
    }
    fn walk_out_method(&self, _: &'a Method<'a>, cx: &mut Scan<'a, 'r>) {
        cx.frames.pop();
    }
    fn walk_in_closure(&self, node: &'a Closure<'a>, cx: &mut Scan<'a, 'r>) {
        cx.frames.push(Frame::Closure(node));
    }
    fn walk_out_closure(&self, _: &'a Closure<'a>, cx: &mut Scan<'a, 'r>) {
        cx.frames.pop();
    }
    fn walk_in_arrow_function(&self, node: &'a ArrowFunction<'a>, cx: &mut Scan<'a, 'r>) {
        cx.frames.push(Frame::Arrow(node));
    }
    fn walk_out_arrow_function(&self, _: &'a ArrowFunction<'a>, cx: &mut Scan<'a, 'r>) {
        cx.frames.pop();
    }
}
