//! The HTTP side of the Snowflake session protocol: one JSON envelope per response.
//! Every error leaves through [`Scrubber::clean`], so no credential reaches a message or a log.

use ide_core::{IdeError, IdeResult, error::ErrorKind};
use parking_lot::RwLock;
use reqwest::{Client, Method, StatusCode, Url};
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;

/// Replaces known secrets (passphrase, password, tokens) in text that leaves the driver.
#[derive(Clone, Default)]
pub(crate) struct Scrubber(Arc<RwLock<Vec<String>>>);

impl Scrubber {
    pub(crate) fn add(&self, secret: &str) {
        // Short values would blank out ordinary words.
        if secret.len() >= 4 {
            let mut secrets = self.0.write();
            if !secrets.iter().any(|s| s == secret) {
                secrets.push(secret.to_owned());
            }
        }
    }

    pub(crate) fn clean(&self, mut error: IdeError) -> IdeError {
        for secret in self.0.read().iter() {
            if error.message.contains(secret.as_str()) {
                error.message = error.message.replace(secret.as_str(), "[redacted]");
            }
        }
        error
    }
}

/// A response body: `data` on success, `code` and `message` on failure.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(crate) struct Envelope {
    pub success: bool,
    #[serde(deserialize_with = "code")]
    pub code: Option<String>,
    pub message: Option<String>,
    pub data: Value,
}

/// Codes arrive as strings, numbers or null.
fn code<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    Ok(match Value::deserialize(deserializer)? {
        Value::String(s) if !s.is_empty() => Some(s),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    })
}

impl Envelope {
    pub(crate) fn has_code(&self, codes: &[&str]) -> bool {
        self.code.as_deref().is_some_and(|code| codes.contains(&code))
    }
}

#[derive(Clone)]
pub(crate) struct Api {
    http: Client,
    base: Url,
    pub scrub: Scrubber,
}

pub(crate) struct Request<'a> {
    pub method: Method,
    pub path: &'a str,
    pub query: Vec<(&'a str, String)>,
    /// The session or master token.
    pub token: Option<&'a str>,
    pub body: Option<Value>,
    pub timeout: Option<Duration>,
}

impl<'a> Request<'a> {
    pub(crate) fn post(path: &'a str, body: Value) -> Self {
        Self { method: Method::POST, path, query: Vec::new(), token: None, body: Some(body), timeout: None }
    }

    pub(crate) fn get(path: &'a str) -> Self {
        Self { method: Method::GET, path, query: Vec::new(), token: None, body: None, timeout: None }
    }

    pub(crate) fn token(mut self, token: &'a str) -> Self {
        self.token = Some(token);
        self
    }

    pub(crate) fn query(mut self, name: &'a str, value: impl Into<String>) -> Self {
        self.query.push((name, value.into()));
        self
    }

    pub(crate) fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }
}

impl Api {
    pub(crate) fn new(http: Client, base: Url) -> Self {
        Self { http, base, scrub: Scrubber::default() }
    }

    /// The account's address, for keys that tell accounts apart.
    pub(crate) fn address(&self) -> String {
        format!("{}:{}", self.host(), self.base.port_or_known_default().unwrap_or_default())
    }

    fn host(&self) -> &str {
        self.base.host_str().unwrap_or_default()
    }

    /// Sends `request` and reads the envelope, whatever it reports.
    pub(crate) async fn send(&self, request: Request<'_>) -> IdeResult<Envelope> {
        let url = self.base.join(request.path).map_err(|_| IdeError::internal("invalid Snowflake request path"))?;
        let mut builder = self
            .http
            .request(request.method, url)
            .query(&request.query)
            .header(reqwest::header::ACCEPT, "application/snowflake");
        if let Some(token) = request.token {
            builder = builder.header(reqwest::header::AUTHORIZATION, format!("Snowflake Token=\"{token}\""));
        }
        if let Some(body) = &request.body {
            builder = builder.header(reqwest::header::CONTENT_TYPE, "application/json").body(body.to_string());
        }
        if let Some(timeout) = request.timeout {
            builder = builder.timeout(timeout);
        }
        let response = builder.send().await.map_err(|e| self.transport(e))?;
        let status = response.status();
        let body = response.bytes().await.map_err(|e| self.transport(e))?;
        match serde_json::from_slice::<Envelope>(&body) {
            Ok(envelope) if status.is_success() || envelope.code.is_some() || envelope.message.is_some() => {
                Ok(envelope)
            }
            _ => Err(self.scrub.clean(self.status_error(status))),
        }
    }

    /// Downloads a result chunk from cloud storage (no Snowflake credentials: the URL is presigned).
    pub(crate) async fn chunk(&self, url: &str, headers: &[(String, String)]) -> IdeResult<Vec<u8>> {
        let mut builder = self.http.get(url);
        for (name, value) in headers {
            builder = builder.header(name.as_str(), value.as_str());
        }
        let response = builder.send().await.map_err(|e| self.transport(e))?;
        let status = response.status();
        if !status.is_success() {
            return Err(IdeError::new(
                ErrorKind::Io,
                format!("Snowflake: cannot download a result chunk (HTTP {})", status.as_u16()),
            ));
        }
        Ok(response.bytes().await.map_err(|e| self.transport(e))?.to_vec())
    }

    fn status_error(&self, status: StatusCode) -> IdeError {
        let host = self.host();
        match status {
            StatusCode::FORBIDDEN | StatusCode::NOT_FOUND => IdeError::invalid(format!(
                "Snowflake has no account at {host} (HTTP {}): check the account identifier",
                status.as_u16()
            )),
            s if s.is_server_error() || s == StatusCode::TOO_MANY_REQUESTS => IdeError::new(
                ErrorKind::Io,
                format!("Snowflake is temporarily unavailable (HTTP {}); try again", s.as_u16()),
            ),
            s => IdeError::new(ErrorKind::Protocol, format!("Snowflake: unexpected response (HTTP {})", s.as_u16())),
        }
    }

    fn transport(&self, error: reqwest::Error) -> IdeError {
        use std::error::Error;
        let kind = if error.is_timeout() { ErrorKind::TimedOut } else { ErrorKind::Io };
        let connect = error.is_connect();
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
        let hint = if connect { "; check the account identifier and the network connection" } else { "" };
        self.scrub.clean(IdeError::new(kind, format!("Snowflake ({}): {message}{hint}", self.host())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelopes_read_any_code_shape() {
        let e: Envelope =
            serde_json::from_str(r#"{"success":false,"code":"390100","message":"no","data":null}"#).unwrap();
        assert_eq!(e.code.as_deref(), Some("390100"));
        assert!(e.has_code(&["390100"]));
        let e: Envelope = serde_json::from_str(r#"{"success":false,"code":390100}"#).unwrap();
        assert_eq!(e.code.as_deref(), Some("390100"));
        let e: Envelope = serde_json::from_str(r#"{"success":true,"code":null,"data":{"a":1}}"#).unwrap();
        assert!(e.success && e.code.is_none());
        assert_eq!(e.data["a"], 1);
    }

    #[test]
    fn scrubbing_removes_every_known_secret() {
        let scrub = Scrubber::default();
        scrub.add("s3cret-passphrase");
        scrub.add("eyJ.token.value");
        scrub.add("ab");
        let e = scrub.clean(IdeError::invalid("failed with s3cret-passphrase and eyJ.token.value, ab stays"));
        assert_eq!(e.message, "failed with [redacted] and [redacted], ab stays");
    }
}
