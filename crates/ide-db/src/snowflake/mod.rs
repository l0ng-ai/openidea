//! Snowflake over HTTPS: the session protocol of Snowflake's own drivers (login, statements,
//! cancellation, token renewal) with results in JSON. One session per pool; statements run
//! one at a time on it, so session state (`USE`, `ALTER SESSION`, transactions) holds.

mod account;
mod browser;
mod client;
mod error;
mod keypair;
pub(crate) mod meta;
mod rows;

use crate::conn::{QueryResult, Setup};
use crate::source::{DataSource, DbSnowflakeAuth};
use client::{Api, Envelope, Request};
use ide_core::{CancellationToken, IdeError, IdeResult, error::ErrorKind};
use parking_lot::RwLock;
use rows::RowType;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

const APP: &str = "OpenIDEA";
const LOGIN: &str = "session/v1/login-request";
const QUERY: &str = "queries/v1/query-request";
const ABORT: &str = "queries/v1/abort-request";
const RENEW: &str = "session/token-request";
const SESSION: &str = "session";
/// DML statement types (`INSERT`, `UPDATE`, `DELETE`, `MERGE`…): their result is a row of counts.
const DML: std::ops::Range<i64> = 0x3000..0x4000;
const SELECT: i64 = 0x1000;

/// A connection target (a database of a data source) on the Snowflake session its data source's
/// targets share: one login serves every database, and each statement runs under its target's
/// database and schema.
#[derive(Clone)]
pub struct SnowflakePool {
    shared: Arc<State>,
    /// The target's database and the data source's schema (empty: the user's defaults).
    database: String,
    schema: String,
    read_only: Arc<AtomicBool>,
    closed: CancellationToken,
    /// Which of the data source's sessions this handle runs on.
    lane: usize,
}

static CONNECTING: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// The key the single sign-on ID token of `source` is cached under (`None`: another method).
pub(crate) fn sso_key(source: &DataSource) -> Option<String> {
    if source.snowflake().auth != DbSnowflakeAuth::Browser {
        return None;
    }
    let endpoint = account::endpoint(source).ok()?;
    let address = format!(
        "{}:{}",
        endpoint.base.host_str().unwrap_or_default(),
        endpoint.base.port_or_known_default().unwrap_or_default()
    );
    Some(format!("{address}|{}", source.user.trim().to_uppercase()))
}

/// The ID token a browser sign-in left, which signs in again without the browser while Snowflake accepts it.
pub(crate) fn sso_token(key: &str) -> Option<String> {
    browser::cached(key)
}

/// Offers a saved ID token for the next sign-in (one already in use is kept).
pub(crate) fn sso_seed(key: &str, token: &str) {
    if browser::cached(key).is_none() {
        browser::remember(key, token);
    }
}

/// Live sessions by their connection settings, so targets opened with the same settings share one.
static SESSIONS: LazyLock<parking_lot::Mutex<HashMap<String, Weak<State>>>> =
    LazyLock::new(|| parking_lot::Mutex::new(HashMap::new()));

struct State {
    api: Api,
    login: Login,
    /// The consoles' session and the tree's ([`CONSOLE`], [`METADATA`]): a long statement in a
    /// console does not hold up the tree. The second one logs in when it is first used.
    lanes: [Lane; 2],
    /// Open targets on this session; the last one to close ends it.
    users: AtomicUsize,
    key: String,
    closed: CancellationToken,
}

/// One Snowflake session.
#[derive(Default)]
struct Lane {
    tokens: RwLock<Option<Tokens>>,
    /// Statements share the session, so they take turns.
    turn: Mutex<()>,
    sequence: AtomicU64,
    /// The `USE` statement the session is known to be under (`None`: a statement may have
    /// moved it; empty: as the login left it, without a database or schema).
    context: parking_lot::Mutex<Option<String>>,
}

const CONSOLE: usize = 0;
const METADATA: usize = 1;

struct Login {
    account: String,
    user: String,
    credentials: Credentials,
    database: String,
    schema: String,
    warehouse: String,
    role: String,
    parameters: Vec<(String, String)>,
    timeout: Duration,
}

enum Credentials {
    KeyPair { file: String, passphrase: Option<String> },
    Password(String),
    Token(String),
    OAuth(String),
    Browser,
}

#[derive(Clone)]
struct Tokens {
    session: String,
    master: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ResultData {
    rowtype: Vec<RowType>,
    rowset: Vec<Vec<Value>>,
    rowset_base64: Option<String>,
    chunks: Vec<Chunk>,
    chunk_headers: BTreeMap<String, String>,
    qrmk: Option<String>,
    query_result_format: Option<String>,
    statement_type_id: Option<i64>,
    get_result_url: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Chunk {
    url: String,
    row_count: usize,
}

fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn closed() -> IdeError {
    IdeError::new(ErrorKind::Io, "Snowflake connection is closed")
}

/// A session parameter as JSON: Snowflake types booleans and numbers.
fn parameter(value: &str) -> Value {
    if value.eq_ignore_ascii_case("true") {
        Value::Bool(true)
    } else if value.eq_ignore_ascii_case("false") {
        Value::Bool(false)
    } else if let Ok(n) = value.parse::<i64>() {
        json!(n)
    } else {
        Value::String(value.to_owned())
    }
}

/// Settings of the Advanced tab the driver sets itself.
fn reserved(name: &str) -> bool {
    matches!(
        name.to_ascii_uppercase().as_str(),
        "ROWS_PER_RESULTSET" | "MULTI_STATEMENT_COUNT" | "CLIENT_STORE_TEMPORARY_CREDENTIAL"
    )
}

/// A name typed in the dialog, as SQL: typed in one case it is an unquoted name, which folds
/// to upper case; anything else is taken as the exact name.
fn typed(name: &str) -> String {
    let plain = name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
        && !name.starts_with(|c: char| c.is_ascii_digit());
    let one_case = !name.chars().any(|c| c.is_ascii_lowercase()) || !name.chars().any(|c| c.is_ascii_uppercase());
    let name = if plain && one_case { name.to_ascii_uppercase() } else { name.to_owned() };
    crate::sql::quote_ident(crate::DbDriver::Snowflake, &name)
}

fn first_word(sql: &str) -> String {
    let mut sql = sql.trim_start();
    loop {
        if let Some(rest) = sql.strip_prefix("--").or_else(|| sql.strip_prefix("//")) {
            sql = rest.split_once('\n').map_or("", |(_, rest)| rest).trim_start();
        } else if let Some(rest) = sql.strip_prefix("/*") {
            sql = rest.split_once("*/").map_or("", |(_, rest)| rest).trim_start();
        } else {
            break;
        }
    }
    sql.split(|c: char| !c.is_ascii_alphanumeric() && c != '_').next().unwrap_or_default().to_ascii_uppercase()
}

/// Whether `sql` may change data or objects (a read-only data source refuses it).
/// Snowflake answers a `USE` it will not perform with one message for every cause; this adds
/// the causes.
fn explain_use(sql: &str, mut error: IdeError) -> IdeError {
    if first_word(sql) == "USE" && error.message.contains("002043") {
        error.message.push_str(
            "\nThe role, warehouse, database or schema does not exist, or is not granted: a role must be \
             granted to your user (SHOW GRANTS TO USER <name>), the others to the current role.",
        );
    }
    error
}

/// Whether `sql` may change the account. Statements that read, and those that change only the
/// session (`USE`, `SET`, `UNSET`), run on a read-only data source.
fn is_write(sql: &str) -> bool {
    match first_word(sql).as_str() {
        "SELECT" | "SHOW" | "DESCRIBE" | "DESC" | "EXPLAIN" | "LIST" | "LS" | "USE" | "SET" | "UNSET" | "VALUES"
        | "TABLE" | "" => false,
        // `WITH name AS PROCEDURE (…) … CALL name(…)` runs a procedure; other `WITH`s select.
        "WITH" => {
            sql.to_ascii_uppercase().split_whitespace().collect::<Vec<_>>().windows(2).any(|w| w == ["AS", "PROCEDURE"])
        }
        _ => true,
    }
}

fn gunzip(bytes: Vec<u8>) -> IdeResult<Vec<u8>> {
    if !bytes.starts_with(&[0x1f, 0x8b]) {
        return Ok(bytes);
    }
    let mut out = Vec::new();
    std::io::Read::read_to_end(&mut flate2::read::GzDecoder::new(bytes.as_slice()), &mut out)
        .map_err(|e| IdeError::new(ErrorKind::Protocol, format!("Snowflake: cannot read a result chunk: {e}")))?;
    Ok(out)
}

impl SnowflakePool {
    pub(crate) async fn connect(source: &DataSource, secret: Option<&str>, setup: Setup) -> IdeResult<Self> {
        let settings = source.snowflake();
        let endpoint = account::endpoint(source)?;
        let user = source.user.trim();
        if user.is_empty() {
            return Err(IdeError::invalid("enter the Snowflake user name"));
        }
        for (name, _) in &setup.params {
            if reserved(name) {
                return Err(IdeError::invalid(format!("the Snowflake driver manages the {name} parameter")));
            }
        }
        let secret = secret.filter(|s| !s.is_empty());
        let ask = |what: &str| IdeError::new(ErrorKind::PermissionDenied, format!("enter the {what}"));
        let credentials = match settings.auth {
            DbSnowflakeAuth::KeyPair => {
                Credentials::KeyPair { file: settings.private_key_file.clone(), passphrase: secret.map(str::to_owned) }
            }
            DbSnowflakeAuth::Password => Credentials::Password(secret.ok_or_else(|| ask("password"))?.to_owned()),
            DbSnowflakeAuth::Token => {
                Credentials::Token(secret.ok_or_else(|| ask("programmatic access token"))?.to_owned())
            }
            DbSnowflakeAuth::OAuth => Credentials::OAuth(secret.ok_or_else(|| ask("OAuth access token"))?.to_owned()),
            DbSnowflakeAuth::Browser => Credentials::Browser,
        };
        let timeout = setup.connect_timeout.unwrap_or(Duration::from_secs(30));
        let _ = rustls::crypto::ring::default_provider().install_default();
        let builder = reqwest::Client::builder()
            .connect_timeout(timeout)
            .pool_max_idle_per_host(4)
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("OpenIDEA/", env!("CARGO_PKG_VERSION")));
        let proxy = ide_core::proxy_settings::proxy();
        let http = ide_http::client::with_proxy(builder, &proxy)
            .build()
            .map_err(|e| IdeError::new(ErrorKind::Io, format!("Snowflake: cannot start the HTTP client: {e}")))?;
        let api = Api::new(http, endpoint.base);
        if let Some(secret) = secret {
            api.scrub.add(secret);
        }
        let database = source.database.trim().to_owned();
        let schema = source.options.default_schema.trim().to_owned();
        let target = |shared: Arc<State>| Self {
            shared,
            database: database.clone(),
            schema: schema.clone(),
            read_only: Arc::new(AtomicBool::new(source.read_only)),
            closed: CancellationToken::new(),
            lane: CONSOLE,
        };
        // Everything that makes a session what it is, the secret included (hashed: the key is only compared).
        let key = blake3::hash(
            format!(
                "{}\0{user}\0{:?}\0{}\0{}\0{}\0{}\0{:?}\0{:?}",
                api.address(),
                settings.auth,
                secret.unwrap_or_default(),
                settings.private_key_file,
                settings.warehouse.trim(),
                settings.role.trim(),
                setup.params,
                setup.statements
            )
            .as_bytes(),
        )
        .to_hex()
        .to_string();
        // One connect at a time: targets opened together (the tree, consoles, completion) find the
        // session the first of them signs in to, instead of each signing in (and each opening the
        // browser with single sign-on).
        let _connecting = CONNECTING.lock().await;
        let live = SESSIONS.lock().get(&key).and_then(Weak::upgrade).filter(|s| !s.closed.is_cancelled());
        if let Some(shared) = live {
            shared.users.fetch_add(1, Ordering::SeqCst);
            return Ok(target(shared));
        }
        let pool = target(Arc::new(State {
            api,
            login: Login {
                account: endpoint.account,
                user: user.to_owned(),
                credentials,
                database: database.clone(),
                schema: schema.clone(),
                warehouse: settings.warehouse.trim().to_owned(),
                role: settings.role.trim().to_owned(),
                parameters: setup.params,
                timeout,
            },
            lanes: Default::default(),
            users: AtomicUsize::new(1),
            key: key.clone(),
            closed: CancellationToken::new(),
        }));
        pool.login().await?;
        // The login asked for this target's database and schema.
        *pool.lane().context.lock() = Some(pool.context(None).unwrap_or_default());
        let cancel = CancellationToken::new();
        // The startup script may write whatever the read-only setting says.
        pool.read_only.store(false, Ordering::Relaxed);
        for sql in setup.statements {
            if let Err(error) = pool.execute(&sql, 0, &cancel).await {
                pool.close().await;
                return Err(error);
            }
        }
        pool.read_only.store(source.read_only, Ordering::Relaxed);
        SESSIONS.lock().insert(key, Arc::downgrade(&pool.shared));
        Ok(pool)
    }

    /// The target's database as SQL (`None`: the session's current database).
    pub(crate) fn database_ident(&self) -> Option<String> {
        (!self.database.is_empty()).then(|| typed(&self.database))
    }

    /// The `USE` statement for this target with `schema` active (`None`: the data source's schema).
    fn context(&self, schema: Option<&str>) -> Option<String> {
        let quote = |name: &str| crate::sql::quote_ident(crate::DbDriver::Snowflake, name);
        let schema = match schema.filter(|s| !s.is_empty()) {
            // Picked from the list of schemas: the exact name.
            Some(picked) => Some(quote(picked)),
            None if self.schema.is_empty() => None,
            None => Some(typed(&self.schema)),
        };
        match (self.database.is_empty(), schema) {
            (false, Some(schema)) => Some(format!("USE SCHEMA {}.{schema}", typed(&self.database))),
            (false, None) => Some(format!("USE DATABASE {}", typed(&self.database))),
            (true, Some(schema)) => Some(format!("USE SCHEMA {schema}")),
            (true, None) => None,
        }
    }

    /// Ends the session on the server (best effort) and refuses further statements.
    pub async fn close(&self) {
        if self.closed.is_cancelled() {
            return;
        }
        self.closed.cancel();
        if self.shared.users.fetch_sub(1, Ordering::SeqCst) != 1 {
            return;
        }
        self.shared.closed.cancel();
        {
            let mut sessions = SESSIONS.lock();
            if sessions.get(&self.shared.key).is_some_and(|s| std::ptr::eq(s.as_ptr(), Arc::as_ptr(&self.shared))) {
                sessions.remove(&self.shared.key);
            }
        }
        for lane in &self.shared.lanes {
            let tokens = lane.tokens.write().take();
            if let Some(tokens) = tokens {
                let request = Request::post(SESSION, json!({}))
                    .query("delete", "true")
                    .query("requestId", uuid())
                    .token(&tokens.session)
                    .timeout(Duration::from_secs(5));
                let _ = self.shared.api.send(request).await;
            }
        }
    }

    fn lane(&self) -> &Lane {
        &self.shared.lanes[self.lane]
    }

    /// This target on the session the tree reads metadata with.
    pub(crate) fn metadata(&self) -> Self {
        // A second browser sign-in would interrupt the user: without an ID token to sign in
        // with, metadata takes turns with the consoles.
        let second = !matches!(self.shared.login.credentials, Credentials::Browser)
            || browser::cached(&self.browser_key()).is_some();
        Self { lane: if second { METADATA } else { CONSOLE }, ..self.clone() }
    }

    fn browser_key(&self) -> String {
        format!("{}|{}", self.shared.api.address(), self.shared.login.user.to_uppercase())
    }

    pub fn is_closed(&self) -> bool {
        self.closed.is_cancelled() || self.shared.closed.is_cancelled()
    }

    /// The fields of the login request that prove who the user is.
    async fn proof(&self) -> IdeResult<(Vec<(&'static str, Value)>, Option<String>)> {
        let login = &self.shared.login;
        Ok(match &login.credentials {
            Credentials::KeyPair { file, passphrase } => {
                let (file, passphrase) = (file.clone(), passphrase.clone());
                let (account, user) = (login.account.clone(), login.user.clone());
                // Decrypting the key derives its encryption key, which takes a while by design.
                let (token, fingerprint) = tokio::task::spawn_blocking(move || {
                    let pair = keypair::load(&file, passphrase.as_deref())?;
                    Ok::<_, IdeError>((pair.jwt(&account, &user, now_secs())?, pair.fingerprint()?))
                })
                .await
                .map_err(|e| IdeError::internal(e.to_string()))??;
                self.shared.api.scrub.add(&token);
                (vec![("AUTHENTICATOR", json!("SNOWFLAKE_JWT")), ("TOKEN", json!(token))], Some(fingerprint))
            }
            Credentials::Password(password) => (vec![("PASSWORD", json!(password))], None),
            Credentials::Token(token) => {
                (vec![("AUTHENTICATOR", json!("PROGRAMMATIC_ACCESS_TOKEN")), ("TOKEN", json!(token))], None)
            }
            Credentials::OAuth(token) => (vec![("AUTHENTICATOR", json!("OAUTH")), ("TOKEN", json!(token))], None),
            Credentials::Browser => unreachable!("browser sign-in has its own login"),
        })
    }

    async fn login(&self) -> IdeResult<Tokens> {
        if matches!(self.shared.login.credentials, Credentials::Browser) {
            return self.browser_login().await;
        }
        let (proof, fingerprint) = self.proof().await?;
        self.sign_in(proof, fingerprint, None).await
    }

    /// Signs in through the web browser, or without it while an ID token of an earlier
    /// sign-in of this run is still accepted.
    async fn browser_login(&self) -> IdeResult<Tokens> {
        let login = &self.shared.login;
        let key = self.browser_key();
        let _flow = browser::FLOW.lock().await;
        if let Some(id_token) = browser::cached(&key) {
            self.shared.api.scrub.add(&id_token);
            let proof = vec![("AUTHENTICATOR", json!("ID_TOKEN")), ("TOKEN", json!(id_token))];
            match self.sign_in(proof, None, Some(&key)).await {
                Ok(tokens) => return Ok(tokens),
                // The network is down: the browser would not get further either.
                Err(error) if matches!(error.kind, ErrorKind::Io | ErrorKind::TimedOut) => return Err(error),
                Err(_) => browser::forget(&key),
            }
        }
        let (token, proof_key) =
            browser::authenticate(&self.shared.api, &login.account, &login.user, login.timeout).await?;
        let proof =
            vec![("AUTHENTICATOR", json!("EXTERNALBROWSER")), ("TOKEN", json!(token)), ("PROOF_KEY", json!(proof_key))];
        self.sign_in(proof, None, Some(&key)).await
    }

    /// The login request. `id_token_key`: ask for an ID token and keep it under this key.
    async fn sign_in(
        &self,
        proof: Vec<(&'static str, Value)>,
        fingerprint: Option<String>,
        id_token_key: Option<&str>,
    ) -> IdeResult<Tokens> {
        let login = &self.shared.login;
        let mut parameters: serde_json::Map<String, Value> =
            login.parameters.iter().map(|(name, value)| (name.to_ascii_uppercase(), parameter(value))).collect();
        if id_token_key.is_some() {
            parameters.insert("CLIENT_STORE_TEMPORARY_CREDENTIAL".into(), Value::Bool(true));
        }
        let mut data = json!({
            "CLIENT_APP_ID": APP,
            "CLIENT_APP_VERSION": env!("CARGO_PKG_VERSION"),
            "ACCOUNT_NAME": login.account,
            "LOGIN_NAME": login.user,
            "CLIENT_ENVIRONMENT": { "APPLICATION": APP, "OS": std::env::consts::OS },
            "SESSION_PARAMETERS": parameters,
        });
        for (name, value) in proof {
            data[name] = value;
        }
        let mut request = Request::post(LOGIN, json!({ "data": data }))
            .query("requestId", uuid())
            .query("request_guid", uuid())
            .timeout(login.timeout);
        for (name, value) in [
            ("databaseName", &login.database),
            ("schemaName", &login.schema),
            ("warehouse", &login.warehouse),
            ("roleName", &login.role),
        ] {
            if !value.is_empty() {
                request = request.query(name, value.as_str());
            }
        }
        let envelope = self.shared.api.send(request).await?;
        if !envelope.success {
            let code = envelope.code.as_deref().unwrap_or_default();
            let mut failure = error::server(envelope.code.as_deref(), envelope.message.as_deref());
            if let Some(fingerprint) = fingerprint.filter(|_| error::key_rejected(code)) {
                failure.message.push_str(&format!("\nFingerprint of this private key: {fingerprint}"));
            }
            return Err(self.shared.api.scrub.clean(failure));
        }
        let text = |name: &str| envelope.data.get(name).and_then(Value::as_str).map(str::to_owned);
        let (Some(session), Some(master)) = (text("token"), text("masterToken")) else {
            return Err(IdeError::new(ErrorKind::Protocol, "Snowflake: the login response has no session token"));
        };
        self.shared.api.scrub.add(&session);
        self.shared.api.scrub.add(&master);
        if let (Some(key), Some(id_token)) = (id_token_key, text("idToken")) {
            self.shared.api.scrub.add(&id_token);
            browser::remember(key, &id_token);
        }
        let tokens = Tokens { session, master };
        if self.is_closed() {
            return Err(closed());
        }
        // A new session: nothing is known about where it is until a statement says.
        *self.lane().context.lock() = None;
        *self.lane().tokens.write() = Some(tokens.clone());
        Ok(tokens)
    }

    /// A fresh session token from the master token; a new login when that is refused.
    async fn renew(&self, stale: &Tokens) -> IdeResult<Tokens> {
        let request = Request::post(RENEW, json!({ "oldSessionToken": stale.session, "requestType": "RENEW" }))
            .query("requestId", uuid())
            .token(&stale.master)
            .timeout(self.shared.login.timeout);
        if let Ok(envelope) = self.shared.api.send(request).await
            && envelope.success
        {
            let text = |name: &str| envelope.data.get(name).and_then(Value::as_str).map(str::to_owned);
            if let Some(session) = text("sessionToken") {
                let master = text("masterToken").unwrap_or_else(|| stale.master.clone());
                self.shared.api.scrub.add(&session);
                self.shared.api.scrub.add(&master);
                let tokens = Tokens { session, master };
                *self.lane().tokens.write() = Some(tokens.clone());
                return Ok(tokens);
            }
        }
        self.login().await
    }

    async fn tokens(&self) -> IdeResult<Tokens> {
        let current = self.lane().tokens.read().clone();
        match current {
            Some(tokens) => Ok(tokens),
            None if self.is_closed() => Err(closed()),
            None => self.login().await,
        }
    }

    pub async fn execute(&self, sql: &str, max_rows: usize, cancel: &CancellationToken) -> IdeResult<QueryResult> {
        self.execute_from(sql, 0, max_rows, cancel).await
    }

    /// [`execute`](Self::execute), leaving out the first `skip` rows (a later page): whole
    /// result chunks before the page are not downloaded.
    pub async fn execute_from(
        &self,
        sql: &str,
        skip: usize,
        max_rows: usize,
        cancel: &CancellationToken,
    ) -> IdeResult<QueryResult> {
        self.execute_in(None, sql, skip, max_rows, cancel).await
    }

    /// [`execute_from`](Self::execute_from) with unqualified names resolving in `schema`
    /// (a console's active schema; `None`: the data source's). The switch and the statement
    /// hold the session together, so consoles with different schemas do not cross.
    pub async fn execute_in(
        &self,
        schema: Option<&str>,
        sql: &str,
        skip: usize,
        max_rows: usize,
        cancel: &CancellationToken,
    ) -> IdeResult<QueryResult> {
        if self.read_only.load(Ordering::Relaxed) && is_write(sql) {
            return Err(IdeError::invalid(format!(
                "read-only data source: {} statements are not allowed",
                first_word(sql)
            )));
        }
        if matches!(first_word(sql).as_str(), "PUT" | "GET") {
            // The server only plans these; the client moves the files, which this driver does not do.
            return Err(IdeError::invalid(format!(
                "{} copies files between this computer and a stage, which OpenIDEA does not do yet: \
                 run it with the Snowflake CLI (snow sql) or SnowSQL",
                first_word(sql)
            )));
        }
        let _turn = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(IdeError::cancelled()),
            () = self.closed.cancelled() => return Err(closed()),
            turn = self.lane().turn.lock() => turn,
        };
        // A `USE` needs no schema to run in, and may be what makes the schema reachable.
        if first_word(sql) != "USE" {
            self.enter(schema, cancel).await?;
        }
        // These can move the session to another database or schema.
        let moves = matches!(first_word(sql).as_str(), "USE" | "CALL" | "EXECUTE");
        let result = self.statement(sql, skip, max_rows, cancel).await;
        if moves {
            *self.lane().context.lock() = None;
        }
        result.map_err(|error| explain_use(sql, error))
    }

    /// Puts the session under this target's database and `schema` when it is not there already.
    async fn enter(&self, schema: Option<&str>, cancel: &CancellationToken) -> IdeResult<()> {
        if let Some(wanted) = self.context(schema)
            && self.lane().context.lock().as_deref() != Some(wanted.as_str())
        {
            *self.lane().context.lock() = None;
            match self.statement(&wanted, 0, 0, cancel).await {
                Ok(_) => {}
                // The session's role may not use this database or schema (after `USE ROLE`, or a
                // schema that is gone). The statement still runs, in the session's own context:
                // it may be the `USE` that leads back, or name its objects in full. Asked again
                // once a statement moves the session.
                Err(refused) if refused.kind == ErrorKind::InvalidInput => {
                    tracing::warn!("Snowflake: the session did not enter its database and schema");
                }
                Err(error) => return Err(error),
            }
            *self.lane().context.lock() = Some(wanted);
        }
        Ok(())
    }

    /// Runs `statements` in one transaction; each must change one row when flagged
    /// (table editor submits). Nothing else runs on the session meanwhile.
    pub(crate) async fn transaction(&self, statements: &[(String, bool)]) -> IdeResult<u64> {
        if self.read_only.load(Ordering::Relaxed) {
            return Err(IdeError::invalid("read-only data source: changes are not allowed"));
        }
        let _turn = self.lane().turn.lock().await;
        let cancel = CancellationToken::new();
        self.enter(None, &cancel).await?;
        self.statement("BEGIN", 0, 0, &cancel).await?;
        let changes = async {
            let mut total = 0;
            for (sql, expect_one) in statements {
                let changed = self.statement(sql, 0, 0, &cancel).await?.affected.unwrap_or(0.0) as u64;
                if *expect_one && changed != 1 {
                    return Err(IdeError::invalid(format!(
                        "{sql}: expected to change 1 row, changed {changed}; nothing was saved"
                    )));
                }
                total += changed;
            }
            Ok(total)
        }
        .await;
        match changes {
            Ok(total) => {
                self.statement("COMMIT", 0, 0, &cancel).await?;
                Ok(total)
            }
            Err(error) => {
                let _ = self.statement("ROLLBACK", 0, 0, &cancel).await;
                Err(error)
            }
        }
    }

    /// One statement on the session; the caller holds the session's turn.
    async fn statement(
        &self,
        sql: &str,
        skip: usize,
        max_rows: usize,
        cancel: &CancellationToken,
    ) -> IdeResult<QueryResult> {
        let started = Instant::now();
        let mut tokens = self.tokens().await?;
        let mut renewed = false;
        loop {
            let request_id = uuid();
            let run = self.run(sql, skip, max_rows, &tokens, &request_id, started);
            let outcome = tokio::select! {
                biased;
                () = cancel.cancelled() => None,
                () = self.closed.cancelled() => None,
                outcome = run => Some(outcome),
            };
            let Some(outcome) = outcome else {
                if self.is_closed() {
                    return Err(closed());
                }
                return Err(match self.abort(sql, &request_id, &tokens).await {
                    Ok(()) => IdeError::cancelled(),
                    Err(error) => IdeError::new(
                        ErrorKind::Cancelled,
                        format!("cancelled locally; Snowflake did not confirm the cancellation: {}", error.message),
                    ),
                });
            };
            match outcome {
                Ok(Outcome::Done(result)) => return Ok(*result),
                Ok(Outcome::Expired { gone }) if !renewed => {
                    renewed = true;
                    tokens = if gone { self.login().await? } else { self.renew(&tokens).await? };
                }
                Ok(Outcome::Expired { .. }) => {
                    return Err(IdeError::new(ErrorKind::Io, "Snowflake: the session expired; reconnect"));
                }
                Err(error) => return Err(self.shared.api.scrub.clean(error)),
            }
        }
    }

    async fn run(
        &self,
        sql: &str,
        skip: usize,
        max_rows: usize,
        tokens: &Tokens,
        request_id: &str,
        started: Instant,
    ) -> IdeResult<Outcome> {
        let wanted = skip.saturating_add(max_rows).saturating_add(1);
        let body = json!({
            "sqlText": sql,
            "asyncExec": false,
            "sequenceId": self.lane().sequence.fetch_add(1, Ordering::Relaxed) + 1,
            "querySubmissionTime": SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64),
            // The grid's page, plus one row that tells whether more exist.
            "parameters": { "ROWS_PER_RESULTSET": wanted },
        });
        let request = Request::post(QUERY, body)
            .query("requestId", request_id)
            .query("request_guid", uuid())
            .token(&tokens.session);
        let mut envelope = self.shared.api.send(request).await?;
        while envelope.has_code(error::IN_PROGRESS) {
            let Some(url) = envelope.data.get("getResultUrl").and_then(Value::as_str).map(str::to_owned) else {
                return Err(IdeError::new(ErrorKind::Protocol, "Snowflake: a running statement has no result address"));
            };
            tokio::time::sleep(Duration::from_millis(200)).await;
            envelope = self.shared.api.send(Request::get(url.trim_start_matches('/')).token(&tokens.session)).await?;
        }
        if let Some(expired) = expiry(&envelope) {
            return Ok(expired);
        }
        if !envelope.success {
            return Err(error::server(envelope.code.as_deref(), envelope.message.as_deref()));
        }
        let execution_ms = started.elapsed().as_secs_f64() * 1000.0;
        let data: ResultData = serde_json::from_value(envelope.data)
            .map_err(|e| IdeError::new(ErrorKind::Protocol, format!("Snowflake: unreadable result: {e}")))?;
        let arrow = data.query_result_format.as_deref().is_some_and(|f| !f.eq_ignore_ascii_case("json"));
        if arrow || (data.rowset_base64.as_deref().is_some_and(|r| !r.is_empty()) && data.rowset.is_empty()) {
            return Err(IdeError::new(
                ErrorKind::Protocol,
                "Snowflake sent the result in a format other than JSON, which this driver does not read",
            ));
        }
        let (rows, has_more) = self.rows(&data, skip, max_rows).await?;
        let kind = data.statement_type_id.unwrap_or(SELECT);
        let status_only = kind != SELECT && data.rowtype.len() == 1 && data.rowtype[0].name == "status";
        let (columns, rows, affected, has_more) = if DML.contains(&kind) {
            let changed: f64 = data
                .rowset
                .first()
                .map(|row| row.iter().filter_map(|v| v.as_str().and_then(|s| s.parse::<f64>().ok())).sum())
                .unwrap_or(0.0);
            (Vec::new(), Vec::new(), Some(changed), false)
        } else if status_only {
            (Vec::new(), Vec::new(), Some(0.0), false)
        } else {
            (data.rowtype.iter().map(RowType::column).collect(), rows, None, has_more)
        };
        Ok(Outcome::Done(Box::new(QueryResult {
            statement: sql.to_owned(),
            columns,
            rows,
            affected,
            has_more,
            elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
            execution_ms,
        })))
    }

    /// The page of rows `skip..skip + max_rows`, and whether rows follow it.
    async fn rows(
        &self,
        data: &ResultData,
        mut skip: usize,
        max_rows: usize,
    ) -> IdeResult<(Vec<Vec<Option<String>>>, bool)> {
        let mut rows = Vec::new();
        let mut more = false;
        let mut take = |batch: Vec<Vec<Value>>, skip: &mut usize| -> IdeResult<bool> {
            for row in batch {
                if *skip > 0 {
                    *skip -= 1;
                    continue;
                }
                if rows.len() >= max_rows {
                    return Ok(true);
                }
                if row.len() != data.rowtype.len() {
                    return Err(IdeError::new(
                        ErrorKind::Protocol,
                        "Snowflake: a result row does not match the result's columns",
                    ));
                }
                rows.push(
                    row.into_iter().zip(&data.rowtype).map(|(value, column)| rows::cell(column, value)).collect(),
                );
            }
            Ok(false)
        };
        if take(data.rowset.clone(), &mut skip)? {
            more = true;
        }
        let headers: Vec<(String, String)> = if !data.chunk_headers.is_empty() {
            data.chunk_headers.iter().map(|(name, value)| (name.clone(), value.clone())).collect()
        } else if let Some(key) = &data.qrmk {
            vec![
                ("x-amz-server-side-encryption-customer-algorithm".into(), "AES256".into()),
                ("x-amz-server-side-encryption-customer-key".into(), key.clone()),
            ]
        } else {
            Vec::new()
        };
        for chunk in &data.chunks {
            if more {
                break;
            }
            if chunk.row_count > 0 && skip >= chunk.row_count {
                skip -= chunk.row_count;
                continue;
            }
            let body = gunzip(self.shared.api.chunk(&chunk.url, &headers).await?)?;
            // A chunk is its rows separated by commas, without the enclosing brackets.
            let mut text = Vec::with_capacity(body.len() + 2);
            text.push(b'[');
            text.extend_from_slice(&body);
            text.push(b']');
            let batch: Vec<Vec<Value>> = serde_json::from_slice(&text)
                .map_err(|e| IdeError::new(ErrorKind::Protocol, format!("Snowflake: unreadable result chunk: {e}")))?;
            if take(batch, &mut skip)? {
                more = true;
            }
        }
        Ok((rows, more))
    }

    async fn abort(&self, sql: &str, request_id: &str, tokens: &Tokens) -> IdeResult<()> {
        let request = Request::post(ABORT, json!({ "sqlText": sql, "requestId": request_id }))
            .query("requestId", uuid())
            .token(&tokens.session)
            .timeout(Duration::from_secs(5));
        let envelope = self.shared.api.send(request).await?;
        if envelope.success {
            Ok(())
        } else {
            Err(self.shared.api.scrub.clean(error::server(envelope.code.as_deref(), envelope.message.as_deref())))
        }
    }
}

enum Outcome {
    Done(Box<QueryResult>),
    /// The session token no longer works (`gone`: nor does the master token).
    Expired {
        gone: bool,
    },
}

fn expiry(envelope: &Envelope) -> Option<Outcome> {
    if envelope.has_code(&[error::SESSION_EXPIRED]) {
        Some(Outcome::Expired { gone: false })
    } else if envelope.has_code(error::SESSION_GONE) {
        Some(Outcome::Expired { gone: true })
    } else {
        None
    }
}

#[cfg(test)]
mod commands;
#[cfg(test)]
mod tests;
