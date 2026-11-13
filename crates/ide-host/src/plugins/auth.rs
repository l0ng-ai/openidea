//! One-shot OAuth redirects, always bound on the desktop's IPv4 loopback.
use ide_core::CancellationToken;
use ide_plugin::HostError;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

pub(super) trait Service: Send + Sync {
    fn begin(&self, plugin: &str, window: &str, path: &str) -> Result<(u64, String), HostError>;
    fn wait(
        &self,
        plugin: &str,
        id: u64,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<Option<String>, HostError>;
    fn close(&self, plugin: &str, id: u64);
    fn clear(&self, plugin: &str);
    fn forget_window(&self, window: &str);
}
struct Entry {
    window: String,
    path: String,
    listener: Mutex<Option<TcpListener>>,
    cancel: CancellationToken,
}
#[derive(Default)]
pub(super) struct Loopbacks {
    next: AtomicU64,
    entries: Mutex<HashMap<(String, u64), Arc<Entry>>>,
}
fn failed(e: impl std::fmt::Display) -> HostError {
    HostError::Failed(e.to_string())
}
fn respond(stream: &mut TcpStream, ok: bool) {
    let body = if ok { "You can close this tab." } else { "Not found." };
    let status = if ok { "200 OK" } else { "404 Not Found" };
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{body}",
        body.len()
    );
}
impl Loopbacks {
    fn remove_where(&self, predicate: impl Fn(&str, &Entry) -> bool) {
        self.entries.lock().retain(|(p, _), entry| {
            if !predicate(p, entry) {
                return true;
            }
            entry.cancel.cancel();
            entry.listener.lock().take();
            false
        });
    }
}
impl Service for Loopbacks {
    fn begin(&self, plugin: &str, window: &str, path: &str) -> Result<(u64, String), HostError> {
        let path = path.trim_start_matches('/');
        if path.len() > 1024
            || path.bytes().any(|b| !(b.is_ascii_alphanumeric() || b"/-._~".contains(&b)))
            || path.split('/').any(|s| matches!(s, "." | ".."))
        {
            return Err(HostError::Invalid("loopback path must be a URL path without query or fragment".into()));
        }
        let mut entries = self.entries.lock();
        if entries.keys().filter(|(p, _)| p == plugin).count() >= 2 {
            return Err(HostError::Invalid("at most two open loopbacks per plugin".into()));
        }
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(failed)?;
        listener.set_nonblocking(true).map_err(failed)?;
        let uri = format!("http://127.0.0.1:{}/{path}", listener.local_addr().map_err(failed)?.port());
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        entries.insert(
            (plugin.into(), id),
            Arc::new(Entry {
                window: window.into(),
                path: format!("/{path}"),
                listener: Mutex::new(Some(listener)),
                cancel: CancellationToken::new(),
            }),
        );
        Ok((id, uri))
    }
    fn wait(
        &self,
        plugin: &str,
        id: u64,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<Option<String>, HostError> {
        let entry = self
            .entries
            .lock()
            .get(&(plugin.into(), id))
            .cloned()
            .ok_or_else(|| HostError::NotFound("loopback".into()))?;
        let listener =
            entry.listener.lock().take().ok_or_else(|| HostError::Invalid("loopback already awaited".into()))?;
        let deadline = Instant::now() + timeout;
        let result = (|| loop {
            if cancel.is_cancelled() || entry.cancel.is_cancelled() {
                return Err(HostError::Cancelled);
            }
            match listener.accept() {
                Ok((mut stream, address)) => {
                    if !address.ip().is_loopback() {
                        continue;
                    }
                    stream.set_nonblocking(true).map_err(failed)?;
                    let mut head = Vec::new();
                    loop {
                        if cancel.is_cancelled() || entry.cancel.is_cancelled() {
                            return Err(HostError::Cancelled);
                        }
                        if Instant::now() >= deadline {
                            return Ok(None);
                        }
                        let mut buf = [0; 1024];
                        match stream.read(&mut buf) {
                            Ok(0) => break,
                            Ok(n) => {
                                head.extend_from_slice(&buf[..n]);
                                if head.windows(4).any(|w| w == b"\r\n\r\n") || head.len() > 8192 {
                                    break;
                                }
                            }
                            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                                std::thread::sleep(Duration::from_millis(5))
                            }
                            Err(e) => return Err(failed(e)),
                        }
                    }
                    let line = std::str::from_utf8(&head).unwrap_or_default().lines().next().unwrap_or_default();
                    let target = line.strip_prefix("GET ").and_then(|s| s.split_once(' ')).map(|(target, _)| target);
                    let query = target.and_then(|target| {
                        let (path, query) = target.split_once('?').unwrap_or((target, ""));
                        (path == entry.path && head.len() <= 8192).then(|| query.to_owned())
                    });
                    stream.set_nonblocking(false).map_err(failed)?;
                    stream.set_write_timeout(Some(Duration::from_millis(100))).map_err(failed)?;
                    respond(&mut stream, query.is_some());
                    if query.is_some() {
                        return Ok(query);
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(e) => return Err(failed(e)),
            }
            if Instant::now() >= deadline {
                return Ok(None);
            }
            std::thread::sleep(Duration::from_millis(5));
        })();
        self.close(plugin, id);
        result
    }
    fn close(&self, plugin: &str, id: u64) {
        let entry = self.entries.lock().remove(&(plugin.into(), id));
        if let Some(entry) = entry {
            entry.cancel.cancel();
            entry.listener.lock().take();
        }
    }
    fn clear(&self, plugin: &str) {
        self.remove_where(|p, _| p == plugin || p.starts_with("remote:") && p.ends_with(&format!(":{plugin}")));
    }
    fn forget_window(&self, window: &str) {
        self.remove_where(|_, entry| entry.window == window);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn one_shot_raw_query_limits_timeout_and_cleanup() {
        let service = Arc::new(Loopbacks::default());
        let (id, uri) = service.begin("a", "main", "oauth/callback").unwrap();
        assert!(uri.starts_with("http://127.0.0.1:"));
        let (other, _) = service.begin("a", "main", "").unwrap();
        assert!(service.begin("a", "main", "third").is_err());
        assert_eq!(service.wait("a", other, Duration::ZERO, &CancellationToken::new()).unwrap(), None);
        let host = uri.strip_prefix("http://").unwrap().split('/').next().unwrap().to_owned();
        let worker = std::thread::spawn(move || {
            let mut stream = TcpStream::connect(host).unwrap();
            stream.write_all(b"GET /oauth/callback?code=a%2Bb&state=x HTTP/1.1\r\nHost: localhost\r\n\r\n").unwrap();
            let mut answer = String::new();
            stream.read_to_string(&mut answer).unwrap();
            assert!(answer.contains("You can close this tab"));
        });
        assert_eq!(
            service.wait("a", id, Duration::from_secs(2), &CancellationToken::new()).unwrap(),
            Some("code=a%2Bb&state=x".into())
        );
        worker.join().unwrap();
        assert!(service.wait("a", id, Duration::ZERO, &CancellationToken::new()).is_err());
        let (id, _) = service.begin("a", "main", "callback").unwrap();
        service.forget_window("main");
        assert!(service.wait("a", id, Duration::ZERO, &CancellationToken::new()).is_err());
    }
}
