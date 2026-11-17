//! Single sign-on in the web browser (Snowflake's `externalbrowser` authenticator): Snowflake
//! names the identity provider's page, the browser signs in there and is sent back to a
//! listener on this computer with a one-time token, which the login request then presents
//! together with the proof key Snowflake issued for this attempt.

use super::client::{Api, Request};
use super::{APP, error, uuid};
use ide_core::{IdeError, IdeResult, error::ErrorKind};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const AUTHENTICATOR: &str = "session/authenticator-request";
/// How long the user has to finish signing in.
const WAIT: Duration = Duration::from_secs(120);
const DONE_PAGE: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><title>OpenIDEA</title></head>\
<body style=\"font-family: sans-serif; margin: 3em\"><h3>Signed in to Snowflake</h3>\
<p>You can close this tab and return to OpenIDEA.</p></body></html>";

/// One browser sign-in at a time: connections opened together share its outcome through [`cached`].
pub(crate) static FLOW: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

/// ID tokens Snowflake issued after a browser sign-in, by account address and user. They let
/// further sessions of this run open without the browser. Kept in memory only.
static ID_TOKENS: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

pub(crate) fn cached(key: &str) -> Option<String> {
    ID_TOKENS.lock().get(key).cloned()
}

pub(crate) fn remember(key: &str, token: &str) {
    ID_TOKENS.lock().insert(key.to_owned(), token.to_owned());
}

pub(crate) fn forget(key: &str) {
    ID_TOKENS.lock().remove(key);
}

/// What opens the sign-in page; tests put a stand-in for the browser here.
#[cfg(test)]
type Opener = dyn Fn(&str, u16) -> IdeResult<()> + Send + Sync;

#[cfg(test)]
pub(crate) static TEST_OPENER: LazyLock<Mutex<Option<Box<Opener>>>> = LazyLock::new(|| Mutex::new(None));

fn open(url: &str, port: u16) -> IdeResult<()> {
    #[cfg(test)]
    if let Some(opener) = TEST_OPENER.lock().as_ref() {
        return opener(url, port);
    }
    let _ = port;
    open::that_detached(url)
        .map_err(|e| IdeError::new(ErrorKind::Io, format!("Snowflake: cannot open the web browser: {e}")))
}

/// The one-time token and proof key of a completed browser sign-in.
pub(crate) async fn authenticate(
    api: &Api,
    account: &str,
    user: &str,
    timeout: Duration,
) -> IdeResult<(String, String)> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| IdeError::new(ErrorKind::Io, format!("Snowflake: cannot listen for the browser sign-in: {e}")))?;
    let port = listener.local_addr().map_err(|e| IdeError::new(ErrorKind::Io, e.to_string()))?.port();
    let body = json!({ "data": {
        "ACCOUNT_NAME": account,
        "LOGIN_NAME": user,
        "AUTHENTICATOR": "EXTERNALBROWSER",
        "BROWSER_MODE_REDIRECT_PORT": port.to_string(),
        "CLIENT_APP_ID": APP,
        "CLIENT_APP_VERSION": env!("CARGO_PKG_VERSION"),
    } });
    let envelope = api.send(Request::post(AUTHENTICATOR, body).query("requestId", uuid()).timeout(timeout)).await?;
    if !envelope.success {
        return Err(api.scrub.clean(error::server(envelope.code.as_deref(), envelope.message.as_deref())));
    }
    let text = |name: &str| envelope.data.get(name).and_then(Value::as_str).map(str::to_owned);
    let (Some(url), Some(proof_key)) = (text("ssoUrl"), text("proofKey")) else {
        return Err(IdeError::new(
            ErrorKind::Protocol,
            "Snowflake did not name a sign-in page; check that the account allows browser sign-in",
        ));
    };
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(IdeError::new(ErrorKind::Protocol, "Snowflake named a sign-in page that is not a web address"));
    }
    api.scrub.add(&proof_key);
    open(&url, port)?;
    let token = tokio::time::timeout(WAIT, callback(&listener)).await.map_err(|_| {
        IdeError::new(ErrorKind::TimedOut, "Snowflake: the browser sign-in was not finished within 2 minutes")
    })??;
    api.scrub.add(&token);
    Ok((token, proof_key))
}

/// Waits for the browser to come back with the token (other requests, like the tab's icon, are refused).
async fn callback(listener: &TcpListener) -> IdeResult<String> {
    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|e| IdeError::new(ErrorKind::Io, format!("Snowflake: browser sign-in failed: {e}")))?;
        let Some(request) = read(&mut stream).await else { continue };
        let line = request.head.lines().next().unwrap_or_default();
        let mut parts = line.split_whitespace();
        let (method, target) = (parts.next().unwrap_or_default(), parts.next().unwrap_or_default());
        let origin = request.header("origin").unwrap_or("*").to_owned();
        let cors = format!(
            "Access-Control-Allow-Origin: {origin}\r\nVary: Origin\r\nAccess-Control-Allow-Methods: POST, GET\r\n\
             Access-Control-Allow-Headers: {}\r\n",
            request.header("access-control-request-headers").unwrap_or("content-type")
        );
        if method == "OPTIONS" {
            respond(&mut stream, "200 OK", &cors, "").await;
            continue;
        }
        let token = match method {
            "GET" => target.split_once('?').and_then(|(_, query)| parameter(query, "token")),
            "POST" => serde_json::from_str::<Value>(&request.body)
                .ok()
                .and_then(|v| v.get("token").and_then(Value::as_str).map(str::to_owned))
                .or_else(|| parameter(&request.body, "token")),
            _ => None,
        };
        match token.filter(|t| !t.is_empty()) {
            Some(token) => {
                respond(&mut stream, "200 OK", &format!("{cors}Content-Type: text/html; charset=utf-8\r\n"), DONE_PAGE)
                    .await;
                return Ok(token);
            }
            None => respond(&mut stream, "404 Not Found", "", "").await,
        }
    }
}

struct Received {
    head: String,
    body: String,
}

impl Received {
    fn header(&self, name: &str) -> Option<&str> {
        self.head.lines().skip(1).find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case(name).then(|| value.trim())
        })
    }
}

async fn read(stream: &mut TcpStream) -> Option<Received> {
    const LIMIT: usize = 256 * 1024;
    let mut bytes = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        let count = tokio::time::timeout(Duration::from_secs(10), stream.read(&mut buffer)).await.ok()?.ok()?;
        if count == 0 || bytes.len() > LIMIT {
            return None;
        }
        bytes.extend_from_slice(&buffer[..count]);
        if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&bytes[..end]).into_owned();
            let length: usize = head
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase().strip_prefix("content-length:").and_then(|v| v.trim().parse().ok())
                })
                .unwrap_or(0);
            if length > LIMIT {
                return None;
            }
            if bytes.len() >= end + 4 + length {
                return Some(Received { head, body: String::from_utf8_lossy(&bytes[end + 4..]).into_owned() });
            }
        }
    }
}

async fn respond(stream: &mut TcpStream, status: &str, headers: &str, body: &str) {
    let response =
        format!("HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

/// The value of `name` in a URL query or form body.
fn parameter(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == name).then(|| decode(value))
    })
}

fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let hex = |i: usize| bytes.get(i).and_then(|&c| (c as char).to_digit(16));
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let (Some(high), Some(low)) = (hex(i + 1), hex(i + 2))
        {
            out.push((high * 16 + low) as u8);
            i += 3;
            continue;
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_token_from_a_query_or_form() {
        assert_eq!(parameter("token=abc%2Bdef%3D%3D&x=1", "token").as_deref(), Some("abc+def=="));
        assert_eq!(parameter("x=1&token=t", "token").as_deref(), Some("t"));
        assert_eq!(parameter("tokens=1", "token"), None);
        assert_eq!(parameter("", "token"), None);
    }
}
