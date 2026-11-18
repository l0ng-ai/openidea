//! A trusted local driver profile is shared by data sources. JDBC URLs and properties
//! can run driver-specific initialization. A project source may connect only with the
//! settings its user last accepted in the dialog; the approval lives outside the project.
use crate::{DataSource, DbManager, QueryResult, ResultColumn};
use ide_core::{CancellationToken, IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

const LIMIT: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DbJdbcDriver {
    pub id: String,
    pub name: String,
    pub jars: Vec<String>,
    pub class_name: String,
    pub url_template: String,
}

fn persist_local(path: &Path, data: &[u8]) -> IdeResult<()> {
    let dir = path.parent().expect("registry paths have a parent");
    std::fs::create_dir_all(dir)?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    std::io::Write::write_all(&mut tmp, data)?;
    tmp.persist(path).map_err(|e| IdeError::from(e.error))?;
    Ok(())
}

fn local_jar(jar: &str) -> IdeResult<&Path> {
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
        let settings = serde_json::to_vec(&(
            &source.jdbc_driver,
            &source.url,
            &source.user,
            source.read_only,
            &source.properties,
            &source.options,
        ))
        .map_err(|e| IdeError::internal(e.to_string()))?;
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
        let (path, fingerprint) = self.jdbc_approval(source)?;
        persist_local(&path, fingerprint.as_bytes())
    }

    pub(crate) async fn open_pool(
        &self,
        source: &DataSource,
        password: Option<&str>,
        testing: bool,
    ) -> IdeResult<crate::Pool> {
        if source.driver != crate::DbDriver::Jdbc {
            return crate::Pool::connect(source, password, Some(&self.root)).await;
        }
        if source.read_only {
            return Err(IdeError::invalid(
                "Custom JDBC cannot enforce read-only access. Use a database account with read-only privileges.",
            ));
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
        let driver = self
            .jdbc_drivers()?
            .into_iter()
            .find(|d| d.id == source.jdbc_driver)
            .ok_or_else(|| IdeError::invalid("Select an installed JDBC driver profile"))?;
        JdbcPool::connect(source, password, driver).await.map(Box::new).map(crate::Pool::Jdbc)
    }
}

struct Bridge {
    stop: tokio::sync::oneshot::Sender<()>,
    exited: tokio::task::JoinHandle<()>,
    input: ChildStdin,
    output: ChildStdout,
}

pub struct JdbcPool {
    bridge: Mutex<Option<Bridge>>,
    closed: CancellationToken,
    pub(crate) version: String,
    pub(crate) identifier_quote: String,
}

impl Bridge {
    fn start() -> IdeResult<Self> {
        let jdks = ide_sdk::java::installed_jdks();
        let jdk = ide_sdk::java::runtime_with_modules(&jdks, 17, &["jdk.compiler", "java.sql"])
            .ok_or_else(|| IdeError::invalid("Install a JDK 17 or newer to use custom JDBC drivers"))?;
        let dir = tempfile::tempdir()?;
        let file = dir.path().join("OpenIdeaJdbc.java");
        std::fs::write(&file, include_bytes!("OpenIdeaJdbc.java"))?;
        let mut command = Command::new(ide_sdk::java::java_executable(&jdk.home));
        command.current_dir(dir.path());
        ide_core::process::prepare(command.as_std_mut());
        let mut child = command
            .arg("-Xmx192m")
            .arg("--enable-native-access=ALL-UNNAMED")
            .arg("OpenIdeaJdbc.java")
            .env_remove("CLASSPATH")
            .env_remove("JDK_JAVA_OPTIONS")
            .env_remove("JAVA_TOOL_OPTIONS")
            .env_remove("_JAVA_OPTIONS")
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let input = child.stdin.take().expect("piped");
        let output = child.stdout.take().expect("piped");
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let exited = tokio::spawn(async move {
            tokio::select! {
                _ = stopped => { let _ = child.kill().await; }
                _ = child.wait() => {}
            }
            // Windows keeps the working directory open until the JVM exits.
            drop(dir);
        });
        Ok(Self { input, output, stop, exited })
    }

    async fn close(self) {
        drop(self.stop);
        let _ = self.exited.await;
    }

    async fn exchange(&mut self, fields: &[&str]) -> IdeResult<Vec<u8>> {
        let mut data = Vec::new();
        data.extend_from_slice(&(fields.len() as u32).to_be_bytes());
        if fields.len() > 8192 {
            return Err(IdeError::invalid("Too many JDBC connection properties"));
        }
        for field in fields {
            if field.len() + data.len() + 4 > LIMIT {
                return Err(IdeError::invalid("JDBC request exceeds 16 MiB"));
            }
            data.extend_from_slice(&(field.len() as u32).to_be_bytes());
            data.extend_from_slice(field.as_bytes());
        }
        self.input.write_all(&data).await?;
        self.input.flush().await?;
        let n = self.output.read_u32().await? as usize;
        if n > LIMIT {
            return Err(IdeError::invalid("JDBC response exceeds 16 MiB"));
        }
        let mut reply = vec![0; n];
        self.output.read_exact(&mut reply).await?;
        Ok(reply)
    }
}

impl JdbcPool {
    async fn connect(source: &DataSource, password: Option<&str>, driver: DbJdbcDriver) -> IdeResult<Self> {
        driver.validate()?;
        let mut fields = vec![
            "open".to_string(),
            driver.class_name,
            source.url.clone(),
            source.user.clone(),
            password.unwrap_or_default().to_owned(),
            driver.jars.len().to_string(),
        ];
        fields.extend(driver.jars);
        for p in &source.properties {
            if p.name.eq_ignore_ascii_case("password") {
                return Err(IdeError::invalid("Enter the JDBC password in the password field"));
            }
            fields.extend([p.name.clone(), p.value.clone()]);
        }
        let bridge =
            tokio::task::spawn_blocking(Bridge::start).await.map_err(|e| IdeError::internal(e.to_string()))??;
        let mut pool = Self {
            bridge: Mutex::new(Some(bridge)),
            closed: CancellationToken::new(),
            version: String::new(),
            identifier_quote: String::new(),
        };
        let args: Vec<_> = fields.iter().map(String::as_str).collect();
        let cancel = CancellationToken::new();
        let result = tokio::time::timeout(Duration::from_secs(30), pool.request(&args, "", &cancel))
            .await
            .map_err(|_| IdeError::new(ide_core::error::ErrorKind::TimedOut, "JDBC connection timed out"))??;
        let mut metadata = result.rows.into_iter().next().unwrap_or_default().into_iter();
        pool.version = metadata.next().flatten().unwrap_or_else(|| "Connected".into());
        pool.identifier_quote = metadata.next().flatten().unwrap_or_default().trim().into();
        Ok(pool)
    }

    pub(crate) async fn close(&self) {
        self.closed.cancel();
        if let Some(bridge) = self.bridge.lock().await.take() {
            bridge.close().await;
        }
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.closed.is_cancelled()
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
        self.request(
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

    pub(crate) async fn metadata(&self, fields: &[&str]) -> IdeResult<Vec<Vec<Option<String>>>> {
        Ok(self.request(fields, "", &CancellationToken::new()).await?.rows)
    }

    async fn request(&self, fields: &[&str], sql: &str, cancel: &CancellationToken) -> IdeResult<QueryResult> {
        let mut slot = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(IdeError::cancelled()),
            () = self.closed.cancelled() => return Err(IdeError::invalid("JDBC connection is closed")),
            slot = self.bridge.lock() => slot,
        };
        let mut bridge = slot
            .take()
            .ok_or_else(|| IdeError::invalid("JDBC connection is closed; reconnect to start a new session"))?;
        // Dropping an in-flight request must discard its process and partially consumed frame.
        let interrupted = self.closed.clone().drop_guard();
        let start = Instant::now();
        let response = tokio::select! {
            biased;
            () = cancel.cancelled() => Err(IdeError::cancelled()),
            () = self.closed.cancelled() => Err(IdeError::cancelled()),
            response = bridge.exchange(fields) => response,
        };
        let data = match response {
            Ok(data) => {
                *slot = Some(bridge);
                interrupted.disarm();
                data
            }
            Err(e) => {
                bridge.close().await;
                return Err(e);
            }
        };
        decode(&data, sql, start.elapsed().as_secs_f64() * 1000.0)
    }
}

fn decode(data: &[u8], sql: &str, elapsed_ms: f64) -> IdeResult<QueryResult> {
    let mut input = Cursor::new(data);
    fn bytes<const N: usize>(input: &mut Cursor<&[u8]>) -> IdeResult<[u8; N]> {
        let mut buf = [0; N];
        Read::read_exact(input, &mut buf)?;
        Ok(buf)
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
    if bytes::<1>(&mut input)? == [0] {
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
    while bytes::<1>(&mut input)? == [1] {
        if count == 0 {
            return Err(IdeError::invalid("JDBC returned a row with no columns"));
        }
        rows.push((0..count).map(|_| field(&mut input)).collect::<IdeResult<_>>()?);
    }
    let has_more = bytes::<1>(&mut input)? == [1];
    let affected = i64::from_be_bytes(bytes(&mut input)?);
    Ok(QueryResult {
        statement: sql.into(),
        columns,
        rows,
        has_more,
        affected: (affected >= 0).then_some(affected as f64),
        elapsed_ms,
        execution_ms: elapsed_ms,
    })
}

impl DbManager {
    pub(crate) async fn jdbc_completion(&self, id: &str, pool: &JdbcPool) -> IdeResult<crate::CompletionModel> {
        let mut tables = vec![];
        let schemas = self.schemas(id).await?;
        for schema in &schemas {
            for table in self.tables(id, schema).await? {
                tables.push(crate::CompletionTable {
                    schema: schema.clone(),
                    name: table.name,
                    kind: table.kind,
                    columns: vec![],
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
