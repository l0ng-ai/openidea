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
    /// The fields of the array a class's `rules()` method returns (a Form
    /// Request's, when the class is one).
    pub rules: Vec<RequestRules>,
    /// Methods whose value a class passes as the rules of a validator
    /// (`Validator::make($data, $this->rules())`), so what they return,
    /// in the class and its subclasses, is a rules array.
    pub rule_methods: Vec<RuleMethod>,
    /// The relations `withCount(…)` and `loadCount(…)` calls and `$withCount`
    /// properties name, with the property each loads (`posts_count`, or the
    /// alias of `'posts as drafts_count'`).
    pub counted: Vec<CountedRelation>,
}

impl LaravelFacts {
    pub fn is_empty(&self) -> bool {
        self.bindings.is_empty()
            && self.tables.is_empty()
            && self.casts.is_empty()
            && self.routes.is_empty()
            && self.rules.is_empty()
            && self.rule_methods.is_empty()
            && self.counted.is_empty()
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
            out.rules.extend(facts.rules.iter().map(|rules| RequestRules { file: file.clone(), ..rules.clone() }));
            out.rule_methods.extend(facts.rule_methods.iter().cloned());
            for counted in &facts.counted {
                if !out.counted.contains(counted) {
                    out.counted.push(counted.clone());
                }
            }
        }
        out.apply_schema_changes();
        out
    }

    /// Applies the columns later migrations drop and rename to the tables
    /// before them, in order: a dropped column is removed from the earlier
    /// tables of its name, and a renamed one moves to the renaming
    /// migration under its new name (keeping its type).
    fn apply_schema_changes(&mut self) {
        for at in 0..self.tables.len() {
            let (before, rest) = self.tables.split_at_mut(at);
            let current = &mut rest[0];
            if current.dropped.is_empty() && current.renamed.is_empty() {
                continue;
            }
            let mut earlier: Vec<&mut Table> =
                before.iter_mut().filter(|table| table.name.eq_ignore_ascii_case(&current.name)).collect();
            for renamed in &current.renamed {
                let mut found = None;
                for table in earlier.iter_mut() {
                    if let Some(position) = table.columns.iter().position(|column| column.name == renamed.from) {
                        found = Some(table.columns.remove(position));
                    }
                }
                let column = match found {
                    Some(column) => Column { name: renamed.to.clone(), loc: renamed.loc, ..column },
                    // Made by a statement the migrations didn't understand.
                    None => Column {
                        name: renamed.to.clone(),
                        ty: DocType("mixed".to_owned()),
                        nullable: false,
                        length: None,
                        loc: renamed.loc,
                    },
                };
                current.columns.retain(|known| known.name != column.name);
                current.columns.push(column);
            }
            for dropped in &current.dropped {
                for table in earlier.iter_mut() {
                    table.columns.retain(|column| &column.name != dropped);
                }
            }
        }
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

    /// Whether what method `method` of `class` returns is a rules array
    /// because `class` or one of `parents` (its ancestors) validates with
    /// it ([`LaravelFacts::rule_methods`]).
    pub fn returns_rules(&self, class: &str, parents: &[String], method: &str) -> bool {
        let same = |a: &str, b: &str| a.trim_start_matches('\\').eq_ignore_ascii_case(b.trim_start_matches('\\'));
        self.rule_methods.iter().any(|found| {
            found.method.eq_ignore_ascii_case(method)
                && (same(&found.class, class) || parents.iter().any(|parent| same(&found.class, parent)))
        })
    }

    /// Whether the migrations say for certain which columns `table` has:
    /// some migration creates it, and every statement of the migrations
    /// changing it was understood; or the live database schema has it.
    pub fn schema_certain(&self, table: &str) -> bool {
        let all: Vec<&Table> = self.tables.iter().filter(|t| t.name.eq_ignore_ascii_case(table)).collect();
        all.iter().any(|t| t.database.is_some()) || (all.iter().any(|t| t.created) && all.iter().all(|t| !t.partial))
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
    /// `Schema::create` (as opposed to `Schema::table`).
    pub created: bool,
    /// Some statement of the closure wasn't understood: it may make columns
    /// that aren't listed.
    pub partial: bool,
    /// The file of the migration, when the facts were merged with their
    /// files ([`LaravelFacts::merge_located`]); not stored in summaries.
    #[serde(skip)]
    pub file: Option<PathBuf>,
    /// The data source whose live schema says the table has these columns
    /// (their types and nullability as the database reports them), when
    /// the engine was given one ([`LiveSchema`](crate::frameworks::laravel::database::LiveSchema));
    /// `file` is then the migration making the columns, if any. Not stored
    /// in summaries.
    #[serde(skip)]
    pub database: Option<String>,
    /// The columns the call drops (`dropColumn('a')`, `dropTimestamps()`),
    /// from the tables of earlier migrations.
    pub dropped: Vec<String>,
    /// The columns the call renames (`renameColumn('from', 'to')`), in the
    /// tables of earlier migrations.
    pub renamed: Vec<RenamedColumn>,
}

/// `renameColumn('from', 'to')`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenamedColumn {
    pub from: String,
    pub to: String,
    /// The new name in the migration.
    pub loc: Loc,
}

/// A relation counted by `withCount('posts')` and the like.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CountedRelation {
    /// The relation method's name.
    pub relation: String,
    /// The property the count is loaded as (`posts_count`, or the alias).
    pub property: String,
}

impl Table {
    /// A table a migration call makes (`created`) or changes, before any
    /// of its statements is read.
    pub fn new(name: String, created: bool) -> Self {
        Self {
            name,
            columns: Vec::new(),
            created,
            partial: false,
            file: None,
            database: None,
            dropped: Vec::new(),
            renamed: Vec::new(),
        }
    }

    /// Where the columns come from, for hover: "a migration", "the
    /// database `app`".
    pub fn source_label(&self) -> String {
        match &self.database {
            Some(source) => format!("the database `{source}`"),
            None => "a migration".to_owned(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Column {
    pub name: String,
    /// The type a model attribute reading the column has (before casts).
    pub ty: DocType,
    /// `->nullable()`, or a column Laravel creates nullable
    /// (`timestamps()`).
    pub nullable: bool,
    /// The maximum length of a string column (`string('title', 100)`, 255
    /// when not given), when known.
    pub length: Option<u32>,
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

/// The fields a class's `rules()` method validates.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequestRules {
    /// The class (FQN).
    pub class: String,
    pub fields: Vec<RuleEntry>,
    /// The file declaring the class, when the facts were merged with their
    /// files ([`LaravelFacts::merge_located`]); not stored in summaries.
    #[serde(skip)]
    pub file: Option<PathBuf>,
}

/// A method a class validates with: `$this->rules()` given as the rules
/// of `Validator::make`, `validator()`, `$request->validate()` and the
/// like inside the class.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuleMethod {
    /// The class (FQN).
    pub class: String,
    pub method: String,
}

/// A field of a rules array: `'title' => 'required|string|max:255'`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuleEntry {
    /// The key (`title`, `tags.*`).
    pub field: String,
    /// The names of its string rules (`required`, `string`, `max`), any
    /// case as written; rule objects aren't listed.
    pub rules: Vec<String>,
    /// The key in the array.
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
