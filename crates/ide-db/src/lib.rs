//! Database tools: data sources ([`source`]), connections and statement
//! execution ([`conn`]), introspection, table data paging / editing ([`sql`])
//! and statement splitting ([`split`]), for SQLite, PostgreSQL and MySQL/MariaDB.

pub mod catalog;
mod clickhouse;
mod external_tunnel;
pub use external_tunnel::stop_external_tunnels_on_exit;
mod jdbc;
mod local_settings;
mod route;
mod tunnel_approval;
pub use jdbc::{DbJdbcDriver, jdbc_driver_classes};
pub mod conn;
pub mod history;
mod oracle;
pub mod plan;
pub mod plugin;
pub mod secrets;
mod snowflake;
pub mod source;
pub mod split;
pub mod sql;
pub mod tools;
mod watch;
pub use watch::SourcesWatch;

pub use catalog::{CatalogDatabase, CatalogSchema, SourceCatalog};
pub use conn::{Held, Pool, QueryResult, ResultColumn, TruncatedCell};
pub use history::HistoryEntry;
pub use plan::{PlanNode, PlanProperty};
pub use source::{
    DataSource, DbColor, DbDriver, DbExternalTunnel, DbIntrospection, DbOptions, DbProperty, DbSchemaSelection,
    DbSnowflake, DbSnowflakeAuth, DbSsh, DbSshAuth, DbSslMode, DbTxMode, DbVisibilityChange,
};
pub use sql::{CellValue, DbRowEdit, SortKey};

use history::HistoryStore;
use ide_core::{CancellationToken, IdeError, IdeResult, error::ErrorKind};
use ide_ssh::{SshManager, SshTarget, Tunnel};
use parking_lot::Mutex;
use secrets::SecretStore;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DbTableKind {
    Table,
    View,
    MaterializedView,
}

impl DbTableKind {
    fn from_catalog(kind: Option<&str>) -> Self {
        match kind {
            Some("view") => Self::View,
            Some("materialized view") => Self::MaterializedView,
            _ => Self::Table,
        }
    }
}

/// Schema objects other than tables and columns (Go to DDL, Drop).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DbObjectKind {
    Function,
    Procedure,
    Package,
    Trigger,
    Sequence,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[serde(rename = "DbTriggerInfo")]
pub struct TriggerInfo {
    pub name: String,
    /// `before`, `after`, `instead of`.
    pub timing: String,
    /// `insert`, `update or delete`…
    pub events: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[serde(rename = "DbRoutineInfo")]
pub struct RoutineInfo {
    pub name: String,
    /// `Function` or `Procedure`.
    pub kind: DbObjectKind,
    pub arguments: String,
    /// Result type of a function.
    pub returns: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[serde(rename = "DbSequenceInfo")]
pub struct SequenceInfo {
    pub name: String,
    pub data_type: String,
}

/// An Oracle package (its procedures and functions are not listed separately).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[serde(rename = "DbPackageInfo")]
pub struct PackageInfo {
    pub name: String,
}

/// A schema's routines (procedures and functions), packages and sequences.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[serde(rename = "DbSchemaObjects")]
pub struct SchemaObjects {
    pub routines: Vec<RoutineInfo>,
    pub packages: Vec<PackageInfo>,
    pub sequences: Vec<SequenceInfo>,
    /// Objects of kinds only some databases have (Snowflake stages, streams, tasks…).
    #[serde(default)]
    pub others: Vec<SchemaObject>,
}

/// A schema object the tree lists by name under a folder of its kind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[serde(rename = "DbSchemaObject")]
pub struct SchemaObject {
    /// `stage`, `stream`, `task`, `pipe`, `fileFormat`.
    pub kind: String,
    pub name: String,
    /// What the list says about it (a stage's type, a stream's table, a task's schedule).
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[serde(rename = "DbTableInfo")]
pub struct TableInfo {
    pub name: String,
    pub kind: DbTableKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[serde(rename = "DbColumnInfo")]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default: Option<String>,
    pub primary_key: bool,
    /// `None` when it has none, or the engine keeps no comments.
    #[serde(default)]
    #[specta(optional)]
    pub comment: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[serde(rename = "DbIndexInfo")]
pub struct IndexInfo {
    pub name: String,
    pub unique: bool,
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[serde(rename = "DbTableDetails")]
pub struct TableDetails {
    /// The table's comment; `None` when it has none, or the engine keeps no comments.
    #[serde(default)]
    #[specta(optional)]
    pub comment: Option<String>,
    pub columns: Vec<ColumnInfo>,
    pub indexes: Vec<IndexInfo>,
    pub foreign_keys: Vec<ForeignKey>,
    pub triggers: Vec<TriggerInfo>,
}

/// One object privilege on a table: `grantee` may run `privilege` (`SELECT`, …), granted
/// by `grantor` (unknown on MySQL), and may grant it on when `grantable`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[serde(rename = "DbTableGrant")]
pub struct TableGrant {
    pub grantee: String,
    pub grantor: Option<String>,
    pub privilege: String,
    pub grantable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[serde(rename = "DbCompletionColumn")]
pub struct CompletionColumn {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub primary_key: bool,
    /// Has a default (or is generated): optional in INSERT.
    pub has_default: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[serde(rename = "DbCompletionTable")]
pub struct CompletionTable {
    pub schema: String,
    pub name: String,
    pub kind: DbTableKind,
    pub columns: Vec<CompletionColumn>,
}

/// `schema.table (columns) REFERENCES ref_schema.ref_table (ref_columns)`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[serde(rename = "DbForeignKey")]
pub struct ForeignKey {
    pub schema: String,
    pub table: String,
    pub columns: Vec<String>,
    pub ref_schema: String,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
}

/// The schema model SQL completion and resolution work from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[serde(rename = "DbCompletion")]
pub struct CompletionModel {
    /// Schema unqualified names resolve to.
    pub default_schema: String,
    pub tables: Vec<CompletionTable>,
    pub foreign_keys: Vec<ForeignKey>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[serde(rename = "DbTablePage")]
pub struct TablePage {
    pub result: QueryResult,
    pub details: TableDetails,
    pub offset: f64,
}

/// What a Snowflake session computes with and acts as, and what it may switch to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[serde(rename = "DbSessionContext")]
pub struct SessionContext {
    /// Empty: no warehouse is in use.
    pub warehouse: String,
    pub role: String,
    pub warehouses: Vec<String>,
    pub roles: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[serde(rename = "DbDatabases")]
pub struct Databases {
    /// The database the data source connects to (its setting, or the server default).
    pub current: String,
    pub names: Vec<String>,
}

/// Connections of one project's data sources, keyed by connection target (see [`split_target`]).
pub struct DbManager {
    root: PathBuf,
    pools: Mutex<HashMap<String, Arc<route::ConnectionSlot>>>,
    routes: route::Routes,
    local_external_tunnels: bool,
    /// App-wide SSH connections and host-key trust.
    ssh: Arc<SshManager>,
    saved_passwords: Arc<SecretStore>,
    /// Directory of the global data sources and their saved passwords ([`DbManager::with_global_sources`]).
    global: Option<(PathBuf, Arc<SecretStore>)>,
    history: Arc<HistoryStore>,
    /// What introspection read of each data source, kept between runs.
    catalogs: catalog::CatalogStore,
    /// Records executed statements in the history off the async threads, in order.
    recorder: std::sync::mpsc::Sender<(String, String, f64)>,
    /// Passwords entered this session (not saved, or not yet), by credential key.
    session_passwords: Mutex<HashMap<String, String>>,
    /// Manual-commit data sources, each with the connection of its open
    /// transaction (taken by the first statement after a commit / rollback).
    sessions: Mutex<HashMap<String, Session>>,
    /// Result pages read on from where the previous page stopped, not by running the statement again.
    cursors: conn::Cursors,
    /// The data sources as last read from disk, for [`DbManager::reconcile_sources`]
    /// (`None` until [`DbManager::watch_sources`]).
    on_disk: Mutex<Option<Vec<DataSource>>>,
}

type Session = Arc<tokio::sync::Mutex<Option<Held>>>;

const MAX_META_ROWS: usize = 100_000;
/// Completion columns of the default schema, which are read without the shared cap.
const MAX_SCHEMA_COMPLETION_ROWS: usize = 1_000_000;

/// Rows of catalog query `q`, run again as [`sql::postgres_legacy`] when a PostgreSQL server's
/// catalog lacks a column it reads (openGauss, PostgreSQL 9).
async fn catalog_rows(pool: &Pool, q: &str) -> IdeResult<Vec<Vec<Option<String>>>> {
    match pool.rows(q, MAX_META_ROWS).await {
        Err(e) if pool.driver() == DbDriver::Postgres => match sql::postgres_legacy(q) {
            Some(legacy) => pool.rows(&legacy, MAX_META_ROWS).await.map_err(|_| e),
            None => Err(e),
        },
        rows => rows,
    }
}

fn flag(v: &Option<String>) -> bool {
    matches!(v.as_deref(), Some("1" | "t" | "true" | "YES"))
}

/// Groups [`sql::foreign_keys`] rows into keys; a missing ref column (SQLite's
/// implicit primary key reference) takes the referenced table's primary key.
fn group_foreign_keys(rows: Vec<Vec<Option<String>>>, tables: &[CompletionTable]) -> Vec<ForeignKey> {
    let mut out: Vec<(String, ForeignKey)> = Vec::new();
    for r in rows {
        let mut it = r.into_iter();
        let mut next = || it.next().flatten();
        let (Some(schema), Some(table), Some(constraint), Some(column), ref_schema, Some(ref_table), ref_column) =
            (next(), next(), next(), next(), next(), next(), next())
        else {
            continue;
        };
        let ref_schema = ref_schema.unwrap_or_else(|| schema.clone());
        let same = |(c, k): &(String, ForeignKey)| *c == constraint && k.schema == schema && k.table == table;
        if !out.last().is_some_and(same) {
            out.push((
                constraint.clone(),
                ForeignKey { schema, table, columns: Vec::new(), ref_schema, ref_table, ref_columns: Vec::new() },
            ));
        }
        let key = &mut out.last_mut().expect("pushed above").1;
        key.columns.push(column);
        key.ref_columns.extend(ref_column);
    }
    out.into_iter()
        .filter_map(|(_, mut k)| {
            if k.ref_columns.is_empty() {
                let Some(target) = tables.iter().find(|t| t.schema == k.ref_schema && t.name == k.ref_table) else {
                    // Resolved by the caller (or dropped) when there is no table list.
                    return tables.is_empty().then_some(k);
                };
                k.ref_columns = target.columns.iter().filter(|c| c.primary_key).map(|c| c.name.clone()).collect();
            }
            (k.ref_columns.len() == k.columns.len()).then_some(k)
        })
        .collect()
}

/// Connection target: a data source id (its configured database), or
/// `<id>:<database>` for another database of the same server. Data source ids
/// never contain `:`.
/// Snowflake is HTTPS to a named host: a tunnel's local end cannot pass its certificate check.
fn tunneled(driver: DbDriver) -> bool {
    !matches!(driver, DbDriver::Sqlite | DbDriver::Snowflake | DbDriver::Jdbc)
}

/// The database host and port the SSH host forwards to.
fn tunnel_target(source: &DataSource) -> (&str, u16) {
    let port = source.port.or(source.driver.default_port()).unwrap_or_default();
    (if source.host.trim().is_empty() { "localhost" } else { source.host.trim() }, port)
}

pub fn split_target(target: &str) -> (&str, Option<&str>) {
    match target.split_once(':') {
        Some((id, db)) if !db.is_empty() => (id, Some(db)),
        Some((id, _)) => (id, None),
        None => (target, None),
    }
}

/// Says which leg failed when the database is unreachable from the SSH host.
fn through_tunnel(e: IdeError, source: &DataSource, via: Option<&str>) -> IdeError {
    let Some(via) = via.filter(|_| e.kind == ErrorKind::Io) else { return e };
    let port = source.port.or(source.driver.default_port()).unwrap_or_default();
    IdeError::new(
        ErrorKind::Io,
        format!("{} through the SSH tunnel ({}:{port} as seen from {via})", e.message, source.host),
    )
}

/// Options › Run keep-alive query: pings the pool until it is closed or dropped
/// (a dropped SSH tunnel or an idle-killing proxy stays alive meanwhile).
pub(crate) fn keep_alive(pool: &Arc<Pool>, every: Duration) {
    let pool = Arc::downgrade(pool);
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(every);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tick.tick().await;
        loop {
            tick.tick().await;
            let Some(p) = pool.upgrade().filter(|p| !p.is_closed()) else { break };
            if let Err(e) = p.ping().await {
                tracing::info!("keep-alive: {}", e.message);
            }
        }
    });
}

/// Rolls back a session's transaction and releases its connection.
async fn end_session(session: &Session) {
    let held = session.lock().await.take();
    if let Some(mut conn) = held
        && (conn.finish_manual(false).await.is_err() || conn.restore_default().await.is_err())
    {
        conn.discard().await;
    }
}

impl DbManager {
    /// `passwords` / `history` are the app-wide files of saved passwords
    /// ([`SecretStore`]) and query history ([`HistoryStore`]).
    pub fn new(root: PathBuf, passwords: PathBuf, history: PathBuf, ssh: Arc<SshManager>) -> Self {
        // Beside the query history, in the app data directory.
        let catalogs = history.parent().unwrap_or(&root).join("db-catalogs");
        let catalogs = catalog::CatalogStore::new(catalogs, &root);
        let history = Arc::new(HistoryStore::new(history, &root));
        let (recorder, statements) = std::sync::mpsc::channel::<(String, String, f64)>();
        {
            let history = history.clone();
            let spawned = std::thread::Builder::new().name("openidea-db-history".into()).spawn(move || {
                for (source, text, time) in statements {
                    if let Err(e) = history.add(&source, &text, time) {
                        tracing::warn!("{}", e.message);
                    }
                }
            });
            if let Err(e) = spawned {
                tracing::warn!("query history recorder: {e}");
            }
        }
        Self {
            saved_passwords: Arc::new(SecretStore::new(passwords, &root)),
            global: None,
            history,
            catalogs,
            recorder,
            root,
            pools: Mutex::default(),
            routes: Mutex::default(),
            local_external_tunnels: false,
            ssh,
            session_passwords: Mutex::default(),
            on_disk: Mutex::default(),
            sessions: Mutex::default(),
            cursors: conn::Cursors::default(),
        }
    }

    /// Also lists the global data sources stored in `dir` (the app data directory).
    pub fn with_global_sources(mut self, dir: PathBuf) -> Self {
        let passwords = self.saved_passwords.scoped(&dir);
        self.global = Some((dir, Arc::new(passwords)));
        self
    }

    /// The project's data sources, then the global ones (a project one wins on the same id).
    pub fn sources(&self) -> IdeResult<Vec<DataSource>> {
        let mut all = source::load(&self.root)?;
        let global: Vec<_> = self.global_sources().into_iter().filter(|g| all.iter().all(|s| s.id != g.id)).collect();
        all.extend(global);
        Ok(all)
    }

    fn global_sources(&self) -> Vec<DataSource> {
        let Some((dir, _)) = &self.global else { return Vec::new() };
        source::load_global(dir).unwrap_or_else(|e| {
            tracing::warn!("global data sources: {}", e.message);
            Vec::new()
        })
    }

    /// Where the saved passwords of data source `id` live: app-wide for a global one.
    fn saved_for(&self, id: &str) -> &SecretStore {
        match &self.global {
            Some((_, store)) if self.sources().is_ok_and(|sources| sources.iter().any(|s| s.id == id && s.global)) => {
                store
            }
            _ => &self.saved_passwords,
        }
    }

    fn store_of(&self, source: &DataSource) -> &Arc<SecretStore> {
        match &self.global {
            Some((_, store)) if source.global => store,
            _ => &self.saved_passwords,
        }
    }

    fn non_password_snowflake(source: &DataSource) -> Option<DbSnowflake> {
        let settings = match source.driver {
            DbDriver::Snowflake => source.resolved().map(|source| source.snowflake()).unwrap_or_default(),
            DbDriver::Jdbc => source.snowflake.clone()?,
            _ => return None,
        };
        (settings.auth != DbSnowflakeAuth::Password).then_some(settings)
    }

    fn jdbc_password_isolated(&self, source: &DataSource) -> bool {
        source.driver == DbDriver::Jdbc
            && (Self::non_password_snowflake(source).is_some()
                || self
                    .sources()
                    .unwrap_or_default()
                    .iter()
                    .any(|stored| stored.id == source.id && Self::non_password_snowflake(stored).is_some()))
    }

    fn password_key(&self, source: &DataSource) -> String {
        if self.jdbc_password_isolated(source) { secrets::jdbc_key(&source.id) } else { source.id.clone() }
    }

    /// The connection settings of target `target` ([`DataSource::resolved`]), with
    /// its database for `<id>:<database>`.
    pub fn source(&self, target: &str) -> IdeResult<DataSource> {
        let (id, database) = split_target(target);
        let mut source = self
            .sources()?
            .into_iter()
            .find(|s| s.id == id)
            .ok_or_else(|| IdeError::not_found(format!("no data source {id}")))?
            .resolved()?;
        source.select_database(database);
        Ok(source)
    }

    /// Saves the data source list, preserving connections when only visibility rules change.
    /// Global ones (`global`) go to the app-wide list, the others to the project's.
    pub async fn save_sources(&self, mut sources: Vec<DataSource>) -> IdeResult<()> {
        if sources.iter().any(|s| s.global && s.plugin_owner.is_some()) {
            return Err(IdeError::invalid("plugin-owned data sources must stay project-scoped"));
        }
        let old = {
            let _guard = plugin::EDIT.lock();
            let old = self.sources().unwrap_or_default();
            for source in sources.iter_mut().filter(|s| s.driver == DbDriver::Jdbc) {
                // Retain the credential scope even when URL-only settings supplied the old authenticator.
                if let Some(settings) = old.iter().find(|s| s.id == source.id).and_then(Self::non_password_snowflake) {
                    source.snowflake = Some(settings);
                }
            }
            let (global, project): (Vec<_>, Vec<_>) = sources.iter().cloned().partition(|s| s.global);
            match &self.global {
                // Rewritten only when it changes: other projects' windows edit the same file.
                Some((dir, _)) => {
                    if global != old.iter().filter(|s| s.global).cloned().collect::<Vec<_>>() {
                        source::save_global(dir, &global)?;
                    }
                }
                None if !global.is_empty() => {
                    return Err(IdeError::invalid("global data sources are not available here"));
                }
                None => {}
            }
            source::save(&self.root, &project)?;
            old
        };
        for o in old {
            match sources.iter().find(|s| s.id == o.id) {
                Some(n) if o.same_except_visibility(n) => {}
                gone_or_changed => {
                    let keys =
                        [o.id.clone(), secrets::jdbc_key(&o.id), secrets::ssh_key(&o.id), Self::sso_credential(&o.id)];
                    match gone_or_changed {
                        None => {
                            self.catalogs.forget(&o.id);
                            for k in &keys {
                                self.session_passwords.lock().remove(k);
                                self.store_of(&o).delete(k);
                            }
                        }
                        // Made global or project-level: its saved passwords move along.
                        Some(n) if n.global != o.global => {
                            for k in &keys {
                                if let Some(p) = self.store_of(&o).get(k) {
                                    self.store_of(n).set(k, &p)?;
                                    self.store_of(&o).delete(k);
                                }
                            }
                        }
                        Some(_) => {}
                    }
                    self.disconnect_source(&o.id).await;
                }
            }
        }
        // Our own write is not reported as an edit on disk.
        if let Some(known) = self.on_disk.lock().as_mut() {
            *known = self.sources().unwrap_or(sources);
        }
        Ok(())
    }

    /// Updates one scope of a source's visibility against its latest saved rules.
    pub fn save_source_visibility(&self, id: &str, available: &[String], change: DbVisibilityChange) -> IdeResult<()> {
        let _guard = plugin::EDIT.lock();
        let mut sources = source::load(&self.root)?;
        let scoped_global = self.global.as_ref().filter(|_| !sources.iter().any(|source| source.id == id));
        if let Some((dir, _)) = scoped_global {
            sources = source::load_global(dir)?;
        }
        let selected = sources
            .iter_mut()
            .find(|source| source.id == id)
            .ok_or_else(|| IdeError::not_found(format!("no data source {id}")))?;
        let previous = selected.introspection.clone();
        change.apply(&mut selected.introspection, available);
        if selected.introspection == previous {
            return Ok(());
        }
        if let Some((dir, _)) = scoped_global {
            source::save_global(dir, &sources)?;
        } else {
            source::save(&self.root, &sources)?;
        }
        Ok(())
    }

    /// Watches the data source files (the project's and the global one) for edits made
    /// outside the IDE; `on_change` runs on a background thread once they settle, and
    /// should call [`DbManager::reconcile_sources`]. Stops when the result is dropped.
    pub fn watch_sources(&self, on_change: Box<dyn Fn() + Send>) -> IdeResult<SourcesWatch> {
        *self.on_disk.lock() = Some(self.sources().unwrap_or_default());
        SourcesWatch::start(&self.root, self.global.as_ref().map(|(dir, _)| dir.as_path()), on_change)
    }

    /// Re-reads the data sources after their files changed on disk and closes affected
    /// connections as on [`DbManager::save_sources`] (saved passwords stay, the source
    /// may come back). Returns whether the list the tree
    /// shows changed, or the files no longer parse (the tree reports the error).
    pub async fn reconcile_sources(&self) -> bool {
        let now = match self.sources() {
            Ok(now) => now,
            Err(e) => {
                tracing::warn!("data sources: {}", e.message);
                return true;
            }
        };
        let before = self.on_disk.lock().replace(now.clone()).unwrap_or_default();
        if before == now {
            return false;
        }
        for o in &before {
            if now.iter().find(|s| s.id == o.id).is_none_or(|n| !o.same_except_visibility(n)) {
                self.disconnect_source(&o.id).await;
            }
        }
        true
    }

    /// Remembers `password` for the session, and in the saved passwords when
    /// the data source saves passwords (`None` forgets it).
    pub async fn set_password(&self, id: &str, password: Option<String>, save: bool) -> IdeResult<()> {
        let source = self.sources()?.into_iter().find(|s| s.id == id);
        let (store, key) = match source.as_ref() {
            Some(source) => (self.store_of(source), self.password_key(source)),
            None => (&self.saved_passwords, id.to_owned()),
        };
        self.remember(store, key, password, save).await
    }

    /// [`DbManager::set_password`] for the SSH password / key passphrase.
    /// A data source using an SSH configuration sets that configuration's secret.
    pub async fn set_ssh_secret(&self, id: &str, secret: Option<String>, save: bool) -> IdeResult<()> {
        let config = self.sources()?.into_iter().find(|s| s.id == id).and_then(|s| s.ssh).map(|s| s.config);
        if let Some(c) = config.filter(|c| !c.trim().is_empty()) {
            let save = self.ssh.config(&c).map(|c| c.save_secret).unwrap_or(save);
            return self.ssh.set_secret(&c, secret, save);
        }
        self.remember(self.saved_for(id), secrets::ssh_key(id), secret, save).await
    }

    async fn remember(&self, store: &SecretStore, key: String, secret: Option<String>, save: bool) -> IdeResult<()> {
        match &secret {
            Some(p) => {
                self.session_passwords.lock().insert(key.clone(), p.clone());
            }
            None => {
                self.session_passwords.lock().remove(&key);
            }
        }
        let result = match (secret, save) {
            (Some(p), true) => store.set(&key, &p),
            _ => {
                store.delete(&key);
                Ok(())
            }
        };
        if let Err(e) = result {
            // The session copy still works; the user is asked again next time.
            tracing::warn!("could not save the password: {}", e.message);
        }
        Ok(())
    }

    async fn secret(&self, source: &DataSource, key: String, saved: bool) -> Option<String> {
        if let Some(p) = self.session_passwords.lock().get(&key) {
            return Some(p.clone());
        }
        if !saved {
            return None;
        }
        // The OS may wait for the user to unlock the credential store. A cancelled connection
        // must be able to stop waiting without starting its helper when the prompt is answered.
        let store = Arc::clone(self.store_of(source));
        tokio::task::spawn_blocking(move || store.get(&key)).await.ok().flatten()
    }

    async fn password(&self, source: &DataSource) -> Option<String> {
        match self
            .secret(source, self.password_key(source), source.driver != DbDriver::Sqlite && source.save_password)
            .await
        {
            Some(p) => Some(p),
            None => source.url_password(),
        }
    }

    /// Trusts the host key that failed the last connection of `id` (adds it to `known_hosts`).
    pub async fn trust_ssh_host(&self, id: &str) -> IdeResult<()> {
        if self.ssh.trust_host(&self.host_key(id)).await.is_ok() {
            return Ok(());
        }
        let config = self.sources()?.into_iter().find(|s| s.id == id).and_then(|s| s.ssh).map(|s| s.config);
        match config.filter(|c| !c.trim().is_empty()) {
            Some(c) => self.ssh.trust_host(&c).await,
            None => Err(IdeError::not_found("no host key to trust")),
        }
    }

    /// Key of the unknown host keys of data source `id`'s own SSH settings.
    fn host_key(&self, id: &str) -> String {
        format!("db:{}:{id}", self.root.display())
    }

    /// How the SSH host of `ssh` is shown in errors.
    fn ssh_label(&self, ssh: &DbSsh) -> String {
        match self.ssh.config(ssh.config.trim()) {
            Ok(c) if !ssh.config.trim().is_empty() => c.label(),
            _ => ssh.host.clone(),
        }
    }

    /// The SSH session the tunnel of `source` goes through: its shared SSH configuration's, or one
    /// opened with the settings typed in the data source.
    async fn ssh_session(
        &self,
        source: &DataSource,
        ssh: &DbSsh,
        ssh_secret: Option<String>,
    ) -> IdeResult<Arc<ide_ssh::Session>> {
        let config = ssh.config.trim();
        Ok(if config.is_empty() {
            let secret = match ssh_secret {
                Some(s) => Some(s),
                None => self.secret(source, secrets::ssh_key(&source.id), ssh.save_secret).await,
            };
            let target = SshTarget {
                host: ssh.host.clone(),
                port: ssh.port,
                user: ssh.user.clone(),
                auth: ssh.auth,
                key_file: ssh.key_file.clone(),
            };
            Arc::new(self.ssh.connect(&self.host_key(&source.id), &target, secret.as_deref()).await?)
        } else {
            if let Some(s) = ssh_secret {
                let save = self.ssh.config(config)?.save_secret;
                if let Err(e) = self.ssh.set_secret(config, Some(s), save) {
                    tracing::warn!("could not save the SSH credential: {}", e.message);
                }
            }
            self.ssh.session(config).await?
        })
    }

    /// Data Source › SSH/SSL › Test SSH Tunnel: logs in to the SSH host and checks that it reaches
    /// the database host and port, without logging in to the database.
    pub async fn test_tunnel(&self, source: &DataSource, ssh_secret: Option<String>) -> IdeResult<String> {
        let source = &source.resolved()?;
        let ssh = source
            .ssh
            .as_ref()
            .filter(|s| s.enabled && tunneled(source.driver))
            .ok_or_else(|| IdeError::invalid("This data source does not use an SSH tunnel"))?;
        let session = self.ssh_session(source, ssh, ssh_secret).await?;
        let (host, port) = tunnel_target(source);
        drop(Tunnel::open(session.clone(), host, port).await?);
        Ok(format!("{} reaches {host}:{port}", session.label()))
    }

    /// Connects with `source` as given (not necessarily saved): Test Connection.
    pub async fn test(
        &self,
        source: &DataSource,
        password: Option<String>,
        ssh_secret: Option<String>,
    ) -> IdeResult<String> {
        if source.external_tunnel.is_some() {
            return Err(IdeError::invalid("Review the external tunnel in the local Test Connection dialog"));
        }
        self.test_connection(source, password, ssh_secret, route::RouteUse::Test).await
    }

    pub async fn test_external_tunnel(&self, source: &DataSource, password: Option<String>) -> IdeResult<String> {
        self.external_config(source)?;
        self.test_connection(source, password, None, route::RouteUse::ReviewedExternalTest).await
    }

    async fn test_connection(
        &self,
        source: &DataSource,
        password: Option<String>,
        ssh_secret: Option<String>,
        purpose: route::RouteUse,
    ) -> IdeResult<String> {
        let source = &source.resolved()?;
        let password = match password {
            Some(p) => Some(p),
            None => self.password(source).await,
        };
        let (target, _tunnel) = self.endpoint(source, ssh_secret, purpose).await?;
        self.restore_sso(source).await;
        let connected = self.open_pool(&target, password.as_deref(), true).await;
        self.keep_sso(source).await;
        let pool = connected.map_err(|e| self.connection_error(e, source))?;
        if let Pool::Jdbc(p) = &pool {
            let version = p.version.clone();
            pool.close().await;
            return Ok(version);
        }
        let version = match source.driver {
            DbDriver::Jdbc => unreachable!("JDBC uses driver metadata"),
            DbDriver::Sqlite => "SELECT 'SQLite ' || sqlite_version()",
            DbDriver::Postgres | DbDriver::Clickhouse => "SELECT version()",
            DbDriver::Mysql => "SELECT CONCAT(@@version_comment, ' ', VERSION())",
            DbDriver::SqlServer => "SELECT @@VERSION",
            DbDriver::Oracle => "SELECT banner FROM v$version WHERE banner LIKE 'Oracle%' AND ROWNUM = 1",
            DbDriver::Snowflake => "SELECT 'Snowflake ' || CURRENT_VERSION()",
        };
        let result = match &pool {
            // On the session the login opened: metadata has its own, which would sign in again.
            Pool::Snowflake(p) => p.execute(version, 1, &CancellationToken::new()).await.map(|r| r.rows),
            _ => pool.rows(version, 1).await,
        };
        pool.close().await;
        let strict = pool.transaction_read_only()
            || source.external_tunnel.is_some()
            || matches!(source.driver, DbDriver::Clickhouse | DbDriver::Snowflake);
        let rows = if strict { result? } else { result.unwrap_or_default() };
        let v = rows.into_iter().next().and_then(|r| r.into_iter().next().flatten());
        let mut message = v.unwrap_or_else(|| "Connected".into());
        if pool.transaction_read_only() {
            message.push_str(
                "\nRead-only queries use BEGIN READ ONLY because this endpoint rejected the startup setting.",
            );
        }
        Ok(message)
    }

    /// Runs `job` with the client tool at `executable` against target `id`, connected like the
    /// data source (through its SSH tunnel, with its SSL settings and password), until it exits
    /// or `cancel` fires. Connects first, so a missing password fails the way it does for a
    /// console. Returns the exit code.
    pub async fn run_tool(
        &self,
        id: &str,
        executable: &std::path::Path,
        job: &tools::DbToolJob,
        cancel: &CancellationToken,
        on_output: impl FnMut(Vec<tools::ToolLine>),
    ) -> IdeResult<Option<i32>> {
        let tool = job.tool();
        if !tool.is_program(executable) {
            return Err(IdeError::invalid(format!("{} is not {}", executable.display(), tool.program())));
        }
        let source = self.source(id)?;
        if source.driver != tool.driver() {
            return Err(IdeError::invalid(format!("{} cannot connect to {}", tool.program(), source.name)));
        }
        // Keep the same route as the connected pool for the entire tool invocation.
        let connection = self.connection(id).await?;
        let target = connection.target(&source);
        let password = self.password(&source).await;
        let mut prepared = tools::prepare(job, executable, &target, password.as_deref())?;
        if source.external_tunnel.is_some() {
            // libpq gives PGHOSTADDR precedence over --host when choosing the TCP peer.
            prepared.env.push(("PGHOSTADDR".into(), target.host.clone()));
        }
        tools::run(executable, &prepared.args, &prepared.env, prepared.input.as_deref(), cancel, on_output).await
    }

    /// The command [`DbManager::run_tool`] would run, for the dialogs' preview: the data source's
    /// own host and port (not a tunnel's local end), and no password.
    pub fn tool_preview(&self, id: &str, executable: &std::path::Path, job: &tools::DbToolJob) -> IdeResult<String> {
        let source = self.source(id)?;
        let prepared = tools::prepare(job, executable, &source, None)?;
        Ok(tools::command_line(executable, &prepared.args, job.input()))
    }

    /// The PostgreSQL server's `server_version_num` (`150013` for 15.13).
    pub async fn server_version(&self, id: &str) -> IdeResult<u32> {
        let pool = self.pool(id).await?;
        if pool.driver() != DbDriver::Postgres {
            return Err(IdeError::invalid("not a PostgreSQL data source"));
        }
        let rows = pool.rows("SHOW server_version_num", 1).await?;
        rows.into_iter()
            .next()
            .and_then(|r| r.into_iter().next().flatten())
            .and_then(|v| v.trim().parse().ok())
            .ok_or_else(|| IdeError::internal("no server version"))
    }

    /// Creates a database on the server of data source `id` by running `statement` on the data
    /// source's own database, after closing the IDE's connections to `template`, the database
    /// the server copies (PostgreSQL and SQL Server refuse to copy one that has sessions).
    pub async fn create_database(&self, id: &str, template: &str, statement: &str) -> IdeResult<()> {
        let id = split_target(id).0;
        if self.source(id)?.read_only {
            return Err(IdeError::new(ErrorKind::PermissionDenied, "the data source is read-only"));
        }
        self.disconnect(&format!("{id}:{template}")).await;
        self.pool(id).await?.execute(statement, 0, &CancellationToken::new()).await?;
        self.remember_statement(id, statement);
        Ok(())
    }

    /// Drops `database` of the server of data source `id` by running `statement` on the data
    /// source's own database, after closing the IDE's connections to `database`.
    /// Refuses the database the data source connects to and read-only data sources.
    pub async fn drop_database(&self, id: &str, database: &str, statement: &str) -> IdeResult<()> {
        let id = split_target(id).0;
        if self.source(id)?.read_only {
            return Err(IdeError::new(ErrorKind::PermissionDenied, "the data source is read-only"));
        }
        if self.databases(id).await?.current == database {
            return Err(IdeError::invalid(format!("the data source connects to {database}; it cannot drop it")));
        }
        self.disconnect(&format!("{id}:{database}")).await;
        self.pool(id).await?.execute(statement, 0, &CancellationToken::new()).await?;
        self.remember_statement(id, statement);
        Ok(())
    }

    /// The databases of the server of data source `id` (PostgreSQL), the connected one first.
    pub async fn databases(&self, id: &str) -> IdeResult<Databases> {
        let id = split_target(id).0;
        let introspection = self.source(id)?.introspection;
        let system = introspection.show_system;
        let pool = self.pool(id).await?;
        if pool.driver() == DbDriver::SqlServer {
            let first =
                |rows: Vec<Vec<Option<String>>>| rows.into_iter().filter_map(|r| r.into_iter().next().flatten());
            let current = first(pool.rows("SELECT DB_NAME()", 1).await?).next().unwrap_or_default();
            let names = first(pool.rows(sql::sqlserver_databases(), MAX_META_ROWS).await?).collect();
            return Ok(Databases { current, names });
        }
        if pool.driver() == DbDriver::Snowflake {
            let current = pool
                .rows("SELECT CURRENT_DATABASE()", 1)
                .await?
                .into_iter()
                .next()
                .and_then(|r| r.into_iter().next().flatten())
                .unwrap_or_default();
            // `SHOW` needs no running warehouse and lists what the role may see. Columns: created_on, name…
            let names = pool
                .rows("SHOW TERSE DATABASES", MAX_META_ROWS)
                .await?
                .into_iter()
                .filter_map(|r| r.into_iter().nth(1).flatten())
                .collect();
            return Ok(Databases { current, names });
        }
        if pool.driver() != DbDriver::Postgres {
            return Err(IdeError::invalid("this data source does not list databases"));
        }
        let first = |rows: Vec<Vec<Option<String>>>| rows.into_iter().filter_map(|r| r.into_iter().next().flatten());
        let current = first(pool.rows("SELECT current_database()", 1).await?).next().unwrap_or_default();
        let rows = pool.rows(sql::databases(introspection.show_templates), MAX_META_ROWS).await?;
        let mut names: Vec<String> =
            first(rows).filter(|n| system || *n == current || !sql::INTERNAL_DATABASES.contains(&n.as_str())).collect();
        if !names.contains(&current) {
            names.insert(0, current.clone());
        }
        Ok(Databases { current, names })
    }

    /// The schemas of `database` of data source `id` with their tables and views (Snowflake):
    /// what completion needs to follow `database.schema.table` without the tree being opened.
    /// The result is also saved ([`DbManager::saved_catalog`]) for the next run.
    pub async fn database_catalog(&self, id: &str, database: &str) -> IdeResult<Vec<CatalogSchema>> {
        let id = split_target(id).0;
        let schemas = match &*self.pool(id).await? {
            Pool::Snowflake(p) => snowflake::meta::catalog(p, database).await?,
            _ => return Err(IdeError::invalid("this data source does not list other databases")),
        };
        if let Err(e) = self.catalogs.put(id, database, schemas.clone()).await {
            // Completion still has it for this run.
            tracing::warn!("could not save the catalog of {database}: {}", e.message);
        }
        Ok(schemas)
    }

    /// What earlier introspection of data source `id` saved (`None`: never introspected).
    /// Read from disk: the data source is not connected to.
    pub async fn saved_catalog(&self, id: &str) -> IdeResult<Option<SourceCatalog>> {
        self.catalogs.load(split_target(id).0).await
    }

    /// Drops the saved databases of data source `id` that are not in `databases` any more.
    pub async fn retain_catalog(&self, id: &str, databases: Vec<String>) -> IdeResult<()> {
        self.catalogs.retain(split_target(id).0, databases).await
    }

    /// Credential key of the single sign-on ID token of data source `id`.
    fn sso_credential(id: &str) -> String {
        format!("{id}#sso")
    }

    /// Hands the saved single sign-on token of `source` to the driver, so it signs in without the browser.
    async fn restore_sso(&self, source: &DataSource) {
        let Some(key) = snowflake::sso_key(source) else { return };
        if snowflake::sso_token(&key).is_none()
            && let Some(saved) = self.store_of(source).get(&Self::sso_credential(&source.id))
        {
            snowflake::sso_seed(&key, &saved);
        }
    }

    /// Keeps the token the last sign-in of `source` left in the credential store (or forgets a refused one).
    async fn keep_sso(&self, source: &DataSource) {
        let Some(key) = snowflake::sso_key(source) else { return };
        if source.id.is_empty() {
            return;
        }
        let credential = Self::sso_credential(&source.id);
        let store = self.store_of(source);
        let (now, saved) = (snowflake::sso_token(&key), store.get(&credential));
        if now == saved {
            return;
        }
        match now {
            Some(token) => {
                if let Err(e) = store.set(&credential, &token) {
                    tracing::warn!("could not save the single sign-on token: {}", e.message);
                }
            }
            None => store.delete(&credential),
        }
    }

    /// The warehouse and role of the session of data source `id` (Snowflake), and its choices.
    pub async fn session_context(&self, id: &str) -> IdeResult<SessionContext> {
        match &*self.pool(id).await? {
            Pool::Snowflake(p) => snowflake::meta::session(p).await,
            _ => Err(IdeError::invalid("this data source has no warehouse or role")),
        }
    }

    /// Every schema (the Schemas tab picks the ones the tree shows); system schemas
    /// only with [`DbIntrospection::show_system`].
    pub async fn schemas(&self, id: &str) -> IdeResult<Vec<String>> {
        let system = self.source(id)?.introspection.show_system;
        let pool = self.pool(id).await?;
        if let Pool::Snowflake(p) = &*pool {
            return snowflake::meta::schemas(p, system).await;
        }
        let rows = match &*pool {
            Pool::Jdbc(p) => p.metadata(&["schemas"]).await?,
            _ => pool.rows(sql::schemas(pool.driver(), system), MAX_META_ROWS).await?,
        };
        Ok(rows.into_iter().filter_map(|r| r.into_iter().next().flatten()).collect())
    }

    pub async fn tables(&self, id: &str, schema: &str) -> IdeResult<Vec<TableInfo>> {
        let pool = self.pool(id).await?;
        if let Pool::Snowflake(p) = &*pool {
            return snowflake::meta::tables(p, schema).await;
        }
        let rows = match &*pool {
            Pool::Jdbc(p) => p.metadata(&["tables", schema]).await?,
            _ => pool.rows(&sql::tables(pool.driver(), schema), MAX_META_ROWS).await?,
        };
        Ok(rows
            .into_iter()
            .filter_map(|r| {
                let mut it = r.into_iter();
                let name = it.next().flatten()?;
                Some(TableInfo { name, kind: DbTableKind::from_catalog(it.next().flatten().as_deref()) })
            })
            .collect())
    }

    pub async fn table_details(&self, id: &str, schema: &str, table: &str) -> IdeResult<TableDetails> {
        let pool = self.pool(id).await?;
        if let Pool::Snowflake(p) = &*pool {
            return snowflake::meta::table_details(p, schema, table).await;
        }
        let driver = pool.driver();
        let rows = match &*pool {
            Pool::Jdbc(p) => p.metadata(&["columns", schema, table]).await?,
            _ => pool.rows(&sql::columns(driver, schema, table), MAX_META_ROWS).await?,
        };
        let columns = rows
            .into_iter()
            .filter_map(|r| {
                let mut it = r.into_iter();
                let name = it.next().flatten()?;
                let data_type = it.next().flatten().unwrap_or_default();
                let nullable = flag(&it.next().flatten());
                let default = it.next().flatten();
                let primary_key = flag(&it.next().flatten());
                let comment = it.next().flatten().filter(|c| !c.is_empty());
                Some(ColumnInfo { name, data_type, nullable, default, primary_key, comment })
            })
            .collect();
        if driver == DbDriver::Jdbc {
            return Ok(TableDetails {
                comment: None,
                columns,
                indexes: vec![],
                foreign_keys: vec![],
                triggers: vec![],
            });
        }
        let mut indexes: Vec<IndexInfo> = Vec::new();
        for r in pool.rows(&sql::indexes(driver, schema, table), MAX_META_ROWS).await? {
            let mut it = r.into_iter();
            let (Some(name), unique, Some(col)) = (it.next().flatten(), it.next().flatten(), it.next().flatten())
            else {
                continue;
            };
            match indexes.last_mut() {
                Some(last) if last.name == name => last.columns.push(col),
                _ => indexes.push(IndexInfo { name, unique: flag(&unique), columns: vec![col] }),
            }
        }
        let fk_rows = if matches!(driver, DbDriver::Clickhouse | DbDriver::Snowflake) {
            Vec::new()
        } else {
            pool.rows(&sql::table_foreign_keys(driver, schema, table), MAX_META_ROWS).await.unwrap_or_default()
        };
        let mut foreign_keys = group_foreign_keys(fk_rows, &[]);
        // SQLite keys that reference the primary key implicitly: look it up.
        for k in foreign_keys.iter_mut().filter(|k| k.ref_columns.is_empty()) {
            k.ref_columns = pool
                .rows(&sql::columns(driver, &k.ref_schema, &k.ref_table), MAX_META_ROWS)
                .await?
                .into_iter()
                .filter(|r| flag(&r.get(4).cloned().flatten()))
                .filter_map(|r| r.into_iter().next().flatten())
                .collect();
        }
        foreign_keys.retain(|k| k.columns.len() == k.ref_columns.len());
        let trigger_rows = if matches!(driver, DbDriver::Clickhouse | DbDriver::Snowflake) {
            Vec::new()
        } else {
            pool.rows(&sql::triggers(driver, schema, table), MAX_META_ROWS).await.unwrap_or_else(|e| {
                tracing::warn!("triggers: {}", e.message);
                Vec::new()
            })
        };
        let triggers = trigger_rows
            .into_iter()
            .filter_map(|r| {
                let mut it = r.into_iter();
                let name = it.next().flatten()?;
                let (timing, events) = if driver == DbDriver::Sqlite {
                    sql::sqlite_trigger_event(&it.next().flatten().unwrap_or_default())
                } else {
                    (it.next().flatten().unwrap_or_default(), it.next().flatten().unwrap_or_default())
                };
                Some(TriggerInfo { name, timing, events })
            })
            .collect();
        let comment = match sql::table_comment(driver, schema, table) {
            Some(q) => pool.rows(&q, 1).await.map_or_else(
                |e| {
                    tracing::warn!("table comment: {}", e.message);
                    None
                },
                |rows| rows.into_iter().next().and_then(|r| r.into_iter().next().flatten()).filter(|c| !c.is_empty()),
            ),
            None => None,
        };
        Ok(TableDetails { comment, columns, indexes, foreign_keys, triggers })
    }

    /// The object privileges granted on `table`; empty, without a query, on the engines
    /// [`sql::table_grants`] doesn't cover.
    pub async fn table_grants(&self, id: &str, schema: &str, table: &str) -> IdeResult<Vec<TableGrant>> {
        let pool = self.pool(id).await?;
        let Some(q) = sql::table_grants(pool.driver(), schema, table) else {
            return Ok(Vec::new());
        };
        Ok(pool
            .rows(&q, MAX_META_ROWS)
            .await?
            .into_iter()
            .filter_map(|r| {
                let mut it = r.into_iter();
                let grantee = it.next().flatten()?;
                let grantor = it.next().flatten().filter(|g| !g.is_empty());
                let privilege = it.next().flatten()?.to_ascii_uppercase();
                let grantable = flag(&it.next().flatten());
                Some(TableGrant { grantee, grantor, privilege, grantable })
            })
            .collect())
    }

    /// The routines and sequences of `schema`.
    pub async fn schema_objects(&self, id: &str, schema: &str) -> IdeResult<SchemaObjects> {
        let pool = self.pool(id).await?;
        if let Pool::Snowflake(p) = &*pool {
            return snowflake::meta::schema_objects(p, schema).await;
        }
        let driver = pool.driver();
        let mut out = SchemaObjects::default();
        if let Some(q) = sql::routines(driver, schema) {
            out.routines = catalog_rows(&pool, &q)
                .await?
                .into_iter()
                .filter_map(|r| {
                    let mut it = r.into_iter();
                    let name = it.next().flatten()?;
                    let kind = if it.next().flatten().as_deref() == Some("procedure") {
                        DbObjectKind::Procedure
                    } else {
                        DbObjectKind::Function
                    };
                    let arguments = it.next().flatten().unwrap_or_default();
                    let returns = it.next().flatten().filter(|r| !r.is_empty() && kind == DbObjectKind::Function);
                    Some(RoutineInfo { name, kind, arguments, returns })
                })
                .collect();
        }
        if let Some(q) = sql::packages(driver, schema) {
            out.packages = pool
                .rows(&q, MAX_META_ROWS)
                .await?
                .into_iter()
                .filter_map(|r| Some(PackageInfo { name: r.into_iter().next().flatten()? }))
                .collect();
        }
        if let Some(q) = sql::sequences(driver, schema) {
            out.sequences = pool
                .rows(&q, MAX_META_ROWS)
                .await?
                .into_iter()
                .filter_map(|r| {
                    let mut it = r.into_iter();
                    Some(SequenceInfo {
                        name: it.next().flatten()?,
                        data_type: it.next().flatten().unwrap_or_default(),
                    })
                })
                .collect();
        }
        Ok(out)
    }

    /// The definition of a routine (every overload), package (spec and body), trigger or sequence.
    pub async fn object_ddl(&self, id: &str, schema: &str, kind: DbObjectKind, name: &str) -> IdeResult<String> {
        let pool = self.pool(id).await?;
        if let Pool::Snowflake(p) = &*pool {
            let defs = snowflake::meta::object_ddl(p, schema, kind, name).await?;
            if defs.is_empty() {
                return Err(IdeError::not_found(format!("{schema}.{name}")));
            }
            let defs: Vec<String> = defs.iter().map(|d| format!("{};\n", d.trim_end().trim_end_matches(';'))).collect();
            return Ok(defs.join("\n"));
        }
        if kind == DbObjectKind::Package {
            let mut defs: Vec<String> = Vec::new();
            for body in [false, true] {
                let Some(q) = sql::package_ddl(pool.driver(), schema, name, body) else { continue };
                match pool.rows(&q, MAX_META_ROWS).await {
                    Ok(rows) => defs.extend(rows.into_iter().filter_map(|r| r.into_iter().next().flatten())),
                    // A spec-only package has no body: the spec alone still opens.
                    Err(e) if body => tracing::warn!("package body {schema}.{name}: {}", e.message),
                    Err(e) => return Err(e),
                }
            }
            if defs.is_empty() {
                return Err(IdeError::not_found(format!("{schema}.{name}")));
            }
            return Ok(defs
                .iter()
                .map(|d| format!("{};\n", d.trim_end().trim_end_matches(';')))
                .collect::<Vec<_>>()
                .join("\n"));
        }
        let (q, column) = sql::object_ddl(pool.driver(), schema, kind, name)
            .ok_or_else(|| IdeError::invalid(format!("no {kind:?} objects in this database")))?;
        let defs: Vec<String> = pool
            .rows(&q, MAX_META_ROWS)
            .await?
            .into_iter()
            .filter_map(|r| r.into_iter().nth(column).flatten())
            .map(|d| format!("{};\n", d.trim_end().trim_end_matches(';')))
            .collect();
        if defs.is_empty() {
            return Err(IdeError::not_found(format!("{schema}.{name}")));
        }
        Ok(defs.join("\n"))
    }

    /// The DDL of table or view `name`: SQLite's stored statements, MySQL's
    /// `SHOW CREATE`, PostgreSQL's generated from the catalog.
    pub async fn ddl(&self, id: &str, schema: &str, name: &str) -> IdeResult<String> {
        let pool = self.pool(id).await?;
        let driver = pool.driver();
        let missing = || IdeError::not_found(format!("{schema}.{name}"));
        let cells = |rows: Vec<Vec<Option<String>>>, i: usize| -> Vec<String> {
            rows.into_iter().filter_map(|r| r.into_iter().nth(i).flatten()).collect()
        };
        match driver {
            DbDriver::Jdbc => Err(IdeError::invalid("Custom JDBC sources do not provide vendor-specific DDL")),
            DbDriver::Sqlite => {
                let stmts = cells(pool.rows(&sql::sqlite_ddl(schema, name), MAX_META_ROWS).await?, 0);
                if stmts.is_empty() {
                    return Err(missing());
                }
                Ok(stmts
                    .iter()
                    .map(|s| format!("{};\n", s.trim_end().trim_end_matches(';')))
                    .collect::<Vec<_>>()
                    .join("\n"))
            }
            DbDriver::Mysql => {
                let q = format!("SHOW CREATE TABLE {}", sql::qualified(driver, schema, name));
                let ddl = cells(pool.rows(&q, 1).await?, 1).into_iter().next();
                ddl.map(|d| format!("{d};\n")).ok_or_else(missing)
            }
            DbDriver::Clickhouse => {
                let q = format!("SHOW CREATE TABLE {}", sql::qualified(driver, schema, name));
                let ddl = cells(pool.rows(&q, 1).await?, 0).into_iter().next();
                ddl.map(|d| format!("{};\n", d.trim_end().trim_end_matches(';'))).ok_or_else(missing)
            }
            DbDriver::SqlServer => {
                let obj = format!("{}.{}", schema, name).replace('\'', "''");
                let ddl = cells(pool.rows(&format!("SELECT OBJECT_DEFINITION(OBJECT_ID('{}'))", obj), 1).await?, 0)
                    .into_iter()
                    .next();
                ddl.map(|d| format!("{d};\n")).ok_or_else(missing)
            }
            DbDriver::Oracle => {
                let (s, n) = (sql::quote_literal(driver, schema), sql::quote_literal(driver, name));
                let kind = pool
                    .rows(
                        &format!(
                            "SELECT object_type FROM all_objects WHERE owner = {s} AND object_name = {n} \
                             AND object_type IN ('TABLE', 'VIEW') AND ROWNUM = 1"
                        ),
                        1,
                    )
                    .await?
                    .into_iter()
                    .next()
                    .and_then(|r| r.into_iter().next().flatten())
                    .ok_or_else(missing)?;
                let ddl = cells(
                    pool.rows(
                        &format!("SELECT DBMS_METADATA.GET_DDL('{}', {n}, {s}) FROM DUAL", kind.replace('\'', "''")),
                        1,
                    )
                    .await?,
                    0,
                )
                .into_iter()
                .next();
                ddl.map(|d| format!("{};\n", d.trim_end().trim_end_matches(';'))).ok_or_else(missing)
            }
            DbDriver::Snowflake => {
                let path = match &*pool {
                    Pool::Snowflake(p) => p.database_ident().map(|db| format!("{db}.")).unwrap_or_default(),
                    _ => String::new(),
                };
                let target = sql::quote_literal(driver, &format!("{path}{}", sql::qualified(driver, schema, name)));
                let mut ddl = None;
                // Views answer to their own object type on some accounts.
                for kind in ["TABLE", "VIEW"] {
                    match pool.rows(&format!("SELECT GET_DDL('{kind}', {target})"), 1).await {
                        Ok(rows) => {
                            ddl = cells(rows, 0).into_iter().next();
                            break;
                        }
                        Err(_) if kind == "TABLE" => {}
                        Err(e) => return Err(e),
                    }
                }
                ddl.map(|d| format!("{};\n", d.trim_end().trim_end_matches(';'))).ok_or_else(missing)
            }
            DbDriver::Postgres => {
                let rel = pool.rows(&sql::postgres_relation(schema, name), 1).await?.into_iter().next();
                let (oid, kind) = match rel.as_deref() {
                    Some([Some(oid), Some(kind)]) => {
                        (oid.parse::<u32>().map_err(|e| IdeError::invalid(e.to_string()))?, kind.clone())
                    }
                    _ => return Err(missing()),
                };
                if kind == "v" || kind == "m" {
                    let def = cells(pool.rows(&format!("SELECT pg_get_viewdef({oid}, true)"), 1).await?, 0);
                    let what = if kind == "m" { "materialized view" } else { "view" };
                    let body = def.into_iter().next().unwrap_or_default();
                    let target = sql::qualified(driver, schema, name);
                    return Ok(format!("create {what} {target} as\n{};\n", body.trim_end().trim_end_matches(';')));
                }
                let columns = pool
                    .rows(&sql::postgres_ddl_columns(oid), MAX_META_ROWS)
                    .await?
                    .into_iter()
                    .filter_map(|r| {
                        let mut it = r.into_iter();
                        Some(sql::DdlColumn {
                            name: it.next().flatten()?,
                            data_type: it.next().flatten().unwrap_or_default(),
                            not_null: flag(&it.next().flatten()),
                            default: it.next().flatten(),
                        })
                    })
                    .collect::<Vec<_>>();
                let constraints = pool
                    .rows(&sql::postgres_ddl_constraints(oid), MAX_META_ROWS)
                    .await?
                    .into_iter()
                    .filter_map(|r| {
                        let mut it = r.into_iter();
                        Some((it.next().flatten()?, it.next().flatten()?))
                    })
                    .collect::<Vec<_>>();
                let indexes = cells(pool.rows(&sql::postgres_ddl_indexes(oid), MAX_META_ROWS).await?, 0);
                Ok(sql::postgres_table_ddl(schema, name, &columns, &constraints, &indexes))
            }
        }
    }

    pub async fn completion(&self, id: &str) -> IdeResult<CompletionModel> {
        let pool = self.pool(id).await?;
        let driver = pool.driver();
        let mut tables: Vec<CompletionTable> = Vec::new();
        if let Pool::Jdbc(p) = &*pool {
            return self.jdbc_completion(id, p).await;
        }
        let default_schema = match sql::current_schema(driver) {
            None => "main".to_owned(),
            Some(q) => pool
                .rows(q, 1)
                .await?
                .into_iter()
                .next()
                .and_then(|r| r.into_iter().next().flatten())
                .unwrap_or_default(),
        };
        let rows = match &*pool {
            Pool::Snowflake(p) => {
                tables = snowflake::meta::completion(p).await?;
                Vec::new()
            }
            // The default schema is read in full: under a shared row cap, a schema with many
            // tables lost the columns of the tables sorting last (#6118). Other schemas share the cap.
            _ if !default_schema.is_empty() => {
                let only = sql::completion_columns(driver, sql::CompletionScope::Only(&default_schema));
                let mut rows = pool.rows(&only, MAX_SCHEMA_COMPLETION_ROWS).await?;
                let rest = sql::completion_columns(driver, sql::CompletionScope::Except(&default_schema));
                rows.extend(pool.rows(&rest, MAX_META_ROWS).await?);
                rows
            }
            _ => pool.rows(&sql::completion_columns(driver, sql::CompletionScope::All), MAX_META_ROWS).await?,
        };
        for r in rows {
            let mut it = r.into_iter().map(Option::unwrap_or_default);
            let mut next = || it.next().unwrap_or_default();
            let (schema, name, kind) = (next(), next(), next());
            let column = CompletionColumn {
                name: next(),
                data_type: next(),
                nullable: flag(&Some(next())),
                primary_key: flag(&Some(next())),
                has_default: flag(&Some(next())),
            };
            if name.is_empty() || column.name.is_empty() {
                continue;
            }
            match tables.last_mut() {
                Some(t) if t.schema == schema && t.name == name => t.columns.push(column),
                _ => tables.push(CompletionTable {
                    schema,
                    name,
                    kind: DbTableKind::from_catalog(Some(&kind)),
                    columns: vec![column],
                }),
            }
        }
        // Foreign keys are a nicety (JOIN completion): a server that refuses the catalog query still completes.
        let fk_rows = if matches!(driver, DbDriver::Clickhouse | DbDriver::Snowflake) {
            Vec::new()
        } else {
            pool.rows(sql::foreign_keys(driver), MAX_META_ROWS).await.unwrap_or_else(|e| {
                tracing::warn!("foreign keys: {}", e.message);
                Vec::new()
            })
        };
        let foreign_keys = group_foreign_keys(fk_rows, &tables);
        Ok(CompletionModel { default_schema, tables, foreign_keys })
    }

    /// Runs `statement` on `id` (in its open transaction in manual-commit mode),
    /// recording it in the data source's query history.
    pub async fn execute(
        &self,
        id: &str,
        statement: &str,
        max_rows: usize,
        cancel: &CancellationToken,
    ) -> IdeResult<QueryResult> {
        self.execute_from(id, statement, 0, max_rows, cancel, None).await
    }

    /// Refuses transaction control anywhere in a guarded console script before running its first statement.
    pub async fn validate_script(&self, id: &str, statements: &[split::SqlStatement]) -> IdeResult<()> {
        if statements.len() > 1
            && self.source(id).is_ok_and(|s| s.driver == DbDriver::Postgres && s.read_only)
            && self.pool(id).await?.transaction_read_only()
        {
            for statement in statements {
                if let Err(error) = conn::validate_pg_read_only(&statement.text) {
                    self.finish_transaction(id, false).await?;
                    return Err(IdeError::invalid(error));
                }
            }
        }
        Ok(())
    }

    /// [`execute`](Self::execute), reading past the first `skip` rows without keeping
    /// them: a later page of a result, where only that page is decoded and returned.
    /// `schema` is a query console's active context: the connection that runs the
    /// statement is put in it first, so unqualified names resolve there.
    pub async fn execute_from(
        &self,
        id: &str,
        statement: &str,
        skip: usize,
        max_rows: usize,
        cancel: &CancellationToken,
        schema: Option<&str>,
    ) -> IdeResult<QueryResult> {
        let r = self.run(id, statement, skip, max_rows, cancel, schema).await;
        let ran = match &r {
            Ok(_) => true,
            Err(e) => !matches!(e.kind, ErrorKind::Cancelled | ErrorKind::PermissionDenied),
        };
        if ran {
            self.remember_statement(id, statement);
        }
        r
    }

    /// Row number `row` (from 0) of the result of `statement`, whole: what a page shows cut
    /// short. It leaves the cursor of the result's pages where it stands, and is not recorded
    /// in the history (the statement already was).
    pub async fn read_row(
        &self,
        id: &str,
        statement: &str,
        row: usize,
        cancel: &CancellationToken,
        schema: Option<&str>,
    ) -> IdeResult<QueryResult> {
        self.run_paged(id, statement, row, 1, cancel, schema, false).await
    }

    /// Closes the cursor that reads the pages of `statement` on `id` (its result tab was closed).
    pub fn release_result(&self, id: &str, statement: &str, schema: Option<&str>) {
        self.cursors.release(&conn::CursorKey::new(id, statement, schema));
    }

    fn remember_statement(&self, id: &str, statement: &str) {
        let time = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
        let _ = self.recorder.send((split_target(id).0.to_owned(), statement.to_owned(), time));
    }

    /// The query history of data source `id`, newest first.
    pub async fn history(&self, id: &str) -> IdeResult<Vec<HistoryEntry>> {
        let (history, source) = (self.history.clone(), split_target(id).0.to_owned());
        tokio::task::spawn_blocking(move || history.list(&source)).await.map_err(|e| IdeError::internal(e.to_string()))
    }

    /// Forgets statements of the query history of `id` (all of them for `None`).
    pub async fn remove_history(&self, id: &str, texts: Option<Vec<String>>) -> IdeResult<()> {
        let (history, source) = (self.history.clone(), split_target(id).0.to_owned());
        tokio::task::spawn_blocking(move || history.remove(&source, texts.as_deref()))
            .await
            .map_err(|e| IdeError::internal(e.to_string()))?
    }

    /// The execution plan of `statement` (explained, not run), in the console's
    /// active `schema` when it has one.
    pub async fn explain(
        &self,
        id: &str,
        statement: &str,
        cancel: &CancellationToken,
        schema: Option<&str>,
    ) -> IdeResult<Vec<PlanNode>> {
        let driver = self.pool(id).await?.driver();
        if driver == DbDriver::Jdbc {
            return Err(IdeError::invalid("Custom JDBC execution plans are unsupported"));
        }
        if driver == DbDriver::Oracle {
            // EXPLAIN PLAN writes PLAN_TABLE; the plan is read (and cleaned up) separately.
            let plan_id = format!(
                "OPENIDEA{}",
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.subsec_nanos())
            );
            self.run(
                id,
                &format!(
                    "EXPLAIN PLAN SET STATEMENT_ID = '{}' FOR {}",
                    plan_id,
                    statement.trim().trim_end_matches(';')
                ),
                0,
                MAX_META_ROWS,
                cancel,
                schema,
            )
            .await?;
            let result = self.run(id, &plan::oracle_plan_query(&plan_id), 0, MAX_META_ROWS, cancel, None).await?;
            let nodes = plan::parse(driver, &result);
            let _ = self.run(id, &plan::oracle_plan_cleanup(&plan_id), 0, 0, cancel, None).await;
            return nodes;
        }
        let result =
            self.run(id, &plan::explain_statement(driver, statement), 0, MAX_META_ROWS, cancel, schema).await?;
        plan::parse(driver, &result)
    }

    async fn run(
        &self,
        id: &str,
        statement: &str,
        skip: usize,
        max_rows: usize,
        cancel: &CancellationToken,
        schema: Option<&str>,
    ) -> IdeResult<QueryResult> {
        self.run_paged(id, statement, skip, max_rows, cancel, schema, true).await
    }

    /// `paging`: whether the page may continue a cursor of `statement` (see `conn::cursor`).
    #[allow(clippy::too_many_arguments)]
    async fn run_paged(
        &self,
        id: &str,
        statement: &str,
        skip: usize,
        max_rows: usize,
        cancel: &CancellationToken,
        schema: Option<&str>,
        paging: bool,
    ) -> IdeResult<QueryResult> {
        let pool = self.pool(id).await?;
        if let Pool::Jdbc(p) = &*pool {
            return p.query_in_schema(statement, skip, max_rows, cancel, schema).await;
        }
        let session = self.sessions.lock().get(id).cloned();
        let protected = pool.transaction_read_only();
        let cursor = protected || conn::cursor_statement(statement);
        if !cursor || (protected && skip == 0 && paging) {
            // A cursor's open statement could keep this one waiting (a lock), and would show data from before it.
            self.cursors.release_target(id);
        }
        if paging && session.is_none() && (skip > 0 || protected) && pool.keeps_cursors() && cursor {
            let key = conn::CursorKey::new(id, statement, schema);
            let started = std::time::Instant::now();
            let page = match self.cursors.resume(&key, skip, max_rows, cancel, protected).await {
                Some(page) => page,
                None => {
                    if protected && skip > 0 {
                        return Err(IdeError::invalid(
                            "This read-only result is no longer open at this page. Run the query again.",
                        ));
                    }
                    let mut held = Held::acquire(&pool).await?;
                    held.apply_context(schema).await?;
                    self.cursors.start(held, pool.clone(), key, skip, max_rows, cancel).await
                }
            };
            return page.map(|fetched| conn::query_result(statement, fetched, started));
        }
        let Some(session) = session else {
            if schema.is_none() {
                return pool.execute_from(statement, skip, max_rows, cancel).await;
            }
            // Like `Pool::execute_from`, with the schema applied to the connection first.
            let mut conn = Held::acquire(&pool).await?;
            let r = match conn.apply_context(schema).await {
                Ok(()) => conn.execute_from(&pool, statement, skip, max_rows, cancel).await,
                Err(e) => Err(e),
            };
            if cancel.is_cancelled() {
                conn.discard().await;
                return Err(IdeError::cancelled());
            }
            return r;
        };
        if pool.driver() == DbDriver::Clickhouse {
            return Err(IdeError::invalid("ClickHouse manual transactions are unsupported"));
        }
        let mut held = session.lock().await;
        if pool.transaction_read_only() {
            // Own the session during awaits so a dropped request cannot return an unfinished transaction.
            let mut conn = match held.take() {
                Some(conn) => conn,
                None => {
                    let mut conn = Held::acquire(&pool).await?;
                    conn.begin_manual(pool.driver()).await?;
                    conn
                }
            };
            let result = async {
                conn.apply_context(schema).await?;
                conn.execute_from(&pool, statement, skip, max_rows, cancel).await
            }
            .await;
            if result.is_ok() {
                *held = Some(conn);
            } else if cancel.is_cancelled() || conn.finish_manual(false).await.is_err() {
                conn.discard().await;
            }
            return result;
        }
        if held.is_none() {
            let mut conn = Held::acquire(&pool).await?;
            conn.apply_context(schema).await?;
            conn.begin_manual(pool.driver()).await?;
            *held = Some(conn);
        }
        let conn = held.as_mut().expect("opened above");
        conn.apply_context(schema).await?;
        let r = conn.execute_from(&pool, statement, skip, max_rows, cancel).await;
        if cancel.is_cancelled() {
            // The server rolls the transaction back with the connection.
            held.take().expect("opened above").discard().await;
            return Err(IdeError::cancelled());
        }
        r
    }

    /// Switches `id` between auto-commit and manual commit. Leaving manual
    /// mode rolls back what was not committed.
    pub async fn set_manual_commit(&self, id: &str, manual: bool) -> IdeResult<()> {
        if manual && self.source(id)?.driver == DbDriver::Jdbc {
            return Err(IdeError::invalid("Custom JDBC manual transactions are unsupported"));
        }
        if manual {
            if self.source(id)?.driver == DbDriver::Clickhouse {
                return Err(IdeError::invalid("ClickHouse manual transactions are unsupported"));
            }
            self.sessions.lock().entry(id.to_owned()).or_default();
        } else {
            let session = self.sessions.lock().remove(id);
            if let Some(s) = session {
                end_session(&s).await;
            }
        }
        Ok(())
    }

    /// Commits (or rolls back) the open transaction of a manual-commit data source.
    pub async fn finish_transaction(&self, id: &str, commit: bool) -> IdeResult<()> {
        if self.source(id).is_ok_and(|s| s.driver == DbDriver::Clickhouse) {
            return Err(IdeError::invalid("ClickHouse manual transactions are unsupported"));
        }
        if self.source(id).is_ok_and(|s| s.driver == DbDriver::Jdbc) {
            return Err(IdeError::invalid("Custom JDBC manual transactions are unsupported"));
        }
        let session = self.sessions.lock().get(id).cloned();
        let Some(session) = session else { return Ok(()) };
        let mut held = session.lock().await;
        let Some(mut conn) = held.take() else { return Ok(()) };
        if let Err(e) = conn.finish_manual(commit).await {
            // Discarding a Snowflake connection doesn't end its session, which the data source's
            // other targets share: the transaction stays open, so it stays held to be ended again.
            if matches!(conn, conn::Held::Snowflake(..)) {
                *held = Some(conn);
            } else {
                conn.discard().await;
            }
            return Err(e);
        }
        if let Err(e) = conn.restore_default().await {
            conn.discard().await;
            return Err(e);
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn table_page(
        &self,
        id: &str,
        schema: &str,
        table: &str,
        filter: Option<&str>,
        sort: &[SortKey],
        offset: u64,
        limit: u64,
        cancel: &CancellationToken,
    ) -> IdeResult<TablePage> {
        let details = self.table_details(id, schema, table).await?;
        let pool = self.pool(id).await?;
        let mut result = if let Pool::Jdbc(p) = &*pool {
            let q = &p.identifier_quote;
            let names = [schema, table].into_iter().chain(sort.iter().map(|k| k.column.as_str()));
            if q.is_empty()
                && names.into_iter().any(|name| !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
            {
                return Err(IdeError::invalid("This JDBC driver cannot quote the selected identifier"));
            }
            let quote = |s: &str| format!("{q}{}{q}", s.replace(q, &format!("{q}{q}")));
            let name = if schema.is_empty() { quote(table) } else { format!("{}.{}", quote(schema), quote(table)) };
            let sql = sql::table_select(&name, filter, sort, quote);
            p.page(&sql, offset, limit, cancel).await?
        } else {
            let sql = sql::table_page(pool.driver(), schema, table, filter, sort, offset, limit);
            pool.execute(&sql, limit as usize, cancel).await?
        };
        if result.columns.is_empty() {
            result.columns = details
                .columns
                .iter()
                .map(|c| ResultColumn { name: c.name.clone(), type_name: c.data_type.clone() })
                .collect();
        }
        Ok(TablePage { result, details, offset: offset as f64 })
    }

    /// Applies the table editor's pending changes in one transaction.
    pub async fn apply_edits(&self, id: &str, schema: &str, table: &str, edits: &[DbRowEdit]) -> IdeResult<u64> {
        let source = self.source(id)?;
        if source.read_only {
            return Err(IdeError::new(ErrorKind::PermissionDenied, "the data source is read-only"));
        }
        if source.driver == DbDriver::Clickhouse {
            return Err(IdeError::invalid("ClickHouse table editing is unsupported"));
        }
        let pool = self.pool(id).await?;
        let driver = pool.driver();
        let statements = edits
            .iter()
            .map(|e| {
                let sql = sql::edit_statement(driver, schema, table, e).map_err(IdeError::invalid)?;
                Ok((sql, !matches!(e, DbRowEdit::Insert { .. })))
            })
            .collect::<IdeResult<Vec<_>>>()?;
        pool.transaction(&statements).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_ssh::secrets::testing::files_containing;
    use std::path::Path;

    fn manager(dir: &Path) -> DbManager {
        ide_ssh::secrets::testing::use_memory_store();
        let data = dir.join("data");
        let ssh = Arc::new(SshManager::new(data.join("ssh-passwords.json")));
        DbManager::new(dir.join("project"), data.join("db-passwords.json"), data.join("db-history.json"), ssh)
    }

    #[tokio::test]
    async fn external_tunnel_approval_binds_the_command_destination_and_local_scope() {
        let tmp = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        let name = "forward.exe";
        #[cfg(not(windows))]
        let name = "forward";
        let program = tmp.path().join(name);
        std::fs::write(&program, b"fixture version 1").unwrap();
        let app = tmp.path().join("app");
        let desktop = |root: &Path| manager(root).with_global_sources(app.clone()).with_local_external_tunnels(true);
        let db = desktop(tmp.path());
        let other = desktop(&tmp.path().join("other"));
        let mut source = DataSource {
            id: "pg".into(),
            name: "Example PostgreSQL".into(),
            driver: DbDriver::Postgres,
            host: "db.example".into(),
            external_tunnel: Some(DbExternalTunnel {
                executable: program.to_str().unwrap().into(),
                arguments: vec!["--listen={localPort}".into(), "{host}:{port}".into()],
            }),
            ..Default::default()
        };
        assert!(db.check_external_approval(&source).await.is_err());
        db.approve_external_tunnel(&source).await.unwrap();
        db.save_sources(vec![source.clone()]).await.unwrap();
        db.check_external_approval(&db.source("pg").unwrap()).await.unwrap();
        db.check_external_approval(&source).await.unwrap();
        assert!(other.check_external_approval(&source).await.is_err());
        for changed in [
            DataSource { host: "other.example".into(), ..source.clone() },
            DataSource { user: "other".into(), ..source.clone() },
            DataSource { ssl: DbSslMode::Require, ..source.clone() },
        ] {
            assert!(db.check_external_approval(&changed).await.is_err());
        }
        let mut changed = source.clone();
        changed.external_tunnel.as_mut().unwrap().arguments.push("--changed".into());
        assert!(db.check_external_approval(&changed).await.is_err());
        source.global = true;
        assert!(db.check_external_approval(&source).await.is_err());
        db.approve_external_tunnel(&source).await.unwrap();
        db.save_sources(vec![source.clone()]).await.unwrap();
        db.check_external_approval(&db.source("pg").unwrap()).await.unwrap();
        other.check_external_approval(&source).await.unwrap();
        std::fs::write(&program, b"fixture version 2").unwrap();
        assert!(db.check_external_approval(&source).await.is_err());
    }

    #[tokio::test]
    async fn external_tunnel_rejects_incompatible_modes_and_implicit_test() {
        let tmp = tempfile::tempdir().unwrap();
        let source = DataSource {
            id: "pg".into(),
            driver: DbDriver::Postgres,
            external_tunnel: Some(DbExternalTunnel {
                executable: std::env::current_exe().unwrap().to_str().unwrap().into(),
                arguments: vec!["{localPort}".into()],
            }),
            ..Default::default()
        };
        let remote = manager(tmp.path()).with_global_sources(tmp.path().join("app"));
        assert!(remote.test_external_tunnel(&source, None).await.is_err());
        let db = remote.with_local_external_tunnels(true);
        assert!(db.test(&source, None, None).await.is_err());
        for bad in [
            DataSource { ssl: DbSslMode::VerifyFull, ..source.clone() },
            DataSource { url_only: true, ..source.clone() },
            DataSource { plugin_owner: Some("sample".into()), ..source.clone() },
            DataSource { driver: DbDriver::Jdbc, ..source.clone() },
            DataSource { ssh: Some(DbSsh { enabled: true, ..Default::default() }), ..source.clone() },
        ] {
            assert!(db.approve_external_tunnel(&bad).await.is_err());
        }
    }

    #[tokio::test]
    async fn saved_passwords_stay_off_disk() {
        let tmp = tempfile::tempdir().unwrap();
        manager(tmp.path()).set_password("s1", Some("hunter2-db".into()), true).await.unwrap();
        manager(tmp.path()).set_ssh_secret("s1", Some("hunter2-tunnel".into()), true).await.unwrap();
        assert_eq!(files_containing(tmp.path(), "hunter2-db"), Vec::<PathBuf>::new());
        assert_eq!(files_containing(tmp.path(), "hunter2-tunnel"), Vec::<PathBuf>::new());
        let reopened = manager(tmp.path());
        assert_eq!(reopened.secret(&DataSource::default(), "s1".into(), true).await.as_deref(), Some("hunter2-db"));
        assert_eq!(
            reopened.secret(&DataSource::default(), secrets::ssh_key("s1"), true).await.as_deref(),
            Some("hunter2-tunnel")
        );
    }

    #[tokio::test]
    async fn switching_from_snowflake_key_pair_keeps_the_jdbc_password_separate() -> IdeResult<()> {
        let tmp = tempfile::tempdir()?;
        let db = manager(tmp.path()).with_global_sources(tmp.path().join("global"));
        let native = DataSource {
            id: "snowflake".into(),
            name: "Snowflake".into(),
            driver: DbDriver::Snowflake,
            save_password: true,
            url_only: true,
            url: "jdbc:snowflake://example.invalid/?authenticator=SNOWFLAKE_JWT".into(),
            ..Default::default()
        };
        db.save_sources(vec![native.clone()]).await?;
        db.set_password(&native.id, Some("native-passphrase".into()), true).await?;
        let jdbc = DataSource { driver: DbDriver::Jdbc, url: "jdbc:fixture:".into(), ..native.clone() };

        // Test Connection can use the JDBC draft before the user saves it.
        assert_eq!(db.password(&jdbc).await, None);
        assert_eq!(db.password(&native).await.as_deref(), Some("native-passphrase"));

        db.approve_jdbc_source(&jdbc)?;
        db.save_sources(vec![jdbc.clone()]).await?;
        assert_eq!(db.password(&db.source(&jdbc.id)?).await, None);
        db.set_password(&jdbc.id, Some("jdbc-password".into()), true).await?;
        let reopened = manager(tmp.path()).with_global_sources(tmp.path().join("global"));
        let saved = reopened.source(&jdbc.id)?;
        assert_eq!(reopened.password(&saved).await.as_deref(), Some("jdbc-password"));
        let err = reopened.pool(&jdbc.id).await.err().expect("no JDBC profile installed");
        assert!(err.message.contains("Select an installed JDBC driver profile"));

        source::save(&reopened.root, std::slice::from_ref(&jdbc))?;
        let err = reopened.pool(&jdbc.id).await.err().expect("edited settings need approval");
        assert!(err.message.contains("Review this project's JDBC URL and properties"));
        source::save(&reopened.root, std::slice::from_ref(&saved))?;

        let global = DataSource { global: true, ..saved };
        reopened.save_sources(vec![global.clone()]).await?;
        assert_eq!(reopened.password(&reopened.source(&jdbc.id)?).await.as_deref(), Some("jdbc-password"));

        let native = DataSource { global: true, ..native };
        reopened.save_sources(vec![native.clone()]).await?;
        assert_eq!(reopened.password(&native).await.as_deref(), Some("native-passphrase"));
        reopened.save_sources(Vec::new()).await?;
        assert_eq!(reopened.password(&native).await, None);
        assert_eq!(reopened.password(&global).await, None);
        Ok(())
    }

    #[tokio::test]
    async fn switching_from_snowflake_password_keeps_the_password() -> IdeResult<()> {
        let tmp = tempfile::tempdir()?;
        let db = manager(tmp.path());
        let native = DataSource {
            id: "snowflake".into(),
            name: "Snowflake".into(),
            driver: DbDriver::Snowflake,
            save_password: true,
            url_only: true,
            url: "jdbc:snowflake://example.invalid/?authenticator=snowflake".into(),
            ..Default::default()
        };
        db.save_sources(vec![native.clone()]).await?;
        db.set_password(&native.id, Some("existing-password".into()), true).await?;
        let jdbc = DataSource { driver: DbDriver::Jdbc, url: "jdbc:fixture:".into(), ..native };
        assert_eq!(db.password(&jdbc).await.as_deref(), Some("existing-password"));
        db.save_sources(vec![jdbc.clone()]).await?;
        let reopened = manager(tmp.path());
        assert_eq!(reopened.password(&reopened.source(&jdbc.id)?).await.as_deref(), Some("existing-password"));
        Ok(())
    }

    #[tokio::test]
    async fn moves_plaintext_passwords_of_older_versions_off_disk() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("project").to_string_lossy().into_owned();
        let legacy = serde_json::json!({ project: { "s1": "old-db-pw" }, "/other": { "s2": "other-pw" } });
        std::fs::create_dir_all(tmp.path().join("data")).unwrap();
        std::fs::write(tmp.path().join("data/db-passwords.json"), legacy.to_string()).unwrap();
        let m = manager(tmp.path());
        assert_eq!(m.secret(&DataSource::default(), "s1".into(), true).await.as_deref(), Some("old-db-pw"));
        assert_eq!(files_containing(tmp.path(), "old-db-pw"), Vec::<PathBuf>::new());
        assert_eq!(files_containing(tmp.path(), "other-pw"), Vec::<PathBuf>::new());
        let other = SecretStore::new(tmp.path().join("data/db-passwords.json"), Path::new("/other"));
        assert_eq!(other.get("s2").as_deref(), Some("other-pw"));
    }

    #[tokio::test]
    async fn global_data_sources_are_shared_by_projects_with_their_passwords() {
        ide_ssh::secrets::testing::use_memory_store();
        let tmp = tempfile::tempdir().unwrap();
        let (app, one, two) = (tmp.path().join("app"), tmp.path().join("one"), tmp.path().join("two"));
        let manager = |root: &std::path::Path| {
            let ssh = Arc::new(SshManager::new(app.join("ssh-passwords.json")));
            DbManager::new(root.to_path_buf(), app.join("passwords.json"), app.join("history.json"), ssh)
                .with_global_sources(app.clone())
        };
        let (a, b) = (manager(&one), manager(&two));
        let source = |id: &str, global: bool| DataSource {
            id: id.into(),
            name: id.into(),
            driver: DbDriver::Postgres,
            save_password: true,
            global,
            ..Default::default()
        };
        a.save_sources(vec![source("local", false), source("shared", false)]).await.unwrap();
        a.set_password("shared", Some("pw".into()), true).await.unwrap();
        // Made global: listed in the other project too, with its saved password.
        a.save_sources(vec![source("local", false), source("shared", true)]).await.unwrap();
        let ids = |m: &DbManager| m.sources().unwrap().into_iter().map(|s| (s.id, s.global)).collect::<Vec<_>>();
        assert_eq!(ids(&a), [("local".into(), false), ("shared".into(), true)]);
        assert_eq!(ids(&b), [("shared".into(), true)]);
        assert_eq!(b.password(&b.source("shared").unwrap()).await.as_deref(), Some("pw"));
        let project_file = std::fs::read_to_string(one.join(".openidea/data-sources.toml")).unwrap();
        assert!(!project_file.contains("shared") && !project_file.contains("global"), "{project_file}");
        assert!(!std::fs::read_to_string(app.join("data-sources.toml")).unwrap().contains("global"));
        // Made project-level again: gone from the other project, the password stays with it.
        a.save_sources(vec![source("local", false), source("shared", false)]).await.unwrap();
        assert!(b.sources().unwrap().is_empty());
        assert_eq!(a.password(&a.source("shared").unwrap()).await.as_deref(), Some("pw"));
    }

    #[tokio::test]
    async fn clickhouse_rejects_manual_transactions_and_table_edits_without_connecting() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let ssh = Arc::new(SshManager::new(root.join("ssh-passwords.json")));
        let db = DbManager::new(root.clone(), root.join("passwords.json"), root.join("history.json"), ssh);
        db.save_sources(vec![DataSource {
            id: "clickhouse".into(),
            name: "clickhouse".into(),
            driver: DbDriver::Clickhouse,
            host: "127.0.0.1".into(),
            port: Some(1),
            ..Default::default()
        }])
        .await
        .unwrap();
        let error = db.set_manual_commit("clickhouse", true).await.unwrap_err();
        assert!(error.message.contains("manual transactions are unsupported"));
        assert!(db.sessions.lock().is_empty());
        for commit in [false, true] {
            let error = db.finish_transaction("clickhouse", commit).await.unwrap_err();
            assert!(error.message.contains("manual transactions are unsupported"));
        }
        let error = db.apply_edits("clickhouse", "default", "events", &[]).await.unwrap_err();
        assert!(error.message.contains("table editing is unsupported"));
        assert!(!db.is_connected("clickhouse"));
        db.set_manual_commit("clickhouse", false).await.unwrap();
    }
}
