//! String references: completion, goto, find usages, rename and document
//! highlights for string literals in known places (`config('app.name')`,
//! later `route('home')`, `view('posts.index')`, …).
//!
//! The design follows the public description of IntelliJ's reference
//! contributors (IntelliJ Community, Apache-2.0): a **place pattern**
//! ([`PlacePattern`]) says where a string sits (an argument of a function,
//! of a method of a class or its subclasses, of `new`; by position or by
//! name; the string itself or a key or value of an array argument, nested
//! or not), and a **reference kind** ([`ReferenceKind`]) says what such a
//! string names and supplies completion items, targets, usages, rename and
//! validation. Kinds are listed in [`kinds`]: `configKey` ([`config_key`]),
//! `envKey` ([`env_key`]), `translationKey` ([`translation_key`]),
//! `viteAsset` ([`vite_asset`]), `routeName` ([`route_name`]),
//! `controllerAction` and `resourceAction` ([`controller_action`]),
//! `middleware` ([`middleware`]), `viewName` ([`view_name`]), and
//! `validationRule` and `requestField` ([`validation_rule`]), and
//! `eloquentField` and `eloquentRelation` ([`eloquent`]), and `gate`,
//! `authGuard` and `passwordBroker` ([`gate`]), and `artisanCommand` and `artisanOption`
//! ([`artisan_command`]), and `livewireComponent` and `livewireParameter`
//! ([`livewire`]), and
//! `inertiaPage` ([`inertia_page`]), and `staticStrings` and
//! `directoryFiles` ([`rules`]).
//!
//! Besides the built-in patterns, the completion rules of the project's
//! `ide.json` files ([`crate::frameworks::laravel::ide_json`]) say where
//! strings of a kind sit ([`rules::rule_matches`]); the rule a string was
//! matched by is part of its site ([`SiteInfo::rule`]), and its `prefix`
//! option is put before the string's value ([`Subject::prefix`]).
//!
//! A place may also be the value a method returns
//! ([`CalleePattern::Return`]: what a Form Request's `rules()` returns), or
//! the default value of a property ([`CalleePattern::Property`]: a model's
//! `$fillable`).
//!
//! A kind may describe a usage for hover ([`ReferenceKind::hover`]) and say
//! what is wrong with one that names nothing ([`ReferenceKind::undefined`]),
//! which the "undefined …" inspections
//! ([`crate::inspect::laravel::UndefinedReference`]) and the problems of
//! Blade templates ([`PhpEngine::blade_problems`]) report.
//!
//! A kind sees the string's site ([`SiteInfo`]): its file, and the class it
//! is about (the `Foo::class` before it in its array, or the controller of
//! the route registering it), so `[PostController::class, 'index']` names a
//! method of `PostController`. Usages are compared by their canonical value
//! ([`ReferenceKind::canonical`]: `App\Http\Controllers\PostController@index`).
//!
//! The string at the caret is found in the document's parse, or, while it
//! is being typed and isn't closed yet, in a copy of the file with a closed
//! probe string in its place (as completion does), so a partial string
//! (`config('app.na`) works too. Find usages goes through the word index
//! (the words of the value and the kind's words) and checks each candidate
//! string against the patterns again. Blade templates are compiled first
//! ([`crate::blade::compile`]), so the strings of their directives and echoes
//! count too, at their places in the template.
//!
//! Usages that aren't string literals (`<livewire:counter />` tags) come
//! from [`ReferenceKind::markup_usages`]; find usages and rename from files
//! that aren't PHP (`.env`, Inertia pages) are in [`files`]. A rename edits
//! every declaration of the value ([`RenameTarget::declarations`]: each
//! locale's key, both `.env` files).
//!
//! Everything is off unless the project is a Laravel project
//! ([`PhpEngine::laravel`]).

pub mod artisan_command;
pub mod config_key;
pub mod controller_action;
mod controller_fixes;
pub mod db_table;
pub mod eloquent;
pub mod env_key;
pub mod files;
pub mod gate;
pub mod inertia_page;
pub mod intentions;
pub mod livewire;
pub mod middleware;
pub mod route_name;
pub mod rules;
#[cfg(test)]
mod tests;
pub mod translation_key;
pub mod validation_actions;
pub mod validation_rule;
pub mod view_name;
pub mod vite_asset;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ide_core::{
    CancellationToken, Diagnostic, DocId, FileEdit, IdeError, IdeResult, Location, Pos, Range, Severity, TextEdit,
    WorkspaceEdit,
};
use mago_span::{HasSpan, Span};
use mago_syntax::cst::{
    Access, Argument, ArgumentList, ArrayElement, Call, ClassLikeConstantSelector, ClassLikeMemberSelector, Expression,
    Literal,
};
use mago_syntax::walker::Walker;

use super::LaravelProject;
use super::ide_json::CompletionRule;
use super::routes::RouteAction;
use crate::complete::{Completion, CompletionKind, Completions};
use crate::engine::PhpEngine;
use crate::names::{FileNames, NameKind, Resolution, fqn_eq};
use crate::navigate::{Target, Usage, UsageKind};
use crate::signature::Callee;
use crate::summary::FileSummary;
use crate::syntax::ParsedFile;
use crate::types::{ExprTypes, Resolver, Type};

pub use artisan_command::{ArtisanCommandKind, ArtisanOptionKind};
pub use config_key::ConfigKey;
pub use controller_action::{ControllerAction, ResourceAction};
pub use db_table::DbTable;
pub use eloquent::{EloquentField, EloquentRelation};
pub use env_key::EnvKey;
pub use gate::{AuthGuard, Gate, PasswordBroker};
pub use inertia_page::InertiaPageKind;
pub use livewire::{LivewireComponentKind, LivewireParameterKind};
pub use middleware::Middleware;
pub use route_name::RouteName;
pub use rules::{DirectoryFiles, StaticStrings};
pub use translation_key::TranslationKey;
pub use validation_rule::{RequestField, ValidationRule};
pub use view_name::ViewName;
pub use vite_asset::ViteAsset;

// --------------------------------------------------------------- patterns

/// The call a [`PlacePattern`] is about.
#[derive(Clone, Copy, Debug)]
pub enum CalleePattern {
    /// A function, by FQN without the leading `\` (`config`).
    Function(&'static str),
    /// One of `names` (any case) called on one of `classes`, a subclass or
    /// an implementation of one (FQNs; `new` is `__construct`).
    Method { classes: &'static [&'static str], names: &'static [&'static str] },
    /// What one of `names` (any case), a method of one of `classes` or of a
    /// subclass, returns (`rules()` of a Form Request). The returned value
    /// is the argument at index 0.
    Return { classes: &'static [&'static str], names: &'static [&'static str] },
    /// What one of `names` (any case) returns in a Form Request (or a
    /// subclass of `form_request`), or in a class that validates with it
    /// (`Validator::make($data, $this->rules())` in the class or an
    /// ancestor, [`LaravelFacts::rule_methods`](crate::summary::LaravelFacts::rule_methods)).
    /// The returned value is the argument at index 0.
    Rules { form_request: &'static str, names: &'static [&'static str] },
    /// The default value of one of the properties `names` (without `$`) of
    /// one of `classes` or of a subclass (a model's `$fillable`). The value
    /// is the argument at index 0.
    Property { classes: &'static [&'static str], names: &'static [&'static str] },
}

/// Where in the argument the string sits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Position {
    /// The argument is the string.
    Argument,
    /// A key of the array argument.
    ArrayKey,
    /// A value of the array argument.
    ArrayValue,
    /// A value without a key of the array argument (a list item).
    ListValue,
    /// The value under this key of the array argument.
    ValueOfKey(&'static str),
}

/// A place a string literal can sit in; see the module documentation.
#[derive(Clone, Copy, Debug)]
pub struct PlacePattern {
    pub callee: CalleePattern,
    /// The parameter: its position and its name (for named arguments).
    pub index: usize,
    pub name: &'static str,
    pub position: Position,
    /// The array position also holds in arrays nested in the argument at
    /// any depth (as values).
    pub nested: bool,
}

impl PlacePattern {
    /// The string itself is argument `index` (named `name`) of `callee`.
    pub const fn argument(callee: CalleePattern, index: usize, name: &'static str) -> Self {
        Self { callee, index, name, position: Position::Argument, nested: false }
    }

    pub const fn at(self, position: Position) -> Self {
        Self { position, ..self }
    }

    pub const fn nested(self) -> Self {
        Self { nested: true, ..self }
    }

    /// The function or method names the pattern is about (for a quick
    /// look at a call before its types are worked out).
    fn names(&self) -> Vec<&'static str> {
        match self.callee {
            CalleePattern::Function(fqn) => vec![fqn.rsplit('\\').next().unwrap_or(fqn)],
            CalleePattern::Method { names, .. }
            | CalleePattern::Return { names, .. }
            | CalleePattern::Rules { names, .. }
            | CalleePattern::Property { names, .. } => names.to_vec(),
        }
    }

    /// Whether `site` is in this place.
    pub fn matches(&self, site: &StringSite, resolver: &Resolver<'_>) -> bool {
        let argument = match &site.argument_name {
            Some(name) => name == self.name,
            None => site.index == Some(self.index),
        };
        argument && self.position_matches(&site.steps) && self.callee_matches(&site.target, resolver)
    }

    fn position_matches(&self, steps: &[ArrayStep]) -> bool {
        let Some((last, outer)) = steps.split_last() else { return self.position == Position::Argument };
        let last_matches = match (self.position, last) {
            (Position::Argument, _) => false,
            (Position::ArrayKey, ArrayStep::Key) => true,
            (Position::ArrayValue, ArrayStep::Value(_)) => true,
            (Position::ListValue, ArrayStep::Value(None)) => true,
            (Position::ValueOfKey(wanted), ArrayStep::Value(Some(key))) => key == wanted,
            _ => false,
        };
        last_matches
            && (outer.is_empty() || (self.nested && outer.iter().all(|step| matches!(step, ArrayStep::Value(_)))))
    }

    fn callee_matches(&self, target: &CallTarget, resolver: &Resolver<'_>) -> bool {
        match (self.callee, target) {
            (CalleePattern::Function(wanted), CallTarget::Function(candidates)) => {
                candidates.iter().any(|fqn| fqn_eq(NameKind::Function, fqn.trim_start_matches('\\'), wanted))
            }
            (CalleePattern::Method { classes, names }, CallTarget::Method { classes: receivers, name, .. }) => {
                names.iter().any(|wanted| wanted.eq_ignore_ascii_case(name))
                    && receivers.iter().any(|receiver| {
                        classes.iter().any(|class| fqn_eq(NameKind::ClassLike, receiver, class))
                            || resolver.class_model(receiver).is_some_and(|model| {
                                classes.iter().any(|class| class.contains('\\') && model.is_subclass_of(class))
                                    // A method of a listed trait the class uses
                                    // (`AuthorizesRequests::authorize`).
                                    || model.method(name).is_some_and(|method| {
                                        classes.iter().any(|class| {
                                            fqn_eq(NameKind::ClassLike, method.declaring.fqn.trim_start_matches('\\'), class)
                                        })
                                    })
                            })
                    })
            }
            (CalleePattern::Return { classes, names }, CallTarget::Return { class, method })
            | (CalleePattern::Property { classes, names }, CallTarget::Property { class, name: method }) => {
                names.iter().any(|wanted| wanted.eq_ignore_ascii_case(method))
                    && (classes.iter().any(|wanted| fqn_eq(NameKind::ClassLike, class, wanted))
                        || resolver.class_model(class).is_some_and(|model| {
                            classes.iter().any(|wanted| wanted.contains('\\') && model.is_subclass_of(wanted))
                        }))
            }
            (CalleePattern::Rules { form_request, names }, CallTarget::Return { class, method }) => {
                names.iter().any(|wanted| wanted.eq_ignore_ascii_case(method))
                    && resolver.class_model(class).is_some_and(|model| {
                        model.is_subclass_of(form_request)
                            || resolver.laravel().returns_rules(model.fqn(), &model.parents, method)
                    })
            }
            _ => false,
        }
    }
}

// ------------------------------------------------------------------ sites

/// The call a string literal is an argument of.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CallTarget {
    /// A function: the FQNs the name may mean (the namespaced one, then
    /// the global one for an unqualified name).
    Function(Vec<String>),
    /// A method of the receiver's classes (FQNs); `models` are the models
    /// the receiver's generic arguments name (`Builder<Post>`), `tables`
    /// the tables they name (`DB::table('posts')` is a
    /// `Query\Builder<'posts'>`).
    Method { classes: Vec<String>, name: String, models: Vec<String>, tables: Vec<String> },
    /// The value a method returns: the class declaring it (FQN) and its
    /// name.
    Return { class: String, method: String },
    /// The default value of a property: the class declaring it (FQN) and
    /// its name without `$`.
    Property { class: String, name: String },
}

/// One step from an argument into the arrays around the string.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ArrayStep {
    Key,
    /// A value, with its string key when it has one.
    Value(Option<String>),
}

/// A string literal argument of a call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StringSite {
    /// The byte range of the content, inside the quotes.
    pub start: u32,
    pub end: u32,
    /// The content as written.
    pub value: String,
    pub target: CallTarget,
    /// The position among the positional arguments; `None` for a named
    /// argument.
    pub index: Option<usize>,
    pub argument_name: Option<String>,
    /// From the argument down to the string.
    pub steps: Vec<ArrayStep>,
    /// The class a `Foo::class` element of the string's array names.
    pub class: Option<String>,
    /// The byte the call (or the `return`) starts at: strings of one call
    /// share it.
    pub call: u32,
    /// What the positional argument after the string's argument is, for
    /// kinds that ask ([`ReferenceKind::uses_next_argument`]): the classes
    /// of its type (`$post` in `Gate::allows('update', $post)`, the first
    /// element of an array), the class of `Post::class`, or the content of
    /// a string literal.
    pub next_argument: Vec<String>,
    /// For a string of a later argument, the first positional argument when
    /// it is a string literal (its content) or `Foo::class` (the class):
    /// `counter` for the keys of `@livewire('counter', ['start' => 1])`.
    pub first_argument: Option<String>,
}

/// Helpers that return a service when called without arguments, as
/// Laravel's `helpers.php` documents them (`config()` is the repository).
const HELPER_INSTANCES: &[(&str, &str)] = &[
    ("config", "Illuminate\\Config\\Repository"),
    ("redirect", "Illuminate\\Routing\\Redirector"),
    ("url", "Illuminate\\Routing\\UrlGenerator"),
    ("response", "Illuminate\\Routing\\ResponseFactory"),
    ("view", "Illuminate\\View\\Factory"),
    ("trans", "Illuminate\\Translation\\Translator"),
    ("auth", "Illuminate\\Auth\\AuthManager"),
];

/// What a string literal sits in: a call, or the value a method returns.
#[derive(Clone)]
enum SiteCall<'a> {
    Call(&'a Expression<'a>),
    /// The class (as written, with the offset of its name), the method and
    /// the offset of the `return`.
    Return {
        class: (String, u32),
        method: String,
        at: u32,
    },
    /// The class (as above), the property (without `$`) and the offset of
    /// its variable.
    Property {
        class: (String, u32),
        name: String,
        at: u32,
    },
}

impl SiteCall<'_> {
    fn start(&self) -> u32 {
        match self {
            SiteCall::Call(call) => call.span().start.offset,
            SiteCall::Return { at, .. } | SiteCall::Property { at, .. } => *at,
        }
    }
}

/// A class-like, function or method the walker is in.
enum Frame {
    /// A named class (its name and offset), or another class-like.
    Class(Option<(String, u32)>),
    Method(String),
    Function,
}

/// A string literal argument before its call is resolved.
struct RawSite<'a> {
    call: SiteCall<'a>,
    span: Span,
    index: Option<usize>,
    argument_name: Option<String>,
    steps: Vec<ArrayStep>,
    /// The `Foo::class` of the string's array: the name and its offset.
    class: Option<(String, u32)>,
    /// The positional argument after the string's argument, when its call
    /// is named like a pattern of a kind using it.
    next: Option<&'a Expression<'a>>,
    /// The first positional argument, for strings of later arguments.
    first: Option<&'a Expression<'a>>,
}

struct Collect<'a, 'n> {
    /// Only the literal starting at this offset.
    want: Option<u32>,
    /// The function and method names asked about, lower case.
    names: &'n HashSet<String>,
    /// Those of kinds using the argument after the string's.
    next_names: &'n HashSet<String>,
    /// The argument after the one being walked, for those calls.
    next: Option<&'a Expression<'a>>,
    /// The first positional argument, while a later one is walked.
    first: Option<&'a Expression<'a>>,
    out: Vec<RawSite<'a>>,
    /// The class-likes, functions and methods around the walker.
    frames: Vec<Frame>,
}

struct SiteWalker;

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn member_name(selector: &ClassLikeMemberSelector<'_>) -> Option<String> {
    match selector {
        ClassLikeMemberSelector::Identifier(name) => Some(lossy(name.value)),
        _ => None,
    }
}

/// The name of what `expr` calls and its arguments.
fn call_parts<'a>(expr: &'a Expression<'a>) -> Option<(String, &'a ArgumentList<'a>)> {
    match expr {
        Expression::Call(Call::Function(call)) => match call.function {
            Expression::Identifier(identifier) => {
                let name = lossy(identifier.value());
                let short = name.rsplit('\\').next().unwrap_or(&name).to_owned();
                Some((short, &call.argument_list))
            }
            _ => None,
        },
        Expression::Call(Call::Method(call)) => Some((member_name(&call.method)?, &call.argument_list)),
        Expression::Call(Call::NullSafeMethod(call)) => Some((member_name(&call.method)?, &call.argument_list)),
        Expression::Call(Call::StaticMethod(call)) => Some((member_name(&call.method)?, &call.argument_list)),
        Expression::Instantiation(instantiation) => {
            Some(("__construct".to_owned(), instantiation.argument_list.as_ref()?))
        }
        _ => None,
    }
}

impl<'a> Collect<'a, '_> {
    fn strings(
        &mut self,
        call: &SiteCall<'a>,
        value: &'a Expression<'a>,
        at: (Option<usize>, Option<&str>),
        steps: &mut Vec<ArrayStep>,
        class: Option<&(String, u32)>,
    ) {
        match value {
            Expression::Literal(Literal::String(string)) => {
                let span = string.span();
                if self.want.is_none_or(|want| want == span.start.offset) {
                    self.out.push(RawSite {
                        call: call.clone(),
                        span,
                        index: at.0,
                        argument_name: at.1.map(str::to_owned),
                        steps: steps.clone(),
                        class: class.cloned(),
                        next: self.next,
                        first: self.first,
                    });
                }
            }
            Expression::Parenthesized(inner) => self.strings(call, inner.expression, at, steps, class),
            Expression::Array(_) | Expression::LegacyArray(_) => {
                let elements: Vec<&ArrayElement<'_>> = match value {
                    Expression::Array(array) => array.elements.iter().collect(),
                    Expression::LegacyArray(array) => array.elements.iter().collect(),
                    _ => Vec::new(),
                };
                let class = elements.iter().find_map(|element| match element {
                    ArrayElement::Value(element) => class_constant(element.value),
                    _ => None,
                });
                let class = class.as_ref();
                for element in elements {
                    match element {
                        ArrayElement::KeyValue(element) => {
                            steps.push(ArrayStep::Key);
                            self.strings(call, element.key, at, steps, class);
                            steps.pop();
                            let key = match element.key {
                                Expression::Literal(Literal::String(string)) => string.value.map(lossy),
                                _ => None,
                            };
                            steps.push(ArrayStep::Value(key));
                            self.strings(call, element.value, at, steps, class);
                            steps.pop();
                        }
                        ArrayElement::Value(element) => {
                            steps.push(ArrayStep::Value(None));
                            self.strings(call, element.value, at, steps, class);
                            steps.pop();
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
}

/// `Foo::class`: the name as written and its offset.
fn class_constant(expr: &Expression<'_>) -> Option<(String, u32)> {
    let Expression::Access(Access::ClassConstant(access)) = expr else { return None };
    let ClassLikeConstantSelector::Identifier(constant) = &access.constant else { return None };
    let Expression::Identifier(identifier) = access.class else { return None };
    constant.value.eq_ignore_ascii_case(b"class").then(|| (lossy(identifier.value()), identifier.span().start.offset))
}

impl<'a> Walker<'a, 'a, Collect<'a, '_>> for SiteWalker {
    fn walk_in_class(&self, class: &'a mago_syntax::cst::Class<'a>, cx: &mut Collect<'a, '_>) {
        cx.frames.push(Frame::Class(Some((lossy(class.name.value), class.name.span.start.offset))));
    }

    fn walk_out_class(&self, _: &'a mago_syntax::cst::Class<'a>, cx: &mut Collect<'a, '_>) {
        cx.frames.pop();
    }

    fn walk_in_anonymous_class(&self, _: &'a mago_syntax::cst::AnonymousClass<'a>, cx: &mut Collect<'a, '_>) {
        cx.frames.push(Frame::Class(None));
    }

    fn walk_out_anonymous_class(&self, _: &'a mago_syntax::cst::AnonymousClass<'a>, cx: &mut Collect<'a, '_>) {
        cx.frames.pop();
    }

    fn walk_in_trait(&self, _: &'a mago_syntax::cst::Trait<'a>, cx: &mut Collect<'a, '_>) {
        cx.frames.push(Frame::Class(None));
    }

    fn walk_out_trait(&self, _: &'a mago_syntax::cst::Trait<'a>, cx: &mut Collect<'a, '_>) {
        cx.frames.pop();
    }

    fn walk_in_method(&self, method: &'a mago_syntax::cst::Method<'a>, cx: &mut Collect<'a, '_>) {
        cx.frames.push(Frame::Method(lossy(method.name.value)));
    }

    fn walk_out_method(&self, _: &'a mago_syntax::cst::Method<'a>, cx: &mut Collect<'a, '_>) {
        cx.frames.pop();
    }

    fn walk_in_function(&self, _: &'a mago_syntax::cst::Function<'a>, cx: &mut Collect<'a, '_>) {
        cx.frames.push(Frame::Function);
    }

    fn walk_out_function(&self, _: &'a mago_syntax::cst::Function<'a>, cx: &mut Collect<'a, '_>) {
        cx.frames.pop();
    }

    fn walk_in_closure(&self, _: &'a mago_syntax::cst::Closure<'a>, cx: &mut Collect<'a, '_>) {
        cx.frames.push(Frame::Function);
    }

    fn walk_out_closure(&self, _: &'a mago_syntax::cst::Closure<'a>, cx: &mut Collect<'a, '_>) {
        cx.frames.pop();
    }

    fn walk_in_arrow_function(&self, _: &'a mago_syntax::cst::ArrowFunction<'a>, cx: &mut Collect<'a, '_>) {
        cx.frames.push(Frame::Function);
    }

    fn walk_out_arrow_function(&self, _: &'a mago_syntax::cst::ArrowFunction<'a>, cx: &mut Collect<'a, '_>) {
        cx.frames.pop();
    }

    fn walk_in_return(&self, r#return: &'a mago_syntax::cst::Return<'a>, cx: &mut Collect<'a, '_>) {
        let Some(value) = r#return.value else { return };
        let [.., Frame::Class(Some(class)), Frame::Method(method)] = cx.frames.as_slice() else { return };
        if !cx.names.contains(&method.to_ascii_lowercase()) {
            return;
        }
        let call = SiteCall::Return { class: class.clone(), method: method.clone(), at: r#return.span().start.offset };
        cx.strings(&call, value, (Some(0), None), &mut Vec::new(), None);
    }

    fn walk_in_property_concrete_item(
        &self,
        item: &'a mago_syntax::cst::PropertyConcreteItem<'a>,
        cx: &mut Collect<'a, '_>,
    ) {
        let [.., Frame::Class(Some(class))] = cx.frames.as_slice() else { return };
        let name = lossy(item.variable.name.strip_prefix(b"$").unwrap_or(item.variable.name));
        if !cx.names.contains(&name.to_ascii_lowercase()) {
            return;
        }
        let call = SiteCall::Property { class: class.clone(), name, at: item.variable.span.start.offset };
        cx.strings(&call, item.value, (Some(0), None), &mut Vec::new(), None);
    }

    fn walk_in_expression(&self, expr: &'a Expression<'a>, cx: &mut Collect<'a, '_>) {
        let Some((name, list)) = call_parts(expr) else { return };
        if !cx.names.contains(&name.to_ascii_lowercase()) {
            return;
        }
        let call = SiteCall::Call(expr);
        let wants_next = cx.next_names.contains(&name.to_ascii_lowercase());
        let positionals: Vec<&'a Expression<'a>> = list
            .arguments
            .iter()
            .filter_map(|argument| match argument {
                Argument::Positional(argument) => Some(argument.value),
                Argument::Named(_) => None,
            })
            .collect();
        let mut positional = 0;
        for argument in list.arguments.iter() {
            let mut steps = Vec::new();
            match argument {
                Argument::Positional(argument) => {
                    cx.next = if wants_next { positionals.get(positional + 1).copied() } else { None };
                    cx.first = if positional > 0 { positionals.first().copied() } else { None };
                    cx.strings(&call, argument.value, (Some(positional), None), &mut steps, None);
                    cx.next = None;
                    cx.first = None;
                    positional += 1;
                }
                Argument::Named(argument) => {
                    let name = lossy(argument.name.value);
                    cx.strings(&call, argument.value, (None, Some(&name)), &mut steps, None);
                }
            }
        }
    }
}

/// The string literal arguments of `parsed` (only the one starting at
/// `want` when given) in calls named like a pattern of `kinds`, with their
/// calls resolved.
pub fn sites(
    parsed: &ParsedFile,
    resolver: &Resolver<'_>,
    kinds: &[&dyn ReferenceKind],
    want: Option<u32>,
) -> Vec<StringSite> {
    sites_with(parsed, resolver, kinds, &[], want)
}

/// [`sites`], with the calls `rules` of `kinds` name too.
pub fn sites_with(
    parsed: &ParsedFile,
    resolver: &Resolver<'_>,
    kinds: &[&dyn ReferenceKind],
    rules: &[CompletionRule],
    want: Option<u32>,
) -> Vec<StringSite> {
    let rule_names = |next: bool| {
        rules
            .iter()
            .filter(|rule| kinds.iter().any(|kind| kind.id() == rule.kind && (!next || kind.uses_next_argument())))
            .flat_map(|rule| rule.conditions.iter().flat_map(|condition| condition.call_names()))
            .collect::<Vec<String>>()
    };
    let mut names: HashSet<String> = kinds
        .iter()
        .flat_map(|kind| kind.patterns().iter().flat_map(PlacePattern::names))
        .map(str::to_ascii_lowercase)
        .collect();
    names.extend(rule_names(false));
    let mut next_names: HashSet<String> = kinds
        .iter()
        .filter(|kind| kind.uses_next_argument())
        .flat_map(|kind| kind.patterns().iter().flat_map(PlacePattern::names))
        .map(str::to_ascii_lowercase)
        .collect();
    next_names.extend(rule_names(true));
    let mut collect = Collect {
        want,
        names: &names,
        next_names: &next_names,
        next: None,
        first: None,
        out: Vec::new(),
        frames: Vec::new(),
    };
    SiteWalker.walk_program(parsed.program(), &mut collect);
    if collect.out.is_empty() {
        return Vec::new();
    }
    let file_names = FileNames::resolve(parsed);
    let summary = FileSummary::extract(parsed);
    let types = ExprTypes::new(parsed, &file_names, &summary, resolver);
    let text = parsed.text();
    collect
        .out
        .into_iter()
        .filter_map(|raw| {
            let call = raw.call.start();
            let target = match raw.call {
                SiteCall::Call(expr) => call_target(&types, &file_names, resolver, expr)?,
                SiteCall::Return { class: (name, offset), method, .. } => {
                    let class = match file_names.scope_at(offset).resolve(NameKind::ClassLike, &name).resolution {
                        Resolution::Fqn(fqn) | Resolution::Fallback { namespaced: fqn, .. } => fqn,
                        Resolution::Relative(_) => return None,
                    };
                    CallTarget::Return { class: class.trim_start_matches('\\').to_owned(), method }
                }
                SiteCall::Property { class: (class, offset), name, .. } => {
                    let class = match file_names.scope_at(offset).resolve(NameKind::ClassLike, &class).resolution {
                        Resolution::Fqn(fqn) | Resolution::Fallback { namespaced: fqn, .. } => fqn,
                        Resolution::Relative(_) => return None,
                    };
                    CallTarget::Property { class: class.trim_start_matches('\\').to_owned(), name }
                }
            };
            let class = raw.class.and_then(|(name, offset)| {
                match file_names.scope_at(offset).resolve(NameKind::ClassLike, &name).resolution {
                    Resolution::Fqn(fqn) | Resolution::Fallback { namespaced: fqn, .. } => {
                        Some(fqn.trim_start_matches('\\').to_owned())
                    }
                    Resolution::Relative(_) => None,
                }
            });
            let next_argument = raw.next.map(|next| next_argument(&types, &file_names, next)).unwrap_or_default();
            let first_argument = raw.first.and_then(|first| first_argument(&file_names, first));
            let start = raw.span.start.offset + 1;
            let end = raw.span.end.offset.saturating_sub(1).max(start);
            Some(StringSite {
                start,
                end,
                value: text.get(start as usize..end as usize).unwrap_or_default().to_owned(),
                target,
                index: raw.index,
                argument_name: raw.argument_name,
                steps: raw.steps,
                class,
                call,
                next_argument,
                first_argument,
            })
        })
        .collect()
}

/// See [`StringSite::first_argument`].
fn first_argument(names: &FileNames, expr: &Expression<'_>) -> Option<String> {
    if let Some((name, offset)) = class_constant(expr) {
        return match names.scope_at(offset).resolve(NameKind::ClassLike, &name).resolution {
            Resolution::Fqn(fqn) | Resolution::Fallback { namespaced: fqn, .. } => {
                Some(fqn.trim_start_matches('\\').to_owned())
            }
            Resolution::Relative(_) => None,
        };
    }
    match expr {
        Expression::Literal(Literal::String(string)) => string.value.map(lossy),
        _ => None,
    }
}

/// See [`StringSite::next_argument`].
fn next_argument<'a>(types: &ExprTypes<'a, '_>, names: &FileNames, expr: &'a Expression<'a>) -> Vec<String> {
    let first = |elements: Vec<&'a ArrayElement<'a>>| match elements.first() {
        Some(ArrayElement::Value(element)) => Some(element.value),
        _ => None,
    };
    let expr = match expr {
        Expression::Array(array) => first(array.elements.iter().collect()),
        Expression::LegacyArray(array) => first(array.elements.iter().collect()),
        _ => Some(expr),
    };
    let Some(expr) = expr else { return Vec::new() };
    if let Some((name, offset)) = class_constant(expr) {
        return match names.scope_at(offset).resolve(NameKind::ClassLike, &name).resolution {
            Resolution::Fqn(fqn) | Resolution::Fallback { namespaced: fqn, .. } => {
                vec![fqn.trim_start_matches('\\').to_owned()]
            }
            Resolution::Relative(_) => Vec::new(),
        };
    }
    if let Expression::Literal(Literal::String(string)) = expr {
        return string.value.map(lossy).into_iter().collect();
    }
    let frames = types.locate(expr.span().start.offset).expression.map(|(_, frames)| frames).unwrap_or_default();
    let mut out: Vec<String> = Vec::new();
    for member in types.type_of(expr, &frames).members() {
        if let Type::Named { fqn, .. } = member {
            let fqn = fqn.trim_start_matches('\\').to_owned();
            if !out.contains(&fqn) {
                out.push(fqn);
            }
        }
    }
    out
}

fn call_target<'a>(
    types: &ExprTypes<'a, '_>,
    names: &FileNames,
    resolver: &Resolver<'_>,
    call: &'a Expression<'a>,
) -> Option<CallTarget> {
    if let Expression::Call(Call::Function(function)) = call {
        let Expression::Identifier(identifier) = function.function else { return None };
        let name = lossy(identifier.value());
        let resolved = names.scope_at(identifier.span().start.offset).resolve(NameKind::Function, &name);
        return Some(CallTarget::Function(resolved.resolution.candidates().map(str::to_owned).collect()));
    }
    let frames = types.locate(call.span().start.offset).expression.map(|(_, frames)| frames).unwrap_or_default();
    let Callee::Method { receiver, name } = crate::signature::callee(types, names, resolver, call, &frames)? else {
        return None;
    };
    let mut classes: Vec<String> = receiver
        .members()
        .iter()
        .filter_map(|member| match member {
            Type::Named { fqn, .. } => Some(fqn.trim_start_matches('\\').to_owned()),
            // `$this`, `static`, `self`: the class the call is in.
            Type::Relative(_) | Type::GenericRelative { .. } => types.context(&frames).self_class,
            _ => None,
        })
        .collect();
    let object = match call {
        Expression::Call(Call::Method(method)) => Some(method.object),
        Expression::Call(Call::NullSafeMethod(method)) => Some(method.object),
        _ => None,
    };
    if let Some(class) = object.and_then(helper_instance) {
        classes.push(class.to_owned());
    }
    let mut models: Vec<String> = Vec::new();
    let mut tables: Vec<String> = Vec::new();
    for member in receiver.members() {
        let Type::Named { args, .. } = member else { continue };
        for arg in args {
            if let Type::LiteralString(table) = arg
                && !tables.contains(table)
            {
                tables.push(table.clone());
            }
            if let Type::Named { fqn, .. } = arg
                && let Some(model) = resolver.class_model(fqn)
                && model.is_subclass_of(eloquent::MODEL)
                && !models.iter().any(|known| known == model.fqn())
            {
                models.push(model.fqn().to_owned());
            }
        }
    }
    Some(CallTarget::Method { classes, name, models, tables })
}

/// `config()`: the service a helper returns without arguments.
fn helper_instance(object: &Expression<'_>) -> Option<&'static str> {
    let Expression::Call(Call::Function(call)) = object else { return None };
    let Expression::Identifier(identifier) = call.function else { return None };
    if !call.argument_list.arguments.is_empty() {
        return None;
    }
    let name = identifier.value();
    let name = name.strip_prefix(b"\\").unwrap_or(name);
    HELPER_INSTANCES.iter().find(|(helper, _)| helper.as_bytes().eq_ignore_ascii_case(name)).map(|(_, class)| *class)
}

// ------------------------------------------------------------------ kinds

/// What [`ReferenceKind`] methods get.
pub struct RefContext<'e> {
    pub engine: &'e PhpEngine,
    pub project: Arc<LaravelProject>,
    /// The string's site, when the question is about one string.
    pub site: Option<SiteInfo>,
}

/// Where a string sits; see the module documentation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SiteInfo {
    pub path: PathBuf,
    /// The byte its content starts at.
    pub start: u32,
    /// The class the string is about.
    pub class: Option<String>,
    /// The call the string is an argument of (or the method returning it)
    /// and the byte it starts at ([`StringSite::call`]).
    pub call: Option<(CallTarget, u32)>,
    /// The key of the string's entry in the argument's array, when it sits
    /// in one (`'title'` for `['title' => 'required']`).
    pub key: Option<String>,
    /// [`StringSite::next_argument`].
    pub next_argument: Vec<String>,
    /// [`StringSite::first_argument`].
    pub first_argument: Option<String>,
    /// The `ide.json` rule the string was matched by, when no built-in
    /// pattern matched it.
    pub rule: Option<CompletionRule>,
}

impl RefContext<'_> {
    /// The class of the string's site.
    pub fn class(&self) -> Option<&str> {
        self.site.as_ref()?.class.as_deref()
    }
}

/// A completion item of a kind.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RefItem {
    pub label: String,
    /// The text inserted (usually the label).
    pub insert: String,
    pub detail: Option<String>,
    /// The byte range of the value the item replaces: from `from` to the
    /// caret, and to `to` on Tab.
    pub from: usize,
    pub to: usize,
}

/// A part of a value that can be renamed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RenameTarget {
    /// The value usages must have (or start with, see
    /// [`ReferenceKind::renames_with`]).
    pub key: String,
    /// The byte range of `key` that the new name replaces.
    pub range: (usize, usize),
    /// The declarations renamed with it (every locale's key, both `.env`
    /// files): their files and the ranges replaced.
    pub declarations: Vec<(PathBuf, Range)>,
}

/// A kind of string reference; see the module documentation.
pub trait ReferenceKind: Send + Sync {
    /// The kind's id (`configKey`).
    fn id(&self) -> &'static str;

    /// The places strings of this kind sit in.
    fn patterns(&self) -> &'static [PlacePattern];

    /// Completion items for the string `value` with the caret at its byte
    /// `at` (the text before it is what was typed).
    fn complete(&self, cx: &RefContext<'_>, value: &str, at: usize) -> Vec<RefItem>;

    /// What `value` names, the caret at byte `at` of it (a kind with
    /// segments may resolve the segment at the caret).
    fn resolve(&self, cx: &RefContext<'_>, value: &str, at: usize) -> Vec<Target>;

    /// Words (lower case) every file holding a usage of `value` (a
    /// canonical value) has, for the word index.
    fn usage_words(&self, value: &str) -> Vec<String> {
        crate::index::words(value)
    }

    /// Text every file holding a usage of `value` (a canonical value)
    /// contains.
    fn usage_text<'v>(&self, value: &'v str) -> &'v str {
        value
    }

    /// The value a string written `value` at the context's site stands
    /// for, the same for every usage of one thing (the class and method of
    /// a controller action).
    fn canonical(&self, _cx: &RefContext<'_>, value: &str) -> String {
        value.to_owned()
    }

    /// Whether a usage written `value` is one of `key`.
    fn refers_to(&self, value: &str, key: &str) -> bool {
        value == key
    }

    /// The value a declaration at byte `offset` of `path` declares (the
    /// key of a configuration array), with the byte range of its literal's
    /// content and the caret's byte in the value.
    fn declared_at(&self, _cx: &RefContext<'_>, _path: &Path, _parsed: &ParsedFile, _offset: u32) -> Option<Declared> {
        None
    }

    /// What renaming at byte `at` of `value` changes; `None` when it can't
    /// be renamed there.
    fn rename_target(&self, _cx: &RefContext<'_>, _value: &str, _at: usize) -> Option<RenameTarget> {
        None
    }

    /// Whether a usage written `value` changes with a rename of `key`
    /// (`app` when `app.name` is renamed: keys below it change too).
    fn renames_with(&self, value: &str, key: &str) -> bool {
        value == key
    }

    /// The files a rename of `key` moves, `new_value` being `key` with its
    /// rename range replaced (a view's file).
    fn rename_files(&self, _cx: &RefContext<'_>, _key: &str, _new_value: &str) -> Vec<FileEdit> {
        Vec::new()
    }

    /// Whether `name` can be the new name of a rename.
    fn valid_name(&self, name: &str) -> bool {
        !name.is_empty() && !name.contains(['\'', '"', '\\'])
    }

    /// Whether `name` can be the new name of a rename of `key` (by default
    /// [`valid_name`](Self::valid_name)).
    fn valid_name_for(&self, _key: &str, name: &str) -> bool {
        self.valid_name(name)
    }

    /// Usages of `key` (a canonical value) that aren't string literals in
    /// PHP (`<livewire:counter />` tags), as byte ranges of the value in
    /// `text`, the text of the file at `path`.
    fn markup_usages(&self, _cx: &RefContext<'_>, _path: &Path, _text: &str, _key: &str) -> Vec<(u32, u32)> {
        Vec::new()
    }

    /// Words (lower case) a file holding a [`markup_usages`](Self::markup_usages)
    /// usage of `key` has; empty when the kind has none.
    fn markup_words(&self, _key: &str) -> Vec<String> {
        Vec::new()
    }

    /// Whether `value` names something that exists (the "unknown …"
    /// inspection).
    fn is_known(&self, cx: &RefContext<'_>, value: &str) -> bool;

    /// Whether the kind looks at the argument after the string's
    /// ([`SiteInfo::next_argument`]).
    fn uses_next_argument(&self) -> bool {
        false
    }

    /// Markdown describing what a usage written `value` names (hover).
    fn hover(&self, _cx: &RefContext<'_>, _value: &str) -> Option<String> {
        None
    }

    /// What is wrong with a usage written `value` (a plain literal) that
    /// names nothing; `None` when it is fine, or when that can't be told
    /// (a package's configuration, say).
    fn undefined(&self, _cx: &RefContext<'_>, _value: &str) -> Option<Undefined> {
        None
    }
}

/// A usage naming nothing; see [`ReferenceKind::undefined`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Undefined {
    pub message: String,
    pub severity: Severity,
    /// The quick-fixes, the preferred one first.
    pub fixes: Vec<UndefinedFix>,
}

/// A quick-fix of an [`Undefined`] usage.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UndefinedFix {
    pub title: String,
    pub edit: WorkspaceEdit,
    /// Where the editor opens after applying it (a created class at its
    /// new method).
    pub open: Option<Location>,
}

impl UndefinedFix {
    pub fn new(title: impl Into<String>, edit: WorkspaceEdit) -> Self {
        Self { title: title.into(), edit, open: None }
    }

    pub fn opening(mut self, open: Option<Location>) -> Self {
        self.open = open;
        self
    }
}

impl Undefined {
    pub fn warning(message: impl Into<String>) -> Self {
        Self { message: message.into(), severity: Severity::Warning, fixes: Vec::new() }
    }

    pub fn with_fix(self, title: impl Into<String>, edit: WorkspaceEdit) -> Self {
        self.with(UndefinedFix::new(title, edit))
    }

    pub fn with(mut self, fix: UndefinedFix) -> Self {
        self.fixes.push(fix);
        self
    }
}

/// An undefined usage found in a file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UndefinedSite {
    /// The kind's id.
    pub kind: &'static str,
    /// The literal's content (bytes of the parse).
    pub start: u32,
    pub end: u32,
    pub problem: Undefined,
}

/// A declaration found by [`ReferenceKind::declared_at`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Declared {
    pub value: String,
    pub start: u32,
    pub end: u32,
    pub at: usize,
}

/// The built-in kinds.
pub fn kinds() -> &'static [&'static dyn ReferenceKind] {
    &[
        &ConfigKey,
        &EnvKey,
        &TranslationKey,
        &ViteAsset,
        &RouteName,
        &ControllerAction,
        &ResourceAction,
        &Middleware,
        &ViewName,
        &ValidationRule,
        &RequestField,
        &EloquentField,
        &EloquentRelation,
        &DbTable,
        &Gate,
        &AuthGuard,
        &PasswordBroker,
        &ArtisanCommandKind,
        &ArtisanOptionKind,
        &LivewireComponentKind,
        &LivewireParameterKind,
        &InertiaPageKind,
        &StaticStrings,
        &DirectoryFiles,
    ]
}

/// The kind whose patterns `site` matches.
pub fn kind_of(site: &StringSite, resolver: &Resolver<'_>) -> Option<&'static dyn ReferenceKind> {
    kinds().iter().copied().find(|kind| kind.patterns().iter().any(|pattern| pattern.matches(site, resolver)))
}

/// The kind with id `id`.
pub fn kind_by_id(id: &str) -> Option<&'static dyn ReferenceKind> {
    kinds().iter().copied().find(|kind| kind.id() == id)
}

/// The kind of `site`: the one whose patterns match it, else the one of the
/// first of `rules` matching it, with that rule.
pub fn classify<'r>(
    site: &StringSite,
    resolver: &Resolver<'_>,
    rules: &'r [CompletionRule],
) -> Option<(&'static dyn ReferenceKind, Option<&'r CompletionRule>)> {
    if let Some(kind) = kind_of(site, resolver) {
        return Some((kind, None));
    }
    rules
        .iter()
        .find(|rule| rules::rule_matches(rule, site, resolver))
        .and_then(|rule| Some((kind_by_id(&rule.kind)?, Some(rule))))
}

/// The value `site` stands for: its content, after the `prefix` option of
/// the rule matching it.
pub(crate) fn prefixed(site: &StringSite, rule: Option<&CompletionRule>) -> String {
    match rule {
        Some(rule) => format!("{}{}", rule.options.prefix, site.value),
        None => site.value.clone(),
    }
}

// ------------------------------------------------------------------ caret

/// What the caret is on.
pub struct Subject {
    pub kind: &'static dyn ReferenceKind,
    /// The value (a declaration's full key).
    pub value: String,
    /// The caret's byte in `value`.
    pub at: usize,
    /// The byte range of the literal's content in the file.
    pub start: u32,
    pub end: u32,
    /// The caret is on a declaration, not a usage.
    pub declaration: bool,
    /// The length of the text put before the literal's content in `value`
    /// (an `ide.json` rule's `prefix`).
    pub prefix: usize,
}

/// The string literal around `offset` (inside its quotes): the offset of
/// its opening quote, and of the end of its content (the closing quote, or
/// the end of the line while it isn't closed) and whether it is closed.
fn literal_around(text: &str, offset: usize) -> Option<(usize, usize, bool)> {
    let bytes = text.as_bytes();
    let quote = crate::complete::string_start(bytes, offset)?;
    let mut end = offset;
    while end < bytes.len() && bytes[end] != bytes[quote] && bytes[end] != b'\n' {
        if bytes[end] == b'\\' {
            end += 1;
        }
        end += 1;
    }
    let end = end.min(bytes.len());
    let closed = bytes.get(end) == Some(&bytes[quote]);
    let content_end = if closed { end } else { text[..end].trim_end().len().max(offset) };
    Some((quote, content_end, closed))
}

/// The string site at `offset` of `parsed`, in its own parse or in a probe
/// with the literal closed.
pub fn site_at(parsed: &ParsedFile, resolver: &Resolver<'_>, offset: u32) -> Option<StringSite> {
    site_at_with(parsed, resolver, &[], offset)
}

/// [`site_at`], with the calls of `rules` too.
pub fn site_at_with(
    parsed: &ParsedFile,
    resolver: &Resolver<'_>,
    rules: &[CompletionRule],
    offset: u32,
) -> Option<StringSite> {
    let text = parsed.text();
    let (quote, content_end, closed) = literal_around(text, offset as usize)?;
    let kinds = kinds();
    if let Some(site) = sites_with(parsed, resolver, kinds, rules, Some(quote as u32)).into_iter().next() {
        return Some(site);
    }
    // Not a literal of the parse (being typed): a probe string in its place.
    let after = if closed { content_end + 1 } else { content_end };
    let rest = &text[after..];
    let mut tries = vec![String::new()];
    if !closed {
        tries.push(")".to_owned());
    }
    for close in tries {
        let terminator = if crate::complete::needs_terminator(rest) { ";" } else { "" };
        let probe_value = "x".repeat(content_end - quote - 1);
        let probe =
            ParsedFile::parse("reference.php", format!("{}'{probe_value}'{close}{terminator}{rest}", &text[..quote]));
        if let Some(mut site) = sites_with(&probe, resolver, kinds, rules, Some(quote as u32)).into_iter().next() {
            site.start = quote as u32 + 1;
            site.end = content_end as u32;
            site.value = text[quote + 1..content_end].to_owned();
            return Some(site);
        }
    }
    None
}

impl PhpEngine {
    /// The reference context, when the project is a Laravel project.
    pub(crate) fn ref_context(&self) -> Option<RefContext<'_>> {
        Some(RefContext { engine: self, project: self.laravel()?, site: None })
    }

    /// Where class-like `fqn` is declared.
    pub(crate) fn class_targets(&self, fqn: &str) -> Vec<Target> {
        self.declarations_of(NameKind::ClassLike, fqn, Path::new(""), &FileSummary::default())
    }

    /// The places the project's routes name method `method` of `class` (or
    /// of a class it extends, or that extends it): the method's string in
    /// `[Foo::class, 'bar']` and `'Foo@bar'`, the class of an invokable
    /// controller or of a resource. Empty outside Laravel projects.
    pub(crate) fn route_action_usages(&self, class: &str, method: &str) -> Vec<Usage> {
        let Some(routes) = self.laravel_routes() else { return Vec::new() };
        let resolver = self.resolver();
        let related = |found: &str| {
            fqn_eq(NameKind::ClassLike, found, class)
                || resolver.class_model(found).is_some_and(|model| model.is_subclass_of(class))
                || resolver.class_model(class).is_some_and(|model| model.is_subclass_of(found))
        };
        let mut out: Vec<Usage> = Vec::new();
        for route in routes.routes() {
            let RouteAction::Controller { class: found, method: named, at: Some((_, _, range)) } = &route.action else {
                continue;
            };
            if named.eq_ignore_ascii_case(method) && related(found) {
                let usage = Usage { path: route.path.clone(), range: *range, kind: UsageKind::String };
                if !out.contains(&usage) {
                    out.push(usage);
                }
            }
        }
        out
    }

    /// The reference context of `site` in the file at `path`.
    pub(crate) fn site_context(&self, path: &Path, site: &StringSite) -> Option<RefContext<'_>> {
        self.rule_site_context(path, site, None)
    }

    /// [`site_context`](Self::site_context) of a site `rule` matched.
    pub(crate) fn rule_site_context(
        &self,
        path: &Path,
        site: &StringSite,
        rule: Option<&CompletionRule>,
    ) -> Option<RefContext<'_>> {
        let mut cx = self.ref_context()?;
        let class = site.class.clone().or_else(|| {
            let routes = self.laravel_routes()?;
            routes.route_at(path, site.start).and_then(|route| route.action.class()).map(str::to_owned)
        });
        let key = match site.steps.first() {
            Some(ArrayStep::Value(key)) => key.clone(),
            _ => None,
        };
        cx.site = Some(SiteInfo {
            path: path.to_path_buf(),
            start: site.start,
            class,
            call: Some((site.target.clone(), site.call)),
            key,
            next_argument: site.next_argument.clone(),
            first_argument: site.first_argument.clone(),
            rule: rule.cloned(),
        });
        Some(cx)
    }

    /// What the caret at `offset` of `parsed` (the file at `path`) is on.
    fn ref_subject(&self, parsed: &ParsedFile, path: &Path, offset: u32) -> Option<(RefContext<'_>, Subject)> {
        // Cheap checks first: inside a string at all.
        literal_around(parsed.text(), offset as usize)?;
        let cx = self.ref_context()?;
        let resolver = self.resolver();
        let rules = &cx.project.ide_json.completions;
        if let Some(site) = site_at_with(parsed, &resolver, rules, offset)
            && let Some((kind, rule)) = classify(&site, &resolver, rules)
        {
            let site_cx = self.rule_site_context(path, &site, rule)?;
            let prefix = rule.map_or(0, |rule| rule.options.prefix.len());
            let at = prefix + (offset.clamp(site.start, site.end) - site.start) as usize;
            let value = prefixed(&site, rule);
            let subject = Subject { kind, value, at, start: site.start, end: site.end, declaration: false, prefix };
            return Some((site_cx, subject));
        }
        let declared = kinds().iter().find_map(|kind| Some((*kind, kind.declared_at(&cx, path, parsed, offset)?)));
        let (kind, declared) = declared?;
        let subject = Subject {
            kind,
            value: declared.value,
            at: declared.at,
            start: declared.start,
            end: declared.end,
            declaration: true,
            prefix: 0,
        };
        Some((cx, subject))
    }

    /// Completion inside a string reference; `None` when the caret isn't in
    /// one.
    pub(crate) fn string_ref_completion(&self, parsed: &ParsedFile, path: &Path, offset: u32) -> Option<Completions> {
        let (cx, subject) = self.ref_subject(parsed, path, offset)?;
        if subject.declaration {
            return None;
        }
        let lines = parsed.line_index();
        let typed = &subject.value[..subject.at];
        let mut items = Vec::new();
        let mut seen = HashSet::new();
        for item in subject.kind.complete(&cx, &subject.value, subject.at) {
            // An item replacing the rule's prefix can't be inserted.
            if item.from < subject.prefix {
                continue;
            }
            let prefix = typed.get(item.from..).unwrap_or_default();
            let Some(quality) = crate::complete::quality(&item.label, prefix) else { continue };
            if !seen.insert(item.label.clone()) {
                continue;
            }
            let from = subject.start + (item.from - subject.prefix) as u32;
            let to = subject.start + (item.to.max(subject.at) - subject.prefix) as u32;
            items.push(Completion {
                label: item.label.clone(),
                label_detail: None,
                detail: item.detail,
                kind: CompletionKind::Value,
                insert_text: item.insert,
                is_snippet: false,
                filter_text: None,
                sort_text: format!("0{quality}{}", item.label.to_lowercase()),
                replace: lines.range(from, offset),
                replace_tab: (to > offset).then(|| lines.range(from, to)),
                additional_edits: Vec::new(),
                deprecated: false,
                data: None,
            });
        }
        items.sort_by(|a, b| a.sort_text.cmp(&b.sort_text));
        // The segment being completed changes with every `.`: ask again.
        Some(Completions { items, incomplete: true })
    }

    /// Hover over a string reference; `None` when the caret isn't on one (or
    /// its kind has nothing to say).
    pub(crate) fn string_ref_hover(
        &self,
        parsed: &ParsedFile,
        path: &Path,
        offset: u32,
    ) -> Option<crate::navigate::HoverInfo> {
        let (cx, subject) = self.ref_subject(parsed, path, offset)?;
        if subject.declaration {
            return None;
        }
        let markdown = subject.kind.hover(&cx, &subject.value)?;
        Some(crate::navigate::HoverInfo { markdown, range: parsed.line_index().range(subject.start, subject.end) })
    }

    /// The usages of `kinds` in `parsed` (the file at `path`) that name
    /// nothing, plain literals only (no interpolation or escapes).
    pub(crate) fn undefined_references(
        &self,
        parsed: &ParsedFile,
        path: &Path,
        kinds: &[&'static dyn ReferenceKind],
        cancel: &CancellationToken,
    ) -> Vec<UndefinedSite> {
        if self.ref_context().is_none() {
            return Vec::new();
        }
        let resolver = self.resolver();
        let project = self.laravel();
        let rules = project.as_ref().map(|project| project.ide_json.completions.as_slice()).unwrap_or_default();
        let mut out = Vec::new();
        // The parameters of `can:` and `auth:` middleware are abilities and guards.
        let parameters = kinds.iter().any(|kind| kind.id() == Gate.id() || kind.id() == AuthGuard.id());
        let mut walked = kinds.to_vec();
        if parameters {
            walked.push(&Middleware);
        }
        let sites = sites_with(parsed, &resolver, &walked, rules, None);
        // Configuration keys the file sets (`config(['themes.shop.narrow' =>
        // …])` in Bagisto's tests): setting a new key is fine, and so is
        // reading it, or a key below it, afterwards.
        let written: Vec<String> = if kinds.iter().any(|kind| kind.id() == ConfigKey.id()) {
            sites
                .iter()
                .filter(|site| writes_config_key(site))
                .filter(|site| classify(site, &resolver, rules).is_some_and(|(kind, _)| kind.id() == ConfigKey.id()))
                .map(|site| site.value.clone())
                .collect()
        } else {
            Vec::new()
        };
        let set_here = |value: &str| {
            written.iter().any(|key| {
                value.strip_prefix(key.as_str()).is_some_and(|rest| rest.is_empty() || rest.starts_with('.'))
            })
        };
        for site in sites {
            if cancel.is_cancelled() {
                break;
            }
            if site.value.is_empty() || site.value.contains(['$', '\\', '{']) {
                continue;
            }
            let Some((kind, rule)) = classify(&site, &resolver, rules) else { continue };
            if kind.id() == ConfigKey.id() && set_here(&site.value) {
                continue;
            }
            if parameters && kind.id() == Middleware.id() {
                let Some(cx) = self.rule_site_context(path, &site, rule) else { continue };
                for (id, from, to, problem) in middleware::parameter_problems(&cx, &site.value) {
                    if kinds.iter().any(|wanted| wanted.id() == id) {
                        let (start, end) = (site.start + from as u32, site.start + to as u32);
                        out.push(UndefinedSite { kind: id, start, end, problem });
                    }
                }
                continue;
            }
            if !kinds.iter().any(|wanted| wanted.id() == kind.id()) {
                continue;
            }
            let Some(cx) = self.rule_site_context(path, &site, rule) else { continue };
            if let Some(problem) = kind.undefined(&cx, &prefixed(&site, rule)) {
                out.push(UndefinedSite { kind: kind.id(), start: site.start, end: site.end, problem });
            }
        }
        out
    }
}

/// True when `site` sets a configuration key rather than reading it: a key
/// of the array given to `config([...])` or `Config::set([...])`, or the
/// key of `Config::set('key', …)`.
fn writes_config_key(site: &StringSite) -> bool {
    match &site.target {
        CallTarget::Function(_) => matches!(site.steps.as_slice(), [ArrayStep::Key]),
        CallTarget::Method { name, .. } => name.eq_ignore_ascii_case("set"),
        _ => false,
    }
}

impl PhpEngine {
    /// The undefined configuration keys, environment keys, translations, Vite
    /// assets and abilities of a Blade template, as diagnostics of the template.
    pub(crate) fn blade_reference_problems(&self, text: &str) -> Vec<Diagnostic> {
        self.blade_reference_fixes(text).into_iter().map(|(diagnostic, _)| diagnostic).collect()
    }

    /// [`blade_reference_problems`](Self::blade_reference_problems), each
    /// with its quick-fix ("Create view").
    pub(crate) fn blade_reference_fixes(&self, text: &str) -> Vec<(Diagnostic, Option<(String, WorkspaceEdit)>)> {
        let compiled = crate::blade::compile(text, false);
        let parsed = ParsedFile::parse("template.php", compiled.php.as_str());
        // Only the kinds whose inspection the profile leaves on, as in PHP files.
        let enabled = self.inspections().ids();
        let kinds: Vec<&'static dyn ReferenceKind> = [
            &ConfigKey as &'static dyn ReferenceKind,
            &EnvKey,
            &TranslationKey,
            &ViteAsset,
            &Gate,
            &AuthGuard,
            &ViewName,
        ]
        .into_iter()
        .filter(|kind| crate::inspect::laravel::inspection_id(kind.id()).is_some_and(|id| enabled.contains(&id)))
        .collect();
        if kinds.is_empty() {
            return Vec::new();
        }
        let lines = crate::syntax::LineIndex::new(text);
        let mut out = Vec::new();
        for found in self.undefined_references(&parsed, Path::new(""), &kinds, &CancellationToken::new()) {
            let (Some(start), Some(end)) = (compiled.blade_offset(found.start), compiled.blade_offset(found.end))
            else {
                continue;
            };
            let diagnostic = Diagnostic {
                range: lines.range(start, end),
                severity: found.problem.severity,
                message: found.problem.message,
                source: Some(crate::blade::structure::DIAGNOSTIC_SOURCE.into()),
                code: Some(crate::inspect::laravel::inspection_id(found.kind).unwrap_or(found.kind).into()),
                unnecessary: false,
                deprecated: false,
                server: None,
            };
            out.push((diagnostic, found.problem.fixes.into_iter().next().map(|fix| (fix.title, fix.edit))));
        }
        out
    }

    /// Goto from a string reference; `None` when the caret isn't on one (or
    /// is on a declaration).
    pub(crate) fn string_ref_definition(&self, parsed: &ParsedFile, path: &Path, offset: u32) -> Option<Vec<Target>> {
        let (cx, subject) = self.ref_subject(parsed, path, offset)?;
        if subject.declaration {
            return None;
        }
        Some(subject.kind.resolve(&cx, &subject.value, subject.at))
    }

    /// The usages of the string reference at the caret.
    pub(crate) fn string_ref_references(
        &self,
        parsed: &ParsedFile,
        path: &Path,
        offset: u32,
        include_declaration: bool,
        cancel: &CancellationToken,
    ) -> Option<IdeResult<Vec<Usage>>> {
        let (cx, subject) = self.ref_subject(parsed, path, offset)?;
        let key = if subject.declaration { subject.value.clone() } else { subject.kind.canonical(&cx, &subject.value) };
        Some(self.kind_usages(&cx, subject.kind, &subject.value, &key, include_declaration, cancel))
    }

    /// The usages of `key` (a canonical value) of `kind`, sorted, with the
    /// declarations of `value` (what the caret's string says) first when
    /// `include_declaration`.
    pub(crate) fn kind_usages(
        &self,
        cx: &RefContext<'_>,
        kind: &'static dyn ReferenceKind,
        value: &str,
        key: &str,
        include_declaration: bool,
        cancel: &CancellationToken,
    ) -> IdeResult<Vec<Usage>> {
        let sites = self.string_usages(kind, key, &|found| kind.refers_to(found, key), cancel)?;
        let mut usages: Vec<Usage> = Vec::new();
        if include_declaration {
            for target in kind.resolve(cx, value, value.len()) {
                usages.push(Usage { path: target.path, range: target.range, kind: UsageKind::Declaration });
            }
        }
        for site in sites {
            usages.push(Usage { path: site.path, range: site.range, kind: UsageKind::String });
        }
        usages.sort_by(|a, b| (&a.path, a.range.start).cmp(&(&b.path, b.range.start)));
        usages.dedup();
        Ok(usages)
    }

    /// The range a rename at the caret changes, when the caret is on a
    /// string reference: `Some(None)` when it can't be renamed.
    pub(crate) fn string_ref_prepare_rename(
        &self,
        parsed: &ParsedFile,
        path: &Path,
        offset: u32,
    ) -> Option<Option<Range>> {
        let (cx, subject) = self.ref_subject(parsed, path, offset)?;
        if subject.prefix > 0 {
            return Some(None);
        }
        let lines = parsed.line_index();
        Some(subject.kind.rename_target(&cx, &subject.value, subject.at).map(|target| {
            if subject.declaration {
                lines.range(subject.start, subject.end)
            } else {
                lines.range(subject.start + target.range.0 as u32, subject.start + target.range.1 as u32)
            }
        }))
    }

    /// Renames the string reference at the caret: its declaration and every
    /// usage.
    pub(crate) fn string_ref_rename(
        &self,
        parsed: &ParsedFile,
        path: &Path,
        offset: u32,
        new_name: &str,
        cancel: &CancellationToken,
    ) -> Option<IdeResult<WorkspaceEdit>> {
        let (cx, subject) = self.ref_subject(parsed, path, offset)?;
        let kind = subject.kind;
        let target = if subject.prefix > 0 { None } else { kind.rename_target(&cx, &subject.value, subject.at) };
        let Some(target) = target else {
            return Some(Err(IdeError::invalid("this string can't be renamed")));
        };
        Some(self.kind_rename(&cx, kind, target, new_name, cancel))
    }

    /// The edit renaming `target` of `kind` to `new_name`: its declarations,
    /// every usage, and the files the kind moves with it.
    pub(crate) fn kind_rename(
        &self,
        cx: &RefContext<'_>,
        kind: &'static dyn ReferenceKind,
        target: RenameTarget,
        new_name: &str,
        cancel: &CancellationToken,
    ) -> IdeResult<WorkspaceEdit> {
        let key = target.key.clone();
        if !kind.valid_name_for(&key, new_name) {
            return Err(IdeError::invalid(format!("'{new_name}' is not a valid name")));
        }
        let sites = self.string_usages(kind, &key, &|value| kind.renames_with(value, &key), cancel)?;
        let mut files: Vec<(PathBuf, Vec<TextEdit>)> = Vec::new();
        let mut add = |path: PathBuf, range: Range| match files.iter_mut().find(|(known, _)| *known == path) {
            Some((_, edits)) => {
                if !edits.iter().any(|edit| edit.range == range) {
                    edits.push(TextEdit { range, new_text: new_name.to_owned() });
                }
            }
            None => files.push((path, vec![TextEdit { range, new_text: new_name.to_owned() }])),
        };
        for (path, range) in target.declarations.iter().cloned() {
            add(path, range);
        }
        for site in sites {
            let range = site.lines.range(site.start + target.range.0 as u32, site.start + target.range.1 as u32);
            add(site.path, range);
        }
        let mut edit = WorkspaceEdit::default();
        files.sort_by(|a, b| a.0.cmp(&b.0));
        for (path, edits) in files {
            edit.files.push(FileEdit::Edit { path: path.into(), edits, version: None });
        }
        let new_value = format!("{}{new_name}{}", &key[..target.range.0], &key[target.range.1..]);
        edit.files.extend(kind.rename_files(cx, &key, &new_value));
        Ok(edit)
    }

    /// The other places in the document of the string reference at `pos`:
    /// its usages, and its declaration when it is in the document. `None`
    /// when the caret isn't on a string reference.
    pub fn string_highlights(&self, doc: DocId, pos: Pos) -> Option<Vec<StringHighlight>> {
        let parsed = self.parsed_document(doc)?;
        let path = self.document_path(doc)?;
        let offset = parsed.line_index().byte(pos);
        let (cx, subject) = self.ref_subject(&parsed, &path, offset)?;
        let resolver = self.resolver();
        let lines = parsed.line_index();
        let mut out: Vec<StringHighlight> = Vec::new();
        for target in subject.kind.resolve(&cx, &subject.value, subject.value.len()) {
            if target.path == path && target.range != Range::default() {
                out.push(StringHighlight { range: target.range, write: true });
            }
        }
        let key = if subject.declaration { subject.value.clone() } else { subject.kind.canonical(&cx, &subject.value) };
        let rules = &cx.project.ide_json.completions;
        for site in sites_with(&parsed, &resolver, &[subject.kind], rules, None) {
            let Some((kind, rule)) = classify(&site, &resolver, rules) else { continue };
            if kind.id() == subject.kind.id()
                && self.rule_site_context(&path, &site, rule).is_some_and(|cx| {
                    subject.kind.refers_to(&subject.kind.canonical(&cx, &prefixed(&site, rule)), &key)
                })
            {
                out.push(StringHighlight { range: lines.range(site.start, site.end), write: false });
            }
        }
        out.sort_by_key(|highlight| highlight.range.start);
        out.dedup();
        Some(out)
    }

    /// The string sites of `kind` in the project whose value `keep`
    /// accepts. The candidate files are the indexed files with every word
    /// of `key` and of the kind, and the open documents.
    fn string_usages(
        &self,
        kind: &'static dyn ReferenceKind,
        key: &str,
        keep: &dyn Fn(&str) -> bool,
        cancel: &CancellationToken,
    ) -> IdeResult<Vec<FoundSite>> {
        let mut candidates = self.usage_candidates(kind, key)?;
        let open: Vec<_> = self.open_documents().into_iter().filter(|document| !document.embedded).collect();
        let resolver = self.resolver();
        let project = self.laravel();
        let rules: Vec<CompletionRule> = project
            .iter()
            .flat_map(|project| project.ide_json.completions.iter())
            .filter(|rule| rule.kind == kind.id())
            .cloned()
            .collect();
        // A rule's prefix isn't written in the file.
        let mut text = kind.usage_text(key);
        for rule in &rules {
            if !rule.options.prefix.is_empty()
                && let Some(rest) = text.strip_prefix(rule.options.prefix.as_str())
            {
                text = rest;
            }
            // Its usages don't have the prefix's words either.
            if !rule.options.prefix.is_empty()
                && let Some(rest) = key.strip_prefix(rule.options.prefix.as_str())
            {
                for path in self.usage_candidates(kind, rest)? {
                    if !candidates.contains(&path) {
                        candidates.push(path);
                    }
                }
            }
        }
        let mut out = Vec::new();
        for path in candidates {
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            let Some(file) = self.usage_file(&path, &open, text) else { continue };
            for site in sites_with(&file.parsed, &resolver, &[kind], &rules, None) {
                let rule = if kind.patterns().iter().any(|pattern| pattern.matches(&site, &resolver)) {
                    None
                } else {
                    match rules.iter().find(|rule| rules::rule_matches(rule, &site, &resolver)) {
                        Some(rule) => Some(rule),
                        None => continue,
                    }
                };
                let Some(cx) = self.rule_site_context(&path, &site, rule) else { continue };
                if !keep(&kind.canonical(&cx, &prefixed(&site, rule))) {
                    continue;
                }
                let Some((start, end)) = file.to_source(site.start, site.end) else { continue };
                let range = file.lines.range(start, end);
                out.push(FoundSite { path: path.clone(), range, start, lines: file.lines.clone() });
            }
        }
        out.extend(self.markup_sites(kind, key, &open, cancel)?);
        Ok(out)
    }

    /// The [`ReferenceKind::markup_usages`] of `key` in the project's files
    /// with every word of [`ReferenceKind::markup_words`] (and the open
    /// documents), closed or open.
    fn markup_sites(
        &self,
        kind: &'static dyn ReferenceKind,
        key: &str,
        open: &[crate::engine::OpenDocument],
        cancel: &CancellationToken,
    ) -> IdeResult<Vec<FoundSite>> {
        let words = kind.markup_words(key);
        if words.is_empty() {
            return Ok(Vec::new());
        }
        let Some(cx) = self.ref_context() else { return Ok(Vec::new()) };
        let mut candidates = self.files_with_words(words)?;
        for document in open {
            if !candidates.contains(&document.path) {
                candidates.push(document.path.clone());
            }
        }
        candidates.sort();
        let mut out = Vec::new();
        for path in candidates {
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            if self.is_library(&path) {
                continue;
            }
            let text: String = match open.iter().find(|document| document.path == path) {
                Some(document) => document.text.to_string(),
                None => match std::fs::read_to_string(&path) {
                    Ok(text) => text.replace("\r\n", "\n"),
                    Err(_) => continue,
                },
            };
            let found = kind.markup_usages(&cx, &path, &text, key);
            if found.is_empty() {
                continue;
            }
            let lines = Arc::new(crate::syntax::LineIndex::new(&text));
            for (start, end) in found {
                out.push(FoundSite { path: path.clone(), range: lines.range(start, end), start, lines: lines.clone() });
            }
        }
        Ok(out)
    }

    /// The indexed files with every one of `words` (lower case).
    fn files_with_words(&self, mut words: Vec<String>) -> IdeResult<Vec<PathBuf>> {
        let Some(index) = self.index() else { return Ok(Vec::new()) };
        words.sort();
        words.dedup();
        let mut found: Option<HashSet<PathBuf>> = None;
        for word in words {
            let files: HashSet<PathBuf> = index.files_with_word(&word)?.into_iter().collect();
            found = Some(match found {
                Some(known) => known.intersection(&files).cloned().collect(),
                None => files,
            });
        }
        Ok(found.unwrap_or_default().into_iter().collect())
    }

    /// The candidate file `path` of a usage search for text `text`: the
    /// parse of its open buffer or of the file on disk (a Blade template
    /// compiled first). `None` for a library file or one without `text`.
    fn usage_file(&self, path: &Path, open: &[crate::engine::OpenDocument], text: &str) -> Option<UsageFile> {
        if self.is_library(path) {
            return None;
        }
        if crate::frameworks::laravel::views::is_blade(path) {
            let source = std::fs::read_to_string(path).ok()?.replace("\r\n", "\n");
            if !source.contains(text) {
                return None;
            }
            let component = crate::blade::views::ViewPaths::new(&self.root()).is_component_view(path);
            let compiled = crate::blade::compile(&source, component);
            let parsed = Arc::new(ParsedFile::parse("usages.php", compiled.php.as_str()));
            let lines = Arc::new(crate::syntax::LineIndex::new(&source));
            return Some(UsageFile { parsed, lines, compiled: Some(compiled) });
        }
        let parsed = match open.iter().find(|document| document.path == path) {
            Some(document) => self.parse_open(document),
            None => {
                let source = std::fs::read_to_string(path).ok()?;
                if !source.contains(text) {
                    return None;
                }
                Arc::new(ParsedFile::parse("usages.php", source))
            }
        };
        if !parsed.text().contains(text) {
            return None;
        }
        let lines = Arc::new(parsed.line_index().clone());
        Some(UsageFile { parsed, lines, compiled: None })
    }

    /// The files [`string_usages`](Self::string_usages) looks at for `key`
    /// of `kind`: the indexed files with every word, and the open documents.
    fn usage_candidates(&self, kind: &'static dyn ReferenceKind, key: &str) -> IdeResult<Vec<PathBuf>> {
        let mut candidates: Vec<PathBuf> = self.files_with_words(kind.usage_words(key))?;
        for document in self.open_documents().into_iter().filter(|document| !document.embedded) {
            if !candidates.contains(&document.path) {
                candidates.push(document.path.clone());
            }
        }
        candidates.sort();
        Ok(candidates)
    }

    /// The views of the Laravel project with the name of the view file
    /// `path` (`posts.index`), when it is one.
    pub fn laravel_view_name(&self, path: &Path) -> Option<String> {
        self.laravel_views()?.name_of(path)
    }

    /// The usages of view `name` (`view('posts.index')`, `@include(…)`, …)
    /// in the project. `None` outside Laravel projects.
    pub fn laravel_view_usages(&self, name: &str, cancel: &CancellationToken) -> Option<IdeResult<Vec<Usage>>> {
        self.ref_context()?;
        let key = crate::frameworks::laravel::views::normalize_name(name);
        let found = self.string_usages(&ViewName, &key, &|value| value == key, cancel);
        Some(found.map(|sites| {
            let mut usages: Vec<Usage> = sites
                .into_iter()
                .map(|site| Usage { path: site.path, range: site.range, kind: UsageKind::String })
                .collect();
            usages.sort_by(|a, b| (&a.path, a.range.start).cmp(&(&b.path, b.range.start)));
            usages.dedup();
            usages
        }))
    }

    /// The variables the callers of the view file `path` pass it (`(name,
    /// type)`, sorted by name; the types of one name joined), for the Blade
    /// compiler. Empty outside Laravel projects and for other files.
    pub fn laravel_view_variables(&self, path: &Path) -> Arc<Vec<(String, String)>> {
        let modification = self.modification_count();
        let path = crate::project::normalize(path);
        if let Some(found) = self.view_variables_cache().lock().get(&path).filter(|(at, _)| *at == modification) {
            return found.1.clone();
        }
        let found = Arc::new(self.view_variables_uncached(&path).unwrap_or_default());
        self.view_variables_cache().lock().insert(path, (modification, found.clone()));
        found
    }

    fn view_variables_uncached(&self, path: &Path) -> Option<Vec<(String, String)>> {
        self.ref_context()?;
        let name = self.laravel_view_name(path)?;
        let kind: &'static dyn ReferenceKind = &ViewName;
        let candidates = self.usage_candidates(kind, &name).ok()?;
        let open: Vec<_> = self.open_documents().into_iter().filter(|document| !document.embedded).collect();
        let resolver = self.resolver();
        let mut passed: Vec<(String, Type)> = Vec::new();
        for candidate in candidates {
            let Some(file) = self.usage_file(&candidate, &open, kind.usage_text(&name)) else { continue };
            let starts: Vec<u32> = sites(&file.parsed, &resolver, &[kind], None)
                .into_iter()
                .filter(|site| {
                    kind.patterns().iter().any(|pattern| pattern.matches(site, &resolver))
                        && crate::frameworks::laravel::views::normalize_name(&site.value) == name
                })
                .map(|site| site.start)
                .collect();
            if starts.is_empty() {
                continue;
            }
            let file_names = FileNames::resolve(&file.parsed);
            let summary = FileSummary::extract(&file.parsed);
            let types = ExprTypes::new(&file.parsed, &file_names, &summary, &resolver);
            passed.extend(crate::frameworks::laravel::views::passed_variables(&types, &file.parsed, &starts));
        }
        let mut names: Vec<String> = passed.iter().map(|(name, _)| name.clone()).collect();
        names.sort();
        names.dedup();
        Some(
            names
                .into_iter()
                .map(|name| {
                    let known: Vec<Type> = passed
                        .iter()
                        .filter(|(passed, ty)| *passed == name && !matches!(ty, Type::Mixed))
                        .map(|(_, ty)| ty.clone())
                        .collect();
                    let ty = if known.is_empty() { Type::Mixed } else { Type::union(known) };
                    (name, ty.to_string())
                })
                .collect(),
        )
    }
}

/// A file a usage search parsed.
struct UsageFile {
    parsed: Arc<ParsedFile>,
    /// The lines of the file's own text (the template's for a Blade one).
    lines: Arc<crate::syntax::LineIndex>,
    /// A Blade template's compiled PHP, which `parsed` is the parse of.
    compiled: Option<crate::blade::Compiled>,
}

impl UsageFile {
    /// The byte range in the file's own text of `start..end` of the parse.
    fn to_source(&self, start: u32, end: u32) -> Option<(u32, u32)> {
        match &self.compiled {
            Some(compiled) => Some((compiled.blade_offset(start)?, compiled.blade_offset(end)?)),
            None => Some((start, end)),
        }
    }
}

/// A string site found in the project.
struct FoundSite {
    path: PathBuf,
    /// The content of the literal.
    range: Range,
    /// The byte the content starts at, and the file's lines (for edits
    /// inside it).
    start: u32,
    lines: Arc<crate::syntax::LineIndex>,
}

/// One place [`PhpEngine::string_highlights`] marks.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StringHighlight {
    pub range: Range,
    /// The declaration (as opposed to a usage).
    pub write: bool,
}
