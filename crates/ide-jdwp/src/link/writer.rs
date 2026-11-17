//! The link's end of the JVM socket.

use std::io;
use tokio::io::{AsyncWrite, AsyncWriteExt};

/// Keeps the unwritten rest of a queued packet when a write of it is cancelled part way, so
/// every later write finishes that packet first and the JVM never reads a cut one.
pub(super) struct JvmWriter {
    out: Box<dyn AsyncWrite + Send + Unpin>,
    queued: Vec<u8>,
    written: usize,
}

impl JvmWriter {
    pub(super) fn new(out: impl AsyncWrite + Send + Unpin + 'static) -> JvmWriter {
        JvmWriter { out: Box::new(out), queued: Vec::new(), written: 0 }
    }

    /// Writes the rest of the queued packet and flushes. Cancel-safe: a dropped call leaves
    /// the unwritten bytes queued.
    pub(super) async fn finish(&mut self) -> io::Result<()> {
        while self.written < self.queued.len() {
            let n = self.out.write(&self.queued[self.written..]).await?;
            if n == 0 {
                return Err(io::ErrorKind::WriteZero.into());
            }
            self.written += n;
        }
        self.queued = Vec::new();
        self.written = 0;
        self.out.flush().await
    }

    /// Call after [`Self::finish`] succeeded, with no await in between.
    pub(super) fn queue(&mut self, packet: Vec<u8>) {
        debug_assert!(self.queued.is_empty(), "a queued packet is still unwritten");
        self.queued = packet;
        self.written = 0;
    }

    /// Not cancel-safe: only for the relay task, which stops only when the link ends.
    pub(super) async fn write_all(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.finish().await?;
        self.out.write_all(bytes).await
    }

    pub(super) async fn flush(&mut self) -> io::Result<()> {
        self.finish().await
    }
}
