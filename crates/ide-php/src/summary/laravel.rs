//! What a file tells the Laravel type provider about the rest of the
//! project ([`LaravelFacts`]): the container bindings service providers
//! register, the columns migrations create, the casts of models, and the
//! route files the application or a service provider loads.
//!
//! These are recorded for any file (a summary can't know whether Laravel
//! is installed); the index lists the files that have some, and the
//! provider only reads them when it is active.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{DocType, Loc};
use crate::types::LazyType;

/// See the module documentation.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaravelFacts {
    /// `$app->bind('id', …)` and the like, in source order.
    pub bindings: Vec<Binding>,
    /// `Schema::create('table', …)` and `Schema::table('table', …)`, in
    /// source order.
    pub tables: Vec<Table>,
    /// The `$casts` property or `casts()` method of a class.
    pub casts: Vec<ModelCasts>,
    /// Route files loaded with their group attributes, in source order.
    pub routes: Vec<RouteRegistration>,
}

impl LaravelFacts {
    pub fn is_empty(&self) -> bool {
        self.bindings.is_empty() && self.tables.is_empty() && self.casts.is_empty() && self.routes.is_empty()
    }

    /// The facts of several files, in order.
    pub fn merge<'a>(facts: impl IntoIterator<Item = &'a LaravelFacts>) -> Self {
        Self::merge_located(facts.into_iter().map(|facts| (None, facts)))
    }

    /// The facts of several files, in order, the tables and casts
    /// remembering the file they come from (for goto).
    pub fn merge_located<'a>(facts: impl IntoIterator<Item = (Option<&'a Path>, &'a LaravelFacts)>) -> Self {
        let mut out = Self::default();
        for (file, facts) in facts {
            let file = file.map(Path::to_path_buf);
            out.bindings.extend(facts.bindings.iter().cloned());
            out.tables.extend(facts.tables.iter().map(|table| Table { file: file.clone(), ..table.clone() }));
            out.casts.extend(facts.casts.iter().map(|casts| ModelCasts { file: file.clone(), ..casts.clone() }));
            out.routes
                .extend(facts.routes.iter().map(|route| RouteRegistration { file: file.clone(), ..route.clone() }));
        }
        out
    }

    /// The columns migrations give `table` (with the migration call adding
    /// each), later ones overriding earlier ones of the same name.
    pub fn columns(&self, table: &str) -> Vec<(&Table, &Column)> {
        let mut out: Vec<(&Table, &Column)> = Vec::new();
        for table in self.tables.iter().filter(|t| t.name.eq_ignore_ascii_case(table)) {
            for column in &table.columns {
                match out.iter_mut().find(|(_, known)| known.name == column.name) {
                    Some(known) => *known = (table, column),
                    None => out.push((table, column)),
                }
            }
        }
        out
    }
}

/// A container binding registered under a string id (`'payments'`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Binding {
    pub id: String,
    /// What the binding makes: the class named (`Foo::class`, a class-name
    /// string), what a closure returns, or the instance given.
    pub target: LazyType,
}

/// The columns one migration call creates (or adds to) a table.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Table {
    pub name: String,
    pub columns: Vec<Column>,
    /// The file of the migration, when the facts were merged with their
    /// files ([`LaravelFacts::merge_located`]); not stored in summaries.
    #[serde(skip)]
    pub file: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Column {
    pub name: String,
    /// The type a model attribute reading the column has (before casts).
    pub ty: DocType,
    /// `->nullable()`, or a column Laravel creates nullable
    /// (`timestamps()`).
    pub nullable: bool,
    /// The column's name in the migration (the method's when the name is
    /// implied: `timestamps()`).
    pub loc: Loc,
}

/// The casts a class declares.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelCasts {
    /// The class (FQN).
    pub class: String,
    pub casts: Vec<Cast>,
    /// The file declaring the class, when the facts were merged with their
    /// files ([`LaravelFacts::merge_located`]); not stored in summaries.
    #[serde(skip)]
    pub file: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cast {
    pub attribute: String,
    /// A built-in cast as written (`'datetime:Y-m-d'`, `'decimal:2'`), or
    /// a cast class, fully qualified with a leading `\` (its `:arguments`
    /// dropped).
    pub cast: String,
    /// The attribute's key in the casts array.
    pub loc: Loc,
}

/// A route file loaded by the application or a service provider:
/// `withRouting(web: __DIR__.'/../routes/web.php')` in `bootstrap/app.php`,
/// `Route::middleware('api')->prefix('api')->group(base_path('routes/api.php'))`
/// in a `RouteServiceProvider`, `$this->loadRoutesFrom(…)` in a package or
/// module provider.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RouteRegistration {
    pub path: RoutePath,
    pub kind: RouteFileKind,
    /// The URI prefix of the group (`'api'`), as written.
    pub prefix: String,
    /// The route-name prefix of the group (`'admin.'`).
    pub name_prefix: String,
    /// Middleware and middleware groups (`'web'`, `'auth'`), in order.
    pub middleware: Vec<String>,
    /// The controller namespace of the group (`->namespace('App\Http\Controllers')`).
    pub namespace: Option<String>,
    pub domain: Option<String>,
    /// The path argument.
    pub loc: Loc,
    /// The file of the registration, when the facts were merged with their
    /// files ([`LaravelFacts::merge_located`]); not stored in summaries
    /// (`__DIR__` paths are resolved against it).
    #[serde(skip)]
    pub file: Option<PathBuf>,
}

/// A route file's path as the registration writes it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RoutePath {
    /// `__DIR__.'/../routes/web.php'` (`up: 0`) or
    /// `dirname(__DIR__).'/routes/web.php'` (`up: 1`): `rest` after the
    /// registering file's directory and `up` of its parents.
    Dir { up: u32, rest: String },
    /// `base_path('routes/web.php')`.
    Base(String),
    /// `app_path('Http/routes.php')`.
    App(String),
    /// `module_path('Blog', '/routes/web.php')` (nwidart/laravel-modules);
    /// `name` is `None` when it isn't a literal (`$this->name`): the module
    /// holding the registering file.
    Module { name: Option<String>, rest: String },
}

/// What a route file holds, from how it is loaded.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum RouteFileKind {
    /// `web:`, or a group with the `web` middleware.
    Web,
    /// `api:`, or a group with the `api` middleware.
    Api,
    /// `commands:` (`routes/console.php`): closure commands, not routes.
    Console,
    /// `channels:` (`routes/channels.php`): broadcast channels.
    Channels,
    /// Any other group or `loadRoutesFrom`.
    Other,
}
