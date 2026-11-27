use ide_core::{CancellationToken, IdeError, IdeResult, error::ErrorKind};
use parking_lot::Mutex;
use std::{
    collections::HashMap,
    path::Path,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    process::Command,
    sync::{mpsc, oneshot},
    time::{Instant, timeout, timeout_at},
};

const LIMIT: usize = 16 * 1024 * 1024;
const HEADER: usize = 16;
const CANCEL_GRACE: Duration = Duration::from_secs(3);
type Replies = Arc<Mutex<HashMap<u64, mpsc::Sender<Vec<u8>>>>>;

pub(super) struct Bridge {
    closed: CancellationToken,
    exited: CancellationToken,
    sequence: AtomicU64,
    outgoing: mpsc::Sender<Outgoing>,
    replies: Replies,
}

struct Outgoing {
    frame: Vec<u8>,
    session: CancellationToken,
    sent: oneshot::Sender<IdeResult<()>>,
}

struct Pending<'a> {
    bridge: &'a Bridge,
    id: u64,
    incoming: mpsc::Receiver<Vec<u8>>,
}

impl Drop for Pending<'_> {
    fn drop(&mut self) {
        self.bridge.replies.lock().remove(&self.id);
    }
}

impl Pending<'_> {
    async fn recv(&mut self) -> IdeResult<Vec<u8>> {
        tokio::select! {
            biased;
            frame = self.incoming.recv() => frame.ok_or_else(disconnected),
            () = self.bridge.closed.cancelled() => Err(disconnected()),
        }
    }
}

impl Bridge {
    pub(super) fn start(cache: &Path, jars: &[String]) -> IdeResult<Self> {
        let jdks = ide_sdk::java::installed_jdks();
        let java = ide_sdk::java::java_runtime(&jdks, 17)
            .ok_or_else(|| IdeError::invalid("Install a Java 17 or newer runtime to use custom JDBC drivers"))?;
        let jar = ide_sdk::java::jdbc_bridge_jar(cache)
            .ok_or_else(|| IdeError::invalid("Cannot install the JDBC bridge in the application data directory"))?;
        let classpath = std::env::join_paths(std::iter::once(jar.as_path()).chain(jars.iter().map(Path::new)))
            .map_err(|_| IdeError::invalid("A JDBC JAR path contains the system classpath separator"))?;
        // Embedded databases can resolve file URLs against the JVM's working directory.
        let files = cache.join("files");
        std::fs::create_dir_all(&files)?;
        let mut command = Command::new(ide_sdk::java::java_executable(&java.home));
        command.current_dir(files);
        ide_core::process::prepare(command.as_std_mut());
        let mut child = command
            .args(["-Xms8m", "-Xmx192m", "--enable-native-access=ALL-UNNAMED", "-cp"])
            .arg(classpath)
            .args(["ai.openidea.jdbc.OpenIdeaJdbc", "--multiplex"])
            .env_remove("CLASSPATH")
            .env_remove("JDK_JAVA_OPTIONS")
            .env_remove("JAVA_TOOL_OPTIONS")
            .env_remove("_JAVA_OPTIONS")
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let input = child.stdin.take().expect("piped");
        let output = child.stdout.take().expect("piped");
        let closed = CancellationToken::new();
        let exited = CancellationToken::new();
        tokio::spawn({
            let closed = closed.clone();
            let exited = exited.clone();
            async move {
                tokio::select! {
                    _ = child.wait() => {}
                    () = closed.cancelled() => {
                        // The writer drops stdin. Give file-based drivers time to flush.
                        if timeout(Duration::from_secs(2), child.wait()).await.is_err() {
                            let _ = child.kill().await;
                        }
                    }
                }
                closed.cancel();
                exited.cancel();
            }
        });
        Ok(Self::with_io(input, output, closed, exited))
    }

    fn with_io(
        input: impl AsyncWrite + Unpin + Send + 'static,
        output: impl AsyncRead + Unpin + Send + 'static,
        closed: CancellationToken,
        exited: CancellationToken,
    ) -> Self {
        let (outgoing, writes) = mpsc::channel(4);
        let replies = Replies::default();
        tokio::spawn(write_frames(input, writes, closed.clone()));
        tokio::spawn(read_frames(output, replies.clone(), closed.clone()));
        Self { closed, exited, sequence: AtomicU64::new(1), outgoing, replies }
    }

    pub(super) fn shutdown(&self) {
        self.closed.cancel();
    }

    pub(super) fn is_closed(&self) -> bool {
        self.closed.is_cancelled()
    }

    pub(super) async fn close(&self) {
        self.shutdown();
        self.exited.cancelled().await;
    }

    async fn send(&self, frame: Vec<u8>, session: &CancellationToken) -> IdeResult<()> {
        let (sent, receipt) = oneshot::channel();
        tokio::select! {
            () = self.closed.cancelled() => return Err(disconnected()),
            result = self.outgoing.send(Outgoing { frame, session: session.clone(), sent }) => {
                result.map_err(|_| disconnected())?;
            }
        }
        tokio::select! {
            biased;
            result = receipt => result.map_err(|_| disconnected())?,
            () = self.closed.cancelled() => Err(disconnected()),
        }
    }

    pub(super) async fn exchange(
        &self,
        session: u32,
        fields: &[&str],
        cancel: &CancellationToken,
        active: &CancellationToken,
    ) -> IdeResult<Option<Vec<u8>>> {
        if cancel.is_cancelled() {
            return Ok(None);
        }
        if active.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let id = self
            .sequence
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |next| next.checked_add(1))
            .map_err(|_| IdeError::internal("JDBC request IDs exhausted"))?;
        let frame = encode(id, session, fields)?;
        let (sender, incoming) = mpsc::channel(2);
        self.replies.lock().insert(id, sender);
        let mut pending = Pending { bridge: self, id, incoming };
        let send = self.send(frame, active);
        tokio::pin!(send);
        let early_deadline = tokio::select! {
            result = &mut send => { result?; None },
            () = cancel.cancelled() => {
                let end = Instant::now() + CANCEL_GRACE;
                timeout_at(end, send).await.map_err(|_| cancel_timeout())??;
                Some(end)
            }
        };
        let deadline = tokio::select! {
            biased;
            () = cancel.cancelled() => early_deadline.unwrap_or_else(|| Instant::now() + CANCEL_GRACE),
            data = pending.recv() => {
                let data = data?;
                if data.is_empty() { return Err(IdeError::invalid("Unexpected JDBC cancellation acknowledgement")); }
                return Ok(Some(data));
            }
        };
        let data = timeout_at(deadline, async {
            self.send(header(id, session, 0).to_vec(), active).await?;
            let first = pending.recv().await?;
            let second = pending.recv().await?;
            match (first.is_empty(), second.is_empty()) {
                (true, false) => Ok(second),
                (false, true) => Ok(first),
                _ => Err(IdeError::invalid("Invalid JDBC cancellation acknowledgement")),
            }
        })
        .await
        .map_err(|_| cancel_timeout())??;
        match data.first() {
            // A committed statement may finish before the bridge receives Cancel.
            Some(1) => Ok(Some(data)),
            Some(0) => Ok(None),
            _ => Err(IdeError::invalid("Invalid JDBC cancellation response")),
        }
    }

    pub(super) async fn close_session(&self, session: u32) -> IdeResult<()> {
        if self.is_closed() {
            return Ok(());
        }
        let control = CancellationToken::new();
        let data = timeout(CANCEL_GRACE, self.exchange(session, &["close"], &control, &control))
            .await
            .map_err(|_| IdeError::new(ErrorKind::TimedOut, "Closing the JDBC console timed out"))??;
        super::decode(&data.ok_or_else(IdeError::cancelled)?, "", 0.).map(|_| ())
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.shutdown();
    }
}

async fn write_frames(
    mut input: impl AsyncWrite + Unpin,
    mut writes: mpsc::Receiver<Outgoing>,
    closed: CancellationToken,
) {
    while let Some(outgoing) = tokio::select! {
        biased;
        () = closed.cancelled() => None,
        outgoing = writes.recv() => outgoing,
    } {
        // If Close raced with an enqueued Open or query, discard it before writing.
        if outgoing.session.is_cancelled() {
            let _ = outgoing.sent.send(Err(IdeError::cancelled()));
            continue;
        }
        let result = tokio::select! {
            () = closed.cancelled() => break,
            result = input.write_all(&outgoing.frame) => result.map_err(IdeError::from),
        };
        let failed = result.is_err();
        let _ = outgoing.sent.send(result);
        if failed {
            break;
        }
    }
    closed.cancel();
}

async fn read_frames(mut output: impl AsyncRead + Unpin, replies: Replies, closed: CancellationToken) {
    loop {
        let frame = async {
            let id = output.read_u64().await?;
            Ok::<_, IdeError>((id, read_frame(&mut output).await?))
        };
        let (id, data) = match tokio::select! {
            () = closed.cancelled() => break,
            result = frame => result,
        } {
            Ok(frame) => frame,
            Err(_) => break,
        };
        let sender = replies.lock().get(&id).cloned();
        // A response may arrive after its caller was cancelled and retired.
        if let Some(sender) = sender
            && matches!(sender.try_send(data), Err(mpsc::error::TrySendError::Full(_)))
        {
            break;
        }
    }
    closed.cancel();
}

fn disconnected() -> IdeError {
    IdeError::new(ErrorKind::Io, "JDBC connection was lost")
}

fn cancel_timeout() -> IdeError {
    IdeError::invalid(
        "Cancellation timed out and the JDBC session was closed. Check the statement's status on the server before running it again. The next query will try to reconnect.",
    )
}

fn header(id: u64, session: u32, fields: u32) -> [u8; HEADER] {
    let mut bytes = [0; HEADER];
    bytes[..8].copy_from_slice(&id.to_be_bytes());
    bytes[8..12].copy_from_slice(&session.to_be_bytes());
    bytes[12..].copy_from_slice(&fields.to_be_bytes());
    bytes
}

pub(super) fn frame_size(fields: &[&str]) -> IdeResult<usize> {
    if fields.is_empty() || fields.len() > 8192 {
        return Err(IdeError::invalid("Invalid JDBC field count"));
    }
    fields
        .iter()
        .try_fold(HEADER, |n, s| n.checked_add(4)?.checked_add(s.len()).filter(|n| *n <= LIMIT))
        .ok_or_else(|| IdeError::invalid("JDBC request exceeds 16 MiB"))
}

fn encode(id: u64, session: u32, fields: &[&str]) -> IdeResult<Vec<u8>> {
    let size = frame_size(fields)?;
    let mut data = Vec::with_capacity(size);
    data.extend_from_slice(&header(id, session, fields.len() as u32));
    for field in fields {
        data.extend_from_slice(&(field.len() as u32).to_be_bytes());
        data.extend_from_slice(field.as_bytes());
    }
    Ok(data)
}

async fn read_frame(output: &mut (impl AsyncRead + Unpin)) -> IdeResult<Vec<u8>> {
    let n = output.read_u32().await? as usize;
    if n > LIMIT {
        return Err(IdeError::invalid("JDBC response exceeds 16 MiB"));
    }
    let mut data = vec![0; n];
    output.read_exact(&mut data).await?;
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frame_codec_checks_both_16_mib_boundaries() {
        assert_eq!(encode(7, 3, &["a"]).unwrap(), [0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 3, 0, 0, 0, 1, 0, 0, 0, 1, b'a']);
        let mut field = "x".repeat(LIMIT - HEADER - 4);
        assert_eq!(encode(1, 0, &[&field]).unwrap().len(), LIMIT);
        field.push('x');
        assert!(encode(1, 0, &[&field]).is_err());
        let mut framed = vec![0u8; LIMIT + 4];
        framed[..4].copy_from_slice(&(LIMIT as u32).to_be_bytes());
        assert_eq!(read_frame(&mut framed.as_slice()).await.unwrap().len(), LIMIT);
        assert!(read_frame(&mut &((LIMIT + 1) as u32).to_be_bytes()[..]).await.is_err());
        assert!(read_frame(&mut &[0, 0, 0, 2, 1u8][..]).await.is_err());
    }

    async fn reply(output: &mut (impl AsyncWrite + Unpin), id: u64, body: &[u8]) {
        output.write_u64(id).await.unwrap();
        output.write_u32(body.len() as u32).await.unwrap();
        output.write_all(body).await.unwrap();
    }

    #[tokio::test]
    async fn exchange_rejects_an_acknowledgement_for_an_uncancelled_request() {
        let (input, mut peer_input) = tokio::io::duplex(32);
        let (output, mut peer_output) = tokio::io::duplex(32);
        let active = CancellationToken::new();
        let bridge = Bridge::with_io(input, output, CancellationToken::new(), CancellationToken::new());
        let peer = async {
            let frame = encode(1, 0, &["query"]).unwrap();
            let mut actual = vec![0; frame.len()];
            peer_input.read_exact(&mut actual).await.unwrap();
            assert_eq!(actual, frame);
            reply(&mut peer_output, 1, &[]).await;
        };
        let (result, ()) = tokio::join!(bridge.exchange(0, &["query"], &active, &active), peer);
        assert!(result.unwrap_err().message.contains("Unexpected JDBC cancellation acknowledgement"));
    }

    #[tokio::test]
    async fn cancellation_drains_tagged_replies_without_stealing_a_siblings_response() {
        for ack_first in [true, false] {
            let (input, mut peer_input) = tokio::io::duplex(1);
            let (output, mut peer_output) = tokio::io::duplex(1);
            let active = CancellationToken::new();
            let cancel = CancellationToken::new();
            let bridge = Bridge::with_io(input, output, CancellationToken::new(), CancellationToken::new());
            let peer = async {
                let frame = encode(1, 11, &["query"]).unwrap();
                let mut request = vec![0; frame.len()];
                peer_input.read_exact(&mut request).await.unwrap();
                assert_eq!(request, frame);
                peer_input.read_exact(&mut request).await.unwrap();
                assert_eq!(request, encode(2, 22, &["query"]).unwrap());

                // Cancel during a partial reply header; the reader must stay on that frame.
                peer_output.write_all(&1u64.to_be_bytes()[..2]).await.unwrap();
                cancel.cancel();
                let mut stop = [0; HEADER];
                peer_input.read_exact(&mut stop).await.unwrap();
                assert_eq!(stop, header(1, 11, 0));

                peer_output.write_all(&1u64.to_be_bytes()[2..]).await.unwrap();
                let terminal = !ack_first;
                peer_output.write_u32(u32::from(terminal)).await.unwrap();
                if terminal {
                    peer_output.write_u8(1).await.unwrap();
                }
                reply(&mut peer_output, 2, &[1, b'b']).await;
                reply(&mut peer_output, 1, if ack_first { &[0] } else { &[] }).await;
            };
            let (a, b, ()) = tokio::join!(
                biased;
                bridge.exchange(11, &["query"], &cancel, &active),
                bridge.exchange(22, &["query"], &active, &active),
                peer,
            );
            assert_eq!(a.unwrap(), (!ack_first).then(|| vec![1]));
            assert_eq!(b.unwrap(), Some(vec![1, b'b']));
        }
    }
}
