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
//!   `morphs()`.
//! - **Casts:** the array of a class's `$casts` property, or the array a
//!   `casts()` method returns.
//! - **Route files:** the `web`, `api`, `commands` and `channels` files of
//!   `withRouting(…)` (Laravel 11's `bootstrap/app.php`, with the `web` and
//!   `api` middleware groups and the `apiPrefix` its `ApplicationBuilder`
//!   gives them), `Route::…->group(path)` chains and `Route::group([…], path)`
//!   (a `RouteServiceProvider`, a `then:` callback), and
//!   `$this->loadRoutesFrom(path)`, when the path is relative to `__DIR__`
//!   or `dirname(__DIR__)`, or made by `base_path()`, `app_path()` or
//!   `module_path()`.
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
    Binding, Cast, Column, DocType, Loc, ModelCasts, RouteFileKind, RoutePath, RouteRegistration, Table,
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
        if !schema || !(method.eq_ignore_ascii_case("create") || method.eq_ignore_ascii_case("table")) {
            return;
        }
        let args = args(list);
        let (Some(name), Some(callback)) = (args.first().and_then(|arg| string(arg)), args.get(1)) else { return };
        let (params, expressions): (_, Vec<&Expression<'_>>) = match callback {
            Expression::Closure(closure) => (
                &closure.parameter_list,
                closure
                    .body
                    .statements
                    .iter()
                    .filter_map(|statement| match statement {
                        Statement::Expression(statement) => Some(statement.expression),
                        _ => None,
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
        let mut columns = Vec::new();
        for expr in expressions {
            column_statement(expr, &table, &mut columns, |span| self.loc(span));
        }
        if !columns.is_empty() {
            self.summary.laravel.tables.push(Table { name, columns, file: None });
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

/// A route file's path: see [`RoutePath`].
fn route_path(expr: &Expression<'_>) -> Option<RoutePath> {
    match expr {
        Expression::Parenthesized(inner) => route_path(inner.expression),
        Expression::MagicConstant(MagicConstant::Directory(_)) => Some(RoutePath::Dir { up: 0, rest: String::new() }),
        Expression::Binary(binary) if matches!(binary.operator, BinaryOperator::StringConcat(_)) => {
            let tail = string(binary.rhs)?;
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
                Some(arg) => string(arg),
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

/// The columns one `$table->…;` statement makes; `loc` maps a span of the
/// file.
fn column_statement(expr: &Expression<'_>, table: &str, out: &mut Vec<Column>, loc: impl Fn(Span) -> Loc) {
    // Unwind `$table->string('a')->nullable()->default('')`.
    let mut modifiers: Vec<(String, Vec<&Expression<'_>>)> = Vec::new();
    let mut expr = expr;
    let (method, args, method_span) = loop {
        let Expression::Call(Call::Method(call)) = expr else { return };
        let Some(name) = method_name(&call.method) else { return };
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
    let mut push = |name: String, ty: &str, nullable: bool| {
        out.retain(|column: &Column| column.name != name);
        out.push(Column { name, ty: DocType(ty.to_owned()), nullable, loc: at });
    };
    let lower = method.to_ascii_lowercase();
    match lower.as_str() {
        "id" => push(named.unwrap_or_else(|| "id".to_owned()), "int", nullable),
        "timestamps" | "timestampstz" | "nullabletimestamps" => {
            push("created_at".to_owned(), CARBON, true);
            push("updated_at".to_owned(), CARBON, true);
        }
        "softdeletes" | "softdeletestz" => push(named.unwrap_or_else(|| "deleted_at".to_owned()), CARBON, true),
        "remembertoken" => push("remember_token".to_owned(), "string", true),
        "morphs" | "nullablemorphs" | "uuidmorphs" | "nullableuuidmorphs" | "ulidmorphs" | "nullableulidmorphs" => {
            let Some(name) = named else { return };
            let nullable = nullable || lower.starts_with("nullable");
            let id = if lower.contains("uuid") || lower.contains("ulid") { "string" } else { "int" };
            push(format!("{name}_type"), "string", nullable);
            push(format!("{name}_id"), id, nullable);
        }
        _ => {
            if let (Some(ty), Some(name)) = (column_type(&method), named) {
                push(name, ty, nullable);
            }
        }
    }
}
