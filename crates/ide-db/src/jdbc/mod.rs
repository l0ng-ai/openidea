//! A trusted local driver profile is shared by data sources. JDBC URLs and properties
//! can run driver-specific initialization. A project source may connect only with the
//! settings its user last accepted in the dialog; the approval lives outside the project.
use crate::local_settings::persist_local;
use crate::source::{DUCKDB_URL, DbDuckLakeKind, duck_lake_path};
use crate::{ConsoleId, DataSource, DbManager, QueryResult, ResultColumn};
use ide_core::{CancellationToken, IdeError, IdeResult, error::ErrorKind};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tokio::time::timeout;

mod bridge;

use bridge::Bridge;

const DUCKDB_CLASS: &str = "org.duckdb.DuckDBDriver";

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DbJdbcDriver {
    pub id: String,
    pub name: String,
    /// Data source preset id; absent for a generic JDBC profile.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vendor: Option<String>,
    pub jars: Vec<String>,
    pub class_name: String,
    pub url_template: String,
}

fn local_jar(jar: &str) -> IdeResult<&Path> {
    if jar.contains(if cfg!(windows) { ';' } else { ':' }) {
        return Err(IdeError::invalid("A JDBC JAR path contains the system classpath separator"));
    }
    let path = Path::new(jar);
    if !path.is_absolute() || !path.is_file() || !path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("jar")) {
        return Err(IdeError::invalid("Choose an existing local .jar file for each JDBC driver file"));
    }
    Ok(path)
}

/// Read the standard JDBC service descriptors without executing any driver code.
pub fn jdbc_driver_classes(jars: &[String]) -> IdeResult<Vec<String>> {
    let mut classes = Vec::new();
    if jars.len() > 128 {
        return Err(IdeError::invalid("Choose at most 128 JDBC driver files"));
    }
    for jar in jars {
        let file = std::fs::File::open(local_jar(jar)?)?;
        let mut archive = zip::ZipArchive::new(file).map_err(|_| IdeError::invalid("Invalid JDBC JAR archive"))?;
        let descriptor = match archive.by_name("META-INF/services/java.sql.Driver") {
            Ok(entry) => entry,
            Err(zip::result::ZipError::FileNotFound) => continue,
            Err(_) => return Err(IdeError::invalid("Cannot read the JDBC driver descriptor")),
        };
        let mut text = String::new();
        descriptor.take(65537).read_to_string(&mut text)?;
        if text.len() > 65536 {
            return Err(IdeError::invalid("JDBC driver descriptor is too large"));
        }
        for line in text.lines() {
            let name = line.split('#').next().unwrap_or_default().trim();
            if !name.is_empty()
                && name.split('.').all(|part| {
                    let mut chars = part.chars();
                    chars.next().is_some_and(|c| c.is_alphabetic() || matches!(c, '_' | '$'))
                        && chars.all(|c| c.is_alphanumeric() || matches!(c, '_' | '$'))
                })
                && !classes.iter().any(|s| s == name)
            {
                classes.push(name.to_owned());
            }
        }
    }
    Ok(classes)
}

impl DbJdbcDriver {
    fn validate(&self) -> IdeResult<()> {
        if self.id.is_empty()
            || self.name.trim().is_empty()
            || self.jars.is_empty()
            || self.class_name.trim().is_empty()
        {
            return Err(IdeError::invalid("A JDBC driver needs a name, a driver class and at least one JAR"));
        }
        if !self.url_template.is_empty() && !self.url_template.starts_with("jdbc:") {
            return Err(IdeError::invalid("The JDBC URL template must start with jdbc:"));
        }
        for jar in &self.jars {
            local_jar(jar)?;
        }
        Ok(())
    }
}

impl DbManager {
    fn jdbc_registry(&self) -> IdeResult<PathBuf> {
        self.global
            .as_ref()
            .map(|(dir, _)| dir.join("jdbc-drivers.json"))
            .ok_or_else(|| IdeError::invalid("Global JDBC driver profiles are unavailable here"))
    }

    pub fn jdbc_drivers(&self) -> IdeResult<Vec<DbJdbcDriver>> {
        let path = self.jdbc_registry()?;
        match std::fs::File::open(path) {
            Ok(file) => {
                serde_json::from_reader(file).map_err(|e| IdeError::invalid(format!("JDBC driver profiles: {e}")))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
            Err(e) => Err(e.into()),
        }
    }

    fn update_jdbc_driver(&self, id: &str, driver: Option<DbJdbcDriver>) -> IdeResult<()> {
        let _guard = crate::plugin::EDIT.lock();
        let path = self.jdbc_registry()?;
        let mut list = self.jdbc_drivers()?;
        list.retain(|d| d.id != id);
        list.extend(driver);
        let data = serde_json::to_vec_pretty(&list).map_err(|e| IdeError::internal(e.to_string()))?;
        persist_local(&path, &data)
    }

    pub fn save_jdbc_driver(&self, driver: DbJdbcDriver) -> IdeResult<()> {
        driver.validate()?;
        self.update_jdbc_driver(&driver.id.clone(), Some(driver))
    }

    pub fn remove_jdbc_driver(&self, id: &str) -> IdeResult<()> {
        if self.global_sources().iter().any(|s| s.driver == crate::DbDriver::Jdbc && s.jdbc_driver == id) {
            return Err(IdeError::invalid("This JDBC driver is in use by a data source"));
        }
        self.update_jdbc_driver(id, None)
    }

    fn jdbc_approval(&self, source: &DataSource) -> IdeResult<(PathBuf, String)> {
        let registry = self.jdbc_registry()?;
        let key = serde_json::to_vec(&(&self.root, &source.id)).map_err(|e| IdeError::internal(e.to_string()))?;
        let mut settings = serde_json::to_vec(&(
            &source.jdbc_driver,
            &source.url,
            &source.user,
            source.read_only,
            &source.properties,
            &source.options,
        ))
        .map_err(|e| IdeError::internal(e.to_string()))?;
        if let Some(lake) = &source.duck_lake {
            settings.extend_from_slice(b"\0ducklake\0");
            serde_json::to_writer(&mut settings, lake).map_err(|e| IdeError::internal(e.to_string()))?;
        } else if self.jdbc_password_isolated(source) {
            settings.extend_from_slice(b"\0jdbc-password");
        }
        Ok((
            registry.with_file_name("jdbc-approvals").join(blake3::hash(&key).to_hex().as_str()),
            blake3::hash(&settings).to_hex().to_string(),
        ))
    }

    /// Called only for the source the user explicitly saved in the connection dialog.
    pub fn approve_jdbc_source(&self, source: &DataSource) -> IdeResult<()> {
        if source.driver != crate::DbDriver::Jdbc || source.plugin_owner.is_some() {
            return Err(IdeError::invalid("Expected a user-managed JDBC data source"));
        }
        if source.duck_lake.is_some() {
            return self.approve_ducklake_source(source);
        }
        self.record_jdbc_approval(source)
    }

    pub fn approve_ducklake_source(&self, source: &DataSource) -> IdeResult<()> {
        if source.duck_lake.is_none() {
            return Err(IdeError::invalid("Expected a DuckLake data source"));
        }
        source.validate_duck_lake()?;
        self.duck_lake_driver(&source.jdbc_driver)?.validate()?;
        if source.global {
            return Ok(());
        }
        self.record_jdbc_approval(source)
    }

    fn record_jdbc_approval(&self, source: &DataSource) -> IdeResult<()> {
        let (path, fingerprint) = self.jdbc_approval(source)?;
        persist_local(&path, fingerprint.as_bytes())
    }

    fn jdbc_driver_for(&self, id: &str, vendor: &str) -> IdeResult<DbJdbcDriver> {
        let driver = self
            .jdbc_drivers()?
            .into_iter()
            .find(|d| d.id == id)
            .ok_or_else(|| IdeError::invalid("Select an installed JDBC driver profile"))?;
        if !vendor.is_empty() && driver.vendor.as_deref() != Some(vendor) {
            return Err(IdeError::invalid("The JDBC driver profile is not associated with this data source type"));
        }
        Ok(driver)
    }

    fn duck_lake_driver(&self, id: &str) -> IdeResult<DbJdbcDriver> {
        let driver = self.jdbc_driver_for(id, "duckdb")?;
        if driver.class_name != DUCKDB_CLASS {
            return Err(IdeError::invalid("Select a DuckDB driver profile with the official DuckDB JDBC driver class"));
        }
        Ok(driver)
    }

    /// Creates a lake in a new directory through a separate, disposable JDBC session.
    pub async fn create_ducklake(&self, jdbc_driver: &str, directory: &str) -> IdeResult<()> {
        duck_lake_path(directory, false)?;
        let driver = self.duck_lake_driver(jdbc_driver)?;
        let fields = duck_lake_fields("create", directory.to_owned(), "");
        let pool = JdbcPool::open(driver, self.jdbc_registry()?.with_file_name("jdbc"), fields).await?;
        pool.close().await;
        Ok(())
    }

    pub(crate) async fn open_pool(
        &self,
        source: &DataSource,
        password: Option<&str>,
        testing: bool,
    ) -> IdeResult<crate::Pool> {
        source.validate_duck_lake()?;
        if source.driver != crate::DbDriver::Jdbc {
            return crate::Pool::connect(source, password, Some(&self.root)).await;
        }
        if source.plugin_owner.is_some() {
            return Err(IdeError::invalid("Plugins cannot start custom JDBC drivers"));
        }
        if !testing && !source.global {
            let (path, expected) = self.jdbc_approval(source)?;
            if std::fs::read_to_string(path).ok().as_deref() != Some(&expected) {
                return Err(IdeError::invalid(
                    "Review this project's JDBC URL and properties, then save the data source before connecting",
                ));
            }
        }
        let cache = self.jdbc_registry()?.with_file_name("jdbc");
        let pool = if let Some(lake) = &source.duck_lake {
            let driver = self.duck_lake_driver(&source.jdbc_driver)?;
            let (mode, value) = match lake.kind {
                DbDuckLakeKind::Secret => ("secret", lake.value.clone()),
                DbDuckLakeKind::File => {
                    let path = self.root.join(&lake.value);
                    let value = path.to_str().ok_or_else(|| IdeError::invalid("Invalid DuckLake catalog file path"))?;
                    duck_lake_path(value, false)?;
                    ("file", value.to_owned())
                }
            };
            let fields = duck_lake_fields(mode, value, lake.data_path.as_deref().unwrap_or_default());
            JdbcPool::open(driver, cache, fields).await?
        } else {
            let driver = self.jdbc_driver_for(&source.jdbc_driver, &source.vendor)?;
            JdbcPool::connect(source, password, driver, cache).await?
        };
        Ok(crate::Pool::Jdbc(Box::new(pool)))
    }
}

fn duck_lake_fields(mode: &str, value: String, data_path: &str) -> Vec<String> {
    vec![
        "openDuckLake".into(),
        DUCKDB_CLASS.into(),
        DUCKDB_URL.into(),
        String::new(),
        String::new(),
        (mode != "create").to_string(),
        mode.into(),
        value,
        data_path.to_owned(),
    ]
}

struct Session {
    id: u32,
    // A physical JDBC Connection executes one request at a time.
    opened: Mutex<bool>,
    retired: CancellationToken,
}

impl Session {
    fn new(id: u32) -> Self {
        Self { id, opened: Mutex::new(id == 0), retired: CancellationToken::new() }
    }
}

#[derive(Default)]
struct ConsoleSessions {
    latest: u32,
    opened: HashMap<(String, String), Arc<Session>>,
}

pub struct JdbcPool {
    bridge: Arc<Bridge>,
    service: Session,
    consoles: parking_lot::Mutex<ConsoleSessions>,
    shared_connection: bool,
    pub(crate) version: String,
    pub(crate) identifier_quote: String,
}

/// Dropped futures and uncertain transport errors retire the connection they were using.
struct ActiveRequest<'a> {
    pool: &'a JdbcPool,
    session: &'a Session,
    completed: bool,
}

impl Drop for ActiveRequest<'_> {
    fn drop(&mut self) {
        if !self.completed {
            self.pool.retire(self.session);
        }
    }
}

/// A second connection to an anonymous database would see a different database.
fn private_database_url(url: &str) -> bool {
    if let Some(h2) = url.strip_prefix("jdbc:h2:mem:") {
        return h2.is_empty() || h2.starts_with(';');
    }
    let Some(sqlite) = url.strip_prefix("jdbc:sqlite:") else {
        return false;
    };
    let (path, query) = sqlite.split_once('?').unwrap_or((sqlite, ""));
    if matches!(path, "" | ":memory:" | "file:") {
        return true;
    }
    let option = |name| {
        query
            .split('&')
            .rev()
            .filter_map(|part| part.split_once('='))
            .find_map(|(key, value)| (key == name).then_some(value))
    };
    path.starts_with("file:")
        && (path == "file::memory:" || option("mode") == Some("memory"))
        && option("cache") != Some("shared")
}

impl JdbcPool {
    async fn connect(
        source: &DataSource,
        password: Option<&str>,
        driver: DbJdbcDriver,
        cache: PathBuf,
    ) -> IdeResult<Self> {
        let mut fields = vec![
            "open".to_string(),
            driver.class_name.clone(),
            source.url.clone(),
            source.user.clone(),
            password.unwrap_or_default().to_owned(),
            source.read_only.to_string(),
        ];
        for p in &source.properties {
            if p.name.eq_ignore_ascii_case("password") {
                return Err(IdeError::invalid("Enter the JDBC password in the password field"));
            }
            fields.extend([p.name.clone(), p.value.clone()]);
        }
        Self::open(driver, cache, fields).await
    }

    async fn open(driver: DbJdbcDriver, cache: PathBuf, fields: Vec<String>) -> IdeResult<Self> {
        driver.validate()?;
        let bridge = tokio::task::spawn_blocking(move || Bridge::start(&cache, &driver.jars))
            .await
            .map_err(|e| IdeError::internal(e.to_string()))??;
        let args: Vec<_> = fields.iter().map(String::as_str).collect();
        let cancel = CancellationToken::new();
        let data = timeout(Duration::from_secs(30), bridge.exchange(0, &args, &cancel, &cancel))
            .await
            .map_err(|_| IdeError::new(ErrorKind::TimedOut, "JDBC connection timed out"))??;
        let result = decode(&data.ok_or_else(IdeError::cancelled)?, "", 0.)?;
        let mut metadata = result.rows.into_iter().next().unwrap_or_default().into_iter();
        Ok(Self {
            bridge: Arc::new(bridge),
            service: Session::new(0),
            consoles: Default::default(),
            shared_connection: private_database_url(&fields[2]),
            version: metadata.next().flatten().unwrap_or_else(|| "Connected".into()),
            identifier_quote: metadata.next().flatten().unwrap_or_default().trim().into(),
        })
    }

    pub(crate) async fn close(&self) {
        self.bridge.close().await;
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.bridge.is_closed()
    }

    fn console(&self, console: ConsoleId<'_>) -> IdeResult<Arc<Session>> {
        let key = (console.window.to_owned(), console.path.to_owned());
        let mut sessions = self.consoles.lock();
        if let Some(existing) = sessions.opened.get(&key)
            && !existing.retired.is_cancelled()
        {
            return Ok(existing.clone());
        }
        let id = sessions.latest.checked_add(1).ok_or_else(|| IdeError::internal("JDBC session IDs exhausted"))?;
        sessions.latest = id;
        let session = Arc::new(Session::new(id));
        sessions.opened.insert(key, session.clone());
        Ok(session)
    }

    pub(crate) async fn release_console(&self, console: ConsoleId<'_>) -> IdeResult<()> {
        let key = (console.window.to_owned(), console.path.to_owned());
        // Retire the ID before allowing a reopened editor to allocate a replacement.
        let session = self.consoles.lock().opened.remove(&key).inspect(|session| session.retired.cancel());
        if let Some(session) = session {
            let closed = self.bridge.close_session(session.id).await;
            self.shutdown_service_if_idle();
            closed?;
        }
        Ok(())
    }

    fn retire(&self, session: &Session) {
        if session.retired.is_cancelled() {
            return;
        }
        session.retired.cancel();
        if session.id != 0 {
            let bridge = self.bridge.clone();
            let id = session.id;
            tokio::spawn(async move {
                let _ = bridge.close_session(id).await;
            });
        }
        self.shutdown_service_if_idle();
    }

    fn shutdown_service_if_idle(&self) {
        if !self.service.retired.is_cancelled() {
            return;
        }
        let has_consoles =
            self.consoles.lock().opened.values().any(|session| {
                !session.retired.is_cancelled() && session.opened.try_lock().map_or(true, |opened| *opened)
            });
        // Service failure cannot discard a healthy editor's transaction or temporary tables.
        if !has_consoles {
            self.bridge.shutdown();
        }
    }

    pub(crate) async fn query(
        &self,
        sql: &str,
        skip: usize,
        max: usize,
        cancel: &CancellationToken,
    ) -> IdeResult<QueryResult> {
        self.query_in_schema(sql, skip, max, cancel, None).await
    }

    pub(crate) async fn query_in_schema(
        &self,
        sql: &str,
        skip: usize,
        max: usize,
        cancel: &CancellationToken,
        schema: Option<&str>,
    ) -> IdeResult<QueryResult> {
        self.query_in_console(sql, skip, max, cancel, schema, None).await
    }

    pub(crate) async fn query_in_console(
        &self,
        sql: &str,
        skip: usize,
        max: usize,
        cancel: &CancellationToken,
        schema: Option<&str>,
        console: Option<ConsoleId<'_>>,
    ) -> IdeResult<QueryResult> {
        let session = console.filter(|_| !self.shared_connection).map(|console| self.console(console)).transpose()?;
        self.request_on(
            session.as_deref().unwrap_or(&self.service),
            &["query", sql, &skip.to_string(), &max.min(i32::MAX as usize).to_string(), schema.unwrap_or_default()],
            sql,
            cancel,
        )
        .await
    }

    pub(crate) async fn page(
        &self,
        sql: &str,
        offset: u64,
        limit: u64,
        cancel: &CancellationToken,
    ) -> IdeResult<QueryResult> {
        self.request(&["page", sql, &offset.to_string(), &limit.min(i32::MAX as u64).to_string()], sql, cancel).await
    }

    /// Introspection on this connection. `catalogs` lists live catalogs with the current one marked.
    /// `schemas`, `tables`, `schemaColumns`, and `columns` accept a final catalog argument.
    pub(crate) async fn metadata(&self, fields: &[&str]) -> IdeResult<Vec<Vec<Option<String>>>> {
        Ok(self.request(fields, "", &CancellationToken::new()).await?.rows)
    }

    async fn request(&self, fields: &[&str], sql: &str, cancel: &CancellationToken) -> IdeResult<QueryResult> {
        self.request_on(&self.service, fields, sql, cancel).await
    }

    async fn request_on(
        &self,
        session: &Session,
        fields: &[&str],
        sql: &str,
        cancel: &CancellationToken,
    ) -> IdeResult<QueryResult> {
        // A rejected local request has not used the connection and cannot invalidate it.
        bridge::frame_size(fields)?;
        let mut opened = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(IdeError::cancelled()),
            () = session.retired.cancelled() => {
                return Err(if session.id == 0 {
                    IdeError::new(ErrorKind::Io, "The JDBC service connection was lost. Reconnect to restore catalog access.")
                } else {
                    IdeError::cancelled()
                });
            }
            slot = session.opened.lock() => slot,
        };
        let mut active = ActiveRequest { pool: self, session, completed: false };
        if !*opened {
            let data = timeout(Duration::from_secs(30), self.exchange(session, &["open"], cancel))
                .await
                .map_err(|_| IdeError::new(ErrorKind::TimedOut, "JDBC connection timed out"))??;
            decode(&data.ok_or_else(IdeError::cancelled)?, "", 0.)?;
            *opened = true;
        }
        let start = Instant::now();
        let data = self.exchange(session, fields, cancel).await?;
        let result = data
            .ok_or_else(IdeError::cancelled)
            .and_then(|data| decode(&data, sql, start.elapsed().as_secs_f64() * 1000.0));
        if result.as_ref().is_err_and(|error| error.kind != ErrorKind::Cancelled) && !self.session_valid(session).await
        {
            return result;
        }
        active.completed = true;
        result
    }

    async fn exchange(
        &self,
        session: &Session,
        fields: &[&str],
        cancel: &CancellationToken,
    ) -> IdeResult<Option<Vec<u8>>> {
        tokio::select! {
            biased;
            () = session.retired.cancelled() => Err(IdeError::cancelled()),
            data = self.bridge.exchange(session.id, fields, cancel, &session.retired) => data,
        }
    }

    /// Keep-alive operates on the service connection without waiting on an editor's query.
    pub(crate) async fn ping(&self) -> IdeResult<()> {
        let _service = self.service.opened.lock().await;
        if self.service.retired.is_cancelled() || self.session_valid(&self.service).await {
            return Ok(());
        }
        self.retire(&self.service);
        Err(IdeError::new(ErrorKind::Io, "JDBC connection was lost"))
    }

    /// Checks that an error was local to this statement before reusing its connection.
    async fn session_valid(&self, session: &Session) -> bool {
        let cancel = CancellationToken::new();
        let Ok(Ok(Some(data))) = timeout(Duration::from_secs(10), self.exchange(session, &["valid"], &cancel)).await
        else {
            return false;
        };
        decode(&data, "", 0.).is_ok_and(|result| {
            result.rows.first().and_then(|row| row.first()).and_then(Option::as_deref) == Some("true")
        })
    }
}

fn decode(data: &[u8], sql: &str, elapsed_ms: f64) -> IdeResult<QueryResult> {
    let mut input = Cursor::new(data);
    fn bytes<const N: usize>(input: &mut Cursor<&[u8]>) -> IdeResult<[u8; N]> {
        let mut buf = [0; N];
        Read::read_exact(input, &mut buf)?;
        Ok(buf)
    }
    fn flag(input: &mut Cursor<&[u8]>) -> IdeResult<bool> {
        match bytes::<1>(input)? {
            [0] => Ok(false),
            [1] => Ok(true),
            _ => Err(IdeError::invalid("Invalid JDBC flag")),
        }
    }
    fn field(input: &mut Cursor<&[u8]>) -> IdeResult<Option<String>> {
        let n = i32::from_be_bytes(bytes(input)?);
        if n == -1 {
            return Ok(None);
        }
        let start = input.position() as usize;
        let end = start
            .checked_add(n as usize)
            .filter(|end| *end <= input.get_ref().len())
            .ok_or_else(|| IdeError::invalid("Invalid JDBC field length"))?;
        let value = String::from_utf8_lossy(&input.get_ref()[start..end]).into_owned();
        input.set_position(end as u64);
        Ok(Some(value))
    }
    if !flag(&mut input)? {
        return Err(IdeError::invalid(field(&mut input)?.unwrap_or_else(|| "JDBC request failed".into())));
    }
    let count = u32::from_be_bytes(bytes(&mut input)?) as usize;
    if count > data.len() / 8 {
        return Err(IdeError::invalid("Invalid JDBC column count"));
    }
    let mut columns = Vec::new();
    for _ in 0..count {
        columns.push(ResultColumn {
            name: field(&mut input)?.unwrap_or_default(),
            type_name: field(&mut input)?.unwrap_or_default(),
        });
    }
    let mut rows = vec![];
    while flag(&mut input)? {
        if count == 0 {
            return Err(IdeError::invalid("JDBC returned a row with no columns"));
        }
        rows.push((0..count).map(|_| field(&mut input)).collect::<IdeResult<_>>()?);
    }
    let has_more = flag(&mut input)?;
    let affected = i64::from_be_bytes(bytes(&mut input)?);
    if input.position() != data.len() as u64 {
        return Err(IdeError::invalid("Invalid trailing JDBC response data"));
    }
    Ok(QueryResult {
        statement: sql.into(),
        columns,
        rows,
        has_more,
        affected: (affected >= 0).then_some(affected as f64),
        elapsed_ms,
        execution_ms: elapsed_ms,
        truncated: Vec::new(),
    })
}

impl DbManager {
    pub(crate) async fn jdbc_completion(&self, id: &str, pool: &JdbcPool) -> IdeResult<crate::CompletionModel> {
        let mut tables = vec![];
        let mut column_count = 0;
        // Read the schemas the source's Schemas tab picks, like the database tree does. It also
        // keeps large instances usable: an Oracle server exposes dozens of system schemas, and
        // dumping the columns of all of them takes minutes, during which the bridge (a single
        // Java process that runs one command at a time) executes none of the user's statements.
        let introspection = self.source(id)?.introspection;
        let schemas: Vec<String> =
            self.schemas(id).await?.into_iter().filter(|s| introspection.shows_schema(s)).collect();
        for schema in &schemas {
            // Columns of the whole namespace in one call; a driver that refuses it still completes tables.
            let mut columns = if column_count < crate::MAX_META_ROWS {
                pool.metadata(&["schemaColumns", schema]).await.map(schema_columns).unwrap_or_else(|e| {
                    tracing::warn!("JDBC columns of {schema}: {}", e.message);
                    HashMap::new()
                })
            } else {
                HashMap::new()
            };
            for table in self.tables(id, schema).await? {
                let columns = columns.remove(&table.name).unwrap_or_default();
                column_count += columns.len();
                tables.push(crate::CompletionTable {
                    schema: schema.clone(),
                    name: table.name,
                    kind: table.kind,
                    columns,
                });
                if tables.len() >= crate::MAX_META_ROWS {
                    break;
                }
            }
            if tables.len() >= crate::MAX_META_ROWS {
                break;
            }
        }
        Ok(crate::CompletionModel {
            default_schema: pool
                .metadata(&["namespace"])
                .await?
                .into_iter()
                .flatten()
                .flatten()
                .next()
                .unwrap_or_default(),
            tables,
            foreign_keys: vec![],
        })
    }
}

/// The bridge's `schemaColumns` rows (table, name, type, nullable, default, comment) by table.
fn schema_columns(rows: Vec<Vec<Option<String>>>) -> HashMap<String, Vec<crate::CompletionColumn>> {
    let mut by_table: HashMap<String, Vec<crate::CompletionColumn>> = HashMap::new();
    for row in rows {
        let mut it = row.into_iter();
        let (Some(Some(table)), Some(Some(name))) = (it.next(), it.next()) else { continue };
        let data_type = it.next().flatten().unwrap_or_default();
        let nullable = it.next().flatten().as_deref() != Some("0");
        let has_default = it.next().flatten().is_some();
        // Bridges built before the comment column send five fields.
        let comment = it.next().flatten().filter(|c| !c.trim().is_empty());
        by_table.entry(table).or_default().push(crate::CompletionColumn {
            name,
            data_type,
            nullable,
            primary_key: false,
            has_default,
            comment,
        });
    }
    by_table
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_private_jdbc_databases_keep_one_connection() {
        for url in [
            "jdbc:sqlite:",
            "jdbc:sqlite::memory:",
            "jdbc:sqlite:file:",
            "jdbc:sqlite:file:private?mode=memory&cache=private",
            "jdbc:h2:mem:",
            "jdbc:h2:mem:;DB_CLOSE_DELAY=-1",
        ] {
            assert!(private_database_url(url), "{url}");
        }
        for url in [
            "jdbc:sqlite:/tmp/data.db",
            "jdbc:sqlite:file:data.db?cache=shared",
            "jdbc:sqlite:file:shared?mode=memory&cache=shared",
            "jdbc:sqlite:file::memory:?cache=shared",
            "jdbc:h2:mem:shared;DB_CLOSE_DELAY=-1",
            "jdbc:h2:file:/tmp/data",
            "jdbc:h2:tcp://server/data",
            "jdbc:duckdb:",
            "jdbc:clickhouse://localhost/default",
        ] {
            assert!(!private_database_url(url), "{url}");
        }
    }

    #[test]
    fn schema_columns_group_by_table() {
        let row = |t: &str, n: &str, null: &str, def: Option<&str>| {
            vec![Some(t.into()), Some(n.into()), Some("INT".into()), Some(null.into()), def.map(Into::into)]
        };
        let mut commented = row("orders", "note", "1", Some("'none'"));
        commented.push(Some("free text".into()));
        let mut blank = row("items", "sku", "1", None);
        blank.push(Some(" ".into()));
        let by_table =
            schema_columns(vec![row("orders", "id", "0", None), commented, blank, vec![None, Some("orphan".into())]]);
        let orders = &by_table["orders"];
        assert_eq!(orders.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["id", "note"]);
        assert_eq!((orders[0].nullable, orders[0].has_default), (false, false));
        assert_eq!((orders[1].nullable, orders[1].has_default), (true, true));
        assert_eq!((orders[0].comment.as_deref(), orders[1].comment.as_deref()), (None, Some("free text")));
        assert_eq!(by_table["items"][0].comment, None);
        assert_eq!(by_table["items"].len(), 1);
        assert_eq!(by_table.len(), 2);
    }

    #[tokio::test]
    #[ignore = "requires DUCKDB_JDBC_JAR and a local Java 17+ runtime"]
    async fn duckdb_live_catalog_metadata_is_scoped_to_the_requested_namespace() -> IdeResult<()> {
        let tmp = tempfile::tempdir()?;
        let source = DataSource { url: "jdbc:duckdb:".into(), ..Default::default() };
        let driver = DbJdbcDriver {
            id: "duckdb".into(),
            name: "DuckDB".into(),
            vendor: None,
            jars: vec![std::env::var("DUCKDB_JDBC_JAR").expect("DUCKDB_JDBC_JAR")],
            class_name: "org.duckdb.DuckDBDriver".into(),
            url_template: String::new(),
        };
        let pool = JdbcPool::connect(&source, None, driver, tmp.path().join("jdbc")).await?;
        let stop = CancellationToken::new();
        let path = |file| tmp.path().join(file).to_string_lossy().replace('\'', "''");
        let archive = "archive.db:1";
        for sql in [
            "SET threads = 1".into(),
            "CREATE TABLE memory.main.dupe (root_only INT)".into(),
            format!("ATTACH '{}' AS first", path("first.duckdb")),
            format!(r#"ATTACH '{}' AS "archive.db:1""#, path("archive.duckdb")),
            "CREATE TABLE first.main.dupe (first_only INT PRIMARY KEY)".into(),
            r#"CREATE TABLE "archive.db:1".main.dupe (archive_only INT)"#.into(),
            r#"CREATE SCHEMA "archive.db:1"."qa_%""#.into(),
            r#"CREATE SCHEMA "archive.db:1".qaSimilar"#.into(),
            r#"CREATE TABLE "archive.db:1"."qa_%"."t_%""q" (quoted_only INT PRIMARY KEY)"#.into(),
            r#"COMMENT ON TABLE "archive.db:1"."qa_%"."t_%""q" IS 'Archive table'"#.into(),
            r#"COMMENT ON COLUMN "archive.db:1"."qa_%"."t_%""q".quoted_only IS 'In the archive'"#.into(),
            r#"CREATE TABLE "archive.db:1".qaSimilar."t_%""q" (wrong_schema INT)"#.into(),
            r#"COMMENT ON TABLE "archive.db:1".qaSimilar."t_%""q" IS 'Wrong schema table'"#.into(),
            r#"COMMENT ON COLUMN "archive.db:1".qaSimilar."t_%""q".wrong_schema IS 'Outside the schema'"#.into(),
        ] {
            pool.query(&sql, 0, 1, &stop).await?;
        }

        let catalogs = pool.metadata(&["catalogs"]).await?;
        assert!(catalogs.contains(&vec![Some("memory".into()), Some("1".into())]));
        assert!(catalogs.contains(&vec![Some("first".into()), Some("0".into())]));
        assert!(catalogs.contains(&vec![Some(archive.into()), Some("0".into())]));
        let mut schemas = pool.metadata(&["schemas", archive]).await?;
        // DuckDB JDBC 1.1.3 also lists these system schemas for attached catalogs.
        schemas.retain(|row| !matches!(row[0].as_deref(), Some("information_schema" | "pg_catalog")));
        assert_eq!(schemas, ["main", "qaSimilar", "qa_%"].map(|schema| vec![Some(schema.into())]));
        let tables = pool.metadata(&["tables", "qa_%", archive]).await?;
        assert_eq!(tables.len(), 1);
        assert_eq!(tables[0][0].as_deref(), Some(r#"t_%"q"#));
        assert_eq!(tables[0][2].as_deref(), Some("Archive table"));

        for (catalog, column, primary) in
            [("memory", "root_only", "0"), ("first", "first_only", "1"), (archive, "archive_only", "0")]
        {
            let columns = pool.metadata(&["columns", "main", "dupe", catalog]).await?;
            assert_eq!(columns.len(), 1);
            assert_eq!(columns[0][0].as_deref(), Some(column));
            assert_eq!(columns[0][4].as_deref(), Some(primary));
        }
        let quoted = pool.metadata(&["columns", "qa_%", r#"t_%"q"#, archive]).await?;
        assert_eq!(quoted.len(), 1);
        assert_eq!(quoted[0][0].as_deref(), Some("quoted_only"));
        assert_eq!(quoted[0][4].as_deref(), Some("1"));
        let all = schema_columns(pool.metadata(&["schemaColumns", "qa_%", archive]).await?);
        assert_eq!(all.len(), 1);
        assert_eq!(all[r#"t_%"q"#][0].name, "quoted_only");
        assert_eq!(all[r#"t_%"q"#][0].comment.as_deref(), Some("In the archive"));

        pool.query("USE first", 0, 1, &stop).await?;
        let catalogs = pool.metadata(&["catalogs"]).await?;
        assert!(catalogs.contains(&vec![Some("first".into()), Some("1".into())]));
        let legacy = pool.metadata(&["columns", "main", "dupe"]).await?;
        assert_eq!(legacy[0][0].as_deref(), Some("first_only"));
        pool.query("USE memory", 0, 1, &stop).await?;
        pool.query("DETACH first", 0, 1, &stop).await?;
        let catalogs = pool.metadata(&["catalogs"]).await?;
        assert!(!catalogs.iter().any(|r| r[0].as_deref() == Some("first")));
        assert!(pool.metadata(&["schemas", "first"]).await?.is_empty());
        assert!(pool.metadata(&["tables", "main", "first"]).await?.is_empty());
        assert!(pool.metadata(&["columns", "main", "dupe", "first"]).await?.is_empty());
        pool.close().await;
        Ok(())
    }

    #[test]
    fn result_codec_preserves_null_and_rejects_incomplete_frames() {
        let mut frame =
            vec![1, 0, 0, 0, 1, 0, 0, 0, 1, b'n', 0, 0, 0, 3, b'i', b'n', b't', 1, 255, 255, 255, 255, 0, 0];
        frame.extend_from_slice(&(-1i64).to_be_bytes());
        let result = decode(&frame, "select", 0.).unwrap();
        assert_eq!(result.columns[0].name, "n");
        assert_eq!(result.rows, [vec![None]]);
        for end in 0..frame.len() {
            assert!(decode(&frame[..end], "", 0.).is_err());
        }
        frame.push(0);
        assert!(decode(&frame, "", 0.).is_err());
        assert!(decode(&[2], "", 0.).is_err());
    }
}
