//! A TCP connection routed like the HTTP client's requests, for protocols reqwest does not
//! speak (a WebSocket): direct, or through an HTTP proxy's `CONNECT` tunnel.

use base64::Engine;
use ide_core::proxy_settings::ProxyRoute;
use ide_core::{IdeError, IdeResult};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// A connection to `url`'s host and port, through the proxy System Settings › HTTP Proxy
/// (or, in Auto mode, the system) routes that host to.
pub async fn connect(url: &reqwest::Url) -> IdeResult<TcpStream> {
    let host = url.host_str().ok_or_else(|| IdeError::invalid("the URL has no host"))?;
    let port = url.port_or_known_default().ok_or_else(|| IdeError::invalid("the URL has no port"))?;
    let target = if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") };
    let proxy = match ide_core::proxy_settings::proxy().route(Some(host)) {
        ProxyRoute::Direct => None,
        ProxyRoute::Via(via) => Some(via),
        ProxyRoute::System => {
            // The system proxy of the scheme reqwest would use (`ws` → `http`).
            let scheme = if url.scheme() == "wss" || url.scheme() == "https" { "https" } else { "http" };
            let uri: http::Uri =
                format!("{scheme}://{target}/").parse().map_err(|_| IdeError::invalid("invalid host"))?;
            hyper_util::client::proxy::matcher::Matcher::from_system().intercept(&uri).map(|intercept| {
                let auth =
                    intercept.raw_auth().map(|(user, password)| format!("{user}:{password}@")).unwrap_or_default();
                let uri = intercept.uri();
                format!(
                    "{}://{auth}{}",
                    uri.scheme_str().unwrap_or("http"),
                    uri.authority().map(|a| a.as_str()).unwrap_or_default()
                )
            })
        }
    };
    let connecting = async {
        let Some(proxy) = proxy else {
            return TcpStream::connect(&target).await.map_err(|error| reach(&target, &error));
        };
        let proxy = reqwest::Url::parse(&proxy).map_err(|_| IdeError::invalid("invalid proxy URL"))?;
        if proxy.scheme() != "http" {
            return Err(IdeError::unavailable(format!(
                "a {} proxy cannot carry this connection; set an HTTP proxy",
                proxy.scheme()
            )));
        }
        let address =
            format!("{}:{}", proxy.host_str().unwrap_or_default(), proxy.port_or_known_default().unwrap_or(80));
        let stream = TcpStream::connect(&address).await.map_err(|error| reach(&address, &error))?;
        let auth = (!proxy.username().is_empty()).then(|| {
            let user = percent_decode(proxy.username());
            let password = percent_decode(proxy.password().unwrap_or_default());
            base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}"))
        });
        tunnel(stream, &target, auth.as_deref()).await
    };
    tokio::time::timeout(CONNECT_TIMEOUT, connecting)
        .await
        .map_err(|_| IdeError::unavailable(format!("connecting to {target} timed out")))?
}

fn reach(address: &str, error: &std::io::Error) -> IdeError {
    IdeError::unavailable(format!("could not connect to {address}: {error}"))
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(byte) = text.get(i + 1..i + 3).and_then(|hex| u8::from_str_radix(hex, 16).ok())
        {
            out.push(byte);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Asks the proxy on `stream` for a tunnel to `target` (`host:port`).
async fn tunnel(mut stream: TcpStream, target: &str, auth: Option<&str>) -> IdeResult<TcpStream> {
    let auth = auth.map(|auth| format!("Proxy-Authorization: Basic {auth}\r\n")).unwrap_or_default();
    let request = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n{auth}\r\n");
    let failed = |error: std::io::Error| IdeError::unavailable(format!("proxy: {error}"));
    stream.write_all(request.as_bytes()).await.map_err(failed)?;
    // The reply's head only: nothing follows it until this side speaks.
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() > 8192 || stream.read(&mut byte).await.map_err(failed)? == 0 {
            return Err(IdeError::unavailable("the proxy closed the connection"));
        }
        head.push(byte[0]);
    }
    let status = String::from_utf8_lossy(&head);
    let status = status.lines().next().unwrap_or_default();
    match status.split_whitespace().nth(1) {
        Some("200") => Ok(stream),
        Some("407") => Err(IdeError::unavailable("the proxy needs a login (HTTP Proxy settings)")),
        _ => Err(IdeError::unavailable(format!("the proxy refused the connection: {status}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    /// A proxy that answers `reply` to one CONNECT and then echoes; returns what it was asked.
    async fn proxy(reply: &'static str) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let task = tokio::spawn(async move {
            let (mut client, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                client.read_exact(&mut byte).await.unwrap();
                head.push(byte[0]);
            }
            client.write_all(reply.as_bytes()).await.unwrap();
            let mut echo = [0u8; 5];
            if client.read_exact(&mut echo).await.is_ok() {
                client.write_all(&echo).await.unwrap();
            }
            String::from_utf8(head).unwrap()
        });
        (address, task)
    }

    #[tokio::test]
    async fn a_tunnel_carries_bytes_after_the_proxy_agrees() {
        let (address, asked) = proxy("HTTP/1.1 200 Connection established\r\n\r\n").await;
        let stream = TcpStream::connect(&address).await.unwrap();
        let mut stream = tunnel(stream, "hub.example.com:443", Some("dTpw")).await.unwrap();
        stream.write_all(b"hello").await.unwrap();
        let mut back = [0u8; 5];
        stream.read_exact(&mut back).await.unwrap();
        assert_eq!(&back, b"hello");
        let asked = asked.await.unwrap();
        assert!(asked.starts_with("CONNECT hub.example.com:443 HTTP/1.1\r\n"));
        assert!(asked.contains("Proxy-Authorization: Basic dTpw\r\n"));
    }

    #[tokio::test]
    async fn a_refused_tunnel_says_why() {
        let (address, _) = proxy("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n").await;
        let stream = TcpStream::connect(&address).await.unwrap();
        let error = tunnel(stream, "hub.example.com:443", None).await.unwrap_err();
        assert!(error.message.contains("needs a login"), "{}", error.message);
    }

    #[test]
    fn proxy_credentials_are_percent_decoded() {
        assert_eq!(percent_decode("a%40b%3Ac"), "a@b:c");
        assert_eq!(percent_decode("100%"), "100%");
    }
}
