//! Preparing (substitution, body includes) and executing requests.

use crate::client::describe;
use crate::env::{Environments, Resolver};
use crate::parse::{BodyPart, RawRequest};
use ide_core::{CancellationToken, IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeSet;
use std::path::Path;
use std::time::Instant;

/// Bodies above this are cut (the full size is still reported).
pub const MAX_BODY: usize = 16 * 1024 * 1024;

/// A request ready to send: variables substituted, includes read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PreparedRequest {
    pub name: Option<String>,
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    pub status: u16,
    pub status_text: String,
    pub version: String,
    pub headers: Vec<(String, String)>,
    pub content_type: Option<String>,
    /// Body as text (lossy UTF-8); `None` for binary bodies.
    pub body: Option<String>,
    /// Size in bytes as received (after decompression).
    pub size: f64,
    pub truncated: bool,
    /// Request start → response headers.
    pub ttfb_ms: f64,
    /// Request start → body fully read.
    pub total_ms: f64,
}

/// Substitutes variables and reads `< file` includes (relative to the request
/// file's folder). Fails on unresolved variables.
pub fn prepare(
    raw: &RawRequest,
    file_vars: &[(String, String)],
    envs: &Environments,
    env: Option<&str>,
    base_dir: Option<&Path>,
) -> IdeResult<PreparedRequest> {
    let resolver = Resolver { file_vars, env: envs.variables(env) };
    let mut missing = BTreeSet::new();
    let url = resolver.substitute(&raw.block.url, &mut missing);
    let headers: Vec<(String, String)> =
        raw.headers.iter().map(|(k, v)| (k.clone(), resolver.substitute(v, &mut missing))).collect();
    let mut body_lines: Vec<String> = Vec::new();
    for part in &raw.body {
        match part {
            BodyPart::Text(t) => body_lines.push(resolver.substitute(t, &mut missing)),
            BodyPart::File(p) => {
                let p = resolver.substitute(p, &mut missing);
                let path = match base_dir {
                    Some(d) if Path::new(&p).is_relative() => d.join(&p),
                    _ => p.clone().into(),
                };
                let bytes = std::fs::read(&path)
                    .map_err(|e| IdeError::not_found(format!("cannot read body file {}: {e}", path.display())))?;
                body_lines.push(String::from_utf8_lossy(&bytes).trim_end_matches(['\r', '\n']).to_owned());
            }
        }
    }
    if !missing.is_empty() {
        let names: Vec<_> = missing.into_iter().collect();
        let hint = if env.is_none() { " (no environment selected)" } else { "" };
        return Err(IdeError::invalid(format!("unresolved variable(s): {}{hint}", names.join(", "))));
    }
    let url = if url.starts_with('/') {
        // `GET /path` with a `Host` header.
        match headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("host")) {
            Some((_, host)) => format!("http://{host}{url}"),
            None => return Err(IdeError::invalid(format!("relative URL {url} needs a Host header"))),
        }
    } else if !url.contains("://") {
        format!("http://{url}")
    } else {
        url
    };
    Ok(PreparedRequest {
        name: raw.block.name.clone(),
        method: raw.block.method.clone(),
        url,
        headers,
        body: (!body_lines.is_empty()).then(|| body_lines.join("\n")),
    })
}

fn looks_textual(content_type: Option<&str>, bytes: &[u8]) -> bool {
    if let Some(ct) = content_type {
        let ct = ct.to_ascii_lowercase();
        if ct.starts_with("text/")
            || ["json", "xml", "html", "javascript", "x-www-form-urlencoded", "yaml", "csv", "graphql"]
                .iter()
                .any(|k| ct.contains(k))
        {
            return true;
        }
        if ct.starts_with("image/")
            || ct.starts_with("audio/")
            || ct.starts_with("video/")
            || ct.contains("octet-stream")
        {
            return false;
        }
    }
    // Valid UTF-8 up to a possibly cut last character.
    match std::str::from_utf8(&bytes[..bytes.len().min(4096)]) {
        Ok(_) => true,
        Err(e) => e.error_len().is_none(),
    }
}

/// Sends `req`; cancelled when `cancel` fires.
pub async fn execute(req: &PreparedRequest, cancel: &CancellationToken) -> IdeResult<HttpResponse> {
    let client = crate::client::shared()?;
    let method = reqwest::Method::from_bytes(req.method.as_bytes())
        .map_err(|_| IdeError::invalid(format!("invalid method {}", req.method)))?;
    let mut builder = client.request(method, &req.url);
    for (k, v) in &req.headers {
        builder = builder.header(k, v);
    }
    if let Some(body) = &req.body {
        builder = builder.body(body.clone());
    }
    let request = builder.build().map_err(|e| IdeError::invalid(format!("invalid request: {e}")))?;
    let started = Instant::now();
    let send = client.execute(request);
    let mut response = tokio::select! {
        r = send => r.map_err(|e| IdeError::new(ide_core::error::ErrorKind::Io, describe(&e)))?,
        () = cancel.cancelled() => return Err(IdeError::cancelled()),
    };
    let ttfb = started.elapsed();
    let status = response.status();
    let version = format!("{:?}", response.version());
    let headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .map(|(k, v)| (k.as_str().to_owned(), String::from_utf8_lossy(v.as_bytes()).into_owned()))
        .collect();
    let content_type =
        response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let mut bytes = Vec::new();
    let mut size = 0usize;
    loop {
        let chunk = tokio::select! {
            c = response.chunk() => c.map_err(|e| IdeError::new(ide_core::error::ErrorKind::Io, describe(&e)))?,
            () = cancel.cancelled() => return Err(IdeError::cancelled()),
        };
        let Some(chunk) = chunk else { break };
        size += chunk.len();
        if bytes.len() < MAX_BODY {
            let take = chunk.len().min(MAX_BODY - bytes.len());
            bytes.extend_from_slice(&chunk[..take]);
        }
    }
    let total = started.elapsed();
    let body = looks_textual(content_type.as_deref(), &bytes).then(|| String::from_utf8_lossy(&bytes).into_owned());
    Ok(HttpResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_owned(),
        version,
        headers,
        content_type,
        body,
        size: size as f64,
        truncated: size > bytes.len(),
        ttfb_ms: ttfb.as_secs_f64() * 1000.0,
        total_ms: total.as_secs_f64() * 1000.0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::parse;

    #[test]
    fn prepares_with_env_and_includes() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("body.json"), "{\"id\": \"{{id}}\"}\n").unwrap();
        let f = parse("@id = 7\nPOST {{host}}/items\nAuthorization: Bearer {{token}}\n\n< ./body.json\n");
        let envs = Environments::from_json(r#"{"dev":{"host":"https://api.test","token":"abc"}}"#, "").unwrap();
        let p = prepare(&f.requests[0], &f.variables, &envs, Some("dev"), Some(tmp.path())).unwrap();
        assert_eq!(p.url, "https://api.test/items");
        assert_eq!(p.headers, vec![("Authorization".into(), "Bearer abc".into())]);
        // Included files are inserted verbatim (no substitution inside them).
        assert_eq!(p.body.as_deref(), Some("{\"id\": \"{{id}}\"}"));
    }

    #[test]
    fn reports_unresolved_variables() {
        let f = parse("GET https://{{host}}/x\n");
        let err = prepare(&f.requests[0], &f.variables, &Environments::default(), None, None).unwrap_err();
        assert!(err.message.contains("host"), "{}", err.message);
    }

    #[test]
    fn relative_urls_use_the_host_header() {
        let f = parse("GET /status\nHost: localhost:9000\n");
        let p = prepare(&f.requests[0], &f.variables, &Environments::default(), None, None).unwrap();
        assert_eq!(p.url, "http://localhost:9000/status");
    }

    #[tokio::test]
    async fn executes_against_a_local_server() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let n = s.read(&mut buf).await.unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            assert!(req.starts_with("POST /echo HTTP/1.1"), "{req}");
            let body = "{\"ok\":true}";
            let resp = format!(
                "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: {}\r\nX-A: b\r\n\r\n{body}",
                body.len()
            );
            s.write_all(resp.as_bytes()).await.unwrap();
        });
        let req = PreparedRequest {
            name: None,
            method: "POST".into(),
            url: format!("http://{addr}/echo"),
            headers: vec![("Content-Type".into(), "application/json".into())],
            body: Some("{}".into()),
        };
        let r = execute(&req, &CancellationToken::new()).await.unwrap();
        assert_eq!(r.status, 201);
        assert_eq!(r.status_text, "Created");
        assert_eq!(r.body.as_deref(), Some("{\"ok\":true}"));
        assert!(r.headers.iter().any(|(k, v)| k == "x-a" && v == "b"));
        assert!(r.total_ms >= r.ttfb_ms);
    }

    #[tokio::test]
    async fn cancels() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        // Accepts but never answers.
        tokio::spawn(async move {
            let _conn = listener.accept().await;
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        });
        let req = PreparedRequest {
            name: None,
            method: "GET".into(),
            url: format!("http://{addr}/"),
            headers: vec![],
            body: None,
        };
        let cancel = CancellationToken::new();
        let c = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            c.cancel();
        });
        let err = execute(&req, &cancel).await.unwrap_err();
        assert_eq!(err.kind, ide_core::error::ErrorKind::Cancelled);
    }
}
