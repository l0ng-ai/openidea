//! The built-in web server's URLs.

use crate::Host;
use ide_core::IdeResult;
use ide_core::proxy_settings::{ProxyMode, ProxySettings};
use std::path::Path;
use std::time::Duration;

/// Whether `url` names this machine (`localhost` or a loopback address).
fn is_loopback(url: &reqwest::Url) -> bool {
    let host = url.host_str().unwrap_or_default().trim_start_matches('[').trim_end_matches(']');
    host.eq_ignore_ascii_case("localhost") || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

fn is_html(content_type: &str) -> bool {
    let kind = content_type.split(';').next().unwrap_or_default().trim();
    kind.eq_ignore_ascii_case("text/html") || kind.eq_ignore_ascii_case("application/xhtml+xml")
}

/// A client that reaches this machine only: no proxy, and a redirect is followed while it
/// stays here (a dev server sending `/` to `/app/`).
fn loopback_client() -> IdeResult<reqwest::Client> {
    let direct = ProxySettings { mode: ProxyMode::None, ..ProxySettings::default() };
    let stay = reqwest::redirect::Policy::custom(|attempt| {
        if is_loopback(attempt.url()) && attempt.previous().len() < 5 { attempt.follow() } else { attempt.stop() }
    });
    ide_http::client::build_with_redirect(&direct, stay)
}

/// Whether `url`, a server on this machine, answers a browser with an HTML document: a page
/// to open, as a dev server has, and not an API endpoint. Other hosts are never asked.
pub async fn serves_page(url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(url) else { return false };
    if !matches!(url.scheme(), "http" | "https") || !is_loopback(&url) {
        return false;
    }
    let Ok(client) = loopback_client() else { return false };
    // A dev server may compile the page on this first request.
    let request = client.get(url).header(reqwest::header::ACCEPT, "text/html").timeout(Duration::from_secs(10));
    let Ok(response) = request.send().await else { return false };
    let html = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(is_html);
    response.status().is_success() && html
}

/// The URL serving `file`, under the window's project when it holds the file.
pub async fn url(host: &Host, window: &str, file: &Path) -> IdeResult<String> {
    let root = host.project(window).ok().map(|p| p.root.clone());
    host.web.url_for(root.as_deref(), file).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// A server on a free port that answers every request with `status` and `header`. It
    /// listens on every interface, so that a test can reach it under a name that is not loopback.
    async fn answering(status: &'static str, header: String) -> String {
        let listener = tokio::net::TcpListener::bind("0.0.0.0:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut request = [0u8; 2048];
                let _ = socket.read(&mut request).await;
                let response =
                    format!("HTTP/1.1 {status}\r\n{header}\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        format!("http://127.0.0.1:{port}/")
    }

    async fn server(status: &'static str, content_type: &'static str) -> String {
        answering(status, format!("Content-Type: {content_type}")).await
    }

    async fn redirecting_to(location: &str) -> String {
        answering("302 Found", format!("Location: {location}")).await
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_redirect_is_followed_on_this_machine_only() {
        let page = server("200 OK", "text/html").await;
        assert!(serves_page(&redirecting_to(&page).await).await);
        // The same page under an address that is not loopback: it is not asked.
        let elsewhere = page.replace("127.0.0.1", "0.0.0.0");
        assert!(!serves_page(&redirecting_to(&elsewhere).await).await);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_page_is_an_html_answer_from_this_machine() {
        assert!(serves_page(&server("200 OK", "text/html; charset=utf-8").await).await);
        assert!(serves_page(&server("200 OK", "Text/HTML").await.replace("127.0.0.1", "localhost")).await);
        // An API, an error page and a port nothing listens on are not pages.
        assert!(!serves_page(&server("200 OK", "application/json").await).await);
        assert!(!serves_page(&server("404 Not Found", "text/html").await).await);
        assert!(!serves_page("http://127.0.0.1:1/").await);
        // Other machines are not asked at all.
        assert!(!serves_page("http://example.com/").await);
        assert!(!serves_page("ftp://localhost/").await);
        assert!(!serves_page("not a url").await);
    }
}
