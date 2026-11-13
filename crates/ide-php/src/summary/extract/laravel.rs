//! Extraction of [`LaravelFacts`](crate::summary::LaravelFacts):
//!
//! - **Bindings:** `bind`, `singleton`, `scoped`, `instance` (and the `…If`
//!   variants) and `alias` called on `$this->app`, `$app`, `$container`,
//!   `app()` or the `App` facade, with a string id. The target is the class
//!   named (`Foo::class`, a class-name string), what a closure returns, or
//!   the instance's type.
//! - **Migrations:** `Schema::create('table', fn (Blueprint $table) …)` and
//!   `Schema::table(…)`: the columns made by the `$table->type('name')`
//!   statements of the closure, with `->nullable()`, and the columns of
//!   `id()`, `timestamps()`, `softDeletes()`, `rememberToken()` and
//!   `morphs()`; the columns `dropColumn()`, `dropTimestamps()` and the
//!   like drop and `renameColumn()` renames (`Schema::dropColumns()` too),
//!   outside `down()` methods.
//! - **Counted relations:** the relations of a class's `$withCount`
//!   property (strings, list items and array keys; `'posts as
//!   drafts_count'` loads `drafts_count`), with the class.
//! - **Casts:** the array of a class's `$casts` property, or the array a
//!   `casts()` method returns.
//! - **Rules:** the keys of the array a class's `rules()` method returns,
//!   with the names of their string rules (pipe strings and arrays).
//! - **Route files:** the `web`, `api`, `commands` and `channels` files of
//!   `withRouting(…)` (Laravel 11's `bootstrap/app.php`, with the `web` and
//!   `api` middleware groups and the `apiPrefix` its `ApplicationBuilder`
//!   gives them), `Route::…->group(path)` chains and `Route::group([…], path)`
//!   (a `RouteServiceProvider`, a `then:` callback), and
//!   `$this->loadRoutesFrom(path)`, when the path is relative to `__DIR__`
//!   or `dirname(__DIR__)`, or made by `base_path()`, `app_path()` or
//!   `module_path()`; its pieces are literals or `config('key', 'default')`
//!   calls (Jetstream), filled in when the route files are resolved.
//!
//! The column types follow what Eloquent gives an attribute without a cast
//! (Laravel's public documentation on migrations and casts): integers are
//! `int`, decimals and dates `string`, the timestamps `Carbon`.

use mago_span::{HasSpan, Span};
use mago_syntax::cst::{
    Access, Argument, ArgumentList, ArrayElement, BinaryOperator, Call, ClassLikeConstantSelector, ClassLikeMember,
    ClassLikeMemberSelector, Expression, Literal, MagicConstant, MethodBody, Property, PropertyItem, Sequence,
    Statement, Variable,
};

use super::Extractor;
use crate::names::{NameKind, Resolution};
use crate::summary::{
    Binding, Cast, Column, CountedRelation, DocType, Loc, Macro, Method, ModelCasts, PestUses, RenamedColumn,
    RequestRules, RouteFileKind, RoutePath, RouteRegistration, RuleEntry, RuleMethod, Table, Visibility, counted_spec,
};
use crate::types::ops::literal_type;
use crate::types::{LazyType, Type};

/// Container methods registering a binding.
const BIND_METHODS: &[&str] =
    &["bind", "bindIf", "singleton", "singletonIf", "scoped", "scopedIf", "instance", "alias"];

/// Laravel's `Carbon`, what the timestamps are.
const CARBON: &str = "\\Illuminate\\Support\\Carbon";

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// The value of a string literal.
fn string(expr: &Expression<'_>) -> Option<String> {
    match expr {
        Expression::Literal(literal) => match literal_type(literal) {
            Type::LiteralString(value) => Some(value),
            _ => None,
        },
        Expression::Parenthesized(inner) => string(inner.expression),
        _ => None,
    }
}

/// The type of a literal (`mixed` for anything else).
fn literal_type_of(expr: &Expression<'_>) -> Type {
    match expr {
        Expression::Literal(literal) => literal_type(literal),
        Expression::Parenthesized(inner) => literal_type_of(inner.expression),
        _ => Type::Mixed,
    }
}

/// The positional arguments (named ones in their place).
fn args<'a>(list: &'a ArgumentList<'a>) -> Vec<&'a Expression<'a>> {
    list.arguments
        .iter()
        .map(|argument| match argument {
            Argument::Positional(argument) => argument.value,
            Argument::Named(argument) => argument.value,
        })
        .collect()
}

fn method_name(selector: &ClassLikeMemberSelector<'_>) -> Option<String> {
    match selector {
        ClassLikeMemberSelector::Identifier(name) => Some(lossy(name.value)),
        _ => None,
    }
}

/// `$name` without the `$`.
fn variable(expr: &Expression<'_>) -> Option<String> {
    match expr {
        Expression::Variable(Variable::Direct(direct)) => {
            Some(lossy(direct.name.strip_prefix(b"$").unwrap_or(direct.name)))
        }
        _ => None,
    }
}

/// The strings of arguments that are strings or arrays of them
/// (`dropColumn('a', 'b')`, `dropColumn(['a', 'b'])`).
fn string_list(args: &[&Expression<'_>]) -> Vec<String> {
    let mut out = Vec::new();
    for arg in args {
        let elements = match arg {
            Expression::Array(array) => array.elements.iter(),
            Expression::LegacyArray(array) => array.elements.iter(),
            other => {
                out.extend(string(other));
                continue;
            }
        };
        for element in elements {
            if let ArrayElement::Value(element) = element {
                out.extend(string(element.value));
            }
        }
    }
    out
}

/// `posts` (or `posts as drafts_count`) counted by class `class`'s
/// `$withCount`.
fn counted(class: &str, spec: &str) -> Option<CountedRelation> {
    let (relation, property) = counted_spec(spec, snake)?;
    Some(CountedRelation { class: class.trim_start_matches('\\').to_owned(), relation, property })
}

/// `BlogPost` → `blog_post`.
fn snake(name: &str) -> String {
    let mut out = String::new();
    for (i, c) in name.chars().enumerate() {
        if c.is_uppercase() && i > 0 {
            out.push('_');
        }
        out.extend(c.to_lowercase());
    }
    out
}

/// The short name of the class `Foo::class` names (`App\Models\Foo::class`
/// is `Foo`).
fn class_short_name(expr: &Expression<'_>) -> Option<String> {
    let Expression::Access(Access::ClassConstant(access)) = expr else { return None };
    let ClassLikeConstantSelector::Identifier(constant) = &access.constant else { return None };
    let Expression::Identifier(class) = access.class else { return None };
    if !constant.value.eq_ignore_ascii_case(b"class") {
        return None;
    }
    let name = lossy(class.value());
    name.rsplit('\\').next().map(str::to_owned)
}

/// A plain id (`'payments'`): not a class name.
fn is_id(value: &str) -> bool {
    !value.is_empty() && !value.contains('\\')
}

impl Extractor<'_> {
    /// The FQN of a class named by an identifier (`Foo` before `::`).
    fn class_ref(&self, expr: &Expression<'_>) -> Option<String> {
        let Expression::Identifier(identifier) = expr else { return None };
        match self.scope.resolve(NameKind::ClassLike, &lossy(identifier.value())).resolution {
            Resolution::Fqn(fqn) | Resolution::Fallback { namespaced: fqn, .. } => Some(fqn),
            Resolution::Relative(_) => None,
        }
    }

    /// `Foo::class`, as the FQN.
    pub(super) fn class_constant_name(&self, expr: &Expression<'_>) -> Option<String> {
        let Expression::Access(Access::ClassConstant(access)) = expr else { return None };
        let ClassLikeConstantSelector::Identifier(constant) = &access.constant else { return None };
        if !constant.value.eq_ignore_ascii_case(b"class") {
            return None;
        }
        self.class_ref(access.class)
    }

    /// The class an argument names: `Foo::class`, or a string with a `\`.
    fn class_arg(&self, expr: &Expression<'_>) -> Option<String> {
        self.class_constant_name(expr).or_else(|| {
            string(expr).filter(|value| value.contains('\\')).map(|value| value.trim_start_matches('\\').to_owned())
        })
    }

    // ------------------------------------------------------------ bindings

    /// Whether `expr` is the container: `$this->app`, `$app`, `$container`
    /// or `app()`.
    fn is_container(&self, expr: &Expression<'_>) -> bool {
        match expr {
            Expression::Access(Access::Property(access)) => {
                matches!(&access.property, ClassLikeMemberSelector::Identifier(name) if name.value == b"app")
            }
            Expression::Call(Call::Function(call)) => match call.function {
                Expression::Identifier(identifier) => {
                    let name = identifier.value();
                    name.strip_prefix(b"\\").unwrap_or(name).eq_ignore_ascii_case(b"app")
                }
                _ => false,
            },
            _ => variable(expr).is_some_and(|name| name == "app" || name == "container"),
        }
    }

    /// `$this->app->singleton('id', …)` and the like.
    pub(super) fn method_binding(
        &mut self,
        object: &Expression<'_>,
        selector: &ClassLikeMemberSelector<'_>,
        list: &ArgumentList<'_>,
    ) {
        if self.is_container(object) {
            self.binding(selector, list);
        }
    }

    /// `App::singleton('id', …)`.
    pub(super) fn static_binding(
        &mut self,
        class: &Expression<'_>,
        selector: &ClassLikeMemberSelector<'_>,
        list: &ArgumentList<'_>,
    ) {
        let facade =
            self.class_ref(class).is_some_and(|fqn| fqn.rsplit('\\').next().is_some_and(|short| short == "App"));
        if facade {
            self.binding(selector, list);
        }
    }

    fn binding(&mut self, selector: &ClassLikeMemberSelector<'_>, list: &ArgumentList<'_>) {
        let Some(name) = method_name(selector) else { return };
        if !BIND_METHODS.iter().any(|known| known.eq_ignore_ascii_case(&name)) {
            return;
        }
        let args = args(list);
        let (Some(first), Some(second)) = (args.first(), args.get(1)) else { return };
        let (id, target) = if name.eq_ignore_ascii_case("alias") {
            // `alias($abstract, $alias)`: the id is whichever isn't a class.
            match (string(first).filter(|id| is_id(id) && self.class_constant_name(first).is_none()), string(second)) {
                (Some(id), _) if self.class_arg(second).is_some() => (id, self.class_arg(second)),
                (_, Some(id)) if is_id(&id) => (id, self.class_arg(first)),
                _ => return,
            }
        } else {
            let Some(id) = string(first).filter(|id| is_id(id)) else { return };
            (id, None)
        };
        let target = match target {
            Some(class) => LazyType::Known(Type::named(&class)),
            // `instance()` binds the value itself.
            None if name.eq_ignore_ascii_case("instance") => self.value_type(second, false),
            None => self.concrete(second),
        };
        if target != LazyType::mixed() {
            self.summary.laravel.bindings.push(Binding { id, target });
        }
    }

    /// What a binding's concrete makes.
    fn concrete(&self, expr: &Expression<'_>) -> LazyType {
        if let Some(class) = self.class_arg(expr) {
            return LazyType::Known(Type::named(&class));
        }
        match expr {
            Expression::Closure(closure) => match &closure.return_type_hint {
                Some(hint) => LazyType::Known(Type::from_hint(&self.hint(&hint.hint))),
                None => {
                    let params = self.params(&closure.parameter_list);
                    super::infer::body_return(&self.infer(&params, &None, &[]), &closure.body)
                }
            },
            Expression::ArrowFunction(arrow) => match &arrow.return_type_hint {
                Some(hint) => LazyType::Known(Type::from_hint(&self.hint(&hint.hint))),
                None => {
                    let params = self.params(&arrow.parameter_list);
                    self.infer(&params, &None, &[]).expr(arrow.expression)
                }
            },
            Expression::Literal(_) => LazyType::mixed(),
            other => self.value_type(other, false),
        }
    }

    // ---------------------------------------------------------------- pest

    /// The top-level `uses(…)->in(…)`, `pest()->extend(…)->use(…)->in(…)`
    /// and `uses(…)` statements (inside namespaces too).
    pub(super) fn pest_uses<'s>(&mut self, statements: impl Iterator<Item = &'s Statement<'s>>) {
        for statement in statements {
            match statement {
                Statement::Expression(statement) => {
                    if let Some(found) = self.pest_chain(statement.expression) {
                        self.summary.laravel.pest.push(found);
                    }
                }
                Statement::Namespace(namespace) => self.pest_uses(namespace.statements().iter()),
                _ => {}
            }
        }
    }

    /// One `uses(A::class)->in('dir')` chain, from its outermost call.
    fn pest_chain(&self, expr: &Expression<'_>) -> Option<PestUses> {
        let mut classes = Vec::new();
        let mut dirs = Vec::new();
        let mut expr = expr;
        while let Expression::Call(Call::Method(call)) = expr {
            let name = method_name(&call.method)?;
            let args = args(&call.argument_list);
            match name.to_ascii_lowercase().as_str() {
                "in" => dirs.extend(args.iter().filter_map(|arg| string(arg))),
                "extend" | "extends" | "use" | "uses" => {
                    classes.extend(args.iter().filter_map(|arg| self.class_constant_name(arg)));
                }
                // `->group('slow')` and the like configure other things.
                _ => {}
            }
            expr = call.object;
        }
        let Expression::Call(Call::Function(root)) = expr else { return None };
        let Expression::Identifier(function) = root.function else { return None };
        let function = lossy(function.value());
        let function = function.rsplit('\\').next().unwrap_or_default().to_ascii_lowercase();
        match function.as_str() {
            "uses" => classes.extend(args(&root.argument_list).iter().filter_map(|arg| self.class_constant_name(arg))),
            "pest" => {}
            _ => return None,
        }
        if classes.is_empty() {
            return None;
        }
        // Earlier calls of the chain first.
        classes.reverse();
        let classes = classes.into_iter().map(|class| class.trim_start_matches('\\').to_owned()).collect();
        Some(PestUses { classes, dirs, file: None })
    }

    // -------------------------------------------------------------- macros

    /// `Collection::macro('name', function (…) { … })` (or an arrow
    /// function): the closure as a method named after the macro.
    pub(super) fn macro_registration(
        &mut self,
        class: &Expression<'_>,
        selector: &ClassLikeMemberSelector<'_>,
        list: &ArgumentList<'_>,
        span: Span,
    ) {
        if !method_name(selector).is_some_and(|name| name.eq_ignore_ascii_case("macro")) {
            return;
        }
        let Some(class) = self.class_ref(class) else { return };
        let args = args(list);
        let (Some(Expression::Literal(Literal::String(name))), Some(callback)) = (args.first(), args.get(1)) else {
            return;
        };
        let Some(text) = name.value.filter(|text| !text.is_empty()) else { return };
        // The name inside the quotes.
        let mut name_span = name.span;
        if name.raw.len() >= 2 {
            name_span.start.offset += 1;
            name_span.end.offset -= 1;
        }
        let doc = self.doc_at(callback.span().start.offset, &[]);
        let (params, return_type, inferred_return) = match callback {
            Expression::Closure(closure) => {
                let params = self.params(&closure.parameter_list);
                let return_type = self.return_type(&closure.return_type_hint);
                let inferred = self
                    .infers_return(&return_type, &doc)
                    .then(|| super::infer::body_return(&self.infer(&params, &doc, &[]), &closure.body));
                (params, return_type, inferred)
            }
            Expression::ArrowFunction(arrow) => {
                let params = self.params(&arrow.parameter_list);
                let return_type = self.return_type(&arrow.return_type_hint);
                let inferred = self
                    .infers_return(&return_type, &doc)
                    .then(|| self.infer(&params, &doc, &[]).expr(arrow.expression));
                (params, return_type, inferred)
            }
            _ => return,
        };
        let method = Method {
            name: lossy(text),
            name_loc: self.loc(name_span),
            loc: self.loc(span),
            visibility: Visibility::Public,
            is_static: false,
            is_abstract: false,
            is_final: false,
            by_ref_return: false,
            params,
            return_type,
            inferred_return,
            attributes: Vec::new(),
            doc,
        };
        let class = class.trim_start_matches('\\').to_owned();
        self.summary.laravel.macros.push(Macro { class, method, file: None });
    }

    // ---------------------------------------------------------- migrations

    /// `Schema::create('users', function (Blueprint $table) { … })`.
    pub(super) fn migration(
        &mut self,
        class: &Expression<'_>,
        selector: &ClassLikeMemberSelector<'_>,
        list: &ArgumentList<'_>,
    ) {
        let schema =
            self.class_ref(class).is_some_and(|fqn| fqn.rsplit('\\').next().is_some_and(|short| short == "Schema"));
        let Some(method) = method_name(selector) else { return };
        // A rollback doesn't change the schema the application sees.
        if !schema || self.in_down {
            return;
        }
        let args = args(list);
        // `Schema::dropColumns('posts', ['a', 'b'])`.
        if method.eq_ignore_ascii_case("dropColumns") {
            let Some(name) = args.first().and_then(|arg| string(arg)) else { return };
            let dropped = string_list(args.get(1..).unwrap_or_default());
            if !dropped.is_empty() {
                let table = Table { dropped, ..Table::new(name, false) };
                self.summary.laravel.tables.push(table);
            }
            return;
        }
        if !(method.eq_ignore_ascii_case("create") || method.eq_ignore_ascii_case("table")) {
            return;
        }
        let (Some(name), Some(callback)) = (args.first().and_then(|arg| string(arg)), args.get(1)) else { return };
        // Statements other than expressions (`if`, loops) may make columns.
        let mut partial = false;
        let (params, expressions): (_, Vec<&Expression<'_>>) = match callback {
            Expression::Closure(closure) => (
                &closure.parameter_list,
                closure
                    .body
                    .statements
                    .iter()
                    .filter_map(|statement| match statement {
                        Statement::Expression(statement) => Some(statement.expression),
                        Statement::Noop(_) => None,
                        _ => {
                            partial = true;
                            None
                        }
                    })
                    .collect(),
            ),
            Expression::ArrowFunction(arrow) => (&arrow.parameter_list, vec![arrow.expression]),
            _ => return,
        };
        let Some(table) = params
            .parameters
            .first()
            .map(|param| lossy(param.variable.name.strip_prefix(b"$").unwrap_or(param.variable.name)))
        else {
            return;
        };
        let created = method.eq_ignore_ascii_case("create");
        let mut made = Table::new(name, created);
        for expr in expressions {
            partial |= !column_statement(expr, &table, &mut made, |span| self.loc(span));
        }
        made.partial = partial;
        if !made.columns.is_empty() || created || partial || !made.dropped.is_empty() || !made.renamed.is_empty() {
            self.summary.laravel.tables.push(made);
        }
    }

    // ---------------------------------------------------- counted relations

    /// The `$withCount` property of class `class` (a model counting
    /// relations on every query). What `withCount()` and `loadCount()`
    /// calls count is in the type of the models they load instead.
    pub(super) fn counted_property(&mut self, class: &str, members: &Sequence<'_, ClassLikeMember<'_>>) {
        for member in members {
            let ClassLikeMember::Property(Property::Plain(property)) = member else { continue };
            for item in &property.items {
                if let PropertyItem::Concrete(item) = item
                    && item.variable.name == b"$withCount"
                {
                    self.counted_value(class, item.value);
                }
            }
        }
    }

    fn counted_value(&mut self, class: &str, value: &Expression<'_>) {
        let elements = match value {
            Expression::Array(array) => array.elements.iter(),
            Expression::LegacyArray(array) => array.elements.iter(),
            other => {
                if let Some(found) = string(other).and_then(|spec| counted(class, &spec)) {
                    self.add_counted(found);
                }
                return;
            }
        };
        for element in elements {
            let spec = match element {
                ArrayElement::Value(element) => string(element.value),
                // `['posts' => fn ($q) => …]`.
                ArrayElement::KeyValue(element) => string(element.key),
                _ => None,
            };
            if let Some(found) = spec.and_then(|spec| counted(class, &spec)) {
                self.add_counted(found);
            }
        }
    }

    fn add_counted(&mut self, found: CountedRelation) {
        if !self.summary.laravel.counted.contains(&found) {
            self.summary.laravel.counted.push(found);
        }
    }

    // --------------------------------------------------------------- casts

    /// The casts of a class: its `$casts` property, else what `casts()`
    /// returns.
    pub(super) fn model_casts(&mut self, class: &str, members: &Sequence<'_, ClassLikeMember<'_>>) {
        let mut casts = Vec::new();
        for member in members {
            match member {
                ClassLikeMember::Property(Property::Plain(property)) => {
                    for item in &property.items {
                        if let PropertyItem::Concrete(item) = item
                            && item.variable.name == b"$casts"
                        {
                            self.cast_array(item.value, &mut casts);
                        }
                    }
                }
                ClassLikeMember::Method(method) if method.name.value.eq_ignore_ascii_case(b"casts") => {
                    let MethodBody::Concrete(body) = &method.body else { continue };
                    for statement in &body.statements {
                        if let Statement::Return(r#return) = statement
                            && let Some(value) = r#return.value
                        {
                            self.cast_array(value, &mut casts);
                        }
                    }
                }
                _ => {}
            }
        }
        if !casts.is_empty() {
            self.summary.laravel.casts.push(ModelCasts { class: class.to_owned(), casts, file: None });
        }
    }

    // --------------------------------------------------------------- rules

    /// The fields of the array a class's `rules()` method returns.
    pub(super) fn request_rules(&mut self, class: &str, members: &Sequence<'_, ClassLikeMember<'_>>) {
        let mut fields = Vec::new();
        for member in members {
            let ClassLikeMember::Method(method) = member else { continue };
            if !method.name.value.eq_ignore_ascii_case(b"rules") {
                continue;
            }
            let MethodBody::Concrete(body) = &method.body else { continue };
            for statement in &body.statements {
                if let Statement::Return(r#return) = statement
                    && let Some(value) = r#return.value
                {
                    self.rule_array(value, &mut fields);
                }
            }
        }
        if !fields.is_empty() {
            self.summary.laravel.rules.push(RequestRules { class: class.to_owned(), fields, file: None });
        }
    }

    /// A call validating (`validate`, `validateWithBag`, `make`,
    /// `validator()`) with `$this->method()` among its arguments.
    pub(super) fn rule_method(&mut self, method: &ClassLikeMemberSelector<'_>, list: &ArgumentList<'_>) {
        let Some(name) = method_name(method) else { return };
        if ["validate", "validateWithBag", "make"].iter().any(|known| known.eq_ignore_ascii_case(&name)) {
            self.rule_method_arguments(list);
        }
    }

    /// Records the `$this->method()` arguments of a validating call as
    /// rule methods of the class being walked.
    pub(super) fn rule_method_arguments(&mut self, list: &ArgumentList<'_>) {
        let Some(class) = self.classes.last().cloned() else { return };
        for arg in args(list) {
            let Expression::Call(Call::Method(call)) = arg else { continue };
            let Expression::Variable(Variable::Direct(variable)) = call.object else { continue };
            if variable.name != b"$this" || !call.argument_list.arguments.is_empty() {
                continue;
            }
            let Some(method) = method_name(&call.method) else { continue };
            let found = RuleMethod { class: class.clone(), method };
            if !self.summary.laravel.rule_methods.contains(&found) {
                self.summary.laravel.rule_methods.push(found);
            }
        }
    }

    fn rule_array(&self, value: &Expression<'_>, out: &mut Vec<RuleEntry>) {
        let elements = match value {
            Expression::Array(array) => array.elements.iter(),
            Expression::LegacyArray(array) => array.elements.iter(),
            // `array_merge(parent::rules(), [...])`.
            Expression::Call(Call::Function(call)) => {
                for arg in args(&call.argument_list) {
                    self.rule_array(arg, out);
                }
                return;
            }
            _ => return,
        };
        for element in elements {
            let ArrayElement::KeyValue(element) = element else { continue };
            let Some(field) = string(element.key) else { continue };
            let mut rules = Vec::new();
            let mut push = |text: &str| {
                for segment in crate::frameworks::laravel::validation::segments(text) {
                    let name = segment.name.trim();
                    if !name.is_empty() {
                        rules.push(name.to_owned());
                    }
                }
            };
            match element.value {
                Expression::Array(array) => {
                    for item in array.elements.iter() {
                        if let ArrayElement::Value(item) = item
                            && let Some(text) = string(item.value)
                        {
                            push(&text);
                        }
                    }
                }
                value => {
                    if let Some(text) = string(value) {
                        push(&text);
                    }
                }
            }
            let loc = self.loc(element.key.span());
            match out.iter_mut().find(|known| known.field == field) {
                Some(known) => {
                    known.rules = rules;
                    known.loc = loc;
                }
                None => out.push(RuleEntry { field, rules, loc }),
            }
        }
    }

    fn cast_array(&self, value: &Expression<'_>, out: &mut Vec<Cast>) {
        let elements = match value {
            Expression::Array(array) => array.elements.iter(),
            Expression::LegacyArray(array) => array.elements.iter(),
            // `array_merge(parent::casts(), [...])`.
            Expression::Call(Call::Function(call)) => {
                for arg in args(&call.argument_list) {
                    self.cast_array(arg, out);
                }
                return;
            }
            _ => return,
        };
        for element in elements {
            let ArrayElement::KeyValue(element) = element else { continue };
            let Some(attribute) = string(element.key) else { continue };
            let Some(cast) = self.cast_value(element.value) else { continue };
            let loc = self.loc(element.key.span());
            match out.iter_mut().find(|known| known.attribute == attribute) {
                Some(known) => {
                    known.cast = cast;
                    known.loc = loc;
                }
                None => out.push(Cast { attribute, cast, loc }),
            }
        }
    }

    /// `'datetime'`, `Status::class`, `Money::class.':EUR'`,
    /// `AsCollection::of(Item::class)`.
    fn cast_value(&self, value: &Expression<'_>) -> Option<String> {
        if let Some(class) = self.class_arg(value) {
            return Some(format!("\\{class}"));
        }
        match value {
            Expression::Binary(binary) if matches!(binary.operator, BinaryOperator::StringConcat(_)) => {
                self.class_constant_name(binary.lhs).map(|class| format!("\\{class}"))
            }
            Expression::Call(Call::StaticMethod(call)) => self.class_ref(call.class).map(|class| format!("\\{class}")),
            _ => string(value).filter(|cast| !cast.is_empty()),
        }
    }
}

/// The parameters of `ApplicationBuilder::withRouting`, in order.
const WITH_ROUTING: &[&str] = &["using", "web", "api", "commands", "channels", "pages", "health", "apiPrefix", "then"];

/// The group attributes a route registrar chain or a `Route::group` array
/// sets. A chain is read from the `group()` call backwards, so the first
/// value seen of an attribute is the one Laravel keeps (a later call
/// overrides an earlier one); middleware add up.
#[derive(Default)]
struct GroupAttributes {
    prefix: Option<String>,
    name: Option<String>,
    middleware: Vec<String>,
    namespace: Option<String>,
    domain: Option<String>,
}

impl GroupAttributes {
    /// One attribute: `prefix`, `name`/`as`, `middleware`, `namespace`,
    /// `domain`; others are ignored.
    fn set(&mut self, key: &str, value: &Expression<'_>) {
        let key = key.to_ascii_lowercase();
        let slot = match key.as_str() {
            "prefix" => &mut self.prefix,
            "name" | "as" => &mut self.name,
            "namespace" => &mut self.namespace,
            "domain" => &mut self.domain,
            "middleware" => {
                let mut found = strings(value);
                found.append(&mut self.middleware);
                self.middleware = found;
                return;
            }
            _ => return,
        };
        if slot.is_none() {
            *slot = string(value);
        }
    }

    fn kind(&self) -> RouteFileKind {
        if self.middleware.iter().any(|m| m == "web") {
            RouteFileKind::Web
        } else if self.middleware.iter().any(|m| m == "api") {
            RouteFileKind::Api
        } else {
            RouteFileKind::Other
        }
    }
}

/// A string, or the strings of an array (`['web', 'auth']`).
fn strings(expr: &Expression<'_>) -> Vec<String> {
    each(expr).into_iter().filter_map(string).collect()
}

/// The value of a list or key-value array element.
fn element_value<'a>(element: &'a ArrayElement<'a>) -> Option<&'a Expression<'a>> {
    match element {
        ArrayElement::Value(element) => Some(element.value),
        ArrayElement::KeyValue(element) => Some(element.value),
        _ => None,
    }
}

/// The element values of an array literal, else the expression itself.
fn each<'a>(expr: &'a Expression<'a>) -> Vec<&'a Expression<'a>> {
    match expr {
        Expression::Array(array) => array.elements.iter().filter_map(element_value).collect(),
        Expression::LegacyArray(array) => array.elements.iter().filter_map(element_value).collect(),
        other => vec![other],
    }
}

/// The name of a called function (without a leading `\`).
fn function_name(expr: &Expression<'_>) -> Option<String> {
    let Expression::Identifier(identifier) = expr else { return None };
    let name = identifier.value();
    Some(lossy(name.strip_prefix(b"\\").unwrap_or(name)))
}

/// A piece of a route file's path: string literals, `config('key')` and
/// `config('key', 'default')` calls ([`RoutePath::config_part`]), and their
/// concatenations.
fn path_text(expr: &Expression<'_>) -> Option<String> {
    match expr {
        Expression::Parenthesized(inner) => path_text(inner.expression),
        Expression::Binary(binary) if matches!(binary.operator, BinaryOperator::StringConcat(_)) => {
            Some(path_text(binary.lhs)? + &path_text(binary.rhs)?)
        }
        Expression::Call(Call::Function(call)) if function_name(call.function)?.eq_ignore_ascii_case("config") => {
            match args(&call.argument_list)[..] {
                [key] => Some(RoutePath::config_part(&string(key)?, None)),
                [key, default] => Some(RoutePath::config_part(&string(key)?, Some(&string(default)?))),
                _ => None,
            }
        }
        _ => string(expr),
    }
}

/// A route file's path: see [`RoutePath`].
fn route_path(expr: &Expression<'_>) -> Option<RoutePath> {
    match expr {
        Expression::Parenthesized(inner) => route_path(inner.expression),
        Expression::MagicConstant(MagicConstant::Directory(_)) => Some(RoutePath::Dir { up: 0, rest: String::new() }),
        Expression::Binary(binary) if matches!(binary.operator, BinaryOperator::StringConcat(_)) => {
            let tail = path_text(binary.rhs)?;
            Some(match route_path(binary.lhs)? {
                RoutePath::Dir { up, rest } => RoutePath::Dir { up, rest: rest + &tail },
                RoutePath::Base(rest) => RoutePath::Base(rest + &tail),
                RoutePath::App(rest) => RoutePath::App(rest + &tail),
                RoutePath::Module { name, rest } => RoutePath::Module { name, rest: rest + &tail },
            })
        }
        Expression::Call(Call::Function(call)) => {
            let name = function_name(call.function)?.to_ascii_lowercase();
            let args = args(&call.argument_list);
            let text = |index: usize| match args.get(index) {
                Some(arg) => path_text(arg),
                None => Some(String::new()),
            };
            match name.as_str() {
                "base_path" => Some(RoutePath::Base(text(0)?)),
                "app_path" => Some(RoutePath::App(text(0)?)),
                "module_path" => {
                    Some(RoutePath::Module { name: args.first().and_then(|arg| string(arg)), rest: text(1)? })
                }
                "dirname" => {
                    let RoutePath::Dir { up, rest } = route_path(args.first()?)? else { return None };
                    if !rest.is_empty() {
                        return None;
                    }
                    let levels = match args.get(1) {
                        None => 1,
                        Some(Expression::Literal(Literal::Integer(levels))) => u32::try_from(levels.value?).ok()?,
                        Some(_) => return None,
                    };
                    Some(RoutePath::Dir { up: up + levels, rest })
                }
                _ => None,
            }
        }
        _ => None,
    }
}

impl Extractor<'_> {
    fn route_file(&mut self, path_expr: &Expression<'_>, kind: RouteFileKind, attributes: GroupAttributes) {
        let Some(path) = route_path(path_expr) else { return };
        let loc = self.loc(path_expr.span());
        self.summary.laravel.routes.push(RouteRegistration {
            path,
            kind,
            prefix: attributes.prefix.unwrap_or_default(),
            name_prefix: attributes.name.unwrap_or_default(),
            middleware: attributes.middleware,
            namespace: attributes.namespace,
            domain: attributes.domain,
            loc,
            file: None,
        });
    }

    /// `->withRouting(…)`, `Route::…->group(path)` and
    /// `$this->loadRoutesFrom(path)`.
    pub(super) fn method_routes(
        &mut self,
        object: &Expression<'_>,
        selector: &ClassLikeMemberSelector<'_>,
        list: &ArgumentList<'_>,
    ) {
        let Some(method) = method_name(selector) else { return };
        if method.eq_ignore_ascii_case("withRouting") {
            self.with_routing(list);
        } else if method.eq_ignore_ascii_case("loadRoutesFrom") {
            if variable(object).as_deref() == Some("this")
                && let [path] = args(list)[..]
            {
                self.route_file(path, RouteFileKind::Other, GroupAttributes::default());
            }
        } else if method.eq_ignore_ascii_case("group")
            && let [path] = args(list)[..]
            && let Some(attributes) = self.registrar_chain(object)
        {
            let kind = attributes.kind();
            self.route_file(path, kind, attributes);
        }
    }

    /// `Route::group(['prefix' => …], path)`.
    pub(super) fn static_routes(
        &mut self,
        class: &Expression<'_>,
        selector: &ClassLikeMemberSelector<'_>,
        list: &ArgumentList<'_>,
    ) {
        if !method_name(selector).is_some_and(|name| name.eq_ignore_ascii_case("group")) || !self.is_route_facade(class)
        {
            return;
        }
        let [array, path] = args(list)[..] else { return };
        let elements = match array {
            Expression::Array(array) => array.elements.iter(),
            Expression::LegacyArray(array) => array.elements.iter(),
            _ => return,
        };
        let mut attributes = GroupAttributes::default();
        for element in elements {
            if let ArrayElement::KeyValue(element) = element
                && let Some(key) = string(element.key)
            {
                attributes.set(&key, element.value);
            }
        }
        let kind = attributes.kind();
        self.route_file(path, kind, attributes);
    }

    fn is_route_facade(&self, class: &Expression<'_>) -> bool {
        self.class_ref(class).is_some_and(|fqn| fqn.rsplit('\\').next().is_some_and(|short| short == "Route"))
    }

    /// The attributes of `Route::middleware('web')->prefix('x')` (what
    /// `->group(…)` is called on), or `None` when it isn't a route registrar
    /// chain starting at the `Route` facade or `$router`.
    fn registrar_chain(&self, mut expr: &Expression<'_>) -> Option<GroupAttributes> {
        let mut attributes = GroupAttributes::default();
        loop {
            match expr {
                Expression::Call(Call::Method(call)) => {
                    let name = method_name(&call.method)?;
                    if let Some(value) = args(&call.argument_list).first() {
                        attributes.set(&name, value);
                    }
                    expr = call.object;
                }
                Expression::Call(Call::StaticMethod(call)) => {
                    if !self.is_route_facade(call.class) {
                        return None;
                    }
                    let name = method_name(&call.method)?;
                    if let Some(value) = args(&call.argument_list).first() {
                        attributes.set(&name, value);
                    }
                    return Some(attributes);
                }
                Expression::Parenthesized(inner) => expr = inner.expression,
                other => return (variable(other).as_deref() == Some("router")).then_some(attributes),
            }
        }
    }

    /// The route files of `withRouting(…)`: positional or named arguments,
    /// `web` and `api` a path or an array of paths.
    fn with_routing(&mut self, list: &ArgumentList<'_>) {
        let mut slots: [Option<&Expression<'_>>; WITH_ROUTING.len()] = [None; WITH_ROUTING.len()];
        for (index, argument) in list.arguments.iter().enumerate() {
            match argument {
                Argument::Positional(argument) => {
                    if let Some(slot) = slots.get_mut(index) {
                        *slot = Some(argument.value);
                    }
                }
                Argument::Named(argument) => {
                    if let Some(index) = WITH_ROUTING.iter().position(|name| name.as_bytes() == argument.name.value) {
                        slots[index] = Some(argument.value);
                    }
                }
            }
        }
        let api_prefix = slots[7].and_then(string).unwrap_or_else(|| "api".to_owned());
        let files = [
            (1, RouteFileKind::Web, None, Some("web")),
            (2, RouteFileKind::Api, Some(api_prefix), Some("api")),
            (3, RouteFileKind::Console, None, None),
            (4, RouteFileKind::Channels, None, None),
        ];
        for (slot, kind, prefix, middleware) in files {
            let Some(value) = slots[slot] else { continue };
            for path in each(value) {
                let attributes = GroupAttributes {
                    prefix: prefix.clone(),
                    middleware: middleware.map(str::to_owned).into_iter().collect(),
                    ..GroupAttributes::default()
                };
                self.route_file(path, kind, attributes);
            }
        }
    }
}

/// The column methods of `Blueprint` and the type of the attribute they
/// make (before casts).
fn column_type(method: &str) -> Option<&'static str> {
    const INTS: &[&str] = &[
        "id",
        "increments",
        "integerIncrements",
        "tinyIncrements",
        "smallIncrements",
        "mediumIncrements",
        "bigIncrements",
        "integer",
        "tinyInteger",
        "smallInteger",
        "mediumInteger",
        "bigInteger",
        "unsignedInteger",
        "unsignedTinyInteger",
        "unsignedSmallInteger",
        "unsignedMediumInteger",
        "unsignedBigInteger",
        "foreignId",
        "year",
    ];
    const STRINGS: &[&str] = &[
        "char",
        "string",
        "tinyText",
        "text",
        "mediumText",
        "longText",
        "uuid",
        "ulid",
        "foreignUuid",
        "foreignUlid",
        "ipAddress",
        "macAddress",
        "enum",
        "set",
        "json",
        "jsonb",
        "binary",
        "decimal",
        "unsignedDecimal",
        "date",
        "dateTime",
        "dateTimeTz",
        "time",
        "timeTz",
        "timestamp",
        "timestampTz",
    ];
    const FLOATS: &[&str] = &["float", "double", "unsignedFloat", "unsignedDouble"];
    let is = |list: &[&str]| list.iter().any(|known| known.eq_ignore_ascii_case(method));
    if is(INTS) {
        Some("int")
    } else if is(STRINGS) {
        Some("string")
    } else if is(FLOATS) {
        Some("float")
    } else if method.eq_ignore_ascii_case("boolean") {
        Some("bool")
    } else {
        None
    }
}

/// Blueprint methods that make no column of their own (indexes, keys,
/// table options, drops and renames, which the columns don't track).
const NON_COLUMNS: &[&str] = &[
    "primary",
    "unique",
    "index",
    "fulltext",
    "spatialindex",
    "foreign",
    "dropprimary",
    "dropunique",
    "dropindex",
    "dropfulltext",
    "dropspatialindex",
    "dropforeign",
    "dropconstrainedforeignid",
    "dropforeignidfor",
    "dropconstrainedforeignidfor",
    "renameindex",
    "engine",
    "charset",
    "collation",
    "comment",
    "temporary",
    "after",
    "dropcolumn",
    "droptimestamps",
    "droptimestampstz",
    "dropsoftdeletes",
    "dropsoftdeletestz",
    "dropremembertoken",
    "dropmorphs",
];

/// The columns one `$table->…;` statement makes; `loc` maps a span of the
/// file. False when the statement is a call on the blueprint that may make
/// columns it doesn't know.
fn column_statement(expr: &Expression<'_>, table: &str, out: &mut Table, loc: impl Fn(Span) -> Loc) -> bool {
    if let Some(understood) = blueprint_given(expr, table, out, &loc) {
        return understood;
    }
    // Unwind `$table->string('a')->nullable()->default('')`.
    let mut modifiers: Vec<(String, Vec<&Expression<'_>>)> = Vec::new();
    let mut expr = expr;
    let (method, args, method_span) = loop {
        let Expression::Call(Call::Method(call)) = expr else { return true };
        let Some(name) = method_name(&call.method) else { return false };
        if variable(call.object).as_deref() == Some(table) {
            break (name, args(&call.argument_list), call.method.span());
        }
        modifiers.push((name, args(&call.argument_list)));
        expr = call.object;
    };
    let nullable = modifiers.iter().any(|(name, args)| {
        name.eq_ignore_ascii_case("nullable") && !matches!(args.first(), Some(Expression::Literal(Literal::False(_))))
    });
    let named = args.first().and_then(|arg| string(arg));
    // The column's name, else the method implying it.
    let at = loc(match args.first() {
        Some(arg) if named.is_some() => arg.span(),
        _ => method_span,
    });
    let lower = method.to_ascii_lowercase();
    if let Some(understood) = schema_change(&lower, &args, named.as_deref(), out, &loc) {
        return understood;
    }
    // `string('title', 100)`; Laravel's default string length otherwise.
    let length = match lower.as_str() {
        "string" | "char" => Some(match args.get(1).map(|arg| literal_type_of(arg)) {
            Some(Type::LiteralInt(length)) => u32::try_from(length).unwrap_or(255),
            _ => 255,
        }),
        "remembertoken" => Some(100),
        _ => None,
    };
    let mut push = |name: String, ty: &str, nullable: bool| {
        out.columns.retain(|column: &Column| column.name != name);
        out.columns.push(Column { name, ty: DocType(ty.to_owned()), nullable, length, loc: at });
    };
    match lower.as_str() {
        "id" => push(named.unwrap_or_else(|| "id".to_owned()), "int", nullable),
        "timestamps" | "timestampstz" | "nullabletimestamps" => {
            push("created_at".to_owned(), CARBON, true);
            push("updated_at".to_owned(), CARBON, true);
        }
        "softdeletes" | "softdeletestz" => push(named.unwrap_or_else(|| "deleted_at".to_owned()), CARBON, true),
        "remembertoken" => push("remember_token".to_owned(), "string", true),
        // `foreignIdFor(User::class)` is `user_id` (the model's
        // `getForeignKey()`), unless named.
        "foreignidfor" => {
            let name = args.get(1).and_then(|arg| string(arg)).or_else(|| {
                args.first().and_then(|arg| class_short_name(arg)).map(|class| format!("{}_id", snake(&class)))
            });
            let Some(name) = name else { return false };
            push(name, "int", nullable);
        }
        "morphs"
        | "nullablemorphs"
        | "numericmorphs"
        | "nullablenumericmorphs"
        | "uuidmorphs"
        | "nullableuuidmorphs"
        | "ulidmorphs"
        | "nullableulidmorphs" => {
            let Some(name) = named else { return false };
            let nullable = nullable || lower.starts_with("nullable");
            let id = if lower.contains("uuid") || lower.contains("ulid") { "string" } else { "int" };
            push(format!("{name}_type"), "string", nullable);
            push(format!("{name}_id"), id, nullable);
        }
        _ => match (column_type(&method), named) {
            (Some(ty), Some(name)) => push(name, ty, nullable),
            _ => return NON_COLUMNS.contains(&lower.as_str()),
        },
    }
    true
}

/// A statement dropping or renaming columns (`dropColumn('a')`,
/// `renameColumn('a', 'b')`, `dropTimestamps()`): `Some(understood)`, or
/// `None` for other statements. A column the same call made is changed
/// there; the others are recorded for the earlier migrations.
fn schema_change(
    lower: &str,
    args: &[&Expression<'_>],
    named: Option<&str>,
    out: &mut Table,
    loc: &impl Fn(Span) -> Loc,
) -> Option<bool> {
    let dropped: Vec<String> = match lower {
        "dropcolumn" => string_list(args),
        "droptimestamps" | "droptimestampstz" => vec!["created_at".to_owned(), "updated_at".to_owned()],
        "dropsoftdeletes" | "dropsoftdeletestz" => vec![named.unwrap_or("deleted_at").to_owned()],
        "dropremembertoken" => vec!["remember_token".to_owned()],
        "dropmorphs" => match named {
            Some(name) => vec![format!("{name}_type"), format!("{name}_id")],
            None => return Some(false),
        },
        "dropconstrainedforeignid" => match named {
            Some(name) => vec![name.to_owned()],
            None => return Some(false),
        },
        "renamecolumn" => {
            let (Some(from), Some(to)) = (args.first().and_then(|arg| string(arg)), args.get(1)) else {
                return Some(false);
            };
            let Some(name) = string(to) else { return Some(false) };
            let at = loc(to.span());
            match out.columns.iter_mut().find(|column| column.name == from) {
                Some(column) => {
                    column.name = name;
                    column.loc = at;
                }
                None => out.renamed.push(RenamedColumn { from, to: name, loc: at }),
            }
            return Some(true);
        }
        _ => return None,
    };
    if dropped.is_empty() {
        return Some(false);
    }
    for name in dropped {
        out.columns.retain(|column| column.name != name);
        if !out.dropped.contains(&name) {
            out.dropped.push(name);
        }
    }
    Some(true)
}

/// A call the blueprint is given to (`NestedSet::columns($table)`):
/// `Some(understood)`, or `None` when `expr` isn't one. kalnoy/nestedset's
/// `NestedSet::columns()` makes `_lft`, `_rgt` and `parent_id` (as its
/// public README documents); any other call may make columns the
/// migrations can't know.
fn blueprint_given(expr: &Expression<'_>, table: &str, out: &mut Table, loc: &impl Fn(Span) -> Loc) -> Option<bool> {
    let (list, nested_set) = match expr {
        Expression::Call(Call::StaticMethod(call)) => {
            let nested_set = matches!(call.class, Expression::Identifier(class)
                    if class.value().rsplit(|byte| *byte == b'\\').next() == Some(b"NestedSet".as_slice()))
                && method_name(&call.method).is_some_and(|name| name.eq_ignore_ascii_case("columns"));
            (&call.argument_list, nested_set)
        }
        Expression::Call(Call::Function(call)) => (&call.argument_list, false),
        Expression::Call(Call::Method(call)) => (&call.argument_list, false),
        _ => return None,
    };
    if !args(list).iter().any(|arg| variable(arg).as_deref() == Some(table)) {
        return None;
    }
    if !nested_set {
        return Some(false);
    }
    let at = loc(expr.span());
    for (name, nullable) in [("_lft", false), ("_rgt", false), ("parent_id", true)] {
        out.columns.retain(|column| column.name != name);
        out.columns.push(Column {
            name: name.to_owned(),
            ty: DocType("int".to_owned()),
            nullable,
            length: None,
            loc: at,
        });
    }
    Some(true)
}
