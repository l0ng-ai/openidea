//! The one place the backend builds an HTTP client: TLS with the platform's
//! certificates, timeouts, and the proxy of System Settings › HTTP Proxy.

use ide_core::proxy_settings::{ProxyMode, ProxyRoute, ProxySettings};
use ide_core::{CancellationToken, IdeError, IdeResult};
use parking_lot::Mutex;
use std::sync::Arc;
use std::time::Duration;

/// `builder` routed as `proxy` says: direct, the environment's proxy (reqwest's
/// default), or the manual proxy except for the "No proxy for" hosts.
pub fn with_proxy(builder: reqwest::ClientBuilder, proxy: &ProxySettings) -> reqwest::ClientBuilder {
    match proxy.mode {
        ProxyMode::Auto => builder,
        ProxyMode::None => builder.no_proxy(),
        ProxyMode::Manual => {
            let proxy = proxy.clone();
            // A custom proxy also turns off the environment's.
            builder.proxy(reqwest::Proxy::custom(move |url| match proxy.route(url.host_str()) {
                ProxyRoute::Via(via) => Some(via),
                ProxyRoute::Direct | ProxyRoute::System => None,
            }))
        }
    }
}

/// A client for `proxy`.
pub fn build(proxy: &ProxySettings) -> IdeResult<reqwest::Client> {
    build_with_redirect(proxy, reqwest::redirect::Policy::default())
}

/// The backend's TLS configuration: ring with the operating system's trust store.
pub fn tls_config() -> IdeResult<rustls::ClientConfig> {
    use rustls_platform_verifier::BuilderVerifierExt;
    let fail = |e: String| IdeError::internal(format!("TLS client: {e}"));
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| fail(e.to_string()))?
        .with_platform_verifier()
        .map_err(|e| fail(e.to_string()))
        .map(|builder| builder.with_no_client_auth())
}

/// A client with an explicit redirect policy, for callers enforcing network grants.
pub fn build_with_redirect(proxy: &ProxySettings, redirect: reqwest::redirect::Policy) -> IdeResult<reqwest::Client> {
    let fail = |e: String| IdeError::internal(format!("HTTP client: {e}"));
    let tls = tls_config()?;
    // `localhost` is tried on IPv4 first: local servers (Ollama, dev servers)
    // usually listen there, and on Windows a refused `::1` costs ~2 s before
    // the system resolver's order falls back. Ports come from the URL.
    let loopback = [
        std::net::SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, 0)),
        std::net::SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, 0)),
    ];
    let builder = reqwest::Client::builder()
        .tls_backend_preconfigured(tls)
        .redirect(redirect)
        .resolve_to_addrs("localhost", &loopback)
        .connect_timeout(Duration::from_secs(30))
        .user_agent(concat!("OpenIDEA-HttpClient/", env!("CARGO_PKG_VERSION")));
    with_proxy(builder, proxy).build().map_err(|e| fail(e.to_string()))
}

/// The client for the current proxy settings, rebuilt when they change.
pub fn shared() -> IdeResult<reqwest::Client> {
    static CLIENT: Mutex<Option<(Arc<ProxySettings>, reqwest::Client)>> = Mutex::new(None);
    let proxy = ide_core::proxy_settings::proxy();
    let mut cached = CLIENT.lock();
    if let Some((settings, client)) = cached.as_ref()
        && **settings == *proxy
    {
        return Ok(client.clone());
    }
    let client = build(&proxy)?;
    *cached = Some((proxy, client.clone()));
    Ok(client)
}

/// `url`, with `http://` in front unless it starts with a scheme: a `://` later
/// on (`localhost:8080/login?next=http://…`) does not count.
pub(crate) fn with_scheme(url: &str) -> String {
    let has_scheme = url.split_once("://").is_some_and(|(scheme, _)| {
        scheme.starts_with(|c: char| c.is_ascii_alphabetic())
            && scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
    });
    if has_scheme { url.to_owned() } else { format!("http://{url}") }
}

/// HTTP Proxy › Check connection: GETs `url` through `proxy` (the settings as
/// edited, not yet applied). Any response but `407` counts as connected.
pub async fn check_connection(proxy: &ProxySettings, url: &str, cancel: &CancellationToken) -> IdeResult<String> {
    if let Some(problem) = proxy.problem() {
        return Err(IdeError::invalid(problem));
    }
    let url = url.trim();
    let url = with_scheme(url);
    let client = build(proxy)?;
    let request = client.get(&url).timeout(Duration::from_secs(30));
    let response = tokio::select! {
        r = request.send() => r.map_err(|e| IdeError::new(ide_core::error::ErrorKind::Io, describe(&e)))?,
        () = cancel.cancelled() => return Err(IdeError::cancelled()),
    };
    let status = response.status();
    if status == reqwest::StatusCode::PROXY_AUTHENTICATION_REQUIRED {
        return Err(IdeError::new(ide_core::error::ErrorKind::PermissionDenied, "Proxy authentication required (407)"));
    }
    Ok(format!("{} {}", status.as_u16(), status.canonical_reason().unwrap_or("")).trim_end().to_owned())
}

/// reqwest errors with their causes ("error sending request: … connection refused").
pub(crate) fn describe(e: &reqwest::Error) -> String {
    use std::error::Error;
    let mut msg = e.to_string();
    let mut source = e.source();
    while let Some(s) = source {
        let s_msg = s.to_string();
        if !msg.contains(&s_msg) {
            msg.push_str(": ");
            msg.push_str(&s_msg);
        }
        source = s.source();
    }
    msg
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::proxy_settings::ProxyKind;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;

    /// A one-shot HTTP server on loopback: answers `200` and hands back the request head.
    fn server() -> (u16, std::thread::JoinHandle<String>) {
        server_on("127.0.0.1:0")
    }

    fn server_on(addr: &str) -> (u16, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind(addr).unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut head = String::new();
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                    break;
                }
                head.push_str(&line);
            }
            let mut stream = stream;
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok").unwrap();
            head
        });
        (port, handle)
    }

    fn manual(port: u16) -> ProxySettings {
        ProxySettings { mode: ProxyMode::Manual, host: "127.0.0.1".into(), port, ..Default::default() }
    }

    async fn get(proxy: &ProxySettings, url: &str) -> IdeResult<String> {
        check_connection(proxy, url, &CancellationToken::new()).await
    }

    /// `localhost` reaches a server on either loopback address.
    #[tokio::test]
    async fn localhost_reaches_ipv4_and_ipv6_servers() {
        let direct = ProxySettings::default();
        let (port, v4) = server();
        assert_eq!(get(&direct, &format!("http://localhost:{port}/")).await.unwrap(), "200 OK");
        v4.join().unwrap();
        // Hosts without IPv6 loopback skip this half.
        if TcpListener::bind("[::1]:0").is_ok() {
            let (port, v6) = server_on("[::1]:0");
            assert_eq!(get(&direct, &format!("http://localhost:{port}/")).await.unwrap(), "200 OK");
            v6.join().unwrap();
        }
    }

    #[tokio::test]
    async fn builds_for_every_mode() {
        for mode in [ProxyMode::None, ProxyMode::Auto, ProxyMode::Manual] {
            for kind in [ProxyKind::Http, ProxyKind::Socks] {
                let p = ProxySettings { mode, kind, host: "proxy".into(), port: 3128, ..Default::default() };
                assert!(build(&p).is_ok(), "{mode:?} {kind:?}");
            }
        }
    }

    #[tokio::test]
    async fn manual_proxy_receives_the_request_with_credentials() {
        let (port, proxy_server) = server();
        let proxy = ProxySettings { authenticate: true, login: "me".into(), password: "s3cret".into(), ..manual(port) };
        assert_eq!(get(&proxy, "http://example.invalid/ping").await.unwrap(), "200 OK");
        let head = proxy_server.join().unwrap();
        assert!(head.starts_with("GET http://example.invalid/ping HTTP/1.1"), "{head}");
        // base64("me:s3cret")
        assert!(head.to_ascii_lowercase().contains("proxy-authorization: basic bwu6cznjcmv0"), "{head}");
    }

    #[tokio::test]
    async fn manual_proxy_without_authentication_sends_no_credentials() {
        let (port, proxy_server) = server();
        let proxy = ProxySettings { login: "me".into(), password: "x".into(), ..manual(port) };
        get(&proxy, "http://example.invalid/").await.unwrap();
        assert!(!proxy_server.join().unwrap().to_ascii_lowercase().contains("proxy-authorization"));
    }

    #[tokio::test]
    async fn no_proxy_hosts_and_no_proxy_mode_connect_directly() {
        // Nothing listens on the proxy port: a request through it would fail.
        let dead = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let (port, target) = server();
        let listed = ProxySettings { no_proxy: "example.com, 127.0.*".into(), ..manual(dead) };
        assert!(listed.bypasses("127.0.0.1"));
        get(&listed, &format!("http://127.0.0.1:{port}/direct")).await.unwrap();
        assert!(target.join().unwrap().starts_with("GET /direct HTTP/1.1"));

        let (port, target) = server();
        let none = ProxySettings { mode: ProxyMode::None, ..manual(dead) };
        get(&none, &format!("http://127.0.0.1:{port}/none")).await.unwrap();
        assert!(target.join().unwrap().starts_with("GET /none HTTP/1.1"));
    }

    #[tokio::test]
    async fn check_reports_errors() {
        let dead = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let e = get(&manual(dead), "http://example.invalid/").await.unwrap_err();
        assert!(!e.message.is_empty());
        let e = get(&manual(0), "http://example.invalid/").await.unwrap_err();
        assert!(e.message.contains("port"), "{}", e.message);
    }
}
