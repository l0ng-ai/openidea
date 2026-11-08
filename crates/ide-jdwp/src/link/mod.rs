//! Transparent relay between a debug adapter and a JVM that tracks when the VM is stopped and
//! can later inject its own commands (ids in [`OWN_IDS`]) without the adapter seeing them.

use state::{Core, OwnCommand, Route};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;
use std::{future::Future, io};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::task::JoinHandle;

mod command;
mod downstream;
mod ledger;
mod state;
mod upstream;

pub use command::LinkError;

#[cfg(test)]
mod command_tests;
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
    /// Signalled after each reply to one of the link's own commands.
    own_answered: tokio::sync::Notify,
    /// One injected command at a time (see `state::Turn`).
    turn: Arc<tokio::sync::Mutex<()>>,
    /// The current stop's generation; `None` while running or closed. Unlike `state`, not
    /// hidden by `Degraded`.
    stops: watch::Sender<Option<u64>>,
}

impl Shared {
    fn new(options: LinkOptions) -> Shared {
        let core = Core { hold: options.hold_resumes, next_own: OWN_IDS.start, ..Core::default() };
        let (state, _) = watch::channel(core.state());
        Shared {
            core: Mutex::new(core),
            state,
            jvm: tokio::sync::Mutex::new(None),
            own_answered: tokio::sync::Notify::new(),
            turn: Arc::default(),
            stops: watch::Sender::new(None),
        }
    }

    /// Runs `f` on the core and publishes the state if it changed.
    fn update<R>(&self, f: impl FnOnce(&mut Core) -> R) -> R {
        let mut core = self.core.lock().unwrap_or_else(PoisonError::into_inner);
        let out = f(&mut core);
        publish(&self.state, core.state());
        publish(&self.stops, (core.stopped && !core.closed).then_some(core.generation));
        out
    }

    async fn close(&self) {
        self.update(Core::close);
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

fn publish<T: PartialEq>(sender: &watch::Sender<T>, next: T) {
    sender.send_if_modified(|value| {
        let changed = *value != next;
        if changed {
            *value = next;
        }
        changed
    });
}

fn check_handshake(bytes: &[u8; 14]) -> io::Result<()> {
    if bytes == HANDSHAKE { Ok(()) } else { Err(io::Error::new(io::ErrorKind::InvalidData, "invalid JDWP handshake")) }
}
