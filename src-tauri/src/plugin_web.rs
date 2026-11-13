//! The `openidea-plugin` URL scheme: files of plugins' web views
//! (`<plugin id>/<revision>/<path>`, see `ide_host::plugins::web`).
//!
//! Pages run in a sandboxed frame (an opaque origin), so every response allows
//! any origin to read it (module scripts and fonts are fetched in CORS mode),
//! and is immutable: the revision in the URL changes with the installed
//! package. HTML gets a CSP of its own, in case a page navigates its frame to
//! one: still sandboxed, still no network.
//!
//! [`FRAME_HOST_PATH`] is the page that the `html` bodies plugin code renders are
//! written into. A `srcdoc` frame would inherit the workbench's CSP, whose
//! `script-src` blocks the inline scripts of those bodies; a page of this scheme
//! has only the policy of its own response.

use crate::state::AppState;
use tauri::http::{Request, Response, StatusCode, header};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

pub const SCHEME: &str = "openidea-plugin";

/// What a page loaded from the scheme may do: its own files, nothing else.
const HTML_CSP: &str = "sandbox allow-scripts; default-src 'none'; \
    script-src openidea-plugin: http://openidea-plugin.localhost 'unsafe-inline' 'wasm-unsafe-eval'; \
    style-src openidea-plugin: http://openidea-plugin.localhost 'unsafe-inline'; \
    img-src openidea-plugin: http://openidea-plugin.localhost data: blob:; \
    font-src openidea-plugin: http://openidea-plugin.localhost data:; \
    media-src openidea-plugin: http://openidea-plugin.localhost data: blob:; \
    connect-src openidea-plugin: http://openidea-plugin.localhost data: blob:";

/// The host page of `html` bodies: it tells the workbench it is ready and writes
/// the document it gets back (`frameDocument` in src/features/plugins/views/frame.ts).
pub const FRAME_HOST_PATH: &str = ".frame";

/// The policy of rendered `html` bodies (`FRAME_CSP` in frame.ts), sandboxed as their frame is.
const FRAME_HOST_CSP: &str = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; \
    style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:";

const FRAME_HOST: &str = r#"<!doctype html><meta charset="utf-8"><script>
addEventListener("message", (e) => {
  const d = e.data;
  if (e.source !== parent || !d || d.tag !== "openidea-view" || typeof d.document !== "string") return;
  document.open();
  document.write(d.document);
  document.close();
});
parent.postMessage({ tag: "openidea-view", ready: true }, "*");
</script>"#;

/// `window.openidea` (one function expression taking the initial theme), the same
/// source the workbench inlines into rendered `html` bodies.
const BRIDGE: &str = include_str!("../../src/features/plugins/views/frame-bridge.js");

/// `html` with the bridge as its first script (the theme follows in a message).
fn with_bridge(html: &[u8]) -> Vec<u8> {
    let bridge = format!("<script>({})(null);</script>", BRIDGE.trim().trim_end_matches(';'));
    let text = String::from_utf8_lossy(html);
    let lower = text.to_ascii_lowercase();
    // After `<head …>` when there is one, else first.
    let at = lower
        .find("<head")
        .and_then(|i| lower[i..].find('>').map(|j| i + j + 1))
        .unwrap_or_else(|| lower.find("<html").and_then(|i| lower[i..].find('>').map(|j| i + j + 1)).unwrap_or(0));
    let mut out = String::with_capacity(text.len() + bridge.len());
    out.push_str(&text[..at]);
    out.push_str(&bridge);
    out.push_str(&text[at..]);
    out.into_bytes()
}

pub fn handle<R: Runtime>(ctx: UriSchemeContext<'_, R>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let app = ctx.app_handle().clone();
    let path = request.uri().path().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let response = match app.try_state::<AppState>() {
            Some(state) => serve(&state.plugins, &path),
            None => status(StatusCode::SERVICE_UNAVAILABLE),
        };
        responder.respond(response);
    });
}

fn serve(plugins: &ide_host::plugins::PluginHost, path: &str) -> Response<Vec<u8>> {
    let decoded = percent_encoding::percent_decode_str(path.trim_start_matches('/')).decode_utf8_lossy();
    if decoded == FRAME_HOST_PATH {
        return Response::builder()
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(header::CONTENT_SECURITY_POLICY, FRAME_HOST_CSP)
            .header(header::CACHE_CONTROL, "no-cache")
            .header("X-Content-Type-Options", "nosniff")
            .body(FRAME_HOST.as_bytes().to_vec())
            .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR));
    }
    let Some((plugin, rest)) = decoded.split_once('/') else { return status(StatusCode::NOT_FOUND) };
    match plugins.web_file(plugin, rest) {
        Ok(file) => {
            let mut response = Response::builder()
                .header(header::CONTENT_TYPE, file.mime)
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
                .header("X-Content-Type-Options", "nosniff");
            let mut body = file.bytes;
            if file.mime.starts_with("text/html") {
                response = response.header(header::CONTENT_SECURITY_POLICY, HTML_CSP);
                body = with_bridge(&body);
            }
            response.body(body).unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR))
        }
        Err(e) => {
            tracing::debug!("{SCHEME}: {path}: {}", e.message);
            status(match e.kind {
                ide_core::error::ErrorKind::Unavailable => StatusCode::FORBIDDEN,
                ide_core::error::ErrorKind::InvalidInput => StatusCode::BAD_REQUEST,
                _ => StatusCode::NOT_FOUND,
            })
        }
    }
}

fn status(code: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(code)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Vec::new())
        .expect("a status response")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bridge_is_the_first_script() {
        let out = String::from_utf8(with_bridge(b"<!doctype html><html><HEAD lang=x><script>app()</script>")).unwrap();
        let bridge = out.find("window.openidea").unwrap();
        assert!(out.find("<HEAD lang=x>").unwrap() < bridge && bridge < out.find("app()").unwrap(), "{out}");
        assert!(out.contains("})(null);</script>"), "{out}");
        let bare = String::from_utf8(with_bridge(b"<p>x</p>")).unwrap();
        assert!(bare.starts_with("<script>(") && bare.ends_with("<p>x</p>"));
    }

    #[test]
    fn the_frame_host_follows_the_workbench_frame() {
        let frame = include_str!("../../src/features/plugins/views/frame.ts");
        let csp = frame.split("FRAME_CSP =").nth(1).and_then(|s| s.split('"').nth(1)).unwrap();
        assert_eq!(FRAME_HOST_CSP.strip_prefix("sandbox allow-scripts; ").unwrap(), csp);
        let tag = frame.split("FRAME_TAG =").nth(1).and_then(|s| s.split('"').nth(1)).unwrap();
        assert!(FRAME_HOST.contains(&format!("d.tag !== \"{tag}\"")), "{FRAME_HOST}");
        assert!(frame.contains(&format!("FRAME_HOST_PATH = \"{FRAME_HOST_PATH}\"")));
    }
}
