//! Preparing (substitution, body includes) and executing requests.

use crate::client::{describe, with_scheme};
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

/// Redirects followed per request; beyond this the redirect response itself is
/// returned (IntelliJ's HTTP Client follows the same number).
pub const MAX_REDIRECTS: usize = 50;

/// Responses whose `Location` is followed: 301, 302, 303, 307 and 308, the set
/// IntelliJ's HTTP Client redirects on.
const REDIRECT_STATUSES: [u16; 5] = [301, 302, 303, 307, 308];

/// Request headers not re-sent to a redirect on another host. IntelliJ's HTTP
/// Client strips the same set and restores it when the redirect stays on the
/// original host.
const SENSITIVE_HEADERS: [&str; 5] = ["authorization", "cookie", "cookie2", "www-authenticate", "proxy-authorization"];

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

/// One followed redirect: the response and the `Location` it pointed to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RedirectHop {
    pub status: u16,
    pub status_text: String,
    pub location: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    pub status: u16,
    pub status_text: String,
    pub version: String,
    pub headers: Vec<(String, String)>,
    pub content_type: Option<String>,
    /// Followed redirects, first hop first; empty when not redirected.
    #[serde(default)]
    pub redirects: Vec<RedirectHop>,
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
    } else {
        with_scheme(&url)
    };
    // Multipart bodies delimit parts with CRLF per RFC 2046 §5.1; joining
    // with bare LF leaves servers (e.g. Tomcat) unable to find the boundary.
    let is_multipart = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        .is_some_and(|(_, v)| v.to_ascii_lowercase().starts_with("multipart/"));
    let eol = if is_multipart { "\r\n" } else { "\n" };
    Ok(PreparedRequest {
        name: raw.block.name.clone(),
        method: raw.block.method.clone(),
        url,
        headers,
        body: (!body_lines.is_empty()).then(|| body_lines.join(eol)),
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

/// The request for one hop: `req`'s headers and body against `url`, the
/// sensitive headers dropped when the redirect crosses to another host.
fn request_to(
    client: &reqwest::Client,
    method: &reqwest::Method,
    req: &PreparedRequest,
    body: Option<&str>,
    original: &reqwest::Url,
    url: &reqwest::Url,
) -> IdeResult<reqwest::Request> {
    let same_host = url.host_str() == original.host_str();
    let mut builder = client.request(method.clone(), url.clone());
    for (k, v) in &req.headers {
        if same_host || !SENSITIVE_HEADERS.iter().any(|s| k.eq_ignore_ascii_case(s)) {
            builder = builder.header(k, v);
        }
    }
    if let Some(body) = body {
        builder = builder.body(body.to_owned());
    }
    builder.build().map_err(|e| IdeError::invalid(format!("invalid request: {e}")))
}

/// Sends `request`; cancelled when `cancel` fires.
async fn send(
    client: &reqwest::Client,
    request: reqwest::Request,
    cancel: &CancellationToken,
) -> IdeResult<reqwest::Response> {
    let send = client.execute(request);
    tokio::select! {
        r = send => r.map_err(|e| IdeError::new(ide_core::error::ErrorKind::Io, describe(&e))),
        () = cancel.cancelled() => Err(IdeError::cancelled()),
    }
}

/// Sends `req`, following redirects the way IntelliJ's HTTP Client does:
/// 301, 302, 303, 307 and 308 up to [`MAX_REDIRECTS`] times, `303` continuing
/// as `GET` without the body, the other statuses keeping the method and body —
/// so a `POST` redirected to `https` on the same host is re-sent as a `POST`.
/// Sensitive headers (Authorization, cookies, proxy credentials) are not
/// re-sent across hosts. The followed hops are reported in the response.
/// Cancelled when `cancel` fires.
pub async fn execute(req: &PreparedRequest, cancel: &CancellationToken) -> IdeResult<HttpResponse> {
    let client = crate::client::shared_without_redirects()?;
    let method = reqwest::Method::from_bytes(req.method.as_bytes())
        .map_err(|_| IdeError::invalid(format!("invalid method {}", req.method)))?;
    let original = req.url.parse::<reqwest::Url>().map_err(|e| IdeError::invalid(format!("invalid request: {e}")))?;
    let mut url = original.clone();
    let mut method = method;
    let mut body = req.body.clone();
    let mut redirects = Vec::new();
    let started = Instant::now();
    let mut response;
    loop {
        let request = request_to(&client, &method, req, body.as_deref(), &original, &url)?;
        response = send(&client, request, cancel).await?;
        let status = response.status();
        if redirects.len() >= MAX_REDIRECTS || !REDIRECT_STATUSES.contains(&status.as_u16()) {
            break;
        }
        let next = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|location| url.join(location).ok());
        let Some(next) = next else { break };
        redirects.push(RedirectHop {
            status: status.as_u16(),
            status_text: status.canonical_reason().unwrap_or("").to_owned(),
            location: next.to_string(),
        });
        if status == reqwest::StatusCode::SEE_OTHER {
            method = reqwest::Method::GET;
            body = None;
        }
        url = next;
    }
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
        redirects,
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
    fn multipart_bodies_join_lines_with_crlf() {
        let f = parse(
            "POST https://api.test/upload\nContent-Type: multipart/form-data; boundary=xyz\n\n--xyz\nfield\n--xyz--\n",
        );
        let p = prepare(&f.requests[0], &f.variables, &Environments::default(), None, None).unwrap();
        assert_eq!(p.body.as_deref(), Some("--xyz\r\nfield\r\n--xyz--"));
    }

    #[test]
    fn non_multipart_bodies_join_lines_with_lf() {
        let f = parse("POST https://api.test/x\nContent-Type: application/json\n\n{\n\"a\": 1\n}\n");
        let p = prepare(&f.requests[0], &f.variables, &Environments::default(), None, None).unwrap();
        assert_eq!(p.body.as_deref(), Some("{\n\"a\": 1\n}"));
    }

    #[test]
    fn relative_urls_use_the_host_header() {
        let f = parse("GET /status\nHost: localhost:9000\n");
        let p = prepare(&f.requests[0], &f.variables, &Environments::default(), None, None).unwrap();
        assert_eq!(p.url, "http://localhost:9000/status");
    }

    #[test]
    fn urls_without_a_scheme_default_to_http() {
        let url = |text: &str| {
            let f = parse(text);
            prepare(&f.requests[0], &f.variables, &Environments::default(), None, None).unwrap().url
        };
        assert_eq!(url("GET localhost:8080/health\n"), "http://localhost:8080/health");
        assert_eq!(
            url("GET localhost:8080/login?next=http://localhost:3000/\n"),
            "http://localhost:8080/login?next=http://localhost:3000/"
        );
        assert_eq!(url("GET https://api.test/cb?u=http://x\n"), "https://api.test/cb?u=http://x");
    }

    /// A loopback server answering each accepted connection with the next of
    /// `responses`, returning every request as its head and body.
    async fn scripted(responses: Vec<String>) -> (u16, tokio::task::JoinHandle<Vec<(String, String)>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            let mut seen = Vec::new();
            for response in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let (head, body) = loop {
                    let mut buffer = [0u8; 4096];
                    let read = socket.read(&mut buffer).await.unwrap();
                    assert!(read > 0, "request ended before its body");
                    request.extend_from_slice(&buffer[..read]);
                    let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") else { continue };
                    let head = String::from_utf8_lossy(&request[..end]).into_owned();
                    let length: usize = head
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse().unwrap())
                        })
                        .unwrap_or(0);
                    if request.len() >= end + 4 + length {
                        break (head, String::from_utf8_lossy(&request[end + 4..end + 4 + length]).into_owned());
                    }
                };
                seen.push((head, body));
                socket.write_all(response.as_bytes()).await.unwrap();
            }
            seen
        });
        (port, handle)
    }

    fn response(status_line: &str, headers: &str, body: &str) -> String {
        format!("HTTP/1.1 {status_line}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
    }

    #[tokio::test]
    async fn sends_exact_environment_numbers_to_a_local_server() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let (headers, body) = loop {
                let mut buffer = [0u8; 4096];
                let read = socket.read(&mut buffer).await.unwrap();
                assert!(read > 0, "request ended before its body");
                request.extend_from_slice(&buffer[..read]);
                let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") else { continue };
                let headers = String::from_utf8_lossy(&request[..end]);
                let length: usize = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse().unwrap())
                    })
                    .unwrap();
                if request.len() >= end + 4 + length {
                    break (
                        String::from_utf8(request[..end].to_vec()).unwrap(),
                        String::from_utf8(request[end + 4..end + 4 + length].to_vec()).unwrap(),
                    );
                }
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            (headers, body)
        });
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join(crate::env::PUBLIC_FILE),
            r#"{"dev":{"id":123456789012345678901234567890,"amount":1.0000000000000000002,"tiny":1e-400}}"#,
        )
        .unwrap();
        let file = tmp.path().join("precision.http");
        let text = format!(
            "POST http://{addr}/echo?id={{{{id}}}}\nContent-Type: application/json\nX-Exact-Amount: {{{{amount}}}}\n\n{{\"id\":{{{{id}}}},\"amount\":{{{{amount}}}},\"tiny\":{{{{tiny}}}}}}\n"
        );
        let input =
            crate::RunInput { text: &text, index: 0, file: Some(&file), root: Some(tmp.path()), env: Some("dev") };
        let exchange =
            tokio::time::timeout(std::time::Duration::from_secs(5), crate::run(input, &CancellationToken::new()))
                .await
                .unwrap()
                .unwrap();
        let expected = r#"{"id":123456789012345678901234567890,"amount":1.0000000000000000002,"tiny":1e-400}"#;
        let (headers, body) = server.await.unwrap();
        assert_eq!(headers.lines().next().unwrap(), "POST /echo?id=123456789012345678901234567890 HTTP/1.1");
        assert!(headers.lines().any(|line| line.eq_ignore_ascii_case("x-exact-amount: 1.0000000000000000002")));
        assert_eq!(body, expected);
        assert_eq!(exchange.request.body.as_deref(), Some(expected));
        assert_eq!(exchange.response.unwrap().body.as_deref(), Some(expected));
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
        assert!(r.redirects.is_empty());
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

    #[tokio::test]
    async fn post_keeps_method_and_body_on_301_302_307_308() {
        for status_line in ["301 Moved Permanently", "302 Found", "307 Temporary Redirect", "308 Permanent Redirect"] {
            let status: u16 = status_line[..3].parse().unwrap();
            let (port, server) =
                scripted(vec![response(status_line, "Location: /landing\r\n", ""), response("200 OK", "", "ok")]).await;
            let req = PreparedRequest {
                name: None,
                method: "POST".into(),
                url: format!("http://127.0.0.1:{port}/submit"),
                headers: vec![("Content-Type".into(), "application/json".into())],
                body: Some("{\"a\":1}".into()),
            };
            let r = execute(&req, &CancellationToken::new()).await.unwrap();
            let seen = server.await.unwrap();
            let (head, body) = &seen[1];
            assert_eq!(head.lines().next().unwrap(), "POST /landing HTTP/1.1", "{status_line}");
            assert!(head.to_ascii_lowercase().contains("content-type: application/json"), "{head}");
            assert_eq!(body, "{\"a\":1}", "{status_line}");
            assert_eq!(r.status, 200, "{status_line}");
            assert_eq!(r.body.as_deref(), Some("ok"), "{status_line}");
            assert_eq!(
                r.redirects,
                vec![RedirectHop {
                    status,
                    status_text: status_line[4..].to_owned(),
                    location: format!("http://127.0.0.1:{port}/landing"),
                }],
                "{status_line}"
            );
        }
    }

    #[tokio::test]
    async fn see_other_303_resends_as_get_without_the_body() {
        let (port, server) =
            scripted(vec![response("303 See Other", "Location: /after\r\n", ""), response("200 OK", "", "done")]).await;
        let req = PreparedRequest {
            name: None,
            method: "POST".into(),
            url: format!("http://127.0.0.1:{port}/submit"),
            headers: vec![],
            body: Some("{\"a\":1}".into()),
        };
        let r = execute(&req, &CancellationToken::new()).await.unwrap();
        let seen = server.await.unwrap();
        assert_eq!(seen[1].0.lines().next().unwrap(), "GET /after HTTP/1.1");
        assert_eq!(seen[1].1, "");
        assert_eq!(r.status, 200);
        assert_eq!(r.body.as_deref(), Some("done"));
        assert_eq!(r.redirects[0].status, 303);
    }

    #[tokio::test]
    async fn same_host_redirect_keeps_authorization() {
        let (port, server) = scripted(vec![
            response("301 Moved Permanently", "Location: /landing\r\n", ""),
            response("200 OK", "", "ok"),
        ])
        .await;
        let req = PreparedRequest {
            name: None,
            method: "GET".into(),
            url: format!("http://127.0.0.1:{port}/start"),
            headers: vec![("Authorization".into(), "Bearer secret".into())],
            body: None,
        };
        execute(&req, &CancellationToken::new()).await.unwrap();
        let seen = server.await.unwrap();
        assert!(seen[1].0.to_ascii_lowercase().contains("authorization: bearer secret"), "{}", seen[1].0);
    }

    #[tokio::test]
    async fn cross_host_redirect_keeps_the_method_but_drops_authorization() {
        let (port_b, server_b) = scripted(vec![response("200 OK", "", "moved")]).await;
        let (port_a, server_a) = scripted(vec![response(
            "301 Moved Permanently",
            &format!("Location: http://127.0.0.1:{port_b}/x\r\n"),
            "",
        )])
        .await;
        let req = PreparedRequest {
            name: None,
            method: "POST".into(),
            url: format!("http://localhost:{port_a}/start"),
            headers: vec![("Authorization".into(), "Bearer secret".into())],
            body: Some("{\"a\":1}".into()),
        };
        let r = execute(&req, &CancellationToken::new()).await.unwrap();
        let seen_a = server_a.await.unwrap();
        let seen_b = server_b.await.unwrap();
        assert!(seen_a[0].0.to_ascii_lowercase().contains("authorization: bearer secret"), "{}", seen_a[0].0);
        assert_eq!(seen_b[0].0.lines().next().unwrap(), "POST /x HTTP/1.1");
        assert!(!seen_b[0].0.to_ascii_lowercase().contains("authorization"), "{}", seen_b[0].0);
        assert_eq!(seen_b[0].1, "{\"a\":1}");
        assert_eq!(r.status, 200);
        assert_eq!(r.body.as_deref(), Some("moved"));
        assert_eq!(r.redirects.len(), 1);
    }

    #[tokio::test]
    async fn redirects_beyond_the_limit_return_the_last_redirect_response() {
        let responses = vec![response("301 Moved Permanently", "Location: /loop\r\n", ""); MAX_REDIRECTS + 1];
        let (port, server) = scripted(responses).await;
        let req = PreparedRequest {
            name: None,
            method: "GET".into(),
            url: format!("http://127.0.0.1:{port}/start"),
            headers: vec![],
            body: None,
        };
        let r = execute(&req, &CancellationToken::new()).await.unwrap();
        let seen = server.await.unwrap();
        assert_eq!(r.status, 301);
        assert_eq!(r.status_text, "Moved Permanently");
        assert_eq!(r.redirects.len(), MAX_REDIRECTS);
        assert_eq!(seen.len(), MAX_REDIRECTS + 1);
    }

    #[tokio::test]
    async fn redirect_chain_is_recorded_across_hops() {
        let (port, server) = scripted(vec![
            response("302 Found", "Location: /b\r\n", ""),
            response("302 Found", "Location: /c\r\n", ""),
            response("200 OK", "", "end"),
        ])
        .await;
        let req = PreparedRequest {
            name: None,
            method: "GET".into(),
            url: format!("http://127.0.0.1:{port}/a"),
            headers: vec![],
            body: None,
        };
        let r = execute(&req, &CancellationToken::new()).await.unwrap();
        let seen = server.await.unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.body.as_deref(), Some("end"));
        assert_eq!(r.redirects.len(), 2);
        assert_eq!(r.redirects[0].status, 302);
        assert_eq!(r.redirects[0].location, format!("http://127.0.0.1:{port}/b"));
        assert_eq!(r.redirects[1].status, 302);
        assert_eq!(r.redirects[1].location, format!("http://127.0.0.1:{port}/c"));
        assert_eq!(seen[2].0.lines().next().unwrap(), "GET /c HTTP/1.1");
    }
}
