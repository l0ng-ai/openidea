//! Plugin-owned local byte streams, closed on resource drop and plugin shutdown.
use super::api::net_runtime;
use ide_core::CancellationToken;
use ide_plugin::HostError;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}
struct Connection {
    stream: tokio::sync::Mutex<Box<dyn Stream>>,
    closed: CancellationToken,
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.closed.cancel();
    }
}

#[derive(Default)]
pub(super) struct Connections {
    next: AtomicU64,
    entries: Mutex<HashMap<(String, u64), Arc<Connection>>>,
}
fn failed(e: impl std::fmt::Display) -> HostError {
    HostError::Failed(e.to_string())
}
impl Connections {
    pub fn connect(
        &self,
        plugin: &str,
        name: &str,
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> Result<u64, HostError> {
        let check = |entries: &HashMap<(String, u64), Arc<Connection>>| {
            if entries.keys().filter(|(p, _)| p == plugin).count() >= 8 {
                Err(HostError::Invalid("at most eight IPC connections per plugin".into()))
            } else {
                Ok(())
            }
        };
        check(&self.entries.lock())?;
        let stream: Box<dyn Stream> = net_runtime().block_on(async {
            let connect = async {
                #[cfg(unix)]
                { Ok::<Box<dyn Stream>, HostError>(Box::new(tokio::net::UnixStream::connect(name).await.map_err(failed)?)) }
                #[cfg(windows)]
                { Ok::<Box<dyn Stream>, HostError>(Box::new(tokio::net::windows::named_pipe::ClientOptions::new().open(name).map_err(failed)?)) }
                #[cfg(not(any(unix, windows)))]
                { let _ = name; Err(HostError::Failed("local IPC unavailable".into())) }
            };
            tokio::select! {
                r = tokio::time::timeout(timeout, connect) => r.map_err(|_| HostError::Failed("IPC connection timed out".into()))?,
                () = cancel.cancelled() => Err(HostError::Cancelled),
            }
        })?;
        let mut entries = self.entries.lock();
        check(&entries)?;
        if cancel.is_cancelled() {
            return Err(HostError::Cancelled);
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        entries.insert(
            (plugin.into(), id),
            Arc::new(Connection { stream: tokio::sync::Mutex::new(stream), closed: CancellationToken::new() }),
        );
        Ok(id)
    }
    fn get(&self, plugin: &str, id: u64) -> Result<Arc<Connection>, HostError> {
        self.entries
            .lock()
            .get(&(plugin.into(), id))
            .cloned()
            .ok_or_else(|| HostError::NotFound("IPC connection".into()))
    }
    pub fn write(
        &self,
        plugin: &str,
        id: u64,
        bytes: Vec<u8>,
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> Result<(), HostError> {
        let entry = self.get(plugin, id)?;
        net_runtime().block_on(async {
            tokio::select! {
                r = tokio::time::timeout(timeout, async { entry.stream.lock().await.write_all(&bytes).await.map_err(failed) }) => r.map_err(|_| HostError::Failed("IPC write timed out".into()))?,
                () = cancel.cancelled() => Err(HostError::Cancelled),
                () = entry.closed.cancelled() => Err(HostError::Cancelled),
            }
        })
    }
    pub fn read(
        &self,
        plugin: &str,
        id: u64,
        max: usize,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>, HostError> {
        let entry = self.get(plugin, id)?;
        net_runtime().block_on(async {
            let read = async {
                let mut bytes = vec![0; max.min(1 << 20)];
                let count = entry.stream.lock().await.read(&mut bytes).await.map_err(failed)?;
                bytes.truncate(count);
                Ok(bytes)
            };
            tokio::select! {
                biased;
                () = cancel.cancelled() => Err(HostError::Cancelled),
                () = entry.closed.cancelled() => Err(HostError::Cancelled),
                r = read => r,
                () = tokio::time::sleep(timeout) => Ok(Vec::new()),
            }
        })
    }
    pub fn close(&self, plugin: &str, id: u64) {
        if let Some(entry) = self.entries.lock().remove(&(plugin.into(), id)) {
            entry.closed.cancel();
        }
    }
    pub fn clear(&self, plugin: &str) {
        self.entries.lock().retain(|(p, _), entry| {
            if p != plugin {
                return true;
            }
            entry.closed.cancel();
            false
        });
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::os::unix::net::UnixListener;
    #[test]
    fn echo_limit_and_shutdown() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("echo.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut bytes = [0; 4];
            stream.read_exact(&mut bytes).unwrap();
            stream.write_all(&bytes).unwrap();
            // Accept the remaining seven connections before shutdown.
            for _ in 1..8 {
                listener.accept().unwrap();
            }
        });
        let pool = Connections::default();
        let token = CancellationToken::new();
        let timeout = Duration::from_secs(2);
        let id = pool.connect("a", path.to_str().unwrap(), &token, timeout).unwrap();
        pool.write("a", id, b"echo".to_vec(), &token, timeout).unwrap();
        assert_eq!(pool.read("a", id, 4, timeout, &token).unwrap(), b"echo");
        for _ in 1..8 {
            pool.connect("a", path.to_str().unwrap(), &token, timeout).unwrap();
        }
        assert!(matches!(pool.connect("a", path.to_str().unwrap(), &token, timeout), Err(HostError::Invalid(_))));
        assert!(pool.read("b", id, 4, timeout, &token).is_err());
        pool.clear("a");
        assert!(pool.read("a", id, 4, timeout, &token).is_err());
        worker.join().unwrap();
    }
}
