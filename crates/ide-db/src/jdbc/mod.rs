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
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;
use tokio::time::{Instant as Deadline, timeout_at};

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
        JdbcPool::connect(source, password, driver, self.jdbc_registry()?.with_file_name("jdbc"))
            .await
            .map(Box::new)
            .map(crate::Pool::Jdbc)
    }
}

struct Bridge {
    stop: tokio::sync::oneshot::Sender<()>,
    exited: tokio::task::JoinHandle<()>,
    sequence: u64,
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
    fn start(cache: &Path, jars: &[String]) -> IdeResult<Self> {
        let jdks = ide_sdk::java::installed_jdks();
        let java = ide_sdk::java::java_runtime(&jdks, 17)
            .ok_or_else(|| IdeError::invalid("Install a Java 17 or newer runtime to use custom JDBC drivers"))?;
        let jar = ide_sdk::java::jdbc_bridge_jar(cache)
            .ok_or_else(|| IdeError::invalid("Cannot install the JDBC bridge in the application data directory"))?;
        let classpath = std::env::join_paths(std::iter::once(jar.as_path()).chain(jars.iter().map(Path::new)))
            .map_err(|_| IdeError::invalid("A JDBC JAR path contains the system classpath separator"))?;
        // Embedded databases can resolve file URLs against the JVM's working directory.
        let files = cache.join("files");
        std::fs::create_dir_all(&files)?;
        let mut command = Command::new(ide_sdk::java::java_executable(&java.home));
        command.current_dir(files);
        ide_core::process::prepare(command.as_std_mut());
        let mut child = command
            .args(["-Xms8m", "-Xmx192m", "--enable-native-access=ALL-UNNAMED", "-cp"])
            .arg(classpath)
            .arg("ai.openidea.jdbc.OpenIdeaJdbc")
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
                stop = stopped => {
                    // Disconnect closes stdin so a file-backed driver can flush. A dropped
                    // request or an unresponsive driver must be reaped without waiting.
                    if stop.is_err() || tokio::time::timeout(Duration::from_secs(2), child.wait()).await.is_err() {
                        let _ = child.kill().await;
                    }
                }
                _ = child.wait() => {}
            }
        });
        Ok(Self { input, output, stop, exited, sequence: 0 })
    }

    async fn close(self) {
        drop(self.input);
        let _ = self.stop.send(());
        let _ = self.exited.await;
    }
}

// Request: u64 request id, u32 field count, then length-prefixed UTF-8 fields.
// Zero fields cancels that id. Replies have a u32 length; zero acknowledges Cancel.
fn encode(id: u64, fields: &[&str]) -> IdeResult<Vec<u8>> {
    if fields.is_empty() || fields.len() > 8192 {
        return Err(IdeError::invalid("Invalid JDBC field count"));
    }
    let size = fields
        .iter()
        .try_fold(12usize, |n, s| n.checked_add(4)?.checked_add(s.len()).filter(|n| *n <= LIMIT))
        .ok_or_else(|| IdeError::invalid("JDBC request exceeds 16 MiB"))?;
    let mut data = Vec::with_capacity(size);
    data.extend_from_slice(&id.to_be_bytes());
    data.extend_from_slice(&(fields.len() as u32).to_be_bytes());
    for field in fields {
        data.extend_from_slice(&(field.len() as u32).to_be_bytes());
        data.extend_from_slice(field.as_bytes());
    }
    Ok(data)
}

async fn read_frame(output: &mut (impl AsyncRead + Unpin)) -> IdeResult<Vec<u8>> {
    let n = output.read_u32().await? as usize;
    if n > LIMIT {
        return Err(IdeError::invalid("JDBC response exceeds 16 MiB"));
    }
    let mut data = vec![0; n];
    output.read_exact(&mut data).await?;
    Ok(data)
}

const CANCEL_GRACE: Duration = Duration::from_secs(3);

fn cancel_timeout() -> IdeError {
    IdeError::invalid("The JDBC driver did not stop in time. The session was closed. Reconnect to continue.")
}

async fn exchange(
    input: &mut (impl AsyncWrite + Unpin),
    output: &mut (impl AsyncRead + Unpin),
    frame: Vec<u8>,
    cancel: &CancellationToken,
) -> IdeResult<Option<Vec<u8>>> {
    let mut stop = [0; 12];
    stop[..8].copy_from_slice(&frame[..8]);
    let early_deadline = {
        let send = input.write_all(&frame);
        tokio::pin!(send);
        tokio::select! {
            result = &mut send => { result?; None },
            () = cancel.cancelled() => {
                let end = Deadline::now() + CANCEL_GRACE;
                timeout_at(end, send).await.map_err(|_| cancel_timeout())??;
                Some(end)
            }
        }
    };
    drop(frame);
    let (first, deadline) = {
        let reply = read_frame(output);
        tokio::pin!(reply);
        let end = tokio::select! {
            biased;
            () = cancel.cancelled() => early_deadline.unwrap_or_else(|| Deadline::now() + CANCEL_GRACE),
            data = &mut reply => {
                let data = data?;
                if data.is_empty() { return Err(IdeError::invalid("Unexpected JDBC cancellation acknowledgement")); }
                return Ok(Some(data));
            }
        };
        let first = timeout_at(end, async {
            input.write_all(&stop).await?;
            reply.await
        })
        .await
        .map_err(|_| cancel_timeout())??;
        (first, end)
    };
    // Drain both frames before the next statement can use this session. The driver
    // may complete the statement before or after the control thread acknowledges it.
    let data = if first.is_empty() {
        timeout_at(deadline, read_frame(output)).await.map_err(|_| cancel_timeout())??
    } else {
        if timeout_at(deadline, output.read_u32()).await.map_err(|_| cancel_timeout())?? != 0 {
            return Err(IdeError::invalid("Invalid JDBC cancellation acknowledgement"));
        }
        first
    };
    match data.first() {
        // A committed statement may have finished before the control thread received Cancel.
        Some(1) => Ok(Some(data)),
        Some(0) => Ok(None),
        _ => Err(IdeError::invalid("Invalid JDBC cancellation response")),
    }
}

impl JdbcPool {
    async fn connect(
        source: &DataSource,
        password: Option<&str>,
        driver: DbJdbcDriver,
        cache: PathBuf,
    ) -> IdeResult<Self> {
        driver.validate()?;
        let mut fields = vec![
            "open".to_string(),
            driver.class_name,
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
        let bridge = tokio::task::spawn_blocking(move || Bridge::start(&cache, &driver.jars))
            .await
            .map_err(|e| IdeError::internal(e.to_string()))??;
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
        let bridge = slot
            .as_mut()
            .ok_or_else(|| IdeError::invalid("JDBC connection is closed; reconnect to start a new session"))?;
        bridge.sequence = bridge.sequence.wrapping_add(1);
        let frame = encode(bridge.sequence, fields)?;
        let mut bridge = slot.take().expect("checked above");
        // Dropping an in-flight request must discard its process and partially consumed frame.
        let interrupted = self.closed.clone().drop_guard();
        let start = Instant::now();
        let response = tokio::select! {
            biased;
            () = self.closed.cancelled() => Err(IdeError::cancelled()),
            response = exchange(&mut bridge.input, &mut bridge.output, frame, cancel) => response,
        };
        let data = match response {
            Ok(data) => {
                *slot = Some(bridge);
                interrupted.disarm();
                data
            }
            Err(e) => {
                drop(bridge.stop);
                let _ = bridge.exited.await;
                return Err(e);
            }
        };
        decode(&data.ok_or_else(IdeError::cancelled)?, sql, start.elapsed().as_secs_f64() * 1000.0)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frame_codec_checks_both_16_mib_boundaries() {
        assert_eq!(encode(7, &["a"]).unwrap(), [0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 1, 0, 0, 0, 1, b'a']);
        let mut field = "x".repeat(LIMIT - 16);
        assert_eq!(encode(1, &[&field]).unwrap().len(), LIMIT);
        field.push('x');
        assert!(encode(1, &[&field]).is_err());
        let mut framed = vec![0u8; LIMIT + 4];
        framed[..4].copy_from_slice(&(LIMIT as u32).to_be_bytes());
        assert_eq!(read_frame(&mut framed.as_slice()).await.unwrap().len(), LIMIT);
        assert!(read_frame(&mut &((LIMIT + 1) as u32).to_be_bytes()[..]).await.is_err());
        assert!(read_frame(&mut &[0, 0, 0, 2, 1u8][..]).await.is_err());
    }

    #[tokio::test]
    async fn cancel_drains_partial_replies_in_either_order() {
        for ack_first in [true, false] {
            let (mut input, mut peer_input) = tokio::io::duplex(1);
            let (mut output, mut peer_output) = tokio::io::duplex(1);
            let cancel = CancellationToken::new();
            let frame = encode(42, &["query"]).unwrap();
            let peer = async {
                let mut request = vec![0; frame.len()];
                peer_input.read_exact(&mut request).await.unwrap();
                assert_eq!(request, frame);
                // The one-byte pipe forces the reader to consume part of the header before Cancel.
                peer_output.write_all(&[0, 0]).await.unwrap();
                cancel.cancel();
                let mut stop = [0; 12];
                peer_input.read_exact(&mut stop).await.unwrap();
                assert_eq!(&stop[..8], &42u64.to_be_bytes());
                assert_eq!(&stop[8..], &[0; 4]);
                let frames = if ack_first { [0, 0, 0, 0, 0, 1, 0] } else { [0, 1, 1, 0, 0, 0, 0] };
                peer_output.write_all(&frames).await.unwrap();
            };
            let (result, ()) = tokio::join!(exchange(&mut input, &mut output, frame.clone(), &cancel), peer);
            assert_eq!(result.unwrap(), (!ack_first).then(|| vec![1]));
        }
    }

    #[tokio::test]
    async fn exchange_rejects_unexpected_acknowledgements() {
        let cancel = CancellationToken::new();
        let mut sink = tokio::io::sink();
        let mut reply = &[0, 0, 0, 1, 1u8][..];
        assert_eq!(
            exchange(&mut sink, &mut reply, encode(1, &["query"]).unwrap(), &cancel).await.unwrap(),
            Some(vec![1])
        );
        for cancelled in [false, true] {
            if cancelled {
                cancel.cancel();
            }
            let mut duplicate_ack = &[0u8; 8][..];
            assert!(exchange(&mut sink, &mut duplicate_ack, encode(1, &["query"]).unwrap(), &cancel).await.is_err());
        }
        let (mut peer, mut output) = tokio::io::duplex(4);
        peer.write_u32(0).await.unwrap();
        let error = exchange(&mut sink, &mut output, encode(1, &["query"]).unwrap(), &cancel).await.unwrap_err();
        assert_eq!(error.message, cancel_timeout().message);
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
