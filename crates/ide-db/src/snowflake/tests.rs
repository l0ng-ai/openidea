//! The driver against an in-process HTTP server that plays Snowflake's part.

use super::*;
use crate::conn::Pool;
use crate::source::{DbDriver, DbOptions, DbProperty, DbSnowflake, DbSslMode};
use base64::Engine;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const KEY: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/snowflake/rsa_key.p8");
const ENCRYPTED_KEY: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/snowflake/rsa_key_encrypted.p8");
const FINGERPRINT: &str = "SHA256:ajjL6Bf6l1FIIyTcJli4i2AWPYDVJGQnSZr+9q9ClgI=";
pub(super) const LOGIN_OK: &str =
    r#"{"success":true,"code":null,"message":null,"data":{"token":"session-token-1","masterToken":"master-token-1"}}"#;
pub(super) const CLOSED_OK: &str = r#"{"success":true,"data":null}"#;

pub(super) struct Reply {
    status: &'static str,
    body: Vec<u8>,
    /// Answer only after this long (a statement that is still running).
    delay: Duration,
}

pub(super) fn ok(body: impl Into<String>) -> Reply {
    Reply { status: "200 OK", body: body.into().into_bytes(), delay: Duration::ZERO }
}

/// A recorded request: its request line and headers, and its body.
pub(super) struct Seen {
    head: String,
    body: String,
}

impl Seen {
    pub(super) fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap()
    }

    fn line(&self) -> &str {
        self.head.lines().next().unwrap()
    }

    fn header(&self, name: &str) -> Option<&str> {
        self.head.lines().skip(1).find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case(name).then(|| value.trim())
        })
    }
}

async fn read_request(stream: &mut TcpStream) -> Seen {
    let mut bytes = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        let count = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buffer)).await.unwrap().unwrap();
        assert!(count > 0, "request ended early");
        bytes.extend_from_slice(&buffer[..count]);
        if let Some(end) = bytes.windows(4).position(|s| s == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&bytes[..end]).into_owned();
            let length: usize = head
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap())
                })
                .unwrap_or(0);
            if bytes.len() >= end + 4 + length {
                return Seen { head, body: String::from_utf8_lossy(&bytes[end + 4..]).into_owned() };
            }
        }
    }
}

pub(super) async fn bind() -> (TcpListener, u16) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    (listener, port)
}

/// Answers one request per reply, in order, and returns what it received.
pub(super) fn serve(listener: TcpListener, replies: Vec<Reply>) -> tokio::task::JoinHandle<Vec<Seen>> {
    tokio::spawn(async move {
        let mut seen = Vec::new();
        let mut held = Vec::new();
        for reply in replies {
            let (mut stream, _) =
                tokio::time::timeout(Duration::from_secs(5), listener.accept()).await.unwrap().unwrap();
            seen.push(read_request(&mut stream).await);
            let respond = async move {
                tokio::time::sleep(reply.delay).await;
                let head = format!(
                    "HTTP/1.1 {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    reply.status,
                    reply.body.len()
                );
                let _ = stream.write_all(head.as_bytes()).await;
                let _ = stream.write_all(&reply.body).await;
            };
            if reply.delay.is_zero() {
                respond.await;
            } else {
                held.push(tokio::spawn(respond));
            }
        }
        seen
    })
}

pub(super) fn source(port: u16) -> DataSource {
    DataSource {
        id: "sf".into(),
        name: "sf".into(),
        driver: DbDriver::Snowflake,
        host: "127.0.0.1".into(),
        port: Some(port),
        user: "jane".into(),
        database: "ANALYTICS".into(),
        ssl: DbSslMode::Disable,
        options: DbOptions { default_schema: "PUBLIC".into(), ..Default::default() },
        snowflake: Some(DbSnowflake {
            warehouse: "COMPUTE_WH".into(),
            role: "ANALYST".into(),
            private_key_file: KEY.into(),
            ..Default::default()
        }),
        ..Default::default()
    }
}

pub(super) fn result(rowtype: Value, rowset: Value) -> String {
    json!({ "success": true, "code": null, "data": { "rowtype": rowtype, "rowset": rowset, "queryResultFormat": "json",
        "statementTypeId": 4096, "total": 0, "chunks": [] } })
    .to_string()
}

fn one() -> String {
    result(json!([{ "name": "N", "type": "fixed", "precision": 1, "scale": 0 }]), json!([["1"]]))
}

async fn failure(source: &DataSource, secret: Option<&str>) -> IdeError {
    match Pool::connect(source, secret, None).await {
        Ok(_) => panic!("the connection was accepted"),
        Err(error) => error,
    }
}

#[tokio::test]
async fn key_pair_login_then_a_statement_on_the_session() {
    let (listener, port) = bind().await;
    let server = serve(listener, vec![ok(LOGIN_OK), ok(one()), ok(CLOSED_OK)]);
    let mut source = source(port);
    source.options.time_zone = "Europe/Kyiv".into();
    source.properties = vec![
        DbProperty { name: "query_tag".into(), value: "ide".into() },
        DbProperty { name: "statement_timeout_in_seconds".into(), value: "60".into() },
        DbProperty { name: "client_session_keep_alive".into(), value: "true".into() },
    ];
    let pool = Pool::connect(&source, None, None).await.unwrap();
    let cancel = CancellationToken::new();
    let rows = pool.execute("select 1", 10, &cancel).await.unwrap();
    assert_eq!(rows.rows, vec![vec![Some("1".to_owned())]]);
    assert_eq!(rows.columns[0].name, "N");
    assert_eq!(rows.columns[0].type_name, "NUMBER(1,0)");
    assert_eq!(rows.affected, None);
    assert!(!rows.has_more);
    pool.close().await;
    assert!(pool.is_closed());
    let seen = server.await.unwrap();

    let login = &seen[0];
    assert!(login.line().starts_with("POST /session/v1/login-request?"), "{}", login.line());
    for parameter in
        ["databaseName=ANALYTICS", "schemaName=PUBLIC", "warehouse=COMPUTE_WH", "roleName=ANALYST", "requestId="]
    {
        assert!(login.line().contains(parameter), "{parameter}: {}", login.line());
    }
    assert_eq!(login.header("accept"), Some("application/snowflake"));
    assert_eq!(login.header("authorization"), None);
    let data = &login.json()["data"];
    assert_eq!(data["AUTHENTICATOR"], "SNOWFLAKE_JWT");
    assert_eq!(data["LOGIN_NAME"], "jane");
    assert_eq!(data["ACCOUNT_NAME"], "127");
    assert_eq!(data["CLIENT_APP_ID"], "OpenIDEA");
    assert!(data.get("PASSWORD").is_none());
    assert_eq!(
        data["SESSION_PARAMETERS"],
        json!({ "QUERY_TAG": "ide", "STATEMENT_TIMEOUT_IN_SECONDS": 60, "CLIENT_SESSION_KEEP_ALIVE": true, "TIMEZONE": "Europe/Kyiv" })
    );
    let token = data["TOKEN"].as_str().unwrap();
    let claims: Value = serde_json::from_slice(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(token.split('.').nth(1).unwrap()).unwrap(),
    )
    .unwrap();
    assert_eq!(claims["sub"], "127.JANE");
    assert_eq!(claims["iss"], format!("127.JANE.{FINGERPRINT}"));

    let query = &seen[1];
    assert!(query.line().starts_with("POST /queries/v1/query-request?requestId="), "{}", query.line());
    assert_eq!(query.header("authorization"), Some("Snowflake Token=\"session-token-1\""));
    let body = query.json();
    assert_eq!(body["sqlText"], "select 1");
    assert_eq!(body["asyncExec"], false);
    assert_eq!(body["parameters"]["ROWS_PER_RESULTSET"], 11);
    assert_eq!(body["sequenceId"], 1);

    let close = &seen[2];
    assert!(close.line().starts_with("POST /session?delete=true"), "{}", close.line());
    assert_eq!(close.header("authorization"), Some("Snowflake Token=\"session-token-1\""));
}

#[tokio::test]
async fn a_rejected_key_explains_itself_and_shows_the_fingerprint() {
    let (listener, port) = bind().await;
    let refused = r#"{"success":false,"code":"390144","message":"JWT token is invalid. [0ce9eb56-821d-4ca9-a774-04ae89a0cf5a]","data":{"authnMethod":"SNOWFLAKE_JWT"}}"#;
    let server = serve(listener, vec![ok(refused)]);
    let error = failure(&source(port), None).await;
    assert_eq!(error.kind, ErrorKind::InvalidInput);
    assert!(error.message.starts_with("Snowflake [390144]: JWT token is invalid."), "{}", error.message);
    assert!(error.message.contains("ALTER USER"), "{}", error.message);
    assert!(error.message.ends_with(&format!("Fingerprint of this private key: {FINGERPRINT}")), "{}", error.message);
    server.await.unwrap();
}

#[tokio::test]
async fn key_problems_are_found_before_any_request() {
    // Nothing listens: a request would fail with a network error instead.
    let (listener, port) = bind().await;
    drop(listener);
    let mut encrypted = source(port);
    encrypted.snowflake.as_mut().unwrap().private_key_file = ENCRYPTED_KEY.into();
    let error = failure(&encrypted, None).await;
    assert_eq!(error.kind, ErrorKind::PermissionDenied);
    assert_eq!(error.message, "the private key is encrypted; enter its passphrase");
    let error = failure(&encrypted, Some("wrong")).await;
    assert_eq!(error.kind, ErrorKind::PermissionDenied);
    assert_eq!(error.message, "incorrect passphrase for the private key");

    let mut missing = source(port);
    missing.snowflake.as_mut().unwrap().private_key_file = String::new();
    assert_eq!(failure(&missing, None).await.message, "select the private key file of the Snowflake user");
    let mut no_user = source(port);
    no_user.user = " ".into();
    assert_eq!(failure(&no_user, None).await.message, "enter the Snowflake user name");
    let mut reserved = source(port);
    reserved.properties = vec![DbProperty { name: "rows_per_resultset".into(), value: "5".into() }];
    assert!(failure(&reserved, None).await.message.contains("manages the rows_per_resultset parameter"));
    let mut no_account = source(port);
    no_account.host = String::new();
    assert!(failure(&no_account, None).await.message.contains("account identifier"));
    for auth in [DbSnowflakeAuth::Password, DbSnowflakeAuth::Token, DbSnowflakeAuth::OAuth] {
        let mut source = source(port);
        source.snowflake.as_mut().unwrap().auth = auth;
        let error = failure(&source, None).await;
        assert_eq!(error.kind, ErrorKind::PermissionDenied, "{auth:?}");
        assert!(error.message.starts_with("enter the "), "{}", error.message);
    }
}

#[tokio::test]
async fn an_encrypted_key_signs_in_with_its_passphrase_and_never_leaks_it() {
    let (listener, port) = bind().await;
    // A server that echoes what it was sent must not get the secrets into an error message.
    let echo =
        r#"{"success":false,"code":"002003","message":"bad statement test-passphrase session-token-1 master-token-1"}"#;
    let server = serve(listener, vec![ok(LOGIN_OK), ok(echo), ok(CLOSED_OK)]);
    let mut source = source(port);
    source.snowflake.as_mut().unwrap().private_key_file = ENCRYPTED_KEY.into();
    let pool = Pool::connect(&source, Some("test-passphrase"), None).await.unwrap();
    let error = pool.execute("select nope", 1, &CancellationToken::new()).await.unwrap_err();
    assert_eq!(error.kind, ErrorKind::InvalidInput);
    assert_eq!(error.message, "Snowflake [002003]: bad statement [redacted] [redacted] [redacted]");
    pool.close().await;
    let seen = server.await.unwrap();
    assert!(!seen[0].body.contains("test-passphrase"));
    assert!(!seen[0].head.contains("test-passphrase"));
}

#[tokio::test]
async fn password_and_token_methods_send_their_own_proof() {
    for (auth, secret, expected) in [
        (DbSnowflakeAuth::Password, "pa55word!", json!({ "PASSWORD": "pa55word!" })),
        (
            DbSnowflakeAuth::Token,
            "pat-value-1",
            json!({ "AUTHENTICATOR": "PROGRAMMATIC_ACCESS_TOKEN", "TOKEN": "pat-value-1" }),
        ),
        (DbSnowflakeAuth::OAuth, "oauth-value-1", json!({ "AUTHENTICATOR": "OAUTH", "TOKEN": "oauth-value-1" })),
    ] {
        let (listener, port) = bind().await;
        let server = serve(listener, vec![ok(LOGIN_OK), ok(CLOSED_OK)]);
        let mut source = source(port);
        source.snowflake.as_mut().unwrap().auth = auth;
        let pool = Pool::connect(&source, Some(secret), None).await.unwrap();
        pool.close().await;
        let seen = server.await.unwrap();
        let data = &seen[0].json()["data"];
        for (name, value) in expected.as_object().unwrap() {
            assert_eq!(&data[name], value, "{auth:?} {name}");
        }
        if auth == DbSnowflakeAuth::Password {
            assert!(data.get("AUTHENTICATOR").is_none());
        }
    }
}

#[tokio::test]
async fn a_wrong_password_asks_again() {
    let (listener, port) = bind().await;
    let refused = r#"{"success":false,"code":"390100","message":"Incorrect username or password was specified."}"#;
    let server = serve(listener, vec![ok(refused)]);
    let mut source = source(port);
    source.snowflake.as_mut().unwrap().auth = DbSnowflakeAuth::Password;
    let error = failure(&source, Some("pa55word!")).await;
    assert_eq!(error.kind, ErrorKind::PermissionDenied);
    assert_eq!(error.message, "Snowflake [390100]: Incorrect username or password was specified.");
    server.await.unwrap();
}

#[tokio::test]
async fn an_unknown_account_is_named() {
    let (listener, port) = bind().await;
    let server = serve(
        listener,
        vec![Reply { status: "403 Forbidden", body: b"<html>Forbidden</html>".to_vec(), delay: Duration::ZERO }],
    );
    let error = failure(&source(port), None).await;
    assert_eq!(error.kind, ErrorKind::InvalidInput);
    assert_eq!(error.message, "Snowflake has no account at 127.0.0.1 (HTTP 403): check the account identifier");
    server.await.unwrap();
}

#[tokio::test]
async fn pages_skip_whole_chunks_and_stop_after_the_page() {
    let (listener, port) = bind().await;
    let rowtype =
        json!([{ "name": "ID", "type": "fixed", "precision": 38, "scale": 0 }, { "name": "D", "type": "date" }]);
    let chunk = |n: u16| format!("http://127.0.0.1:{port}/chunk{n}");
    let body = json!({ "success": true, "data": {
        "rowtype": rowtype, "rowset": [["1", "0"], ["2", "1"]], "queryResultFormat": "json", "statementTypeId": 4096,
        "chunks": [
            { "url": chunk(1), "rowCount": 2 }, { "url": chunk(2), "rowCount": 3 }, { "url": chunk(3), "rowCount": 2 },
        ],
        "chunkHeaders": { "x-amz-server-side-encryption-customer-key": "key-1" },
    } })
    .to_string();
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    std::io::Write::write_all(&mut gz, br#"["5","4"],["6","5"],["7",null]"#).unwrap();
    let second = Reply { status: "200 OK", body: gz.finish().unwrap(), delay: Duration::ZERO };
    // Rows 5 and 6 (skip 4, keep 2): the first chunk is skipped, the third never fetched.
    let server = serve(listener, vec![ok(LOGIN_OK), ok(body), second, ok(CLOSED_OK)]);
    let pool = Pool::connect(&source(port), None, None).await.unwrap();
    let page = pool.execute_from("select id, d from t", 4, 2, &CancellationToken::new()).await.unwrap();
    assert_eq!(
        page.rows,
        vec![vec![Some("5".into()), Some("1970-01-05".into())], vec![Some("6".into()), Some("1970-01-06".into())]]
    );
    assert!(page.has_more);
    assert_eq!(page.columns[1].type_name, "DATE");
    pool.close().await;
    let seen = server.await.unwrap();
    assert_eq!(seen[1].json()["parameters"]["ROWS_PER_RESULTSET"], 7);
    assert_eq!(seen[2].line(), "GET /chunk2 HTTP/1.1");
    assert_eq!(seen[2].header("x-amz-server-side-encryption-customer-key"), Some("key-1"));
    assert_eq!(seen[2].header("authorization"), None);
}

#[tokio::test]
async fn a_long_statement_is_polled_until_it_finishes() {
    let (listener, port) = bind().await;
    let running = |code: &str| {
        json!({ "success": true, "code": code, "message": "Query execution in progress.",
            "data": { "getResultUrl": "/queries/01b2c3/result", "queryId": "01b2c3" } })
        .to_string()
    };
    let server =
        serve(listener, vec![ok(LOGIN_OK), ok(running("333333")), ok(running("333334")), ok(one()), ok(CLOSED_OK)]);
    let pool = Pool::connect(&source(port), None, None).await.unwrap();
    let done = pool.execute("call system$wait(60)", 5, &CancellationToken::new()).await.unwrap();
    assert_eq!(done.rows, vec![vec![Some("1".to_owned())]]);
    pool.close().await;
    let seen = server.await.unwrap();
    for poll in &seen[2..4] {
        assert_eq!(poll.line(), "GET /queries/01b2c3/result HTTP/1.1");
        assert_eq!(poll.header("authorization"), Some("Snowflake Token=\"session-token-1\""));
    }
}

#[tokio::test]
async fn an_expired_session_token_is_renewed_and_the_statement_repeated() {
    let (listener, port) = bind().await;
    let expired = r#"{"success":false,"code":"390112","message":"Your session has expired. Please login again."}"#;
    let renewed = r#"{"success":true,"data":{"sessionToken":"session-token-2","masterToken":"master-token-2"}}"#;
    let server = serve(listener, vec![ok(LOGIN_OK), ok(expired), ok(renewed), ok(one()), ok(CLOSED_OK)]);
    let pool = Pool::connect(&source(port), None, None).await.unwrap();
    let done = pool.execute("select 1", 5, &CancellationToken::new()).await.unwrap();
    assert_eq!(done.rows.len(), 1);
    pool.close().await;
    let seen = server.await.unwrap();
    assert!(seen[2].line().starts_with("POST /session/token-request?requestId="), "{}", seen[2].line());
    assert_eq!(seen[2].header("authorization"), Some("Snowflake Token=\"master-token-1\""));
    assert_eq!(seen[2].json(), json!({ "oldSessionToken": "session-token-1", "requestType": "RENEW" }));
    assert_eq!(seen[3].header("authorization"), Some("Snowflake Token=\"session-token-2\""));
    assert_eq!(seen[4].header("authorization"), Some("Snowflake Token=\"session-token-2\""));
}

#[tokio::test]
async fn a_lost_session_signs_in_again() {
    let (listener, port) = bind().await;
    let gone = r#"{"success":false,"code":"390114","message":"Authentication token has expired. The user must authenticate again."}"#;
    let again = r#"{"success":true,"data":{"token":"session-token-3","masterToken":"master-token-3"}}"#;
    let server = serve(listener, vec![ok(LOGIN_OK), ok(gone), ok(again), ok(one()), ok(CLOSED_OK)]);
    let pool = Pool::connect(&source(port), None, None).await.unwrap();
    pool.execute("select 1", 5, &CancellationToken::new()).await.unwrap();
    pool.close().await;
    let seen = server.await.unwrap();
    assert!(seen[2].line().starts_with("POST /session/v1/login-request?"), "{}", seen[2].line());
    assert_eq!(seen[3].header("authorization"), Some("Snowflake Token=\"session-token-3\""));
}

#[tokio::test]
async fn cancelling_aborts_the_statement_on_the_server() {
    let (listener, port) = bind().await;
    let slow = Reply { status: "200 OK", body: one().into_bytes(), delay: Duration::from_secs(30) };
    let server = serve(listener, vec![ok(LOGIN_OK), slow, ok(r#"{"success":true,"data":null}"#), ok(CLOSED_OK)]);
    let pool = Pool::connect(&source(port), None, None).await.unwrap();
    let cancel = CancellationToken::new();
    let statement = pool.execute("call system$wait(600)", 5, &cancel);
    let stop = async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        cancel.cancel();
    };
    let (outcome, ()) = tokio::join!(statement, stop);
    let error = outcome.unwrap_err();
    assert_eq!(error.kind, ErrorKind::Cancelled);
    assert_eq!(error.message, "cancelled");
    pool.close().await;
    let seen = server.await.unwrap();
    let request_id =
        |line: &str| line.split(['?', '&', ' ']).find_map(|p| p.strip_prefix("requestId=")).unwrap().to_owned();
    assert!(seen[2].line().starts_with("POST /queries/v1/abort-request?"), "{}", seen[2].line());
    let abort = seen[2].json();
    assert_eq!(abort["sqlText"], "call system$wait(600)");
    assert_eq!(abort["requestId"], request_id(seen[1].line()));
    assert_ne!(request_id(seen[2].line()), request_id(seen[1].line()));
}

#[tokio::test]
async fn changes_report_counts_and_commands_report_nothing() {
    let (listener, port) = bind().await;
    let merged = json!({ "success": true, "data": {
        "rowtype": [{ "name": "number of rows inserted", "type": "fixed" }, { "name": "number of rows updated", "type": "fixed" }],
        "rowset": [["3", "4"]], "queryResultFormat": "json", "statementTypeId": 0x3400 } })
    .to_string();
    let created = json!({ "success": true, "data": {
        "rowtype": [{ "name": "status", "type": "text" }], "rowset": [["Table T successfully created."]],
        "queryResultFormat": "json", "statementTypeId": 0x6100 } })
    .to_string();
    let server = serve(listener, vec![ok(LOGIN_OK), ok(merged), ok(created), ok(CLOSED_OK)]);
    let pool = Pool::connect(&source(port), None, None).await.unwrap();
    let cancel = CancellationToken::new();
    let merge = pool.execute("merge into t using s on …", 10, &cancel).await.unwrap();
    assert_eq!((merge.affected, merge.columns.len(), merge.rows.len()), (Some(7.0), 0, 0));
    let create = pool.execute("create table t (id int)", 10, &cancel).await.unwrap();
    assert_eq!((create.affected, create.columns.len(), create.rows.len()), (Some(0.0), 0, 0));
    pool.close().await;
    server.await.unwrap();
}

#[tokio::test]
async fn a_read_only_data_source_refuses_writes_without_sending_them() {
    let (listener, port) = bind().await;
    let server = serve(listener, vec![ok(LOGIN_OK), ok(one()), ok(one()), ok(CLOSED_OK)]);
    let mut source = source(port);
    source.read_only = true;
    source.options.startup_script = "alter session set week_start = 1".into();
    let pool = Pool::connect(&source, None, None).await.unwrap();
    let cancel = CancellationToken::new();
    for write in
        ["delete from t", "  -- note\n  /* x */ INSERT INTO t VALUES (1)", "create table x (i int)", "// c\ncall p()"]
    {
        let error = pool.execute(write, 1, &cancel).await.unwrap_err();
        assert_eq!(error.kind, ErrorKind::InvalidInput);
        assert!(error.message.starts_with("read-only data source: "), "{}", error.message);
    }
    assert!(pool.transaction(&[("update t set a = 1".into(), true)]).await.is_err());
    pool.execute("-- reads pass\nwith x as (select 1) select * from x", 1, &cancel).await.unwrap();
    pool.close().await;
    let seen = server.await.unwrap();
    assert_eq!(seen[1].json()["sqlText"], "alter session set week_start = 1");
}

#[tokio::test]
async fn table_edits_commit_together_or_roll_back() {
    let changed = |n: &str| {
        json!({ "success": true, "data": { "rowtype": [{ "name": "number of rows updated", "type": "fixed" }],
            "rowset": [[n]], "queryResultFormat": "json", "statementTypeId": 0x3200 } })
        .to_string()
    };
    let status = || {
        json!({ "success": true, "data": { "rowtype": [{ "name": "status", "type": "text" }],
            "rowset": [["Statement executed successfully."]], "queryResultFormat": "json", "statementTypeId": 0x5000 } })
        .to_string()
    };
    let edits =
        [("update t set a = 1 where id = 1".to_owned(), true), ("update t set a = 2 where id = 2".to_owned(), true)];

    let (listener, port) = bind().await;
    let server = serve(
        listener,
        vec![ok(LOGIN_OK), ok(status()), ok(changed("1")), ok(changed("1")), ok(status()), ok(CLOSED_OK)],
    );
    let pool = Pool::connect(&source(port), None, None).await.unwrap();
    assert_eq!(pool.transaction(&edits).await.unwrap(), 2);
    pool.close().await;
    let sent: Vec<String> =
        server.await.unwrap()[1..5].iter().map(|r| r.json()["sqlText"].as_str().unwrap().to_owned()).collect();
    assert_eq!(sent, ["BEGIN", "update t set a = 1 where id = 1", "update t set a = 2 where id = 2", "COMMIT"]);

    let (listener, port) = bind().await;
    let server = serve(listener, vec![ok(LOGIN_OK), ok(status()), ok(changed("0")), ok(status()), ok(CLOSED_OK)]);
    let pool = Pool::connect(&source(port), None, None).await.unwrap();
    let error = pool.transaction(&edits).await.unwrap_err();
    assert!(error.message.contains("expected to change 1 row, changed 0; nothing was saved"), "{}", error.message);
    pool.close().await;
    let sent: Vec<String> =
        server.await.unwrap()[1..4].iter().map(|r| r.json()["sqlText"].as_str().unwrap().to_owned()).collect();
    assert_eq!(sent, ["BEGIN", "update t set a = 1 where id = 1", "ROLLBACK"]);
}

#[tokio::test]
async fn an_arrow_result_is_refused_instead_of_shown_empty() {
    let (listener, port) = bind().await;
    let arrow = json!({ "success": true, "data": { "rowtype": [{ "name": "N", "type": "fixed" }],
        "rowsetBase64": "QVJST1c=", "queryResultFormat": "arrow", "statementTypeId": 4096 } })
    .to_string();
    let server = serve(listener, vec![ok(LOGIN_OK), ok(arrow), ok(CLOSED_OK)]);
    let pool = Pool::connect(&source(port), None, None).await.unwrap();
    let error = pool.execute("select 1", 1, &CancellationToken::new()).await.unwrap_err();
    assert_eq!(error.kind, ErrorKind::Protocol);
    pool.close().await;
    server.await.unwrap();
}

#[test]
fn read_only_knows_reads_from_writes() {
    for read in [
        "select 1",
        "WITH a AS (select 1) select * from a",
        "show tables",
        "desc table t",
        "explain select 1",
        "ls @stage",
        "use schema s",
        "",
    ] {
        assert!(!is_write(read), "{read}");
    }
    for write in [
        "insert into t values (1)",
        "COPY INTO t FROM @s",
        "put file://x @s",
        "truncate t",
        "grant select on t to role r",
        "begin",
    ] {
        assert!(is_write(write), "{write}");
    }
}

#[tokio::test]
async fn browser_sign_in_presents_the_token_and_proof_key_then_reuses_the_id_token() {
    let (listener, port) = bind().await;
    let page =
        r#"{"success":true,"data":{"ssoUrl":"https://idp.example/sso?SAMLRequest=abc","proofKey":"proof-key-1"}}"#;
    let signed_in =
        r#"{"success":true,"data":{"token":"session-token-1","masterToken":"master-token-1","idToken":"id-token-1"}}"#;
    let again = r#"{"success":true,"data":{"token":"session-token-2","masterToken":"master-token-2"}}"#;
    let stale = r#"{"success":false,"code":"390195","message":"The provided ID Token is invalid."}"#;
    let server = serve(
        listener,
        vec![
            // First connection: the browser.
            ok(page),
            ok(signed_in),
            ok(CLOSED_OK),
            // Second connection: the ID token alone.
            ok(again),
            ok(CLOSED_OK),
            // Third: the ID token is refused, so the browser again.
            ok(stale),
            ok(page),
            ok(signed_in),
            ok(CLOSED_OK),
        ],
    );
    let opened = Arc::new(parking_lot::Mutex::new(Vec::<String>::new()));
    let pages = opened.clone();
    // The stand-in browser: the identity provider sends it back to the listener with a token.
    *browser::TEST_OPENER.lock() = Some(Box::new(move |url, redirect_port| {
        pages.lock().push(url.to_owned());
        tokio::spawn(async move {
            let mut stream = TcpStream::connect(("127.0.0.1", redirect_port)).await.unwrap();
            // A browser also asks for the tab's icon; that request must not end the sign-in.
            stream.write_all(b"GET /favicon.ico HTTP/1.1\r\nHost: localhost\r\n\r\n").await.unwrap();
            let mut reply = Vec::new();
            stream.read_to_end(&mut reply).await.unwrap();
            assert!(reply.starts_with(b"HTTP/1.1 404"));
            let mut stream = TcpStream::connect(("127.0.0.1", redirect_port)).await.unwrap();
            stream.write_all(b"GET /?token=sso%2Btoken-1 HTTP/1.1\r\nHost: localhost\r\n\r\n").await.unwrap();
            let mut reply = Vec::new();
            stream.read_to_end(&mut reply).await.unwrap();
            let reply = String::from_utf8_lossy(&reply).into_owned();
            assert!(reply.starts_with("HTTP/1.1 200 OK"), "{reply}");
            assert!(reply.contains("return to OpenIDEA"), "{reply}");
        });
        Ok(())
    }));
    let mut source = source(port);
    source.snowflake.as_mut().unwrap().auth = DbSnowflakeAuth::Browser;
    source.snowflake.as_mut().unwrap().private_key_file = String::new();
    for _ in 0..3 {
        let pool = Pool::connect(&source, None, None).await.unwrap();
        pool.close().await;
    }
    *browser::TEST_OPENER.lock() = None;
    let seen = server.await.unwrap();
    assert_eq!(*opened.lock(), ["https://idp.example/sso?SAMLRequest=abc"; 2]);

    assert!(seen[0].line().starts_with("POST /session/authenticator-request?requestId="), "{}", seen[0].line());
    let asked = &seen[0].json()["data"];
    assert_eq!(asked["AUTHENTICATOR"], "EXTERNALBROWSER");
    assert_eq!(asked["LOGIN_NAME"], "jane");
    assert_eq!(asked["ACCOUNT_NAME"], "127");
    assert!(asked["BROWSER_MODE_REDIRECT_PORT"].as_str().unwrap().parse::<u16>().unwrap() > 0);

    let first = &seen[1].json()["data"];
    assert_eq!(first["AUTHENTICATOR"], "EXTERNALBROWSER");
    assert_eq!(first["TOKEN"], "sso+token-1");
    assert_eq!(first["PROOF_KEY"], "proof-key-1");
    assert_eq!(first["SESSION_PARAMETERS"]["CLIENT_STORE_TEMPORARY_CREDENTIAL"], true);
    assert!(first.get("PASSWORD").is_none());

    let second = &seen[3].json()["data"];
    assert_eq!(second["AUTHENTICATOR"], "ID_TOKEN");
    assert_eq!(second["TOKEN"], "id-token-1");
    assert!(second.get("PROOF_KEY").is_none());

    assert_eq!(seen[5].json()["data"]["AUTHENTICATOR"], "ID_TOKEN");
    assert!(seen[6].line().starts_with("POST /session/authenticator-request?"), "{}", seen[6].line());
    assert_eq!(seen[7].json()["data"]["AUTHENTICATOR"], "EXTERNALBROWSER");
}

#[tokio::test]
async fn an_account_without_browser_sign_in_says_so() {
    let (listener, port) = bind().await;
    let refused = r#"{"success":false,"code":"390190","message":"There was an error related to the SAML Identity Provider account parameter."}"#;
    let server = serve(listener, vec![ok(refused)]);
    let mut source = source(port);
    source.user = "nobody".into();
    source.snowflake.as_mut().unwrap().auth = DbSnowflakeAuth::Browser;
    let error = failure(&source, None).await;
    assert_eq!(error.kind, ErrorKind::InvalidInput);
    assert!(
        error.message.starts_with("Snowflake [390190]: There was an error related to the SAML"),
        "{}",
        error.message
    );
    server.await.unwrap();
}

#[tokio::test]
async fn a_console_schema_is_switched_with_its_statement_and_only_when_needed() {
    let status = || {
        json!({ "success": true, "data": { "rowtype": [{ "name": "status", "type": "text" }],
            "rowset": [["Statement executed successfully."]], "queryResultFormat": "json", "statementTypeId": 0x5000 } })
        .to_string()
    };
    let (listener, port) = bind().await;
    let mut replies = vec![ok(LOGIN_OK)];
    // use Sales, 1, 2 | restore PUBLIC, 3 | 4 | use database (the user's), then PUBLIC again, 5
    for body in [status(), one(), one(), status(), one(), one(), status(), status(), one()] {
        replies.push(ok(body));
    }
    replies.push(ok(CLOSED_OK));
    let server = serve(listener, replies);
    let pool = Pool::connect(&source(port), None, None).await.unwrap();
    let cancel = CancellationToken::new();
    let mut console = crate::conn::Held::acquire(&pool).await.unwrap();
    console.apply_context(Some("Sales \"2024\"")).await.unwrap();
    console.execute(&pool, "select 1", 1, &cancel).await.unwrap();
    console.execute(&pool, "select 2", 1, &cancel).await.unwrap();
    // The tree and other consoles run in the data source's schema.
    pool.execute("select 3", 1, &cancel).await.unwrap();
    pool.execute("select 4", 1, &cancel).await.unwrap();
    // After the user's own USE the session may be anywhere: the schema is set again.
    pool.execute("use database OTHER", 0, &cancel).await.unwrap();
    pool.execute("select 5", 1, &cancel).await.unwrap();
    pool.close().await;
    let sent: Vec<String> =
        server.await.unwrap()[1..10].iter().map(|r| r.json()["sqlText"].as_str().unwrap().to_owned()).collect();
    assert_eq!(
        sent,
        [
            "USE SCHEMA \"ANALYTICS\".\"Sales \"\"2024\"\"\"",
            "select 1",
            "select 2",
            "USE SCHEMA \"ANALYTICS\".\"PUBLIC\"",
            "select 3",
            "select 4",
            "use database OTHER",
            "USE SCHEMA \"ANALYTICS\".\"PUBLIC\"",
            "select 5",
        ]
    );
}

#[tokio::test]
async fn a_role_that_may_not_use_the_schema_still_runs_statements() {
    let status = || {
        json!({ "success": true, "data": { "rowtype": [{ "name": "status", "type": "text" }],
            "rowset": [["Statement executed successfully."]], "queryResultFormat": "json", "statementTypeId": 0x5000 } })
        .to_string()
    };
    let refused = r#"{"success":false,"code":"002043","message":"SQL compilation error:\nObject does not exist, or operation cannot be performed."}"#;
    let (listener, port) = bind().await;
    // use role | the schema is refused once, the statement runs | the next one does not ask again |
    // a role that is not granted | use role back, the schema is entered again
    let replies = vec![
        ok(LOGIN_OK),
        ok(status()),
        ok(refused),
        ok(one()),
        ok(one()),
        ok(refused),
        ok(status()),
        ok(status()),
        ok(one()),
        ok(CLOSED_OK),
    ];
    let server = serve(listener, replies);
    let pool = Pool::connect(&source(port), None, None).await.unwrap();
    let cancel = CancellationToken::new();
    pool.execute("use role auditor", 0, &cancel).await.unwrap();
    pool.execute("select 1", 1, &cancel).await.unwrap();
    pool.execute("select 2", 1, &cancel).await.unwrap();
    let missing = pool.execute("use role nobody", 0, &cancel).await.unwrap_err();
    assert!(missing.message.contains("002043") && missing.message.contains("granted"), "{}", missing.message);
    pool.execute("use role analyst", 0, &cancel).await.unwrap();
    pool.execute("select 3", 1, &cancel).await.unwrap();
    pool.close().await;
    let sent: Vec<String> =
        server.await.unwrap()[1..9].iter().map(|r| r.json()["sqlText"].as_str().unwrap().to_owned()).collect();
    let schema = "USE SCHEMA \"ANALYTICS\".\"PUBLIC\"";
    assert_eq!(
        sent,
        ["use role auditor", schema, "select 1", "select 2", "use role nobody", "use role analyst", schema, "select 3"]
    );
}

#[tokio::test]
async fn databases_of_one_data_source_share_a_login() {
    let (listener, port) = bind().await;
    let status = json!({ "success": true, "data": { "rowtype": [{ "name": "status", "type": "text" }],
        "rowset": [["Statement executed successfully."]], "queryResultFormat": "json", "statementTypeId": 0x5000 } })
    .to_string();
    // One login; `select 1` in ANALYTICS; a switch and `select 2` in "Raw Data"; one session end.
    let server = serve(listener, vec![ok(LOGIN_OK), ok(one()), ok(status), ok(one()), ok(CLOSED_OK)]);
    let first = Pool::connect(&source(port), None, None).await.unwrap();
    let mut other = source(port);
    other.database = "Raw Data".into();
    other.options.default_schema = String::new();
    other.read_only = true;
    let second = Pool::connect(&other, None, None).await.unwrap();
    let cancel = CancellationToken::new();
    first.execute("select 1", 1, &cancel).await.unwrap();
    second.execute("select 2", 1, &cancel).await.unwrap();
    // Read-only is the target's own setting.
    assert!(second.execute("delete from t", 1, &cancel).await.is_err());
    first.close().await;
    assert!(first.is_closed() && !second.is_closed());
    assert!(first.execute("select 3", 1, &cancel).await.is_err());
    second.close().await;
    let seen = server.await.unwrap();
    let sent: Vec<String> = seen[1..4].iter().map(|r| r.json()["sqlText"].as_str().unwrap().to_owned()).collect();
    assert_eq!(sent, ["select 1", "USE DATABASE \"Raw Data\"", "select 2"]);
    assert!(seen[4].line().starts_with("POST /session?delete=true"), "{}", seen[4].line());
}

#[tokio::test]
async fn metadata_runs_on_its_own_session_beside_a_busy_console() {
    let (listener, port) = bind().await;
    let slow = Reply { status: "200 OK", body: one().into_bytes(), delay: Duration::from_millis(1500) };
    let second = r#"{"success":true,"data":{"token":"session-token-2","masterToken":"master-token-2"}}"#;
    let status = json!({ "success": true, "data": { "rowtype": [{ "name": "status", "type": "text" }],
        "rowset": [["Statement executed successfully."]], "queryResultFormat": "json", "statementTypeId": 0x5000 } })
    .to_string();
    // Console login and its slow statement; the metadata session logs in, enters the schema and answers meanwhile.
    let server =
        serve(listener, vec![ok(LOGIN_OK), slow, ok(second), ok(status), ok(one()), ok(CLOSED_OK), ok(CLOSED_OK)]);
    let pool = Pool::connect(&source(port), None, None).await.unwrap();
    let cancel = CancellationToken::new();
    let started = Instant::now();
    let console = pool.execute("call system$wait(60)", 1, &cancel);
    let tree = async {
        tokio::time::sleep(Duration::from_millis(200)).await;
        let rows = pool.rows("show terse schemas", 10).await.unwrap();
        (rows, started.elapsed())
    };
    let (console, (rows, tree_took)) = tokio::join!(console, tree);
    console.unwrap();
    assert_eq!(rows.len(), 1);
    assert!(tree_took < Duration::from_millis(1200), "the tree waited for the console: {tree_took:?}");
    pool.close().await;
    let seen = server.await.unwrap();
    assert!(seen[2].line().starts_with("POST /session/v1/login-request?"), "{}", seen[2].line());
    assert_eq!(seen[3].json()["sqlText"], "USE SCHEMA \"ANALYTICS\".\"PUBLIC\"");
    assert_eq!(seen[4].header("authorization"), Some("Snowflake Token=\"session-token-2\""));
    // Both sessions end with the connection.
    let ended: Vec<&str> = seen[5..7].iter().filter_map(|r| r.header("authorization")).collect();
    assert_eq!(ended.len(), 2);
    assert!(
        ended.contains(&"Snowflake Token=\"session-token-1\"")
            && ended.contains(&"Snowflake Token=\"session-token-2\"")
    );
}

#[tokio::test]
async fn a_database_is_introspected_schema_by_schema_when_its_whole_listing_is_refused() {
    let (listener, port) = bind().await;
    let second = r#"{"success":true,"data":{"token":"session-token-2","masterToken":"master-token-2"}}"#;
    let text = |name: &str| json!({ "name": name, "type": "text" });
    let terse = json!([text("created_on"), text("name"), text("kind"), text("database_name"), text("schema_name")]);
    let schemas = result(
        terse.clone(),
        json!([
            ["", "INFORMATION_SCHEMA", null, "RAW", null],
            ["", "PUBLIC", null, "RAW", null],
            ["", "STAGE", null, "RAW", null]
        ]),
    );
    let refused = r#"{"success":false,"code":"001003","message":"SQL compilation error: unsupported listing"}"#;
    let public = result(
        terse.clone(),
        json!([["", "ORDERS", "TABLE", "RAW", "PUBLIC"], ["", "DAILY", "VIEW", "RAW", "PUBLIC"]]),
    );
    let stage = result(terse, json!([["", "ORDERS", "TABLE", "RAW", "STAGE"]]));
    // Metadata session: login, schema context, the schemas, the refused listing, then each schema.
    let replies = vec![
        ok(LOGIN_OK),
        ok(second),
        ok(one()),
        ok(schemas),
        ok(refused),
        ok(public),
        ok(stage),
        ok(CLOSED_OK),
        ok(CLOSED_OK),
    ];
    let server = serve(listener, replies);
    let pool = Pool::connect(&source(port), None, None).await.unwrap();
    let Pool::Snowflake(snowflake) = &pool else { panic!("not a Snowflake pool") };
    let catalog = super::meta::catalog(snowflake, "RAW").await.unwrap();
    let names = |i: usize| catalog[i].tables.iter().map(|t| t.name.as_str()).collect::<Vec<_>>();
    assert_eq!(catalog.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["PUBLIC", "STAGE"]);
    assert_eq!(names(0), ["DAILY", "ORDERS"]);
    assert_eq!(names(1), ["ORDERS"]);
    pool.close().await;
    let seen = server.await.unwrap();
    let sql = |i: usize| seen[i].json()["sqlText"].as_str().unwrap_or_default().to_owned();
    assert_eq!(sql(3), "SHOW TERSE SCHEMAS IN DATABASE \"RAW\" LIMIT 10000");
    assert_eq!(sql(4), "SHOW TERSE OBJECTS IN DATABASE \"RAW\" LIMIT 10000");
    assert_eq!(sql(5), "SHOW TERSE OBJECTS IN SCHEMA \"RAW\".\"PUBLIC\" LIMIT 10000");
    assert_eq!(sql(6), "SHOW TERSE OBJECTS IN SCHEMA \"RAW\".\"STAGE\" LIMIT 10000");
}

#[tokio::test]
async fn targets_opened_at_the_same_time_sign_in_once() {
    let (listener, port) = bind().await;
    // Had each connect signed in, the server would be asked for more than this one login.
    let slow_login = Reply { status: "200 OK", body: LOGIN_OK.as_bytes().to_vec(), delay: Duration::from_millis(300) };
    let server = serve(listener, vec![slow_login, ok(CLOSED_OK)]);
    let base = source(port);
    let mut others = Vec::new();
    for database in ["RAW", "STAGING", "MARTS"] {
        let mut other = source(port);
        other.database = database.into();
        others.push(other);
    }
    let (a, b, c, d) = tokio::join!(
        Pool::connect(&base, None, None),
        Pool::connect(&others[0], None, None),
        Pool::connect(&others[1], None, None),
        Pool::connect(&others[2], None, None),
    );
    let pools = [a.unwrap(), b.unwrap(), c.unwrap(), d.unwrap()];
    for pool in &pools {
        pool.close().await;
    }
    let seen = server.await.unwrap();
    assert_eq!(seen.len(), 2);
    assert!(seen[0].line().starts_with("POST /session/v1/login-request?"), "{}", seen[0].line());
    assert!(seen[1].line().starts_with("POST /session?delete=true"), "{}", seen[1].line());
}

#[test]
fn single_sign_on_tokens_are_keyed_by_account_and_user_and_only_for_browser_sign_in() {
    let mut source = source(443);
    source.host = "myorg-myaccount".into();
    source.port = None;
    source.ssl = DbSslMode::Prefer;
    assert_eq!(sso_key(&source), None);
    source.snowflake.as_mut().unwrap().auth = DbSnowflakeAuth::Browser;
    let key = sso_key(&source).unwrap();
    assert_eq!(key, "myorg-myaccount.snowflakecomputing.com:443|JANE");
    assert_eq!(sso_token(&key), None);
    sso_seed(&key, "saved-id-token");
    assert_eq!(sso_token(&key).as_deref(), Some("saved-id-token"));
    // A token already in use is not replaced by an older saved one.
    sso_seed(&key, "stale");
    assert_eq!(sso_token(&key).as_deref(), Some("saved-id-token"));
    browser::forget(&key);
}
