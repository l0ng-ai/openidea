//! Transparent relay between a debug adapter and a JVM that tracks when the VM is stopped and
//! can later inject its own commands (ids in [`OWN_IDS`]) without the adapter seeing them.

use crate::codec::{Header, Reader};
use crate::ids::{IdSizes, stop_of};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;
use std::{future::Future, io};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::task::JoinHandle;

mod downstream;
mod upstream;

#[cfg(test)]
mod tests;

/// Packet ids of the link's own commands; the adapter is expected never to use them.
pub const OWN_IDS: std::ops::Range<u32> = 0x7000_0000..0x7FFF_FFFF;

const HANDSHAKE: &[u8; 14] = b"JDWP-Handshake";
const ADAPTER_WAIT: Duration = Duration::from_secs(60);
const RESERVED_ID: &str = "adapter packet id in the reserved range";

#[derive(Clone, Copy, Debug)]
pub struct LinkOptions {
    /// Hold `VirtualMachine.Resume` and `ThreadReference.Resume` until [`JdwpLink::release`].
    pub hold_resumes: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum LinkState {
    Connecting,
    Handshaking,
    /// Running, with the adapter's resumes held until [`JdwpLink::release`].
    Held,
    Ready,
    /// `thread` is `None` when the stopping event names no thread, or arrived before the
    /// link learnt the VM's id sizes and named a thread the link could not read yet.
    Suspended {
        generation: u64,
        thread: Option<u64>,
    },
    /// Only forwarding; the link sends nothing of its own.
    Degraded(String),
    Closed,
}

#[derive(Clone)]
pub struct JdwpLink {
    inner: Arc<Inner>,
}

struct Inner {
    shared: Arc<Shared>,
    release: watch::Sender<bool>,
    task: JoinHandle<()>,
}

impl Drop for Inner {
    fn drop(&mut self) {
        // The task owns both sockets (the JVM writer through its `Arc<Shared>`), so aborting it
        // closes them.
        self.task.abort();
    }
}

type JvmWriter = Box<dyn AsyncWrite + Send + Unpin>;

struct Shared {
    core: Mutex<Core>,
    state: watch::Sender<LinkState>,
    /// Every write to the JVM goes through this lock, so packets never interleave.
    jvm: tokio::sync::Mutex<Option<JvmWriter>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OwnCommand {
    IdSizes,
}

#[derive(Default)]
struct Core {
    hold: bool,
    connected: bool,
    handshaken: bool,
    released: bool,
    stopped: bool,
    thread: Option<u64>,
    generation: u64,
    degraded: Option<String>,
    closed: bool,
    sizes: Option<IdSizes>,
    /// Body of the current stop's event when it arrived before `sizes`.
    unread_stop: Option<Vec<u8>>,
    /// Ids of adapter invokes the JVM has not answered yet.
    invokes: HashSet<u32>,
    own: HashMap<u32, OwnCommand>,
    next_own: u32,
}

impl Core {
    fn state(&self) -> LinkState {
        if self.closed {
            LinkState::Closed
        } else if let Some(reason) = &self.degraded {
            LinkState::Degraded(reason.clone())
        } else if !self.connected {
            LinkState::Connecting
        } else if !self.handshaken {
            LinkState::Handshaking
        } else if self.stopped {
            LinkState::Suspended { generation: self.generation, thread: self.thread }
        } else if self.hold && !self.released {
            LinkState::Held
        } else {
            LinkState::Ready
        }
    }

    fn register_own(&mut self, command: OwnCommand) -> u32 {
        let id = self.next_own;
        self.next_own = if id + 1 >= OWN_IDS.end { OWN_IDS.start } else { id + 1 };
        self.own.insert(id, command);
        id
    }

    fn own_reply(&mut self, command: OwnCommand, header: &Header, body: &[u8]) {
        match command {
            OwnCommand::IdSizes if header.error() == 0 => match IdSizes::parse(body) {
                Ok(sizes) => {
                    self.sizes = Some(sizes);
                    if let Some(event) = self.unread_stop.take() {
                        self.thread = stop_of(&event, &sizes).and_then(|stop| stop.thread);
                    }
                }
                Err(e) => tracing::warn!("JDWP link: malformed IDSizes reply: {e}"),
            },
            OwnCommand::IdSizes => tracing::warn!("JDWP link: IDSizes failed with error {}", header.error()),
        }
    }

    /// A `Composite` event: any event whose policy suspends something starts a new stop.
    fn event(&mut self, body: &[u8]) {
        match self.sizes {
            Some(sizes) => {
                if let Some(stop) = stop_of(body, &sizes).filter(|stop| stop.suspend_policy != 0) {
                    self.begin_stop(stop.thread, None);
                }
            }
            None => {
                let mut r = Reader::new(body);
                if r.u8().is_ok_and(|policy| policy != 0) && r.count().is_ok_and(|n| n > 0) {
                    self.begin_stop(None, Some(body.to_vec()));
                }
            }
        }
    }

    fn begin_stop(&mut self, thread: Option<u64>, unread: Option<Vec<u8>>) {
        self.generation += 1;
        self.stopped = true;
        self.thread = thread;
        self.unread_stop = unread;
    }

    fn end_stop(&mut self) {
        self.stopped = false;
        self.thread = None;
        self.unread_stop = None;
    }
}

impl Shared {
    fn new(options: LinkOptions) -> Shared {
        let core = Core { hold: options.hold_resumes, next_own: OWN_IDS.start, ..Core::default() };
        let (state, _) = watch::channel(core.state());
        Shared { core: Mutex::new(core), state, jvm: tokio::sync::Mutex::new(None) }
    }

    /// Runs `f` on the core and publishes the state if it changed.
    fn update<R>(&self, f: impl FnOnce(&mut Core) -> R) -> R {
        let mut core = self.core.lock().unwrap_or_else(PoisonError::into_inner);
        let out = f(&mut core);
        let next = core.state();
        self.state.send_if_modified(|state| {
            let changed = *state != next;
            if changed {
                *state = next;
            }
            changed
        });
        out
    }

    async fn close(&self) {
        self.update(|core| core.closed = true);
        self.jvm.lock().await.take();
    }
}

impl JdwpLink {
    /// Listens on a loopback port for the adapter (returned), then connects to the JVM. Closes
    /// if the adapter does not connect within 60 s.
    pub async fn start(jvm_host: String, jvm_port: u16, options: LinkOptions) -> io::Result<(JdwpLink, u16)> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let link = Self::spawn(options, async move {
            let (adapter, _) = listener.accept().await?;
            let jvm = TcpStream::connect((jvm_host.as_str(), jvm_port)).await?;
            adapter.set_nodelay(true)?;
            jvm.set_nodelay(true)?;
            Ok((adapter, jvm))
        });
        Ok((link, port))
    }

    /// The link over already connected streams, for fake JVMs in tests.
    #[cfg(test)]
    pub(crate) fn spawn_over<A, J>(adapter: A, jvm: J, options: LinkOptions) -> JdwpLink
    where
        A: AsyncRead + AsyncWrite + Send + Unpin + 'static,
        J: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    {
        Self::spawn(options, async move { Ok((adapter, jvm)) })
    }

    fn spawn<A, J>(options: LinkOptions, connect: impl Future<Output = io::Result<(A, J)>> + Send + 'static) -> JdwpLink
    where
        A: AsyncRead + AsyncWrite + Send + Unpin + 'static,
        J: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    {
        let shared = Arc::new(Shared::new(options));
        let (release, released) = watch::channel(false);
        let task = tokio::spawn({
            let shared = shared.clone();
            async move {
                match tokio::time::timeout(ADAPTER_WAIT, connect).await {
                    Ok(Ok((adapter, jvm))) => relay(&shared, adapter, jvm, released).await,
                    Ok(Err(e)) => tracing::debug!("JDWP link: connect failed: {e}"),
                    Err(_) => tracing::debug!("JDWP link: no adapter within {ADAPTER_WAIT:?}"),
                }
                shared.close().await;
            }
        });
        JdwpLink { inner: Arc::new(Inner { shared, release, task }) }
    }

    /// Lets held resumes through, in the order the adapter sent them.
    pub fn release(&self) {
        self.inner.shared.update(|core| core.released = true);
        self.inner.release.send_replace(true);
    }

    pub fn state(&self) -> LinkState {
        self.inner.shared.state.borrow().clone()
    }

    pub fn subscribe(&self) -> watch::Receiver<LinkState> {
        self.inner.shared.state.subscribe()
    }

    /// Number of stops seen so far; the current stop's number while `Suspended`.
    pub fn generation(&self) -> u64 {
        self.inner.shared.update(|core| core.generation)
    }

    /// Whether an adapter `InvokeMethod`/`NewInstance` is waiting for its reply. The stopped
    /// thread runs during an invoke, so the link must not inject commands meanwhile.
    pub fn adapter_invoking(&self) -> bool {
        self.inner.shared.update(|core| !core.invokes.is_empty())
    }
}

async fn relay<A, J>(shared: &Shared, adapter: A, jvm: J, released: watch::Receiver<bool>)
where
    A: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    J: AsyncRead + AsyncWrite + Send + Unpin + 'static,
{
    let (adapter_rx, adapter_tx) = tokio::io::split(adapter);
    let (jvm_rx, jvm_tx) = tokio::io::split(jvm);
    *shared.jvm.lock().await = Some(Box::new(jvm_tx));
    shared.update(|core| core.connected = true);
    let hold = shared.update(|core| core.hold);
    let result = tokio::select! {
        r = upstream::run(shared, adapter_rx, released, hold) => r,
        r = downstream::run(shared, jvm_rx, adapter_tx) => r,
    };
    if let Err(e) = result {
        tracing::debug!("JDWP link closed: {e}");
    }
}

fn check_handshake(bytes: &[u8; 14]) -> io::Result<()> {
    if bytes == HANDSHAKE { Ok(()) } else { Err(io::Error::new(io::ErrorKind::InvalidData, "invalid JDWP handshake")) }
}
