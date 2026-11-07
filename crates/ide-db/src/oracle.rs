//! Oracle connections through the synchronous `rust-oracle` driver (ODPI-C).
//! The Oracle client library (Instant Client) is loaded once per process from
//! the Options tab or `ORACLE_HOME`; every blocking call runs on the blocking
//! pool, and cancelling a statement closes its connection.

use crate::conn::{Cells, Fetched, ResultColumn, Setup, hex};
use crate::source::{DataSource, DbDriver, DbTxMode};
use bb8::ManageConnection;
use ide_core::{CancellationToken, IdeError, IdeResult, error::ErrorKind};
use oracle::sql_type::{Blob, Clob, OracleType};
use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

/// Characters of a LOB column shown in the grid; catalog text reads more.
const MAX_GRID_LOB: u64 = 4096;
const MAX_TEXT_LOB: u64 = 1 << 16;

/// Everything a new connection needs, built once per pool.
#[derive(Debug)]
struct State {
    user: String,
    password: String,
    /// EZConnect `//host:port/service`, a TNS descriptor or an alias.
    connect: String,
    init: Vec<String>,
    auto_commit: bool,
    read_only: bool,
    statement_cache: Option<u32>,
    timeout: Duration,
}

impl State {
    fn of(source: &DataSource, password: Option<&str>, setup: &Setup) -> IdeResult<Self> {
        let user = source.user.trim();
        if user.is_empty() {
            return Err(IdeError::invalid("Oracle data sources need a user name"));
        }
        Ok(Self {
            user: user.to_owned(),
            password: password.unwrap_or_default().to_owned(),
            connect: connect_string(source),
            init: setup.statements.clone(),
            auto_commit: source.options.transaction != DbTxMode::Manual,
            read_only: source.read_only,
            statement_cache: setup.statement_cache.map(|n| n as u32),
            timeout: setup.connect_timeout.unwrap_or(Duration::from_secs(30)),
        })
    }
}

/// `//host:port/service`; the database field may also hold a TNS descriptor or alias.
fn connect_string(source: &DataSource) -> String {
    let db = source.database.trim();
    if db.starts_with('(') || db.contains('=') {
        return db.to_owned();
    }
    let host = if source.host.trim().is_empty() { "localhost" } else { source.host.trim() };
    let port = source.port.unwrap_or(1521);
    if db.is_empty() { format!("//{host}:{port}") } else { format!("//{host}:{port}/{db}") }
}

/// The expanded Instant Client directory, `None` when the search path is used.
fn client_dir(dir: &str) -> IdeResult<Option<String>> {
    let dir = dir.trim();
    if dir.is_empty() {
        return Ok(None);
    }
    let expanded: PathBuf = ide_ssh::expand(dir);
    if !expanded.is_dir() {
        return Err(IdeError::invalid(format!("Oracle Instant Client directory not found: {}", expanded.display())));
    }
    Ok(Some(expanded.to_string_lossy().into_owned()))
}

/// Loads the Oracle client once per process; the first data source's directory wins.
/// Failures are not cached: a corrected directory works without restarting.
fn init_client(dir: &str) -> IdeResult<()> {
    static LOADED: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
    let dir = dir.trim();
    let mut loaded = LOADED.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(used) = loaded.as_deref() {
        if !dir.is_empty() && !used.is_empty() && used != dir {
            tracing::warn!("Oracle client already loaded from {used}; ignoring {dir}");
        }
        return Ok(());
    }
    let mut params = oracle::InitParams::new();
    if let Some(lib_dir) = client_dir(dir)? {
        params
            .oracle_client_lib_dir(lib_dir)
            .map_err(|e| IdeError::invalid(format!("Oracle Instant Client directory: {e}")))?;
    }
    params.init().map_err(|e| {
        let hint = if e.to_string().contains("DPI-1047") {
            format!("{e} — set the Instant Client directory (Options tab) or ORACLE_HOME")
        } else {
            e.to_string()
        };
        IdeError::new(ErrorKind::Io, format!("Oracle client: {hint}"))
    })?;
    *loaded = Some(dir.to_owned());
    Ok(())
}

/// `rust-oracle` errors are not `Sync`; the pool wants a shareable error.
#[derive(Debug, Clone)]
pub struct OracleError(Arc<oracle::Error>);

impl OracleError {
    fn new(e: oracle::Error) -> Self {
        Self(Arc::new(e))
    }

    fn message(msg: impl Into<String>) -> Self {
        Self::new(oracle::Error::new(oracle::ErrorKind::InvalidArgument, msg.into()))
    }

    fn into_ide(self) -> IdeError {
        oracle_err(clone_db(&self.0))
    }
}

/// Database errors (the interesting ones) rebuild cheaply for cloning.
fn clone_db(e: &oracle::Error) -> oracle::Error {
    match e.db_error() {
        Some(db) => oracle::Error::new(oracle::ErrorKind::OciError, db.message().to_owned()),
        None => message_error(&e.to_string()),
    }
}

fn message_error(msg: &str) -> oracle::Error {
    oracle::Error::new(oracle::ErrorKind::InvalidArgument, msg.to_owned())
}

/// Wrong or missing password: ORA-01017 / ORA-01005; unreachable server: ORA-12xxx / ORA-31xx.
pub(crate) fn oracle_err(e: oracle::Error) -> IdeError {
    let Some(db) = e.db_error() else {
        return IdeError::new(ErrorKind::InvalidInput, e.to_string());
    };
    let msg = db.message().to_owned();
    if msg.contains("DPI-1047") {
        return IdeError::new(
            ErrorKind::Io,
            format!("{msg} — set the Instant Client directory (Options tab) or ORACLE_HOME"),
        );
    }
    let code = db.code();
    let full = format!("[ORA-{code:05}] {msg}");
    match code {
        1005 | 1017 | 28000 | 28001 => IdeError::new(ErrorKind::PermissionDenied, full),
        12150..=12199 | 12537 | 12540 | 12541 | 12543 | 12545 | 3113 | 3114 => IdeError::new(ErrorKind::Io, full),
        _ => IdeError::new(ErrorKind::InvalidInput, full),
    }
}

#[derive(Debug)]
pub struct OraclePool {
    state: Arc<State>,
    pool: Arc<bb8::Pool<OracleConnectionManager>>,
}

impl OraclePool {
    pub(crate) async fn connect(source: &DataSource, password: Option<&str>, setup: &Setup) -> IdeResult<Self> {
        init_client(&source.options.instant_client)?;
        let state = Arc::new(State::of(source, password, setup)?);
        let pool = bb8::Pool::builder()
            .max_size(4)
            .connection_timeout(state.timeout)
            .build(OracleConnectionManager(state.clone()))
            .await
            .map_err(|e| e.into_ide())?;
        // bb8 connects lazily and reports failed attempts as a bare timeout, which
        // would turn a wrong password into "timed out connecting to the database".
        let opened = tokio::task::spawn_blocking({
            let state = state.clone();
            move || open(&state)
        })
        .await
        .map_err(|e| IdeError::internal(format!("Oracle connect task: {e}")))?
        .map_err(oracle_err)?;
        let _ = pool.add(opened);
        Ok(Self { state, pool: Arc::new(pool) })
    }

    /// A connection taken out of the pool for one statement or a held session.
    pub async fn get(&self) -> IdeResult<OracleConnection> {
        let pooled = self.pool.get_owned().await.map_err(|e| pool_err(e).into_ide())?;
        Ok(OracleConnection { state: self.state.clone(), pooled })
    }

    pub fn is_closed(&self) -> bool {
        let state = self.pool.state();
        state.connections == 0 && state.idle_connections == 0
    }
}

fn pool_err(e: bb8::RunError<OracleError>) -> OracleError {
    match e {
        bb8::RunError::User(e) => e,
        bb8::RunError::TimedOut => OracleError::message("timed out connecting to the database"),
    }
}

/// A pooled connection's payload; `conn` is `None` once the connection is
/// discarded (a cancelled statement leaves it in the blocking task).
pub struct OracleHandle {
    conn: Option<oracle::Connection>,
    context: crate::conn::Context,
}

pub struct OracleConnectionManager(Arc<State>);

impl ManageConnection for OracleConnectionManager {
    type Connection = OracleHandle;
    type Error = OracleError;

    async fn connect(&self) -> Result<Self::Connection, Self::Error> {
        let state = self.0.clone();
        let opened = tokio::task::spawn_blocking(move || open(&state))
            .await
            .map_err(|e| OracleError::message(format!("Oracle connect task: {e}")))?;
        let conn = opened.map_err(OracleError::new)?;
        Ok(conn)
    }

    async fn is_valid(&self, conn: &mut Self::Connection) -> Result<(), Self::Error> {
        let state = self.0.clone();
        let Some(raw) = conn.conn.take() else {
            return Err(OracleError::message("Oracle connection is closed"));
        };
        let ping = tokio::time::timeout(
            state.timeout,
            tokio::task::spawn_blocking(move || {
                let result = (|| -> oracle::Result<()> {
                    // `execute` rejects selects, so read one row.
                    let mut stmt = raw.statement("SELECT 1 FROM DUAL").build()?;
                    let mut rows = stmt.query(&[])?;
                    if let Some(row) = rows.next() {
                        row?;
                    }
                    Ok(())
                })();
                (raw, result)
            }),
        )
        .await;
        match ping {
            Ok(Ok((raw, Ok(())))) => {
                conn.conn = Some(raw);
                Ok(())
            }
            Ok(Ok((_, Err(e)))) => Err(OracleError::new(e)),
            Ok(Err(e)) => Err(OracleError::message(format!("Oracle ping task: {e}"))),
            // Timed out (the task keeps the connection and closes it): discard this one.
            Err(_) => Err(OracleError::message("timed out waiting for the Oracle server")),
        }
    }

    fn has_broken(&self, conn: &mut Self::Connection) -> bool {
        conn.conn.is_none()
    }
}

/// A connection borrowed from the pool. It returns to the pool when dropped,
/// unless its statement was cancelled (then it is discarded).
pub struct OracleConnection {
    state: Arc<State>,
    pooled: bb8::PooledConnection<'static, OracleConnectionManager>,
}

impl OracleConnection {
    pub(crate) fn context(&mut self) -> &mut crate::conn::Context {
        &mut self.pooled.context
    }

    pub fn is_closed(&self) -> bool {
        self.pooled.conn.is_none()
    }

    /// Drops the connection instead of returning it; the server rolls an open
    /// transaction back.
    pub(crate) fn discard_inner(&mut self) {
        self.pooled.conn.take();
    }
}

fn open(state: &State) -> oracle::Result<OracleHandle> {
    let mut connector = oracle::Connector::new(state.user.clone(), state.password.clone(), state.connect.clone());
    connector.driver_name("OpenIDEA");
    if let Some(n) = state.statement_cache {
        connector.stmt_cache_size(n);
    }
    let mut conn = connector.connect()?;
    conn.set_autocommit(state.auto_commit);
    for sql in &state.init {
        statement(&mut conn, sql, 0, 0, Cells::Text).map_err(|e| message_error(&e.message))?;
    }
    let user: String = conn.query_row_as("SELECT SYS_CONTEXT('USERENV', 'SESSION_USER') FROM DUAL", &[])?;
    let default = crate::sql::use_schema(DbDriver::Oracle, &user);
    let current: String = conn.query_row_as("SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM DUAL", &[])?;
    let mut context = crate::conn::Context::new(default);
    context.set_current(crate::sql::use_schema(DbDriver::Oracle, &current));
    Ok(OracleHandle { conn: Some(conn), context })
}

/// Runs `f` with the connection on the blocking pool. Cancelling drops the
/// connection instead of returning it (its statement keeps running server-side).
async fn with_conn<T>(
    c: &mut OracleConnection,
    cancel: &CancellationToken,
    f: impl FnOnce(&mut oracle::Connection) -> IdeResult<T> + Send + 'static,
) -> IdeResult<T>
where
    T: Send + 'static,
{
    let Some(conn) = c.pooled.conn.take() else {
        return Err(IdeError::new(ErrorKind::Io, "Oracle connection is closed"));
    };
    let (tx, mut rx) = mpsc::channel::<(oracle::Connection, IdeResult<T>)>(1);
    tokio::task::spawn_blocking(move || {
        let mut slot = Some(conn);
        let result = match slot.as_mut() {
            Some(conn) => f(conn),
            None => unreachable!("connection taken above"),
        };
        // A closed receiver (cancelled) drops the connection, closing it.
        let _ = tx.blocking_send((slot.take().expect("some"), result));
    });
    tokio::select! {
        item = rx.recv() => match item {
            Some((conn, result)) => {
                c.pooled.conn = Some(conn);
                result
            }
            None => Err(IdeError::internal("the Oracle connection task failed")),
        },
        () = cancel.cancelled() => {
            rx.close();
            Err(IdeError::cancelled())
        }
    }
}

/// Runs a script on `c` (see [`crate::conn::Pool::rows`] and `Held::execute`).
pub(crate) async fn run(
    c: &mut OracleConnection,
    sql: &str,
    skip: usize,
    max: usize,
    mode: Cells,
    cancel: &CancellationToken,
) -> IdeResult<Fetched> {
    let state = c.state.clone();
    let sql = sql.to_owned();
    with_conn(c, cancel, move |conn| statements(conn, &state, &sql, skip, max, mode)).await
}

/// The table editor's edits in one transaction.
pub(crate) async fn transaction(c: &mut OracleConnection, statements: &[(String, bool)]) -> IdeResult<u64> {
    if c.state.read_only {
        return Err(IdeError::new(ErrorKind::PermissionDenied, "read-only connection: edits are not allowed"));
    }
    let script = statements.iter().map(|(sql, _)| sql.clone()).collect::<Vec<_>>();
    let expect: Vec<bool> = statements.iter().map(|(_, e)| *e).collect();
    let apply = move |conn: &mut oracle::Connection| -> IdeResult<u64> {
        conn.set_autocommit(false);
        let mut total = 0;
        for (sql, expect_one) in script.iter().zip(&expect) {
            let mut stmt = conn.statement(sql).build().map_err(oracle_err)?;
            stmt.execute(&[]).map_err(oracle_err)?;
            let n = stmt.row_count().map_err(oracle_err)?;
            if *expect_one && n != 1 {
                conn.rollback().ok();
                return Err(IdeError::invalid(format!(
                    "{sql}: expected to change 1 row, changed {n}; nothing was saved"
                )));
            }
            total += n;
        }
        conn.commit().map_err(oracle_err)?;
        Ok(total)
    };
    let cancel = CancellationToken::new();
    with_conn(c, &cancel, apply).await
}

/// Runs every statement of `sql` (one script, PL/SQL blocks kept whole): the
/// first query's rows are the result, otherwise the total rows changed.
fn statements(
    conn: &mut oracle::Connection,
    state: &State,
    sql: &str,
    skip: usize,
    max: usize,
    mode: Cells,
) -> IdeResult<Fetched> {
    conn.set_autocommit(state.auto_commit);
    let mut query: Option<Fetched> = None;
    let mut affected: u64 = 0;
    let mut first: Option<Instant> = None;
    for s in crate::split::split(sql, DbDriver::Oracle) {
        if state.read_only && is_write(&s.text) {
            return Err(IdeError::new(
                ErrorKind::PermissionDenied,
                format!("read-only connection: {} statements are not allowed", first_word(&s.text)),
            ));
        }
        let r = statement(conn, &s.text, skip, max, mode)?;
        first.get_or_insert_with(|| r.4.unwrap_or_else(Instant::now));
        if r.0.is_empty() {
            affected += r.2.unwrap_or(0);
        } else if query.is_none() {
            query = Some(r);
        }
    }
    Ok(query.unwrap_or((Vec::new(), Vec::new(), Some(affected), false, first)))
}

/// Reads one statement; `skip` rows are fetched and dropped (result pagination).
fn statement(conn: &mut oracle::Connection, sql: &str, skip: usize, max: usize, mode: Cells) -> IdeResult<Fetched> {
    let started = Instant::now();
    // LOB locators let `cell` read only the shown prefix (the default fetches whole LOBs).
    let mut stmt = conn
        .statement(sql)
        .fetch_array_size((max as u32).clamp(1, 1000) + 1)
        .lob_locator()
        .build()
        .map_err(oracle_err)?;
    match stmt.statement_type() {
        oracle::StatementType::Select => {
            let rows = stmt.query(&[]).map_err(oracle_err)?;
            let columns: Vec<ResultColumn> = rows
                .column_info()
                .iter()
                .map(|c| ResultColumn { name: c.name().to_owned(), type_name: c.oracle_type().to_string() })
                .collect();
            let mut out: Vec<Vec<Option<String>>> = Vec::new();
            let mut has_more = false;
            let mut to_skip = skip;
            for row in rows {
                if to_skip > 0 {
                    to_skip -= 1;
                    continue;
                }
                if out.len() >= max {
                    has_more = true;
                    break;
                }
                let row = row.map_err(oracle_err)?;
                out.push(row.sql_values().iter().map(|v| cell(v, mode)).collect());
            }
            Ok((columns, out, None, has_more, Some(started)))
        }
        _ => {
            stmt.execute(&[]).map_err(oracle_err)?;
            let affected = stmt.row_count().map_err(oracle_err)?;
            Ok((Vec::new(), Vec::new(), Some(affected), false, Some(started)))
        }
    }
}

fn first_word(sql: &str) -> String {
    sql.lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with("--"))
        .and_then(|l| l.split_whitespace().next())
        .unwrap_or("")
        .to_ascii_uppercase()
}

/// Whether `sql` changes data or schema (read-only connections refuse it).
fn is_write(sql: &str) -> bool {
    !matches!(first_word(sql).as_str(), "SELECT" | "WITH" | "SHOW" | "EXPLAIN" | "DESCRIBE" | "DESC" | "SET")
}

fn cell(v: &oracle::SqlValue, mode: Cells) -> Option<String> {
    if v.is_null().unwrap_or(false) {
        return None;
    }
    match v.oracle_type().ok() {
        Some(OracleType::CLOB | OracleType::NCLOB) => {
            let lob: Clob = v.get().ok()?;
            let cap = if mode == Cells::Text { MAX_TEXT_LOB } else { MAX_GRID_LOB };
            let mut s = String::new();
            lob.take(cap).read_to_string(&mut s).ok()?;
            Some(s)
        }
        Some(OracleType::BLOB) => {
            let lob: Blob = v.get().ok()?;
            let cap = if mode == Cells::Text { MAX_TEXT_LOB } else { MAX_GRID_LOB };
            let mut buf = Vec::new();
            lob.take(cap).read_to_end(&mut buf).ok()?;
            Some(hex(&buf))
        }
        _ => v.get::<String>().ok(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connect_strings() {
        let s = |db: &str| DataSource {
            driver: DbDriver::Oracle,
            host: "db.local".into(),
            port: Some(1521),
            database: db.into(),
            ..Default::default()
        };
        assert_eq!(connect_string(&s("ORCLPDB1")), "//db.local:1521/ORCLPDB1");
        assert_eq!(connect_string(&s("")), "//db.local:1521");
        assert_eq!(
            connect_string(&DataSource { host: String::new(), port: None, database: "ORCL".into(), ..s("") }),
            "//localhost:1521/ORCL"
        );
        assert_eq!(connect_string(&s("(DESCRIPTION=(ADDRESS=...))")), "(DESCRIPTION=(ADDRESS=...))");
        assert_eq!(connect_string(&s("PROD=MYDB")), "PROD=MYDB");
    }

    #[test]
    fn write_detection() {
        assert!(!is_write("SELECT 1 FROM DUAL"));
        assert!(!is_write("-- x\nWITH q AS (SELECT 1) SELECT * FROM q"));
        assert!(!is_write("DESC users"));
        assert!(is_write("INSERT INTO t VALUES (1)"));
        assert!(is_write("begin\n  null;\nend;"));
        assert!(is_write("DROP TABLE t"));
    }

    #[test]
    fn missing_user_is_rejected_before_connecting() {
        let setup = Setup::default();
        let err = State::of(&DataSource { driver: DbDriver::Oracle, ..Default::default() }, None, &setup).unwrap_err();
        assert!(err.message.contains("user name"));
        let state = State::of(
            &DataSource { driver: DbDriver::Oracle, user: "scott".into(), ..Default::default() },
            Some("tiger"),
            &setup,
        )
        .unwrap();
        assert_eq!(
            (state.user.as_str(), state.password.as_str(), state.connect.as_str()),
            ("scott", "tiger", "//localhost:1521")
        );
        assert!(state.auto_commit);
    }

    #[test]
    fn oracle_errors_map_to_kinds() {
        let auth = oracle_err(message_error("x")).kind; // no database error: invalid input
        assert_eq!(auth, ErrorKind::InvalidInput);
    }

    #[tokio::test]
    async fn a_discarded_connection_is_broken_but_a_live_one_is_not() {
        // No server is reachable here, so the pooled connection is a husk: `has_broken`
        // decides whether bb8 keeps it, which is what cancellation relies on.
        let manager = OracleConnectionManager(Arc::new(
            State::of(
                &DataSource { driver: DbDriver::Oracle, user: "scott".into(), ..Default::default() },
                None,
                &Setup::default(),
            )
            .unwrap(),
        ));
        let mut broken = OracleHandle { conn: None, context: crate::conn::Context::new(None) };
        assert!(manager.has_broken(&mut broken));
        // A connection that cannot be opened reports the failure without panicking
        // (a client-load error, or ORA-12541 when a client is available).
        match manager.connect().await {
            Ok(_) => unreachable!("no server is listening"),
            Err(err) => assert!(!err.into_ide().message.is_empty()),
        }
    }

    #[test]
    fn connect_reports_a_missing_client_directory() {
        let err = client_dir("/nonexistent/instantclient").expect_err("no such directory");
        assert!(err.message.contains("Instant Client directory not found"), "{}", err.message);
        assert!(client_dir("").expect("the search path").is_none());
    }

    /// A live server, skipped unless `OPENIDEA_ORACLE_TEST` is
    /// `user/password@host:port/service` (and `OPENIDEA_ORACLE_CLIENT` names the
    /// Instant Client when it is not on the search path).
    ///
    /// Checking out a connection runs `is_valid`, so this fails if the ping is
    /// not a query (bb8 silently retries a rejected check-out until it times out).
    #[tokio::test]
    async fn a_pooled_connection_runs_queries() {
        let Some(spec) = std::env::var("OPENIDEA_ORACLE_TEST").ok().filter(|s| !s.is_empty()) else { return };
        let (auth, addr) = spec.split_once('@').expect("user/password@host:port/service");
        let (user, password) = auth.split_once('/').expect("user/password");
        let (host, rest) = addr.split_once(':').expect("host:port/service");
        let (port, service) = rest.split_once('/').expect("port/service");
        let source = DataSource {
            driver: DbDriver::Oracle,
            host: host.into(),
            port: Some(port.parse().expect("port")),
            database: service.into(),
            user: user.into(),
            options: crate::source::DbOptions {
                instant_client: std::env::var("OPENIDEA_ORACLE_CLIENT").unwrap_or_default(),
                ..Default::default()
            },
            ..Default::default()
        };
        // A missing or wrong password asks for one (the UI prompts on PermissionDenied).
        for wrong in [None, Some("wrong")] {
            let Err(err) = crate::conn::Pool::connect(&source, wrong, None).await else { panic!("bad password") };
            assert_eq!(err.kind, ErrorKind::PermissionDenied, "{}", err.message);
        }
        let pool = crate::conn::Pool::connect(&source, Some(password), None).await.expect("connect");
        let rows = pool.rows("SELECT 1 FROM DUAL", 1).await.expect("query through the pool");
        assert_eq!(rows.first().and_then(|r| r.first().cloned().flatten()).as_deref(), Some("1"));

        // The result grid reads later pages by skipping rows client-side.
        let page = pool
            .execute_from("SELECT LEVEL FROM DUAL CONNECT BY LEVEL <= 10", 4, 3, &CancellationToken::new())
            .await
            .expect("second page");
        let values: Vec<String> = page.rows.iter().filter_map(|r| r.first().cloned().flatten()).collect();
        assert_eq!(values, ["5", "6", "7"]);
        assert!(page.has_more);

        // PL/SQL units reach the server with their closing `END;`.
        pool.rows("begin null; end;", 0).await.expect("anonymous block");
        pool.rows("declare n number := 1; begin n := n + 1; end;", 0).await.expect("declare block");
        let proc = "create or replace procedure openidea_p(a number) is\n  x number := a;\nbegin\n  x := x + 1;\nend;";
        let rows = pool.rows(&format!("{proc}\nselect 7 from dual;"), 1).await.expect("procedure, then a query");
        assert_eq!(rows.first().and_then(|r| r.first().cloned().flatten()).as_deref(), Some("7"));
        pool.rows("begin openidea_p(1); end;", 0).await.expect("call the procedure");
        let package = "create or replace package openidea_k as\n  function f return number;\nend openidea_k;\n/\n\
                       create or replace package body openidea_k as\n  function f return number is begin return 8; end;\nend openidea_k;\n/";
        pool.rows(package, 0).await.expect("package spec and body");
        let rows = pool.rows("select openidea_k.f from dual", 1).await.expect("call the package");
        assert_eq!(rows.first().and_then(|r| r.first().cloned().flatten()).as_deref(), Some("8"));
        pool.rows("drop package openidea_k; drop procedure openidea_p", 0).await.expect("clean up");

        // LOB cells are read through locators.
        let rows = pool.rows("select to_clob('abc'), to_blob(hextoraw('0A0B')) from dual", 1).await.expect("LOBs");
        assert_eq!(rows.first().cloned(), Some(vec![Some("abc".into()), Some("0x0A0B".into())]));
    }
}
