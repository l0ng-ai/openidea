//! Database tools: data sources ([`source`]), connections and statement
//! execution ([`conn`]), introspection, table data paging / editing ([`sql`])
//! and statement splitting ([`split`]), for SQLite, PostgreSQL and MySQL/MariaDB.

pub mod conn;
pub mod history;
pub mod plan;
pub mod secrets;
pub mod source;
pub mod split;
pub mod sql;

pub use conn::{Held, Pool, QueryResult, ResultColumn};
pub use history::HistoryEntry;
pub use plan::{PlanNode, PlanProperty};
pub use source::{
    DataSource, DbColor, DbDriver, DbIntrospection, DbOptions, DbProperty, DbSsh, DbSshAuth, DbSslMode, DbTxMode,
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

/// A schema's routines and sequences (the tree's `routines` / `sequences` folders).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[serde(rename = "DbSchemaObjects")]
pub struct SchemaObjects {
    pub routines: Vec<RoutineInfo>,
    pub sequences: Vec<SequenceInfo>,
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
    pub columns: Vec<ColumnInfo>,
    pub indexes: Vec<IndexInfo>,
    pub foreign_keys: Vec<ForeignKey>,
    pub triggers: Vec<TriggerInfo>,
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
    pools: Mutex<HashMap<String, Arc<Pool>>>,
    /// SSH tunnels by data source id, shared by the pools of its databases
    /// (closed with the last of them).
    tunnels: Mutex<HashMap<String, Arc<Tunnel>>>,
    /// Serialises opening tunnels so concurrent connects share one.
    tunnel_open: tokio::sync::Mutex<()>,
    /// App-wide SSH connections and host-key trust.
    ssh: Arc<SshManager>,
    saved_passwords: SecretStore,
    history: Arc<HistoryStore>,
    /// Records executed statements in the history off the async threads, in order.
    recorder: std::sync::mpsc::Sender<(String, String, f64)>,
    /// Passwords entered this session (not saved, or not yet), by credential key.
    session_passwords: Mutex<HashMap<String, String>>,
    /// Manual-commit data sources, each with the connection of its open
    /// transaction (taken by the first statement after a commit / rollback).
    sessions: Mutex<HashMap<String, Session>>,
}

type Session = Arc<tokio::sync::Mutex<Option<Held>>>;

const MAX_META_ROWS: usize = 100_000;

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
fn keep_alive(pool: &Arc<Pool>, every: Duration) {
    let pool = Arc::downgrade(pool);
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(every);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tick.tick().await;
        loop {
            tick.tick().await;
            let Some(p) = pool.upgrade().filter(|p| !p.is_closed()) else { break };
            if let Err(e) = p.rows("SELECT 1", 1).await {
                tracing::debug!("keep-alive: {}", e.message);
            }
        }
    });
}

/// Rolls back a session's transaction and releases its connection.
async fn end_session(session: &Session) {
    let held = session.lock().await.take();
    if let Some(mut conn) = held
        && conn.command("ROLLBACK").await.is_err()
    {
        conn.discard().await;
    }
}

impl DbManager {
    /// `passwords` / `history` are the app-wide files of saved passwords
    /// ([`SecretStore`]) and query history ([`HistoryStore`]).
    pub fn new(root: PathBuf, passwords: PathBuf, history: PathBuf, ssh: Arc<SshManager>) -> Self {
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
            saved_passwords: SecretStore::new(passwords, &root),
            history,
            recorder,
            root,
            pools: Mutex::default(),
            tunnels: Mutex::default(),
            tunnel_open: tokio::sync::Mutex::new(()),
            ssh,
            session_passwords: Mutex::default(),
            sessions: Mutex::default(),
        }
    }

    pub fn sources(&self) -> IdeResult<Vec<DataSource>> {
        source::load(&self.root)
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
        if let Some(db) = database {
            source.database = db.to_owned();
        }
        Ok(source)
    }

    /// Saves the data source list; connections of removed or changed sources are closed.
    pub async fn save_sources(&self, sources: Vec<DataSource>) -> IdeResult<()> {
        let old = self.sources().unwrap_or_default();
        source::save(&self.root, &sources)?;
        for o in old {
            match sources.iter().find(|s| s.id == o.id) {
                Some(n) if *n == o => {}
                gone_or_changed => {
                    if gone_or_changed.is_none() {
                        for k in [o.id.clone(), secrets::ssh_key(&o.id)] {
                            self.session_passwords.lock().remove(&k);
                            self.saved_passwords.delete(&k);
                        }
                    }
                    self.disconnect_source(&o.id).await;
                }
            }
        }
        Ok(())
    }

    /// Remembers `password` for the session, and in the saved passwords when
    /// the data source saves passwords (`None` forgets it).
    pub async fn set_password(&self, id: &str, password: Option<String>, save: bool) -> IdeResult<()> {
        self.remember(id.to_owned(), password, save).await
    }

    /// [`DbManager::set_password`] for the SSH password / key passphrase.
    /// A data source using an SSH configuration sets that configuration's secret.
    pub async fn set_ssh_secret(&self, id: &str, secret: Option<String>, save: bool) -> IdeResult<()> {
        let config = self.sources()?.into_iter().find(|s| s.id == id).and_then(|s| s.ssh).map(|s| s.config);
        if let Some(c) = config.filter(|c| !c.trim().is_empty()) {
            let save = self.ssh.config(&c).map(|c| c.save_secret).unwrap_or(save);
            self.ssh.set_secret(&c, secret, save);
            return Ok(());
        }
        self.remember(secrets::ssh_key(id), secret, save).await
    }

    async fn remember(&self, key: String, secret: Option<String>, save: bool) -> IdeResult<()> {
        match &secret {
            Some(p) => {
                self.session_passwords.lock().insert(key.clone(), p.clone());
            }
            None => {
                self.session_passwords.lock().remove(&key);
            }
        }
        let result = match (secret, save) {
            (Some(p), true) => self.saved_passwords.set(&key, &p),
            _ => {
                self.saved_passwords.delete(&key);
                Ok(())
            }
        };
        if let Err(e) = result {
            // The session copy still works; the user is asked again next time.
            tracing::warn!("could not save the password: {}", e.message);
        }
        Ok(())
    }

    async fn secret(&self, key: String, saved: bool) -> Option<String> {
        if let Some(p) = self.session_passwords.lock().get(&key) {
            return Some(p.clone());
        }
        if !saved {
            return None;
        }
        self.saved_passwords.get(&key)
    }

    async fn password(&self, source: &DataSource) -> Option<String> {
        match self.secret(source.id.clone(), source.driver != DbDriver::Sqlite && source.save_password).await {
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

    /// Opens the SSH tunnel of `source` when it has one, returning the settings to
    /// connect with (the tunnel's local end instead of the database host).
    /// `shared` reuses (or registers) the data source's tunnel for its pools; Test
    /// Connection opens a private one.
    async fn endpoint(
        &self,
        source: &DataSource,
        ssh_secret: Option<String>,
        shared: bool,
    ) -> IdeResult<(DataSource, Option<Arc<Tunnel>>)> {
        let Some(ssh) = source.ssh.as_ref().filter(|s| s.enabled && source.driver != DbDriver::Sqlite) else {
            return Ok((source.clone(), None));
        };
        let local = |t: &Tunnel| DataSource { host: "127.0.0.1".into(), port: Some(t.port()), ..source.clone() };
        let _opening = if shared { Some(self.tunnel_open.lock().await) } else { None };
        if shared {
            let existing = self.tunnels.lock().get(&source.id).filter(|t| !t.is_closed()).cloned();
            if let Some(t) = existing {
                return Ok((local(&t), Some(t)));
            }
        }
        let config = ssh.config.trim();
        let session = if config.is_empty() {
            let secret = match ssh_secret {
                Some(s) => Some(s),
                None => self.secret(secrets::ssh_key(&source.id), ssh.save_secret).await,
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
                self.ssh.set_secret(config, Some(s), save);
            }
            self.ssh.session(config).await?
        };
        let target_port = source.port.or(source.driver.default_port()).unwrap_or_default();
        let target_host = if source.host.trim().is_empty() { "localhost" } else { source.host.trim() };
        let t = Arc::new(Tunnel::open(session, target_host, target_port).await?);
        if shared {
            self.tunnels.lock().insert(source.id.clone(), t.clone());
        }
        Ok((local(&t), Some(t)))
    }

    /// Connects with `source` as given (not necessarily saved): Test Connection.
    pub async fn test(
        &self,
        source: &DataSource,
        password: Option<String>,
        ssh_secret: Option<String>,
    ) -> IdeResult<String> {
        let source = &source.resolved()?;
        let password = match password {
            Some(p) => Some(p),
            None => self.password(source).await,
        };
        let (target, tunnel) = self.endpoint(source, ssh_secret, false).await?;
        let pool = Pool::connect(&target, password.as_deref(), Some(&self.root)).await.map_err(|e| {
            through_tunnel(
                e,
                source,
                tunnel.is_some().then(|| self.ssh_label(source.ssh.as_ref().expect("tunneled"))).as_deref(),
            )
        })?;
        let version = match source.driver {
            DbDriver::Sqlite => "SELECT 'SQLite ' || sqlite_version()",
            DbDriver::Postgres => "SELECT version()",
            DbDriver::Mysql => "SELECT CONCAT(@@version_comment, ' ', VERSION())",
            DbDriver::SqlServer => "SELECT @@VERSION",
        };
        let v = pool.rows(version, 1).await.ok().and_then(|r| r.into_iter().next()?.into_iter().next()?);
        pool.close().await;
        Ok(v.unwrap_or_else(|| "Connected".into()))
    }

    pub fn is_connected(&self, id: &str) -> bool {
        self.pools.lock().contains_key(id)
    }

    /// Connected targets (data source ids, `<id>:<database>`).
    pub fn connected(&self) -> Vec<String> {
        self.pools.lock().keys().cloned().collect()
    }

    /// The pool of target `id`, connecting first if needed.
    pub async fn pool(&self, id: &str) -> IdeResult<Arc<Pool>> {
        let (source_id, _) = split_target(id);
        // A dropped SSH session leaves every pool through it unusable: start over.
        if self.tunnels.lock().get(source_id).is_some_and(|t| t.is_closed()) {
            self.disconnect_source(source_id).await;
        }
        if let Some(p) = self.pools.lock().get(id) {
            return Ok(p.clone());
        }
        let source = self.source(id)?;
        let password = self.password(&source).await;
        let (target, tunnel) = self.endpoint(&source, None, true).await?;
        let pool = match Pool::connect(&target, password.as_deref(), Some(&self.root)).await {
            Ok(p) => Arc::new(p),
            Err(e) => {
                self.drop_unused_tunnel(source_id);
                return Err(through_tunnel(
                    e,
                    &source,
                    tunnel.is_some().then(|| self.ssh_label(source.ssh.as_ref().expect("tunneled"))).as_deref(),
                ));
            }
        };
        // Another caller may have connected meanwhile; keep theirs.
        let kept = self.pools.lock().entry(id.to_owned()).or_insert_with(|| pool.clone()).clone();
        if Arc::ptr_eq(&kept, &pool)
            && let Some(secs) = source.options.keep_alive_secs.filter(|s| *s > 0)
        {
            keep_alive(&pool, Duration::from_secs(secs.into()));
        }
        Ok(kept)
    }

    /// Closes the tunnel of `source_id` once none of its targets is connected.
    fn drop_unused_tunnel(&self, source_id: &str) {
        let in_use = self.pools.lock().keys().any(|k| split_target(k).0 == source_id);
        if !in_use {
            self.tunnels.lock().remove(source_id);
        }
    }

    /// Disconnects target `id` (one database of a data source).
    pub async fn disconnect(&self, id: &str) {
        // A held connection would keep the pool from closing; manual mode stays on.
        let session = self.sessions.lock().get(id).cloned();
        if let Some(s) = session {
            end_session(&s).await;
        }
        let pool = self.pools.lock().remove(id);
        if let Some(p) = pool {
            p.close().await;
        }
        self.drop_unused_tunnel(split_target(id).0);
    }

    /// Disconnects every database of data source `id`.
    pub async fn disconnect_source(&self, id: &str) {
        let targets: Vec<String> = self.connected().into_iter().filter(|t| split_target(t).0 == id).collect();
        for t in targets {
            self.disconnect(&t).await;
        }
        self.tunnels.lock().remove(id);
    }

    /// The databases of the server of data source `id` (PostgreSQL), the connected one first.
    pub async fn databases(&self, id: &str) -> IdeResult<Databases> {
        let id = split_target(id).0;
        let introspection = self.source(id)?.introspection;
        let system = introspection.show_system;
        let pool = self.pool(id).await?;
        if pool.driver() != DbDriver::Postgres {
            return Err(IdeError::invalid("only PostgreSQL data sources list databases"));
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

    /// Every schema (the Schemas tab picks the ones the tree shows); system schemas
    /// only with [`DbIntrospection::show_system`].
    pub async fn schemas(&self, id: &str) -> IdeResult<Vec<String>> {
        let system = self.source(id)?.introspection.show_system;
        let pool = self.pool(id).await?;
        let rows = pool.rows(sql::schemas(pool.driver(), system), MAX_META_ROWS).await?;
        Ok(rows.into_iter().filter_map(|r| r.into_iter().next().flatten()).collect())
    }

    pub async fn tables(&self, id: &str, schema: &str) -> IdeResult<Vec<TableInfo>> {
        let pool = self.pool(id).await?;
        let rows = pool.rows(&sql::tables(pool.driver(), schema), MAX_META_ROWS).await?;
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
        let driver = pool.driver();
        let columns = pool
            .rows(&sql::columns(driver, schema, table), MAX_META_ROWS)
            .await?
            .into_iter()
            .filter_map(|r| {
                let mut it = r.into_iter();
                let name = it.next().flatten()?;
                let data_type = it.next().flatten().unwrap_or_default();
                let nullable = flag(&it.next().flatten());
                let default = it.next().flatten();
                let primary_key = flag(&it.next().flatten());
                Some(ColumnInfo { name, data_type, nullable, default, primary_key })
            })
            .collect();
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
        let fk_rows =
            pool.rows(&sql::table_foreign_keys(driver, schema, table), MAX_META_ROWS).await.unwrap_or_default();
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
        let triggers = pool
            .rows(&sql::triggers(driver, schema, table), MAX_META_ROWS)
            .await
            .unwrap_or_else(|e| {
                tracing::warn!("triggers: {}", e.message);
                Vec::new()
            })
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
        Ok(TableDetails { columns, indexes, foreign_keys, triggers })
    }

    /// The routines and sequences of `schema`.
    pub async fn schema_objects(&self, id: &str, schema: &str) -> IdeResult<SchemaObjects> {
        let pool = self.pool(id).await?;
        let driver = pool.driver();
        let mut out = SchemaObjects::default();
        if let Some(q) = sql::routines(driver, schema) {
            out.routines = pool
                .rows(&q, MAX_META_ROWS)
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

    /// The definition of a routine (every overload), trigger or sequence.
    pub async fn object_ddl(&self, id: &str, schema: &str, kind: DbObjectKind, name: &str) -> IdeResult<String> {
        let pool = self.pool(id).await?;
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
            DbDriver::SqlServer => {
                let obj = format!("{}.{}", schema, name).replace('\'', "''");
                let ddl = cells(pool.rows(&format!("SELECT OBJECT_DEFINITION(OBJECT_ID('{}'))", obj), 1).await?, 0)
                    .into_iter()
                    .next();
                ddl.map(|d| format!("{d};\n")).ok_or_else(missing)
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
        for r in pool.rows(sql::completion_columns(driver), MAX_META_ROWS).await? {
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
        let fk_rows = pool.rows(sql::foreign_keys(driver), MAX_META_ROWS).await.unwrap_or_else(|e| {
            tracing::warn!("foreign keys: {}", e.message);
            Vec::new()
        });
        let foreign_keys = group_foreign_keys(fk_rows, &tables);
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
        let r = self.run(id, statement, max_rows, cancel).await;
        let ran = match &r {
            Ok(_) => true,
            Err(e) => !matches!(e.kind, ErrorKind::Cancelled | ErrorKind::PermissionDenied),
        };
        if ran {
            self.remember_statement(id, statement);
        }
        r
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

    /// The execution plan of `statement` (explained, not run).
    pub async fn explain(&self, id: &str, statement: &str, cancel: &CancellationToken) -> IdeResult<Vec<PlanNode>> {
        let driver = self.pool(id).await?.driver();
        let result = self.run(id, &plan::explain_statement(driver, statement), MAX_META_ROWS, cancel).await?;
        plan::parse(driver, &result)
    }

    async fn run(
        &self,
        id: &str,
        statement: &str,
        max_rows: usize,
        cancel: &CancellationToken,
    ) -> IdeResult<QueryResult> {
        let pool = self.pool(id).await?;
        let session = self.sessions.lock().get(id).cloned();
        let Some(session) = session else {
            return pool.execute(statement, max_rows, cancel).await;
        };
        let mut held = session.lock().await;
        if held.is_none() {
            let mut conn = Held::acquire(&pool).await?;
            conn.command(conn::begin_statement(pool.driver())).await?;
            *held = Some(conn);
        }
        let conn = held.as_mut().expect("opened above");
        let r = conn.execute(&pool, statement, max_rows, cancel).await;
        if cancel.is_cancelled() {
            // The server rolls the transaction back with the connection.
            held.take().expect("opened above").discard().await;
            return Err(IdeError::cancelled());
        }
        r
    }

    /// Switches `id` between auto-commit and manual commit. Leaving manual
    /// mode rolls back what was not committed.
    pub async fn set_manual_commit(&self, id: &str, manual: bool) {
        if manual {
            self.sessions.lock().entry(id.to_owned()).or_default();
        } else {
            let session = self.sessions.lock().remove(id);
            if let Some(s) = session {
                end_session(&s).await;
            }
        }
    }

    /// Commits (or rolls back) the open transaction of a manual-commit data source.
    pub async fn finish_transaction(&self, id: &str, commit: bool) -> IdeResult<()> {
        let session = self.sessions.lock().get(id).cloned();
        let Some(session) = session else { return Ok(()) };
        let mut held = session.lock().await;
        let Some(mut conn) = held.take() else { return Ok(()) };
        match conn.command(if commit { "COMMIT" } else { "ROLLBACK" }).await {
            Ok(()) => Ok(()),
            Err(e) => {
                conn.discard().await;
                Err(e)
            }
        }
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
        let sql = sql::table_page(pool.driver(), schema, table, filter, sort, offset, limit);
        let mut result = pool.execute(&sql, limit as usize, cancel).await?;
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
