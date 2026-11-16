//! HTTP Client tools: list and run requests from project `.http` / `.rest` files.

use crate::mcp::tool::{Call, Output, Param, ParamType, Tool};
use ide_core::{IdeError, IdeResult};
use serde_json::json;
use std::path::Path;

/// Response body characters returned at most (keeps agent context bounded).
const MAX_BODY_CHARS: usize = 8_192;

pub fn tools() -> Vec<Tool> {
    vec![http_list_requests(), http_run_request()]
}

fn is_http_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("http") || e.eq_ignore_ascii_case("rest"))
}

async fn resolve_http_file(call: &Call, path: &str) -> IdeResult<std::path::PathBuf> {
    let path = call.resolve_inside(path)?;
    if !is_http_file(&path) {
        return Err(IdeError::invalid("path must be a .http or .rest file"));
    }
    if !path.is_file() {
        return Err(IdeError::not_found(format!("No such file: {}", call.display(&path))));
    }
    Ok(path)
}

fn http_list_requests() -> Tool {
    Tool::new(
        "http_list_requests",
        "Lists the HTTP requests in a project `.http` or `.rest` file (IntelliJ-style HTTP Client).
Returns each request's 0-based `index`, optional `name`, `method`, URL as written (variables not substituted), and `line`.
Use `http_run_request` with the same `path` and an `index` to send one.",
        |call| async move {
            let path = resolve_http_file(&call, &call.str("path")?).await?;
            let text = crate::ops::fs::read_text(&call.host(), call.window(), path).await?;
            let requests: Vec<_> = ide_http::parse::requests(&text)
                .into_iter()
                .map(|b| {
                    json!({
                        "index": b.index,
                        "name": b.name,
                        "method": b.method,
                        "url": b.url,
                        "line": b.line,
                    })
                })
                .collect();
            Output::json(json!({ "requests": requests }))
        },
    )
    .param(Param::required(
        "path",
        ParamType::String,
        "Project-relative path to a `.http` or `.rest` file",
    ))
    .output(json!({
        "type": "object",
        "properties": {
            "requests": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "index": { "type": "integer" },
                        "name": { "type": ["string", "null"] },
                        "method": { "type": "string" },
                        "url": { "type": "string" },
                        "line": { "type": "integer" },
                    },
                    "required": ["index", "method", "url", "line"],
                },
            },
        },
        "required": ["requests"],
    }))
}

fn truncate_chars(text: &str, max: usize) -> (String, bool) {
    let count = text.chars().count();
    if count <= max {
        return (text.to_owned(), false);
    }
    (text.chars().take(max).collect(), true)
}

/// Drop resolved URLs from transport errors so MCP JSON does not echo env-substituted targets.
fn redact_transport_error(error: Option<String>, resolved_url: &str) -> Option<String> {
    let error = error?;
    let mut out = error.replace(resolved_url, "<url>");
    // reqwest often embeds `https://host/...` even when the primary URL string differs slightly.
    out = redact_urls(&out);
    Some(out)
}

fn redact_urls(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    loop {
        // Prefer `https://` so we don't match the `http://` prefix inside it.
        let start = match (rest.find("https://"), rest.find("http://")) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (Some(a), None) => Some(a),
            (None, Some(b)) => Some(b),
            (None, None) => None,
        };
        let Some(start) = start else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..start]);
        out.push_str("<url>");
        let after = &rest[start..];
        let end = after.find(|c: char| c.is_whitespace() || c == '\'' || c == '"' || c == ')').unwrap_or(after.len());
        rest = &after[end..];
    }
    out
}

fn http_run_request() -> Tool {
    Tool::new(
        "http_run_request",
        "Runs one request from a project `.http` or `.rest` file by 0-based `index`, using the IDE HTTP Client
(same as Run Request in the editor). Variables resolve from `http-client.env.json` / `http-client.private.env.json`
for the optional `env` name. Asks for confirmation with the resolved URL (and header names) first.
Returns status, timing and a truncated response body — not request headers or body (those may hold secrets).
The `url` field in the result is as written in the file (unsubstituted); transport errors redact URLs.",
        |call| async move {
            let rel = call.str("path")?;
            let path = resolve_http_file(&call, &rel).await?;
            let index =
                call.opt_i64("index")?.ok_or_else(|| IdeError::invalid("missing or invalid argument `index`"))?;
            if index < 0 {
                return Err(IdeError::invalid("index must be >= 0"));
            }
            let index = index as u32;
            let env = call.opt_str("env")?;
            let text = crate::ops::fs::read_text(&call.host(), call.window(), path.clone()).await?;
            let blocks = ide_http::parse::requests(&text);
            let block =
                blocks.get(index as usize).ok_or_else(|| IdeError::not_found(format!("no request #{}", index + 1)))?;

            let input = ide_http::RunInput {
                text: &text,
                index,
                file: Some(&path),
                root: Some(call.root()),
                env: env.as_deref(),
            };
            // Prepare before confirm so the dialog shows the real destination (after env substitution).
            let prepared = ide_http::prepare(&input)?;
            let subject = prepared.name.clone().unwrap_or_else(|| format!("{} {}", prepared.method, prepared.url));
            let headers: Vec<_> = prepared.headers.iter().map(|(k, _)| k.as_str()).collect();
            let mut detail = format!("{} {}\nFile: {rel}\nIndex: {index}", prepared.method, prepared.url);
            if let Some(env) = &env {
                detail.push_str(&format!("\nEnvironment: {env}"));
            }
            if !headers.is_empty() {
                detail.push_str(&format!("\nHeaders: {}", headers.join(", ")));
            }
            if prepared.body.is_some() {
                detail.push_str("\nBody: present");
            }
            call.confirm(&subject, Some(detail)).await?;

            // Exactly the request the user approved: preparing it again would read the
            // environment files again, which may name another destination by now.
            let redact_url = prepared.url.clone();
            let exchange = ide_http::send(prepared, Some(&path), &call.cancel).await?;
            let history = call.project().http_history.clone();
            let saved = exchange.clone();
            let _ = call.host().blocking(move || history.add(&saved)).await;

            let (body, body_truncated) = match exchange.response.as_ref().and_then(|r| r.body.as_deref()) {
                Some(b) => {
                    let (t, truncated) = truncate_chars(b, MAX_BODY_CHARS);
                    (Some(t), truncated)
                }
                None => (None, false),
            };
            let response = exchange.response.as_ref();
            Output::json(json!({
                "index": index,
                "name": block.name,
                "method": block.method,
                "url": block.url,
                "status": response.map(|r| r.status),
                "statusText": response.map(|r| r.status_text.clone()),
                "totalMs": response.map(|r| r.total_ms).or(exchange.entry.total_ms),
                "error": redact_transport_error(exchange.entry.error.clone(), &redact_url),
                "body": body,
                "bodyTruncated": body_truncated,
            }))
        },
    )
    .write()
    .param(Param::required("path", ParamType::String, "Project-relative path to a `.http` or `.rest` file"))
    .param(Param::required("index", ParamType::Integer, "0-based request index from `http_list_requests`"))
    .param(Param::optional(
        "env",
        ParamType::String,
        "Environment name from `http-client.env.json` / `http-client.private.env.json`",
    ))
    .output(json!({
        "type": "object",
        "properties": {
            "index": { "type": "integer" },
            "name": { "type": ["string", "null"] },
            "method": { "type": "string" },
            "url": { "type": "string" },
            "status": { "type": ["integer", "null"] },
            "statusText": { "type": ["string", "null"] },
            "totalMs": { "type": ["number", "null"] },
            "error": { "type": ["string", "null"] },
            "body": { "type": ["string", "null"] },
            "bodyTruncated": { "type": "boolean" },
        },
        "required": ["index", "method", "url", "bodyTruncated"],
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_http_and_rest_extensions() {
        assert!(is_http_file(Path::new("a.http")));
        assert!(is_http_file(Path::new("a.REST")));
        assert!(!is_http_file(Path::new("a.txt")));
    }

    #[test]
    fn truncates_long_bodies() {
        let long = "x".repeat(MAX_BODY_CHARS + 10);
        let (t, truncated) = truncate_chars(&long, MAX_BODY_CHARS);
        assert!(truncated);
        assert_eq!(t.chars().count(), MAX_BODY_CHARS);
        assert_eq!(truncate_chars("ok", MAX_BODY_CHARS), ("ok".into(), false));
    }

    #[test]
    fn redacts_urls_in_transport_errors() {
        let url = "https://secret.example/v1?token=abc";
        assert_eq!(
            redact_transport_error(Some(format!("error sending request for {url}")), url).as_deref(),
            Some("error sending request for <url>")
        );
        assert_eq!(redact_urls("fail https://a.example/x and http://b/y"), "fail <url> and <url>");
    }
}
