use crate::conn::{QueryResult, ResultColumn, Setup};
use crate::source::{DataSource, DbSslMode, DbTxMode};
use ide_core::{CancellationToken, IdeError, IdeResult, error::ErrorKind};
use parking_lot::RwLock;
use reqwest::{Client, RequestBuilder, StatusCode, Url};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct ClickhousePool(Arc<State>);

struct State {
    client: RwLock<Option<Client>>,
    endpoint: Url,
    user: String,
    password: String,
    database: String,
    settings: Vec<(String, String)>,
    read_only: bool,
    session_id: String,
    session: Mutex<bool>,
    closed: CancellationToken,
}

/// The response format: a names line, a types line, then one JSON array per row, so rows past
/// the grid's limit are skipped without being parsed.
const FORMAT: &str = "JSONCompactEachRowWithNamesAndTypes";

pub(crate) fn transaction_error() -> IdeError {
    IdeError::invalid("ClickHouse HTTP does not support SQL transactions; use auto-commit and run writes directly")
}

impl ClickhousePool {
    pub(crate) async fn connect(source: &DataSource, password: Option<&str>, setup: Setup) -> IdeResult<Self> {
        if source.options.transaction == DbTxMode::Manual {
            return Err(transaction_error());
        }
        for (name, _) in &setup.params {
            if reserved_setting(name) {
                return Err(IdeError::invalid(format!("ClickHouse HTTP manages the {name} setting")));
            }
        }
        let secure = matches!(source.ssl, DbSslMode::Require | DbSslMode::VerifyCa | DbSslMode::VerifyFull);
        let tls_files = [&source.ssl_ca_file, &source.ssl_cert_file, &source.ssl_key_file];
        if !secure && tls_files.iter().any(|p| !p.trim().is_empty()) {
            return Err(IdeError::invalid(
                "ClickHouse TLS certificate files require an SSL mode of Require, Verify CA, or Verify Full",
            ));
        }
        let host = source.host.trim();
        if host.is_empty() || host.contains(['/', '@', '?', '#']) {
            return Err(IdeError::invalid("ClickHouse host must contain only a hostname or IP address"));
        }
        let host = if host.contains(':') && !host.starts_with('[') { format!("[{host}]") } else { host.to_owned() };
        let scheme = if secure { "https" } else { "http" };
        let port = source.port.unwrap_or(if secure { 8443 } else { 8123 });
        let endpoint = Url::parse(&format!("{scheme}://{host}:{port}/"))
            .map_err(|_| IdeError::invalid("invalid ClickHouse HTTP host or port"))?;
        let timeout = setup.connect_timeout.unwrap_or(Duration::from_secs(30));
        let _ = rustls::crypto::ring::default_provider().install_default();
        let mut builder = Client::builder()
            .connect_timeout(timeout)
            .pool_max_idle_per_host(4)
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("OpenIDEA/", env!("CARGO_PKG_VERSION")));
        let ca = source.ssl_ca_file.trim();
        if !ca.is_empty() {
            let pem = read_pem(ca, "CA certificate")?;
            let certificates = reqwest::Certificate::from_pem_bundle(&pem)
                .map_err(|_| IdeError::invalid("invalid ClickHouse CA certificate PEM"))?;
            if certificates.is_empty() {
                return Err(IdeError::invalid("ClickHouse CA certificate PEM contains no certificates"));
            }
            builder = builder.tls_certs_only(certificates);
        }
        if source.ssl == DbSslMode::VerifyCa {
            if ca.is_empty() {
                return Err(IdeError::invalid("ClickHouse Verify CA requires a CA certificate file"));
            }
            builder = builder.tls_danger_accept_invalid_hostnames(true);
        }
        let cert = source.ssl_cert_file.trim();
        let key = source.ssl_key_file.trim();
        if cert.is_empty() != key.is_empty() {
            return Err(IdeError::invalid("ClickHouse client TLS requires both certificate and key files"));
        }
        if !cert.is_empty() {
            let mut pem = read_pem(cert, "client certificate")?;
            pem.push(b'\n');
            pem.extend(read_pem(key, "client key")?);
            let identity = reqwest::Identity::from_pem(&pem)
                .map_err(|_| IdeError::invalid("invalid ClickHouse client certificate or key PEM"))?;
            builder = builder.identity(identity);
        }
        let proxy = ide_core::proxy_settings::proxy();
        let client = ide_http::client::with_proxy(builder, &proxy).build().map_err(http_error)?;
        let database = if source.options.default_schema.trim().is_empty() {
            source.database.trim()
        } else {
            source.options.default_schema.trim()
        };
        let pool = Self(Arc::new(State {
            client: RwLock::new(Some(client)),
            endpoint,
            user: if source.user.is_empty() { "default".into() } else { source.user.clone() },
            password: password.unwrap_or_default().to_owned(),
            database: if database.is_empty() { "default".into() } else { database.into() },
            settings: setup.params,
            read_only: source.read_only,
            session_id: uuid::Uuid::new_v4().to_string(),
            session: Mutex::new(false),
            closed: CancellationToken::new(),
        }));
        let cancel = CancellationToken::new();
        let initialize = async {
            pool.execute("SELECT 1", 1, &cancel).await?;
            for sql in setup.statements {
                pool.execute(&sql, 0, &cancel).await?;
            }
            Ok(pool.clone())
        };
        tokio::pin!(initialize);
        tokio::select! {
            result = &mut initialize => {
                if result.is_err() {
                    pool.close();
                }
                result
            },
            () = tokio::time::sleep(timeout) => {
                cancel.cancel();
                let _ = initialize.await;
                pool.close();
                Err(IdeError::new(ErrorKind::TimedOut, "timed out connecting to ClickHouse HTTP"))
            }
        }
    }

    pub fn close(&self) {
        self.0.closed.cancel();
        self.0.client.write().take();
    }

    pub fn is_closed(&self) -> bool {
        self.0.closed.is_cancelled()
    }

    fn client(&self) -> IdeResult<Client> {
        self.0.client.read().clone().ok_or_else(|| IdeError::new(ErrorKind::Io, "ClickHouse connection is closed"))
    }

    fn request(&self, client: &Client, query_id: &str, max_rows: usize, initialized: bool) -> RequestBuilder {
        let mut request = client
            .post(self.0.endpoint.clone())
            .basic_auth(&self.0.user, Some(&self.0.password))
            .header(reqwest::header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .query(&self.0.settings)
            .query(&[
                ("session_id", self.0.session_id.clone()),
                ("session_timeout", "3600".into()),
                ("query_id", query_id.to_owned()),
                ("default_format", FORMAT.into()),
                ("output_format_json_quote_denormals", "1".into()),
                ("max_result_rows", max_rows.saturating_add(1).to_string()),
                ("result_overflow_mode", "break".into()),
            ]);
        if initialized {
            request = request.query(&[("session_check", "1")]);
        } else {
            request = request.query(&[("database", &self.0.database)]);
        }
        if self.0.read_only {
            request = request.query(&[("readonly", "1")]);
        }
        request
    }

    pub async fn execute(&self, sql: &str, max_rows: usize, cancel: &CancellationToken) -> IdeResult<QueryResult> {
        if transaction_statement(sql) {
            return Err(transaction_error());
        }
        let mut session = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(IdeError::cancelled()),
            () = self.0.closed.cancelled() => return Err(IdeError::new(ErrorKind::Io, "ClickHouse connection is closed")),
            session = self.0.session.lock() => session,
        };
        let client = self.client()?;
        let query_id = uuid::Uuid::new_v4().to_string();
        let request = self.request(&client, &query_id, max_rows, *session).body(sql.to_owned());
        let started = Instant::now();
        let fetch = async {
            let mut response = request.send().await.map_err(http_error)?;
            let execution_ms = started.elapsed().as_secs_f64() * 1000.0;
            let status = response.status();
            let header = |name: &str| response.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
            let exception_code = header("X-ClickHouse-Exception-Code");
            let format = header("X-ClickHouse-Format");
            let affected = header("X-ClickHouse-Summary")
                .and_then(|v| serde_json::from_str::<serde_json::Value>(&v).ok())
                .and_then(|v| {
                    v.get("written_rows")
                        .and_then(|n| n.as_str().and_then(|n| n.parse::<u64>().ok()).or_else(|| n.as_u64()))
                });
            if !status.is_success() || exception_code.as_deref().is_some_and(|code| code != "0") {
                let body = response.bytes().await.map_err(http_error)?;
                return Err(self.server_error(status, exception_code.as_deref(), &body));
            }
            let (columns, rows, has_more) = if format.as_deref().is_some_and(|f| f != FORMAT) {
                let body = response.bytes().await.map_err(http_error)?;
                if !body.iter().all(u8::is_ascii_whitespace) {
                    return Err(IdeError::invalid(
                        "ClickHouse result grids need the default output format; remove the query's FORMAT clause",
                    ));
                }
                (Vec::new(), Vec::new(), false)
            } else {
                let mut reader = RowReader::new(max_rows);
                while let Some(chunk) = response.chunk().await.map_err(http_error)? {
                    reader.push(&chunk)?;
                }
                reader.finish().map_err(|error| self.redact_error(error))?
            };
            let affected = if columns.is_empty() { affected.map(|n| n as f64) } else { None };
            Ok(QueryResult {
                statement: sql.to_owned(),
                columns,
                rows,
                affected,
                has_more,
                elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
                execution_ms,
            })
        };
        let result = tokio::select! {
            biased;
            () = cancel.cancelled() => None,
            () = self.0.closed.cancelled() => None,
            result = fetch => Some(result),
        };
        match result {
            Some(result) => {
                if result.is_ok() {
                    *session = true;
                }
                result
            }
            None => {
                let killed = self.kill(&client, &query_id).await;
                match killed {
                    Ok(()) => Err(IdeError::cancelled()),
                    Err(error) => Err(IdeError::new(
                        ErrorKind::Cancelled,
                        format!("cancelled locally; ClickHouse server cancellation failed: {}", error.message),
                    )),
                }
            }
        }
    }

    async fn kill(&self, client: &Client, query_id: &str) -> IdeResult<()> {
        let response = client
            .post(self.0.endpoint.clone())
            .basic_auth(&self.0.user, Some(&self.0.password))
            .timeout(Duration::from_secs(3))
            .body(format!("KILL QUERY WHERE query_id = '{query_id}' SYNC"))
            .send()
            .await
            .map_err(http_error)?;
        let status = response.status();
        let code = response
            .headers()
            .get("X-ClickHouse-Exception-Code")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let body = response.bytes().await.map_err(http_error)?;
        if status.is_success() && !code.as_deref().is_some_and(|code| code != "0") && !body.starts_with(b"Code:") {
            Ok(())
        } else {
            Err(self.server_error(status, code.as_deref(), &body))
        }
    }

    fn redact_error(&self, mut error: IdeError) -> IdeError {
        if !self.0.password.is_empty() {
            error.message = error.message.replace(&self.0.password, "[redacted]");
        }
        error
    }

    fn server_error(&self, status: StatusCode, code: Option<&str>, body: &[u8]) -> IdeError {
        let message = String::from_utf8_lossy(body);
        let message = message.trim();
        let message: String = message.chars().take(16_384).collect();
        let auth = matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN)
            || matches!(code, Some("193" | "194" | "195" | "516" | "497"));
        let detail = if message.is_empty() { status.canonical_reason().unwrap_or("request failed") } else { &message };
        let detail = if detail.contains("SESSION_NOT_FOUND") || detail.contains("Session not found") {
            "ClickHouse HTTP session expired; reconnect to restore session settings"
        } else {
            detail
        };
        self.redact_error(IdeError::new(
            if auth { ErrorKind::PermissionDenied } else { ErrorKind::InvalidInput },
            format!("ClickHouse HTTP {}: {detail}", status.as_u16()),
        ))
    }
}

type DecodedResult = (Vec<ResultColumn>, Vec<Vec<Option<String>>>, bool);

/// Decodes a streamed [`FORMAT`] body. Keeps the first `max_rows` rows; later rows only set
/// `has_more` and are read past unparsed, so a grid limit bounds memory however large the
/// block `result_overflow_mode=break` lets the server send. A line that is not a JSON array
/// starts the exception ClickHouse writes when a query fails mid-stream.
struct RowReader {
    max_rows: usize,
    pending: Vec<u8>,
    names: Option<Vec<String>>,
    types: Option<Vec<String>>,
    rows: Vec<Vec<Option<String>>>,
    more: bool,
    exception: Option<String>,
}

impl RowReader {
    fn new(max_rows: usize) -> Self {
        Self { max_rows, pending: Vec::new(), names: None, types: None, rows: Vec::new(), more: false, exception: None }
    }

    fn push(&mut self, chunk: &[u8]) -> IdeResult<()> {
        self.pending.extend_from_slice(chunk);
        let buffer = std::mem::take(&mut self.pending);
        let mut start = 0;
        while let Some(end) = buffer[start..].iter().position(|&b| b == b'\n') {
            self.line(&buffer[start..start + end])?;
            start += end + 1;
        }
        self.pending = buffer[start..].to_vec();
        Ok(())
    }

    fn line(&mut self, line: &[u8]) -> IdeResult<()> {
        if let Some(exception) = &mut self.exception {
            if exception.len() < 16_384 {
                exception.push_str(&String::from_utf8_lossy(line));
                exception.push('\n');
            }
            return Ok(());
        }
        let text = line.trim_ascii();
        if text.is_empty() {
            return Ok(());
        }
        if text[0] != b'[' {
            self.exception = Some(format!("{}\n", String::from_utf8_lossy(line)));
            return Ok(());
        }
        if self.names.is_some() && self.types.is_some() && self.rows.len() >= self.max_rows {
            self.more = true;
            return Ok(());
        }
        let Ok(values) = serde_json::from_slice::<Vec<Box<serde_json::value::RawValue>>>(text) else {
            self.exception = Some(format!("{}\n", String::from_utf8_lossy(line)));
            return Ok(());
        };
        let protocol = |message: String| IdeError::new(ErrorKind::Protocol, message);
        let header = |values: Vec<Box<serde_json::value::RawValue>>| {
            values
                .iter()
                .map(|v| serde_json::from_str::<String>(v.get()))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| protocol(format!("invalid ClickHouse result header: {e}")))
        };
        let Some(names) = &self.names else {
            self.names = Some(header(values)?);
            return Ok(());
        };
        if self.types.is_none() {
            self.types = Some(header(values)?);
            return Ok(());
        }
        if values.len() != names.len() {
            return Err(protocol("ClickHouse result row width does not match its metadata".into()));
        }
        let row = values
            .into_iter()
            .map(|value| {
                let text = value.get();
                if text == "null" {
                    Ok(None)
                } else if text.starts_with('"') {
                    serde_json::from_str::<String>(text).map(Some).map_err(|e| protocol(e.to_string()))
                } else {
                    Ok(Some(text.to_owned()))
                }
            })
            .collect::<IdeResult<_>>()?;
        self.rows.push(row);
        Ok(())
    }

    fn finish(mut self) -> IdeResult<DecodedResult> {
        let rest = std::mem::take(&mut self.pending);
        self.line(&rest)?;
        if let Some(exception) = self.exception {
            let detail = exception
                .find("Code:")
                .map_or(exception.trim(), |at| exception[at..].lines().next().unwrap_or_default().trim());
            return Err(IdeError::invalid(format!("ClickHouse: {detail}")));
        }
        let Some(names) = self.names else { return Ok((Vec::new(), Vec::new(), false)) };
        let types = self.types.unwrap_or_default();
        if types.len() != names.len() {
            return Err(IdeError::new(ErrorKind::Protocol, "ClickHouse result types do not match its columns"));
        }
        let columns = names.into_iter().zip(types).map(|(name, type_name)| ResultColumn { name, type_name }).collect();
        Ok((columns, self.rows, self.more))
    }
}

fn http_error(error: reqwest::Error) -> IdeError {
    use std::error::Error;
    let kind = if error.is_timeout() { ErrorKind::TimedOut } else { ErrorKind::Io };
    let error = error.without_url();
    let mut message = error.to_string();
    let mut source = error.source();
    while let Some(error) = source {
        let detail = error.to_string();
        if !message.contains(&detail) {
            message.push_str(": ");
            message.push_str(&detail);
        }
        source = error.source();
    }
    IdeError::new(kind, format!("ClickHouse HTTP: {message}"))
}

fn read_pem(path: &str, label: &str) -> IdeResult<Vec<u8>> {
    std::fs::read(ide_ssh::expand(path))
        .map_err(|error| IdeError::new(ErrorKind::Io, format!("cannot read ClickHouse {label}: {error}")))
}

fn reserved_setting(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.starts_with("output_format_json_")
        || matches!(
            name.as_str(),
            "user"
                | "password"
                | "query"
                | "database"
                | "session_id"
                | "session_check"
                | "session_timeout"
                | "query_id"
                | "default_format"
                | "max_result_rows"
                | "result_overflow_mode"
                | "readonly"
        )
}

fn transaction_statement(sql: &str) -> bool {
    let mut sql = sql.trim_start();
    loop {
        if let Some(rest) = sql.strip_prefix("--").or_else(|| sql.strip_prefix('#')) {
            sql = rest.split_once('\n').map_or("", |(_, rest)| rest).trim_start();
        } else if let Some(rest) = sql.strip_prefix("/*") {
            sql = rest.split_once("*/").map_or("", |(_, rest)| rest).trim_start();
        } else {
            break;
        }
    }
    let mut words = sql.split(|c: char| !c.is_ascii_alphanumeric() && c != '_').filter(|s| !s.is_empty());
    let first = words.next().unwrap_or_default();
    ["BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE"].iter().any(|s| first.eq_ignore_ascii_case(s))
        || (first.eq_ignore_ascii_case("START") && words.next().is_some_and(|s| s.eq_ignore_ascii_case("TRANSACTION")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conn::Pool;
    use crate::source::{DbDriver, DbOptions, DbProperty};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const ONE: &str = "[\"1\"]\n[\"UInt8\"]\n[1]\n";

    async fn read_request(stream: &mut tokio::net::TcpStream) -> String {
        let mut bytes = Vec::new();
        let mut buffer = [0; 4096];
        loop {
            let count = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buffer)).await.unwrap().unwrap();
            assert!(count > 0, "request ended early");
            bytes.extend_from_slice(&buffer[..count]);
            if let Some(end) = bytes.windows(4).position(|s| s == b"\r\n\r\n") {
                let header = String::from_utf8_lossy(&bytes[..end]);
                let length: usize = header
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap())
                    })
                    .unwrap_or(0);
                if bytes.len() >= end + 4 + length {
                    return String::from_utf8(bytes).unwrap();
                }
            }
        }
    }

    async fn reply(stream: &mut tokio::net::TcpStream, status: &str, headers: &str, body: &str) {
        let response =
            format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}", body.len());
        stream.write_all(response.as_bytes()).await.unwrap();
    }

    async fn server(
        responses: Vec<(&'static str, &'static str, &'static str)>,
    ) -> (u16, tokio::task::JoinHandle<Vec<String>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let mut requests = Vec::new();
            for (status, headers, body) in responses {
                let (mut stream, _) =
                    tokio::time::timeout(Duration::from_secs(5), listener.accept()).await.unwrap().unwrap();
                requests.push(read_request(&mut stream).await);
                reply(&mut stream, status, headers, body).await;
            }
            requests
        });
        (port, task)
    }

    fn source(port: u16) -> DataSource {
        DataSource { driver: DbDriver::Clickhouse, host: "127.0.0.1".into(), port: Some(port), ..Default::default() }
    }

    fn decode(body: &[u8], max_rows: usize, chunk: usize) -> IdeResult<DecodedResult> {
        let mut reader = RowReader::new(max_rows);
        for part in body.chunks(chunk) {
            reader.push(part)?;
        }
        reader.finish()
    }

    #[test]
    fn rows_preserve_precision_nulls_and_strings_across_chunks() {
        let body = concat!(
            r#"["n", "d", "v", "v", "v"]"#,
            "\n",
            r#"["UInt64", "Decimal(38, 9)", "Nullable(String)", "Nullable(String)", "Nullable(String)"]"#,
            "\n",
            r#"[18446744073709551615, 12345678901234567890.123456789, null, "null", "ᴺᵁᴸᴸ"]"#,
        );
        for chunk in [1, 7, body.len()] {
            let (columns, rows, more) = decode(body.as_bytes(), 1, chunk).unwrap();
            assert_eq!(columns.len(), 5);
            assert_eq!(columns[1].type_name, "Decimal(38, 9)");
            assert_eq!(
                rows[0],
                vec![
                    Some("18446744073709551615".into()),
                    Some("12345678901234567890.123456789".into()),
                    None,
                    Some("null".into()),
                    Some("ᴺᵁᴸᴸ".into()),
                ]
            );
            assert!(!more);
        }
        let (columns, rows, more) = decode(b"[\"x\"]\n[\"String\"]\n", 0, 64).unwrap();
        assert_eq!(columns[0].name, "x");
        assert!(rows.is_empty() && !more);
        assert_eq!(decode(b"", 5, 64).unwrap().0.len(), 0);
        assert!(decode(b"[\"x\"]\n[\"UInt8\"]\n[1, 2]\n", 1, 64).is_err());
    }

    #[test]
    fn rows_past_the_limit_are_skipped_but_a_later_exception_still_fails() {
        let mut body = String::from("[\"n\"]\n[\"UInt64\"]\n");
        for n in 0..1000 {
            body.push_str(&format!("[{n}]\n"));
        }
        let (_, rows, more) = decode(body.as_bytes(), 2, 4096).unwrap();
        assert_eq!(rows, vec![vec![Some("0".into())], vec![Some("1".into())]]);
        assert!(more);
        body.push_str("\n__exception__\nabcdefgh\nCode: 395. DB::Exception: Value passed to 'throwIf' is non-zero\n");
        body.push_str("62 abcdefgh\n__exception__\n");
        let error = decode(body.as_bytes(), 2, 4096).unwrap_err();
        assert_eq!(error.message, "ClickHouse: Code: 395. DB::Exception: Value passed to 'throwIf' is non-zero");
    }

    #[tokio::test]
    async fn http_requests_use_auth_settings_limits_and_a_shared_session() {
        let (port, requests) = server(vec![
            ("200 OK", "X-ClickHouse-Format: JSONCompactEachRowWithNamesAndTypes\r\n", ONE),
            ("200 OK", "", ""),
            (
                "200 OK",
                "X-ClickHouse-Format: JSONCompactEachRowWithNamesAndTypes\r\n",
                "[\"n\"]\n[\"UInt64\"]\n[\"1\"]\n[\"2\"]\n[\"3\"]\n",
            ),
        ])
        .await;
        let source = DataSource {
            user: "reader".into(),
            read_only: true,
            options: DbOptions { default_schema: "analytics".into(), time_zone: "UTC".into(), ..Default::default() },
            properties: vec![DbProperty { name: "max_threads".into(), value: "2".into() }],
            ..source(port)
        };
        let pool = Pool::connect(&source, Some("mock-password"), None).await.unwrap();
        pool.execute("USE other", 0, &CancellationToken::new()).await.unwrap();
        let result = pool.execute("SELECT number FROM numbers(3)", 1, &CancellationToken::new()).await.unwrap();
        assert_eq!(result.rows, vec![vec![Some("1".into())]]);
        assert!(result.has_more && result.affected.is_none());
        let requests = requests.await.unwrap();
        let target = |request: &String| {
            Url::parse(&format!(
                "http://localhost{}",
                request.lines().next().unwrap().split_whitespace().nth(1).unwrap()
            ))
            .unwrap()
        };
        let urls: Vec<_> = requests.iter().map(target).collect();
        let value = |url: &Url, key: &str| url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned());
        assert_eq!(value(&urls[0], "database").as_deref(), Some("analytics"));
        assert_eq!(value(&urls[1], "database"), None);
        assert_eq!(value(&urls[1], "session_check").as_deref(), Some("1"));
        assert_eq!(value(&urls[0], "session_id"), value(&urls[2], "session_id"));
        assert_ne!(value(&urls[0], "query_id"), value(&urls[2], "query_id"));
        assert_eq!(value(&urls[2], "max_result_rows").as_deref(), Some("2"));
        for (request, url) in requests.iter().zip(&urls) {
            assert!(request.starts_with("POST /?"));
            assert!(request.contains("Basic cmVhZGVyOm1vY2stcGFzc3dvcmQ="));
            assert!(!url.as_str().contains("reader") && !url.as_str().contains("mock-password"));
            assert_eq!(value(url, "readonly").as_deref(), Some("1"));
            assert_eq!(value(url, "session_timezone").as_deref(), Some("UTC"));
            assert_eq!(value(url, "max_threads").as_deref(), Some("2"));
        }
        assert!(requests[0].ends_with("SELECT 1"));
        assert!(pool.transaction(&[]).await.is_err());
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert_eq!(pool.execute("SELECT 1", 1, &cancel).await.unwrap_err().kind, ErrorKind::Cancelled);
        pool.close().await;
        assert!(pool.is_closed());
        assert!(pool.execute("SELECT 1", 1, &CancellationToken::new()).await.is_err());
    }

    #[tokio::test]
    async fn sequential_queries_reuse_the_http_connection() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            for _ in 0..2 {
                read_request(&mut stream).await;
                let response = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{ONE}", ONE.len());
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let pool = Pool::connect(&source(port), None, None).await.unwrap();
        assert_eq!(
            pool.execute("SELECT 1", 1, &CancellationToken::new()).await.unwrap().rows,
            vec![vec![Some("1".into())]]
        );
        task.await.unwrap();
    }

    #[tokio::test]
    async fn server_errors_keep_details_and_hide_passwords() {
        let (port, requests) = server(vec![(
            "403 Forbidden",
            "X-ClickHouse-Exception-Code: 516\r\n",
            "Code: 516. DB::Exception: bad mock-password",
        )])
        .await;
        let error = match Pool::connect(&source(port), Some("mock-password"), None).await {
            Ok(_) => panic!("expected login failure"),
            Err(error) => error,
        };
        assert_eq!(error.kind, ErrorKind::PermissionDenied);
        assert!(error.message.contains("516") && error.message.contains("[redacted]"));
        assert!(!error.message.contains("mock-password"));
        requests.await.unwrap();
        let (port, requests) = server(vec![("200 OK", "", "Code: 241. DB::Exception: memory limit")]).await;
        let error = match Pool::connect(&source(port), None, None).await {
            Ok(_) => panic!("expected late query failure"),
            Err(error) => error,
        };
        assert!(error.message.contains("memory limit"));
        requests.await.unwrap();
    }

    #[tokio::test]
    async fn cancellation_sends_kill_outside_the_busy_session() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (started, received) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut health, _) = listener.accept().await.unwrap();
            read_request(&mut health).await;
            reply(&mut health, "200 OK", "", ONE).await;
            drop(health);
            let (mut query, _) = listener.accept().await.unwrap();
            let request = read_request(&mut query).await;
            started.send(()).unwrap();
            let (mut kill, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept()).await.unwrap().unwrap();
            let kill_request = read_request(&mut kill).await;
            reply(&mut kill, "200 OK", "", "").await;
            (request, kill_request)
        });
        let pool = Pool::connect(&source(port), None, None).await.unwrap();
        let cancel = CancellationToken::new();
        let query = pool.execute("SELECT sleep(30)", 1, &cancel);
        let cancelled = async {
            received.await.unwrap();
            cancel.cancel();
        };
        let (result, ()) = tokio::join!(query, cancelled);
        assert_eq!(result.unwrap_err().kind, ErrorKind::Cancelled);
        let (query, kill) = server.await.unwrap();
        let target = query.lines().next().unwrap().split_whitespace().nth(1).unwrap();
        let url = Url::parse(&format!("http://localhost{target}")).unwrap();
        let query_id = url.query_pairs().find(|(k, _)| k == "query_id").unwrap().1.into_owned();
        assert!(kill.ends_with(&format!("KILL QUERY WHERE query_id = '{query_id}' SYNC")));
        assert!(!kill.contains("session_id="));
    }

    #[tokio::test]
    async fn unsupported_settings_and_transactions_fail_before_connecting() {
        for statement in ["BEGIN", "-- comment\n COMMIT", "/* comment */ ROLLBACK", "START TRANSACTION", "SAVEPOINT s"]
        {
            assert!(transaction_statement(statement));
        }
        assert!(!transaction_statement("SELECT 'BEGIN'"));
        let sources = [
            DataSource { options: DbOptions { transaction: DbTxMode::Manual, ..Default::default() }, ..source(1) },
            DataSource {
                properties: vec![DbProperty { name: "statement_cache_capacity".into(), value: "4".into() }],
                ..source(1)
            },
            DataSource { properties: vec![DbProperty { name: "password".into(), value: "x".into() }], ..source(1) },
            DataSource { ssl_ca_file: "unused.pem".into(), ..source(1) },
            DataSource { ssl: DbSslMode::VerifyCa, ..source(1) },
            DataSource { ssl: DbSslMode::Require, ssl_cert_file: "unused.pem".into(), ..source(1) },
        ];
        for source in sources {
            let error = match Pool::connect(&source, None, None).await {
                Ok(_) => panic!("unsupported settings were accepted"),
                Err(error) => error,
            };
            assert_eq!(error.kind, ErrorKind::InvalidInput);
        }
    }

    #[tokio::test]
    #[ignore = "requires CLICKHOUSE_TEST_HOST, CLICKHOUSE_TEST_USER, and CLICKHOUSE_TEST_PASSWORD"]
    async fn clickhouse_cloud_transport() {
        let source = DataSource {
            driver: DbDriver::Clickhouse,
            host: std::env::var("CLICKHOUSE_TEST_HOST").expect("CLICKHOUSE_TEST_HOST"),
            port: Some(std::env::var("CLICKHOUSE_TEST_PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(8443)),
            user: std::env::var("CLICKHOUSE_TEST_USER").expect("CLICKHOUSE_TEST_USER"),
            ssl: DbSslMode::Require,
            options: DbOptions {
                time_zone: "UTC".into(),
                startup_script: "SET max_threads = 2".into(),
                ..Default::default()
            },
            properties: vec![DbProperty { name: "max_block_size".into(), value: "50".into() }],
            ..Default::default()
        };
        let password = std::env::var("CLICKHOUSE_TEST_PASSWORD").expect("CLICKHOUSE_TEST_PASSWORD");
        let pool = Pool::connect(&source, Some(&password), None).await.unwrap();
        let cancel = CancellationToken::new();
        let settings = pool
            .execute("SELECT getSetting('max_threads'), getSetting('max_block_size'), timezone()", 1, &cancel)
            .await
            .unwrap();
        assert_eq!(settings.rows, vec![vec![Some("2".into()), Some("50".into()), Some("UTC".into())]]);
        let result = pool.execute("SELECT toUInt64('18446744073709551615') AS n, CAST(NULL AS Nullable(String)) AS missing, CAST('ᴺᵁᴸᴸ' AS Nullable(String)) AS text, 'a\\nb' AS lines", 1, &cancel).await.unwrap();
        assert_eq!(
            result.rows,
            vec![vec![Some("18446744073709551615".into()), None, Some("ᴺᵁᴸᴸ".into()), Some("a\nb".into())]]
        );
        assert_eq!(result.columns[1].type_name, "Nullable(String)");
        let limited = pool.execute("SELECT number FROM numbers(100)", 2, &cancel).await.unwrap();
        assert_eq!(limited.rows.len(), 2);
        assert!(limited.has_more);
        let marker = format!("transport_cancel_{}", uuid::Uuid::new_v4().simple());
        let sql = format!("SELECT sleepEachRow(0.05) FROM numbers(50) /* {marker} */");
        let stop = CancellationToken::new();
        let query = pool.execute(&sql, 1, &stop);
        let cancel_query = async {
            tokio::time::sleep(Duration::from_millis(500)).await;
            stop.cancel();
        };
        let (cancelled, ()) = tokio::join!(query, cancel_query);
        let cancelled = cancelled.unwrap_err();
        assert_eq!(cancelled.kind, ErrorKind::Cancelled);
        assert_eq!(cancelled.message, "cancelled");
        let active = pool.execute(&format!("SELECT count() FROM system.processes WHERE position(query, '{marker}') > 0 AND query_id != currentQueryID()"), 1, &cancel).await.unwrap();
        assert_eq!(active.rows, vec![vec![Some("0".into())]]);
        let table = format!("transport_test_{}", uuid::Uuid::new_v4().simple());
        pool.execute(&format!("CREATE TEMPORARY TABLE {table} (n UInt8)"), 0, &cancel).await.unwrap();
        let continuity = async {
            pool.execute(&format!("INSERT INTO {table} VALUES (7)"), 0, &cancel).await?;
            pool.execute(&format!("SELECT n FROM {table}"), 1, &cancel).await
        }
        .await;
        let cleanup = pool.execute(&format!("DROP TEMPORARY TABLE {table}"), 0, &cancel).await;
        assert_eq!(continuity.unwrap().rows, vec![vec![Some("7".into())]]);
        cleanup.unwrap();
        pool.close().await;
        assert!(pool.is_closed());
    }
}
