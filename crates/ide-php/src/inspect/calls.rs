//! Calls and types: arguments that don't fit the callee, returns that
//! don't fit the function, and property assignments that don't fit the
//! property.
//!
//! - [`ArgumentCount`] (`PhpMethodParametersCountMismatch`): a required
//!   parameter without an argument (positional or named), and more
//!   arguments than a callee without a variadic parameter takes.
//! - [`NamedArgument`] (`PhpUnknownNamedArgument`): a named argument no
//!   parameter has (unless the callee is variadic, which collects them),
//!   or one naming a parameter a positional argument already filled.
//! - [`ArgumentType`] (`PhpParams`): an argument whose type the parameter
//!   doesn't accept.
//! - [`ReturnType`] (`PhpIncompatibleReturnType`): a `return` value (or an
//!   arrow function's body) the declared return type doesn't accept.
//! - [`PropertyType`] (`PhpFieldAssignmentTypeMismatch`): `$o->p = v` /
//!   `Foo::$p = v` where the property's type doesn't accept `v`.
//!
//! Each inspection runs in a [`TypeCheckMode`]:
//!
//! - **Lenient** (the default) reports only what fails at runtime for
//!   certain: a missing required argument, an unknown or overwriting named
//!   argument, too many arguments to an internal function or to an internal
//!   method of a final internal class (those throw; user functions silently
//!   ignore extras, and a subclass's override may take more), and values
//!   that no member of
//!   the *native* type accepts under PHP's rules, with the coercions of
//!   the file's mode (scalars juggle into scalars unless the file declares
//!   `strict_types=1`, `int` widens to `float` always, objects with
//!   `__toString` become strings, `null` is only deprecated for built-in
//!   scalar parameters). Two classes are incompatible only when neither
//!   extends the other and neither is an interface a subclass could still
//!   implement (a final class or an enum can't gain interfaces). Unknown
//!   classes, incomplete hierarchies, `mixed`, templates and anything the
//!   inference isn't sure of count as accepted, and so do values whose type
//!   only a docblock gives (a parameter or property without a native type,
//!   a method reached through `@mixin`/`@method`), elements of objects
//!   (`ArrayAccess`, `FFI\CData`), and expressions other than variables
//!   after an `is_*`/`instanceof`/comparison/`isset` check of them in the
//!   function (the flow only narrows variables).
//! - Inside a function that probes the installed version
//!   (`method_exists`, `property_exists`, `version_compare`,
//!   `PHP_VERSION_ID`), problems are only reported in strict mode: such
//!   code calls the APIs of several versions.
//! - Built-in signatures come from the stubs: a function or method the
//!   stubs declare twice (`strtr`) isn't checked, and parameters their
//!   docblock marks `[optional]` aren't required.
//! - **Strict** reports in addition too many arguments to user functions,
//!   and values whose type isn't a subtype of the *declared* type
//!   (`@param`/`@return`/`@var` first, generic arguments bound): a
//!   `?Foo` passed where `Foo` is expected, a parent where a subclass is
//!   expected, `array<string>` where `list<int>` is documented. Types with
//!   templates, unknown classes or `mixed` arguments are still skipped.
//!
//! Certain problems are errors, the strict-only ones warnings. The scan
//! runs once per file for all five inspections ([`find`]), recording for
//! each problem whether it is certain.
//!
//! Not checked: callees declared in several files (polyfills, fixtures),
//! magic `@method`s and `__call`, union receivers whose classes declare the
//! method differently, calls after a spread argument (`...$args`), by-ref
//! parameters (they are destinations), returns of generators (a
//! `Generator`/`Iterator`/`Traversable`/`iterable` return type), `void`
//! and `never` functions ([`super::control`]), property hooks, dumb mode and
//! `.phpstorm.meta.php` files. The ids follow PhpStorm's documented
//! inspections where one exists; the rules are our own.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use ide_core::Severity;
use mago_span::{HasSpan, Span};
use mago_syntax::cst::{
    Access, AnonymousClass, Argument, ArgumentList, ArrowFunction, AssignmentOperator, BinaryOperator, Call, Class,
    ClassLikeMemberSelector, Closure, Construct, Enum, Expression, Function, FunctionLikeParameterList,
    FunctionLikeReturnTypeHint, Interface, Method, Return, Statement, Trait, Variable,
};
use mago_syntax::walker::Walker;

use super::{Inspection, InspectionContext, Problems};
use crate::engine::{EngineState, is_meta_path};
use crate::names::NameKind;
use crate::signature::{Callee, argument_list, callee, parameter_index};
use crate::summary::{ClassKind, DocBlock, Param};
use crate::types::expr::{MAX_CHAIN, chain_depth};
use crate::types::model::Origin;
use crate::types::{ClassModel, Context, ExprTypes, Frame, Relative, Resolver, SignatureParam, Type};

/// How sure a type problem must be to be reported.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum TypeCheckMode {
    /// Only what certainly fails at runtime, against native types.
    #[default]
    Lenient,
    /// Also possible mismatches, against declared (PHPDoc) types.
    Strict,
}

/// `PhpMethodParametersCountMismatch`.
pub struct ArgumentCount {
    pub mode: TypeCheckMode,
}

/// `PhpUnknownNamedArgument`.
pub struct NamedArgument {
    pub mode: TypeCheckMode,
}

/// `PhpParams`.
pub struct ArgumentType {
    pub mode: TypeCheckMode,
}

/// `PhpIncompatibleReturnType`.
pub struct ReturnType {
    pub mode: TypeCheckMode,
}

/// `PhpFieldAssignmentTypeMismatch`.
pub struct PropertyType {
    pub mode: TypeCheckMode,
}

macro_rules! inspection {
    ($ty:ident, $id:literal, $check:expr) => {
        impl Inspection for $ty {
            fn id(&self) -> &'static str {
                $id
            }

            fn default_severity(&self) -> Severity {
                Severity::Error
            }

            fn check(&self, cx: &InspectionContext<'_>, out: &mut Problems) {
                report(cx, $check, self.mode, out);
            }
        }
    };
}

inspection!(ArgumentCount, "PhpMethodParametersCountMismatch", Check::Count);
inspection!(NamedArgument, "PhpUnknownNamedArgument", Check::Named);
inspection!(ArgumentType, "PhpParams", Check::Argument);
inspection!(ReturnType, "PhpIncompatibleReturnType", Check::Return);
inspection!(PropertyType, "PhpFieldAssignmentTypeMismatch", Check::Property);

/// What a problem is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Check {
    Count,
    Named,
    Argument,
    Return,
    Property,
}

/// A problem found in a file.
#[derive(Clone, Debug)]
pub(crate) struct Found {
    check: Check,
    /// Fails at runtime for certain: reported in lenient mode too.
    certain: bool,
    start: u32,
    end: u32,
    message: String,
}

fn report(cx: &InspectionContext<'_>, check: Check, mode: TypeCheckMode, out: &mut Problems) {
    for found in cx.calls().iter().filter(|f| f.check == check && (f.certain || mode == TypeCheckMode::Strict)) {
        let problem = out.report(found.start, found.end, found.message.clone());
        if !found.certain {
            problem.with_severity(Severity::Warning);
        }
    }
}

/// Every call and type problem of the file, certain or not (computed once
/// for the five inspections).
pub(crate) fn find(cx: &InspectionContext<'_>) -> Vec<Found> {
    if cx.engine.status().state != EngineState::Ready || is_meta_path(cx.path) {
        return Vec::new();
    }
    let resolver = cx.resolver();
    let types = cx.types();
    let mut scan = Scan {
        cx,
        types,
        resolver: &resolver,
        frames: Vec::new(),
        strict_types: declares_strict_types(cx),
        null_coerces: false,
        complete: RefCell::new(HashMap::new()),
        checked: Vec::new(),
        found: Vec::new(),
    };
    ScanWalker.walk_program(cx.parsed.program(), &mut scan);
    if cx.is_cancelled() {
        return Vec::new();
    }
    let mut found = scan.found;
    found.sort_by_key(|f| (f.start, f.end));
    found
}

/// Whether the file starts with `declare(strict_types=1)`.
fn declares_strict_types(cx: &InspectionContext<'_>) -> bool {
    let text = cx.text();
    cx.parsed.program().statements.iter().any(|statement| {
        let Statement::Declare(declare) = statement else { return false };
        declare.items.iter().any(|item| {
            let span = item.value.span();
            item.name.value.eq_ignore_ascii_case(b"strict_types")
                && text.get(span.start.offset as usize..span.end.offset as usize).is_some_and(|v| v.trim() == "1")
        })
    })
}

/// A callee's parameters, natively typed and as declared.
struct Target {
    /// Native hints only (`mixed` when untyped), `null` added for a `null`
    /// default; relative classes bound.
    native: Vec<SignatureParam>,
    /// `@param` types first, generic arguments bound.
    declared: Vec<SignatureParam>,
    /// Declared only in the stubs: an internal function or method.
    builtin: bool,
    /// Extra arguments throw for certain: an internal function, or an
    /// internal method of a final internal class (a subclass's override may
    /// take more).
    extra_throws: bool,
}

impl Target {
    /// The target with the parameters named in `optional` not required.
    fn with_optional(mut self, optional: &[String]) -> Self {
        for params in [&mut self.native, &mut self.declared] {
            for param in params.iter_mut() {
                if param.name.as_ref().is_some_and(|name| optional.contains(name)) {
                    param.optional = true;
                }
            }
        }
        self
    }
}

/// The parameters a stub docblock marks `[optional]`: the stubs give
/// optional parameters of internal functions no default when PHP has none
/// to show (`array_keys`' `$filter_value`, `array_walk`'s `$arg`).
fn stub_optional(path: &str, start: u32) -> Vec<String> {
    let Some(source) = crate::stubs::BundledStubs::get().source(path) else { return Vec::new() };
    let Some(doc) = crate::navigate::hover::doc_comment_before(source, start) else { return Vec::new() };
    doc.lines()
        .filter(|line| line.contains("@param") && line.contains("[optional]"))
        .filter_map(|line| {
            let at = line.find('$')?;
            let name: String = line[at + 1..].chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
            (!name.is_empty()).then_some(name)
        })
        .collect()
}

/// How the classes of a value or type are named in context.
#[derive(Clone, Default)]
struct Classes {
    self_class: Option<String>,
    static_class: Option<String>,
    parent: Option<String>,
}

/// A value's type reduced to what PHP checks at runtime.
enum Atom<'t> {
    Null,
    Bool,
    Int,
    Float,
    /// A string, with its value when literal.
    Str(Option<&'t str>),
    Array,
    Object(&'t str),
}

fn atom(ty: &Type) -> Option<Atom<'_>> {
    Some(match ty {
        Type::Null => Atom::Null,
        Type::Bool | Type::LiteralBool(_) => Atom::Bool,
        Type::Int | Type::IntRange { .. } | Type::LiteralInt(_) => Atom::Int,
        Type::Float | Type::LiteralFloat(_) => Atom::Float,
        Type::LiteralString(value) => Atom::Str(Some(value)),
        Type::String(_) | Type::ClassString(_) => Atom::Str(None),
        Type::Array { .. } | Type::List { .. } | Type::Shape(_) => Atom::Array,
        Type::Named { fqn, .. } => Atom::Object(fqn),
        Type::Closure(_) => Atom::Object("Closure"),
        _ => return None,
    })
}

/// Whether a string may convert to a number (PHP 8 accepts leading-numeric
/// strings with a warning and rejects the rest).
fn may_be_numeric(value: &str) -> bool {
    value.trim_start().starts_with(|c: char| c.is_ascii_digit() || matches!(c, '+' | '-' | '.'))
}

/// True when `ty` has template parameters or `static<…>`/`self<…>` in it.
fn has_templates(ty: &Type) -> bool {
    let mut found = false;
    ty.map(&mut |ty| {
        found |= matches!(ty, Type::Template(_) | Type::GenericRelative { .. } | Type::ClassConstant { .. });
        None
    });
    found
}

/// True when `mixed` is part of `ty` (`array<mixed>`, `Foo<mixed>`): its
/// contents aren't known.
fn mentions_mixed(ty: &Type) -> bool {
    let mut found = false;
    ty.map(&mut |ty| {
        found |= matches!(ty, Type::Mixed | Type::ArrayKey);
        None
    });
    found
}

/// `declared` with `null` added where the parameter defaults to `null`
/// (implicitly nullable).
fn with_null_defaults(declared: Vec<SignatureParam>, params: &[Param]) -> Vec<SignatureParam> {
    declared
        .into_iter()
        .zip(params)
        .map(|(param, source)| {
            let null = source.default.as_deref().is_some_and(|d| d.trim().eq_ignore_ascii_case("null"));
            if null && !param.ty.is_nullable() { SignatureParam { ty: param.ty.nullable(), ..param } } else { param }
        })
        .collect()
}

/// Code that checks which version of an API it runs against.
const VERSION_PROBES: [&str; 4] = ["method_exists(", "property_exists(", "version_compare(", "PHP_VERSION_ID"];

/// A function's docblock with the templates in scope, for its `@return`.
type ReturnDoc = (DocBlock, Vec<String>);

/// Types a generator function returns.
const GENERATOR_TYPES: [&str; 4] = ["Generator", "Iterator", "Traversable", "IteratorAggregate"];

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn plural(n: usize) -> String {
    if n == 1 { "1 argument".to_owned() } else { format!("{n} arguments") }
}

struct Scan<'a, 'r> {
    cx: &'r InspectionContext<'a>,
    types: &'r ExprTypes<'a, 'r>,
    resolver: &'r Resolver<'r>,
    frames: Vec<Frame<'a>>,
    /// The file declares `strict_types=1`: no scalar juggling.
    strict_types: bool,
    /// `null` is accepted (deprecated) by the scalar parameter being
    /// checked: a built-in's, in coercive mode.
    null_coerces: bool,
    /// Lower-case class name → whether its whole hierarchy is known and it
    /// is declared once.
    complete: RefCell<HashMap<String, bool>>,
    /// Expressions (their text) that aren't variables but are checked with
    /// `is_*`, `instanceof`, a comparison, `isset` or `empty`, and where:
    /// the flow doesn't narrow them, so their type is unsure from there.
    checked: Vec<(String, u32, u32)>,
    found: Vec<Found>,
}

impl<'a> Scan<'a, '_> {
    fn context(&self) -> Context {
        self.types.context(&self.frames)
    }

    /// The classes `self`, `static` and `parent` mean where the scan is.
    fn here(&self) -> Classes {
        let self_class = self.context().self_class;
        let parent = self_class.as_deref().and_then(|class| self.resolver.class_model(class)?.parents.first().cloned());
        Classes { static_class: self_class.clone(), self_class, parent }
    }

    fn push(&mut self, check: Check, certain: bool, span: Span, message: String) {
        let certain = certain && !self.version_dependent();
        self.found.push(Found { check, certain, start: span.start.offset, end: span.end.offset, message });
    }

    /// The class's model when its whole hierarchy is declared and it is
    /// declared in one file only.
    fn complete(&self, fqn: &str) -> Option<Arc<ClassModel>> {
        let model = self.resolver.class_model(fqn)?;
        let key = model.fqn().to_ascii_lowercase();
        if let Some(&known) = self.complete.borrow().get(&key) {
            return known.then_some(model);
        }
        let complete = model
            .parents
            .iter()
            .chain(&model.interfaces)
            .chain(&model.traits)
            .chain(&model.mixins)
            .all(|name| self.resolver.class_model(name).is_some())
            && self.declared_once(NameKind::ClassLike, model.fqn());
        self.complete.borrow_mut().insert(key, complete);
        complete.then_some(model)
    }

    /// Whether at most one project file declares `fqn`.
    fn declared_once(&self, kind: NameKind, fqn: &str) -> bool {
        let Some(index) = self.cx.engine.index() else { return true };
        let decls = index.declarations(kind, fqn).unwrap_or_default();
        let mut files: Vec<&str> = decls.iter().map(|decl| decl.file.as_str()).collect();
        files.sort_unstable();
        files.dedup();
        files.len() <= 1
    }

    // ------------------------------------------------------------- calls

    fn call(&mut self, expr: &'a Expression<'a>) {
        let Some(list) = argument_list(expr) else { return };
        let receiver = match expr {
            Expression::Call(Call::Method(call)) => Some(call.object),
            Expression::Call(Call::NullSafeMethod(call)) => Some(call.object),
            _ => None,
        };
        if receiver.is_some_and(|object| chain_depth(object) > MAX_CHAIN) {
            return;
        }
        let Some(callee) = callee(self.types, self.cx.names(), self.resolver, expr, &self.frames) else { return };
        let Some(target) = self.target(&callee) else { return };
        self.arguments(&target, list);
    }

    fn target(&self, callee: &Callee) -> Option<Target> {
        match callee {
            Callee::Function(fqn) => {
                let function =
                    self.resolver.declarations().function(fqn).or_else(|| self.cx.summary().function(fqn).cloned())?;
                if !self.declared_once(NameKind::Function, &function.fqn) {
                    return None;
                }
                let doc = function.doc.as_deref();
                let templates: Vec<&str> = doc.iter().flat_map(|doc| doc.local_type_names()).collect();
                let builtin = self.cx.engine.only_stubs_declare(NameKind::Function, &function.fqn);
                let target = Target {
                    native: native_params(&function.params, &Classes::default()),
                    declared: with_null_defaults(
                        crate::types::resolve::declared_params(&function.params, doc, &templates),
                        &function.params,
                    ),
                    builtin,
                    extra_throws: builtin,
                };
                if !builtin {
                    return Some(target);
                }
                // The stubs write some signatures twice (`strtr`), and mark
                // optional parameters without a default in the docblock.
                let stubs = self.cx.engine.stubs();
                let declarations: Vec<_> = stubs
                    .files
                    .iter()
                    .flat_map(|file| file.summary.functions.iter().map(move |f| (file, f)))
                    .filter(|(_, f)| f.fqn.eq_ignore_ascii_case(&function.fqn))
                    .collect();
                let [(file, stub)] = declarations.as_slice() else { return None };
                Some(target.with_optional(&stub_optional(&file.path, stub.loc.start)))
            }
            Callee::Method { receiver, name } => {
                let context = self.context();
                let parts: Vec<&Type> = receiver.members().iter().filter(|part| **part != Type::Null).collect();
                if parts.is_empty() || !parts.iter().all(|part| matches!(part, Type::Named { .. } | Type::Relative(_)))
                {
                    return None;
                }
                let models = self.resolver.class_models(receiver, &context);
                if models.is_empty() {
                    return None;
                }
                // Every class must declare the same method.
                let mut chosen: Option<(&Arc<ClassModel>, &crate::types::model::ModelMethod)> = None;
                for model in &models {
                    let method = model.method(name)?;
                    method.declared()?;
                    // Mixin methods are reached through `__call` forwarding.
                    if !matches!(method.origin, Origin::Declared | Origin::Trait) {
                        return None;
                    }
                    match chosen {
                        None => chosen = Some((model, method)),
                        Some((_, first)) => {
                            let same = first.declaring.fqn.eq_ignore_ascii_case(&method.declaring.fqn)
                                && first.declared().map(|m| m.name_loc.start)
                                    == method.declared().map(|m| m.name_loc.start);
                            if !same {
                                return None;
                            }
                        }
                    }
                }
                let (model, method) = chosen?;
                let declared = method.declared()?;
                if !self.declared_once(NameKind::ClassLike, &method.declaring.fqn) {
                    return None;
                }
                let parent = self.resolver.class_model(&method.self_class).and_then(|m| m.parents.first().cloned());
                let classes = Classes {
                    self_class: Some(method.self_class.clone()),
                    static_class: Some(model.fqn().to_owned()),
                    parent,
                };
                let native = native_params(&declared.params, &classes);
                let declared_params = self.resolver.method_params_on(receiver, name, &context).unwrap_or_default();
                if declared_params.len() != native.len() {
                    return None;
                }
                let declared_params = declared_params
                    .into_iter()
                    .map(|param| SignatureParam { ty: bind(&param.ty, &classes), ..param })
                    .collect();
                let declared_params = with_null_defaults(declared_params, &declared.params);
                let builtin = self.cx.engine.only_stubs_declare(NameKind::ClassLike, &method.declaring.fqn);
                let final_builtin = (model.class.modifiers.is_final || model.kind() == ClassKind::Enum)
                    && self.cx.engine.only_stubs_declare(NameKind::ClassLike, model.fqn());
                let target =
                    Target { native, declared: declared_params, builtin, extra_throws: builtin && final_builtin };
                if !builtin {
                    return Some(target);
                }
                let stubs = self.cx.engine.stubs();
                let (file, class) = stubs.class_like(&method.declaring.fqn)?;
                let declarations: Vec<_> =
                    class.methods.iter().filter(|m| m.name.eq_ignore_ascii_case(&declared.name)).collect();
                let [stub] = declarations.as_slice() else { return None };
                Some(target.with_optional(&stub_optional(&file.path, stub.loc.start)))
            }
        }
    }

    fn arguments(&mut self, target: &Target, list: &'a ArgumentList<'a>) {
        let args: Vec<&'a Argument<'a>> = list.arguments.iter().collect();
        let params = &target.native;
        let spread = args.iter().any(|arg| matches!(arg, Argument::Positional(p) if p.ellipsis.is_some()));
        if !spread {
            self.count(target, list, &args);
        }
        let builtin = target.builtin;
        for (i, arg) in args.iter().enumerate() {
            let value = match arg {
                Argument::Positional(arg) if arg.ellipsis.is_some() => break,
                Argument::Positional(arg) => arg.value,
                Argument::Named(arg) => arg.value,
            };
            let Some(index) = parameter_index(params, list, i) else { continue };
            let (Some(native), Some(declared)) = (params.get(index), target.declared.get(index)) else { continue };
            if native.by_ref {
                continue;
            }
            self.null_coerces = builtin && !self.strict_types;
            self.value(Check::Argument, value, &native.ty, &declared.ty, |expected, given| {
                format!("Expected parameter of type '{expected}', '{given}' provided")
            });
            self.null_coerces = false;
        }
    }

    /// Missing, extra and named arguments.
    fn count(&mut self, target: &Target, list: &'a ArgumentList<'a>, args: &[&'a Argument<'a>]) {
        let params = &target.native;
        let positional = args.iter().take_while(|arg| matches!(arg, Argument::Positional(_))).count();
        let variadic = params.last().is_some_and(|param| param.variadic);
        let mut named: Vec<String> = Vec::new();
        for arg in args {
            let Argument::Named(arg) = arg else { continue };
            let name = lossy(arg.name.value);
            match params.iter().position(|param| param.name.as_deref() == Some(name.as_str())) {
                None if !variadic => {
                    self.push(Check::Named, true, arg.name.span, format!("Unknown named argument '${name}'"));
                }
                Some(index) if index < positional && !params[index].variadic => {
                    self.push(
                        Check::Named,
                        true,
                        arg.name.span,
                        format!("Named argument '${name}' overwrites a positional argument"),
                    );
                }
                _ => {}
            }
            named.push(name);
        }
        let required = params.iter().filter(|param| param.is_required()).count();
        let fixed = params.iter().filter(|param| !param.variadic).count();
        let missing: Vec<&SignatureParam> = params
            .iter()
            .enumerate()
            .filter(|(i, param)| {
                param.is_required() && *i >= positional && !param.name.as_ref().is_some_and(|n| named.contains(n))
            })
            .map(|(_, param)| param)
            .collect();
        let whole = list.left_parenthesis.join(list.right_parenthesis);
        if let Some(first) = missing.first() {
            let message = if named.is_empty() {
                let at_least = if required == fixed && !variadic { "" } else { "at least " };
                format!("Expected {at_least}{}, found {positional}", plural(required))
            } else {
                format!("Missing argument for parameter '${}'", first.name.as_deref().unwrap_or_default())
            };
            self.push(Check::Count, true, whole, message);
        }
        if !variadic && positional > fixed {
            let extra = args[fixed].span().join(args[positional - 1].span());
            let at_most = if required == fixed { "" } else { "at most " };
            let message = format!("Expected {at_most}{}, found {positional}", plural(fixed));
            self.push(Check::Count, target.extra_throws, extra, message);
        }
    }

    // ------------------------------------------------------------- values

    /// Checks `value` against the native type (certain problems) and, for
    /// strict mode, the declared type.
    fn value(
        &mut self,
        check: Check,
        value: &'a Expression<'a>,
        native: &Type,
        declared: &Type,
        message: impl Fn(&Type, &Type) -> String,
    ) {
        if self.cx.is_cancelled() {
            return;
        }
        let at = value.span().start.offset;
        let text = self.source(value.span());
        if self.checked.iter().any(|(checked, start, end)| *checked == text && *start <= at && at <= *end) {
            return;
        }
        let given = bind(&self.types.type_of(value, &self.frames), &self.here());
        if matches!(given, Type::Mixed | Type::Never | Type::Void) {
            return;
        }
        if !self.documented_only(value) && self.rejects(native, &given) {
            self.push(check, true, value.span(), message(native, &given.widen()));
        } else if self.strict_rejects(declared, &given) {
            self.push(check, false, value.span(), message(declared, &given.widen()));
        }
    }

    /// No value of `given` is accepted by `param` at runtime.
    fn rejects(&self, param: &Type, given: &Type) -> bool {
        if matches!(param, Type::Mixed) || has_templates(param) {
            return false;
        }
        given.members().iter().all(|member| {
            if member.is_subtype_of(param, self.resolver) {
                return false;
            }
            let Some(atom) = atom(member) else { return false };
            // A class no file declares (a constant in a docblock, a
            // missing `vendor/`): unknown.
            if let Atom::Object(class) = atom
                && self.resolver.class_model(class).is_none()
            {
                return false;
            }
            !param.members().iter().any(|accepting| self.may_accept(accepting, &atom))
        })
    }

    /// Whether type `param` (not a union) may accept a value of `atom`
    /// (uncertain cases accept).
    fn may_accept(&self, param: &Type, atom: &Atom<'_>) -> bool {
        let coercive = !self.strict_types;
        let nulls = self.null_coerces;
        match param {
            Type::Null => matches!(atom, Atom::Null),
            Type::Bool | Type::LiteralBool(_) => match atom {
                Atom::Bool => true,
                Atom::Int | Atom::Float | Atom::Str(_) => coercive,
                Atom::Null => nulls,
                Atom::Array | Atom::Object(_) => false,
            },
            Type::Int | Type::IntRange { .. } | Type::LiteralInt(_) => match atom {
                Atom::Int => true,
                Atom::Float | Atom::Bool => coercive,
                Atom::Str(value) => coercive && value.is_none_or(may_be_numeric),
                Atom::Null => nulls,
                Atom::Array | Atom::Object(_) => false,
            },
            Type::Float | Type::LiteralFloat(_) => match atom {
                Atom::Int | Atom::Float => true,
                Atom::Bool => coercive,
                Atom::Str(value) => coercive && value.is_none_or(may_be_numeric),
                Atom::Null => nulls,
                Atom::Array | Atom::Object(_) => false,
            },
            Type::String(_) | Type::LiteralString(_) | Type::ClassString(_) => match atom {
                Atom::Str(_) => true,
                Atom::Int | Atom::Float | Atom::Bool => coercive,
                Atom::Object(class) => coercive && !self.final_without(class, "__toString"),
                Atom::Null => nulls,
                Atom::Array => false,
            },
            Type::ArrayKey | Type::Numeric | Type::Scalar => match atom {
                Atom::Null => nulls,
                Atom::Array | Atom::Object(_) => false,
                _ => true,
            },
            Type::Array { .. } | Type::List { .. } | Type::Shape(_) => matches!(atom, Atom::Array),
            Type::Iterable { .. } => match atom {
                Atom::Array => true,
                Atom::Object(class) => self.may_be_instance(class, "Traversable"),
                _ => false,
            },
            Type::Callable(_) => match atom {
                Atom::Str(_) | Atom::Array => true,
                Atom::Object(class) => !self.final_without(class, "__invoke"),
                _ => false,
            },
            Type::Object => matches!(atom, Atom::Object(_)),
            Type::Named { fqn, .. } => match atom {
                Atom::Object(class) => self.may_be_instance(class, fqn),
                _ => false,
            },
            Type::Closure(_) => match atom {
                Atom::Object(class) => self.may_be_instance(class, "Closure"),
                _ => false,
            },
            Type::Intersection(parts) => match atom {
                Atom::Object(_) => parts.iter().all(|part| self.may_accept(part, atom)),
                _ => false,
            },
            // Unknown or not checked: `mixed`, templates, relative classes
            // not bound, resources, `void`.
            _ => true,
        }
    }

    /// Whether an object of class `class` may be an instance of `of`.
    fn may_be_instance(&self, class: &str, of: &str) -> bool {
        use crate::types::Hierarchy;
        if self.resolver.is_subclass(class, of) || self.resolver.is_subclass(of, class) {
            return true;
        }
        let (Some(object), Some(expected)) = (self.complete(class), self.complete(of)) else { return true };
        let is_final = |model: &ClassModel| model.class.modifiers.is_final || model.kind() == ClassKind::Enum;
        match (object.kind(), expected.kind()) {
            (ClassKind::Trait, _) | (_, ClassKind::Trait) => true,
            // A subclass of the object's class may implement it.
            (_, ClassKind::Interface) => !is_final(&object),
            // A subclass of the expected class may implement the interface.
            (ClassKind::Interface, _) => !is_final(&expected),
            _ => false,
        }
    }

    /// Whether `class` is final (or an enum) and has no method `method`:
    /// none of its objects has it.
    fn final_without(&self, class: &str, method: &str) -> bool {
        let Some(model) = self.complete(class) else { return false };
        (model.class.modifiers.is_final || model.kind() == ClassKind::Enum) && model.method(method).is_none()
    }

    /// Strict mode: some value of `given` isn't of the declared type.
    fn strict_rejects(&self, declared: &Type, given: &Type) -> bool {
        if matches!(declared, Type::Mixed) || has_templates(declared) || !self.classes_known(declared) {
            return false;
        }
        given.members().iter().any(|member| {
            if !self.is_known(member) || member.is_subtype_of(declared, self.resolver) {
                return false;
            }
            let accepts = |pred: fn(&Type) -> bool| declared.members().iter().any(pred);
            !match atom(member) {
                // `int` widens to `float`.
                Some(Atom::Int) => accepts(|ty| matches!(ty, Type::Float | Type::LiteralFloat(_))),
                // Function names and `[$object, 'method']` arrays.
                Some(Atom::Str(_) | Atom::Array) => accepts(|ty| matches!(ty, Type::Callable(_))),
                _ => false,
            }
        })
    }

    /// Whether every class `ty` names is complete.
    fn classes_known(&self, ty: &Type) -> bool {
        let mut known = true;
        ty.map(&mut |ty| {
            match ty {
                Type::Named { fqn, .. } => known &= self.complete(fqn).is_some(),
                Type::Relative(_) | Type::Template(_) => known = false,
                _ => {}
            }
            None
        });
        known
    }

    /// Whether a value type is precise enough for strict checks.
    fn is_known(&self, ty: &Type) -> bool {
        match ty {
            Type::Mixed | Type::Never | Type::Void | Type::Template(_) | Type::Relative(_) => false,
            Type::GenericRelative { .. } | Type::ClassConstant { .. } | Type::Callable(_) | Type::Resource => false,
            Type::Intersection(_) | Type::Object | Type::Iterable { .. } => false,
            Type::Named { fqn, .. } => {
                self.complete(fqn).is_some_and(|model| model.kind() != ClassKind::Trait)
                    && self.classes_known(ty)
                    && !mentions_mixed(ty)
            }
            other => !has_templates(other) && self.classes_known(other) && !mentions_mixed(other),
        }
    }

    // ------------------------------------------------------------ returns

    fn r#return(&mut self, node: &'a Return<'a>) {
        let Some(value) = node.value else { return };
        let Some((hint, doc)) = self.function_return() else { return };
        self.returned(value, hint, doc);
    }

    /// The return type hint and docblock (with its templates) of the
    /// innermost function-like.
    fn function_return(&self) -> Option<(&'a FunctionLikeReturnTypeHint<'a>, Option<ReturnDoc>)> {
        let summary = self.cx.summary();
        match self.frames.iter().rev().find(|frame| !matches!(frame, Frame::Class(_)))? {
            Frame::Function(node) => {
                let start = node.name.span.start.offset;
                let doc = summary
                    .functions
                    .iter()
                    .find(|f| f.name_loc.start == start)
                    .and_then(|f| f.doc.as_deref().cloned())
                    .map(|doc| {
                        let templates = doc.local_type_names().map(str::to_owned).collect();
                        (doc, templates)
                    });
                Some((node.return_type_hint.as_ref()?, doc))
            }
            Frame::Method(node) => {
                let start = node.name.span.start.offset;
                let doc = summary.class_likes.iter().find_map(|class| {
                    let method = class.methods.iter().find(|m| m.name_loc.start == start)?;
                    let doc = method.doc.as_deref()?.clone();
                    let templates = doc
                        .local_type_names()
                        .chain(class.doc.iter().flat_map(|doc| doc.local_type_names()))
                        .map(str::to_owned)
                        .collect();
                    Some((doc, templates))
                });
                Some((node.return_type_hint.as_ref()?, doc))
            }
            Frame::Closure(node) => Some((node.return_type_hint.as_ref()?, None)),
            Frame::Arrow(_) | Frame::Class(_) => None,
        }
    }

    fn returned(
        &mut self,
        value: &'a Expression<'a>,
        hint: &'a FunctionLikeReturnTypeHint<'a>,
        doc: Option<ReturnDoc>,
    ) {
        let scope = self.cx.names().scope_at(hint.span().start.offset);
        let classes = self.here();
        let native = bind(&Type::from_hint(&crate::summary::type_hint(scope, &hint.hint)), &classes);
        let generator = native.members().iter().any(|ty| match ty {
            Type::Named { fqn, .. } => GENERATOR_TYPES.iter().any(|g| g.eq_ignore_ascii_case(fqn)),
            Type::Iterable { .. } => true,
            _ => false,
        });
        if generator || matches!(native, Type::Void | Type::Never | Type::Mixed) {
            return;
        }
        let declared = doc
            .and_then(|(doc, templates)| {
                let templates: Vec<&str> = templates.iter().map(String::as_str).collect();
                doc.return_type.as_ref().map(|ty| Type::from_doc(ty, &templates))
            })
            .map(|ty| bind(&ty, &classes))
            .unwrap_or_else(|| native.clone());
        self.value(Check::Return, value, &native, &declared, |expected, given| {
            format!("Return value is expected to be '{expected}', '{given}' returned")
        });
    }

    fn arrow(&mut self, node: &'a ArrowFunction<'a>) {
        if let Some(hint) = &node.return_type_hint {
            self.returned(node.expression, hint, None);
        }
    }

    // --------------------------------------------------------- properties

    fn assignment(&mut self, lhs: &'a Expression<'a>, rhs: &'a Expression<'a>) {
        let (receiver, name) = match lhs {
            Expression::Access(Access::Property(access)) => {
                let ClassLikeMemberSelector::Identifier(name) = &access.property else { return };
                if chain_depth(access.object) > MAX_CHAIN {
                    return;
                }
                (self.types.type_of(access.object, &self.frames), lossy(name.value))
            }
            Expression::Access(Access::StaticProperty(access)) => {
                let Variable::Direct(variable) = &access.property else { return };
                (
                    self.types.class_ref(access.class, &self.frames),
                    lossy(variable.name).trim_start_matches('$').to_owned(),
                )
            }
            _ => return,
        };
        let context = self.context();
        let parts: Vec<&Type> = receiver.members().iter().filter(|part| **part != Type::Null).collect();
        if parts.is_empty() || !parts.iter().all(|part| matches!(part, Type::Named { .. } | Type::Relative(_))) {
            return;
        }
        let models = self.resolver.class_models(&receiver, &context);
        let mut chosen = None;
        for model in &models {
            let Some(property) = model.property(&name) else { return };
            let Some(declared) = property.declared() else { return };
            let Some(hint) = &declared.type_hint else { return };
            if declared.has_hooks {
                return;
            }
            let classes = Classes {
                self_class: Some(property.self_class.clone()),
                static_class: Some(model.fqn().to_owned()),
                parent: self.resolver.class_model(&property.self_class).and_then(|m| m.parents.first().cloned()),
            };
            let native = bind(&Type::from_hint(hint), &classes);
            match &chosen {
                None => chosen = Some((native, classes)),
                Some((first, _)) if *first == native => {}
                Some(_) => return,
            }
        }
        let Some((native, classes)) = chosen else { return };
        let declared = bind(&self.resolver.property_type(&receiver, &name, &context), &classes);
        self.value(Check::Property, rhs, &native, &declared, |expected, given| {
            format!("Property '${name}' expects '{expected}', '{given}' assigned")
        });
    }

    fn expression(&mut self, expr: &'a Expression<'a>) {
        if self.cx.is_cancelled() {
            return;
        }
        self.record_checks(expr);
        match expr {
            Expression::Call(Call::Function(_) | Call::Method(_) | Call::NullSafeMethod(_) | Call::StaticMethod(_))
            | Expression::Instantiation(_) => self.call(expr),
            Expression::Assignment(assignment) if matches!(assignment.operator, AssignmentOperator::Assign(_)) => {
                self.assignment(assignment.lhs, assignment.rhs)
            }
            _ => {}
        }
    }

    /// Records the non-variable expressions `expr` checks the type of.
    fn record_checks(&mut self, expr: &'a Expression<'a>) {
        let mut subjects: Vec<&'a Expression<'a>> = Vec::new();
        match expr {
            Expression::Call(Call::Function(call)) => {
                let Expression::Identifier(callee) = call.function else { return };
                let callee = callee.value();
                let callee = callee.rsplit(|b| *b == b'\\').next().unwrap_or(callee).to_ascii_lowercase();
                if callee.starts_with(b"is_") || callee == b"gettype" || callee == b"get_debug_type" {
                    subjects.extend(call.argument_list.arguments.iter().map(|arg| arg.value()));
                }
            }
            Expression::Binary(binary)
                if matches!(
                    binary.operator,
                    BinaryOperator::Instanceof(_)
                        | BinaryOperator::Identical(_)
                        | BinaryOperator::NotIdentical(_)
                        | BinaryOperator::Equal(_)
                        | BinaryOperator::NotEqual(_)
                        | BinaryOperator::AngledNotEqual(_)
                        | BinaryOperator::NullCoalesce(_)
                ) =>
            {
                subjects.push(binary.lhs);
                subjects.push(binary.rhs);
            }
            Expression::Construct(Construct::Isset(isset)) => subjects.extend(isset.values.iter()),
            Expression::Construct(Construct::Empty(empty)) => subjects.push(empty.value),
            _ => return,
        }
        let end = self.scope_end();
        for subject in subjects {
            if matches!(subject, Expression::Variable(_) | Expression::Literal(_)) {
                continue;
            }
            let text = self.source(subject.span());
            self.checked.push((text, expr.span().start.offset, end));
        }
    }

    /// Whether the type of `value` comes from a docblock PHP doesn't
    /// enforce, or from `@mixin` forwarding: a parameter or property
    /// without a native type, a method reached through a mixin or a
    /// `@method` tag. Lenient mode doesn't trust those.
    fn documented_only(&self, value: &'a Expression<'a>) -> bool {
        match value {
            Expression::Parenthesized(inner) => self.documented_only(inner.expression),
            Expression::Variable(Variable::Direct(variable)) => self.parameters().is_some_and(|params| {
                params.parameters.iter().any(|param| param.variable.name == variable.name && param.hint.is_none())
            }),
            Expression::Access(Access::Property(access)) => {
                let ClassLikeMemberSelector::Identifier(name) = &access.property else { return false };
                let receiver = self.types.type_of(access.object, &self.frames);
                self.untyped_property(&receiver, &lossy(name.value))
            }
            Expression::Access(Access::NullSafeProperty(access)) => {
                let ClassLikeMemberSelector::Identifier(name) = &access.property else { return false };
                let receiver = self.types.type_of(access.object, &self.frames);
                self.untyped_property(&receiver, &lossy(name.value))
            }
            Expression::Access(Access::StaticProperty(access)) => {
                let Variable::Direct(variable) = &access.property else { return false };
                let receiver = self.types.class_ref(access.class, &self.frames);
                self.untyped_property(&receiver, lossy(variable.name).trim_start_matches('$'))
            }
            // Elements of objects (`ArrayAccess`, `FFI\CData`) aren't typed
            // reliably.
            Expression::ArrayAccess(access) => {
                let base = self.types.type_of(access.array, &self.frames);
                !base.members().iter().all(|ty| crate::types::ops::is_array(ty) || matches!(ty, Type::String(_)))
            }
            Expression::Call(Call::Method(call)) => self.via_mixin(call.object, &call.method, false),
            Expression::Call(Call::NullSafeMethod(call)) => self.via_mixin(call.object, &call.method, false),
            Expression::Call(Call::StaticMethod(call)) => self.via_mixin(call.class, &call.method, true),
            _ => false,
        }
    }

    /// The parameters of the innermost function-like.
    fn parameters(&self) -> Option<&'a FunctionLikeParameterList<'a>> {
        match self.frames.iter().rev().find(|frame| !matches!(frame, Frame::Class(_)))? {
            Frame::Function(node) => Some(&node.parameter_list),
            Frame::Method(node) => Some(&node.parameter_list),
            Frame::Closure(node) => Some(&node.parameter_list),
            Frame::Arrow(node) => Some(&node.parameter_list),
            Frame::Class(_) => None,
        }
    }

    /// Whether some class of `receiver` has property `name` without a
    /// native type (or reaches it through a mixin or `@property`).
    fn untyped_property(&self, receiver: &Type, name: &str) -> bool {
        self.resolver.class_models(receiver, &self.context()).iter().any(|model| {
            model.property(name).is_some_and(|property| {
                !matches!(property.origin, Origin::Declared | Origin::Trait)
                    || property.declared().is_none_or(|declared| declared.type_hint.is_none())
            })
        })
    }

    /// Whether method `selector` of `object` comes from a `@mixin` or a
    /// `@method` tag on some class of the receiver.
    fn via_mixin(&self, object: &'a Expression<'a>, selector: &ClassLikeMemberSelector<'_>, is_static: bool) -> bool {
        let ClassLikeMemberSelector::Identifier(name) = selector else { return false };
        if chain_depth(object) > MAX_CHAIN {
            return true;
        }
        let receiver = if is_static {
            self.types.class_ref(object, &self.frames)
        } else {
            self.types.type_of(object, &self.frames)
        };
        let name = lossy(name.value);
        self.resolver.class_models(&receiver, &self.context()).iter().any(|model| {
            model.method(&name).is_some_and(|method| matches!(method.origin, Origin::Mixin | Origin::Magic))
        })
    }

    /// Whether the innermost function-like probes what the installed
    /// version provides (`method_exists`, `property_exists`,
    /// `version_compare`, `PHP_VERSION_ID`): it calls APIs of several
    /// versions, only one of which the stubs and the index describe.
    fn version_dependent(&self) -> bool {
        let span = match self.frames.iter().rev().find(|frame| !matches!(frame, Frame::Class(_))) {
            Some(Frame::Function(node)) => node.span(),
            Some(Frame::Method(node)) => node.span(),
            Some(Frame::Closure(node)) => node.span(),
            Some(Frame::Arrow(node)) => node.span(),
            _ => return false,
        };
        let body = self.source(span);
        VERSION_PROBES.iter().any(|probe| body.contains(probe))
    }

    /// The end of the enclosing function-like, or of the file.
    fn scope_end(&self) -> u32 {
        match self.frames.iter().rev().find(|frame| !matches!(frame, Frame::Class(_))) {
            Some(Frame::Function(node)) => node.span().end.offset,
            Some(Frame::Method(node)) => node.span().end.offset,
            Some(Frame::Closure(node)) => node.span().end.offset,
            Some(Frame::Arrow(node)) => node.span().end.offset,
            _ => u32::MAX,
        }
    }

    fn source(&self, span: Span) -> String {
        let text = self.cx.text();
        text.get(span.start.offset as usize..span.end.offset as usize).unwrap_or_default().to_owned()
    }

    fn class(&mut self, name_start: u32) {
        let fqn = self
            .cx
            .summary()
            .class_likes
            .iter()
            .find(|class| class.name_loc.start == name_start)
            .map(|c| c.fqn.clone());
        self.frames.push(Frame::Class(fqn));
    }
}

/// The parameters with their native types (`mixed` without one), `null`
/// added for a `null` default (an implicitly nullable parameter).
fn native_params(params: &[Param], classes: &Classes) -> Vec<SignatureParam> {
    params
        .iter()
        .map(|param| {
            let ty = match &param.type_hint {
                Some(hint) => {
                    let ty = bind(&Type::from_hint(hint), classes);
                    if param.default.as_deref().is_some_and(|d| d.trim().eq_ignore_ascii_case("null")) {
                        ty.nullable()
                    } else {
                        ty
                    }
                }
                None => Type::Mixed,
            };
            SignatureParam {
                ty,
                name: Some(param.name.clone()),
                by_ref: param.by_ref,
                optional: param.default.is_some(),
                variadic: param.variadic,
            }
        })
        .collect()
}

/// `ty` with `self`, `static`/`$this` and `parent` replaced by the classes
/// they name (left as they are when unknown).
fn bind(ty: &Type, classes: &Classes) -> Type {
    ty.map(&mut |ty| {
        let (relative, args) = match ty {
            Type::Relative(relative) => (*relative, Vec::new()),
            Type::GenericRelative { relative, args } => (*relative, args.clone()),
            _ => return None,
        };
        let class = match relative {
            Relative::Self_ => classes.self_class.as_deref(),
            Relative::Static | Relative::This => classes.static_class.as_deref(),
            Relative::Parent => classes.parent.as_deref(),
        }?;
        Some(Type::generic(class, args))
    })
}

struct ScanWalker;

impl<'a, 'r> Walker<'a, 'a, Scan<'a, 'r>> for ScanWalker {
    fn walk_in_expression(&self, expr: &'a Expression<'a>, cx: &mut Scan<'a, 'r>) {
        cx.expression(expr);
    }

    fn walk_in_return(&self, node: &'a Return<'a>, cx: &mut Scan<'a, 'r>) {
        cx.r#return(node);
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
        cx.arrow(node);
    }
    fn walk_out_arrow_function(&self, _: &'a ArrowFunction<'a>, cx: &mut Scan<'a, 'r>) {
        cx.frames.pop();
    }
}
