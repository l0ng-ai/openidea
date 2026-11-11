//! A packet of the link's own that a cancelled caller or a failing socket cuts short, and a
//! flush that returns only after the JVM already acted on the packet.

use super::command_tests::{
    THREAD, entries, header, instances_body, own_instances, result, resume, spawn_command, suspended, tagged,
};
use super::tests::{
    OPEN, Pair, WAIT, adapter_marker, assert_eof, command, connect, pair_over, read_packet, reply, stop, wait_state,
    within,
};
use super::*;
use crate::codec::{HEADER_LEN, Header};
use crate::ids::ReplyIds;
use std::pin::Pin;
use std::task::{Context, Poll, Waker, ready};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream, ReadBuf};

/// Body bytes of the link's `Instances` the JVM gets before the writer stalls or fails.
const CUT: usize = 3;

#[derive(Default)]
struct Gate {
    /// Bytes still let through; `None`: no limit.
    budget: Option<usize>,
    /// Once the budget is spent: fail writes instead of stalling them.
    fail: bool,
    /// Bytes still to be written before flushes stall; `None`: flushes never stall.
    flush_after: Option<usize>,
    waker: Option<Waker>,
}

#[derive(Clone, Default)]
struct Valve(Arc<Mutex<Gate>>);

impl Valve {
    fn limit(&self, bytes: usize, fail: bool) {
        let mut gate = self.0.lock().unwrap();
        gate.budget = Some(bytes);
        gate.fail = fail;
    }

    /// Writes go through, but once `bytes` more are written flushes stay pending until [`Self::open`].
    fn stall_flush_after(&self, bytes: usize) {
        self.0.lock().unwrap().flush_after = Some(bytes);
    }

    fn open(&self) {
        let mut gate = self.0.lock().unwrap();
        gate.budget = None;
        gate.fail = false;
        gate.flush_after = None;
        if let Some(waker) = gate.waker.take() {
            waker.wake();
        }
    }
}

/// The link's end of the JVM stream; writes only what the valve lets through.
struct Throttled {
    inner: DuplexStream,
    valve: Valve,
}

impl AsyncRead for Throttled {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_read(cx, buf)
    }
}

impl AsyncWrite for Throttled {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let mut gate = this.valve.0.lock().unwrap();
        let allowed = match gate.budget {
            None => buf.len(),
            Some(0) if gate.fail => return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into())),
            Some(0) => {
                gate.waker = Some(cx.waker().clone());
                return Poll::Pending;
            }
            Some(n) => n.min(buf.len()),
        };
        let written = ready!(Pin::new(&mut this.inner).poll_write(cx, &buf[..allowed]));
        if let (Ok(n), Some(budget)) = (&written, gate.budget.as_mut()) {
            *budget -= n;
        }
        if let (Ok(n), Some(left)) = (&written, gate.flush_after.as_mut()) {
            *left = left.saturating_sub(*n);
        }
        Poll::Ready(written)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let mut gate = this.valve.0.lock().unwrap();
        if gate.flush_after == Some(0) {
            gate.waker = Some(cx.waker().clone());
            return Poll::Pending;
        }
        drop(gate);
        Pin::new(&mut this.inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

async fn throttled() -> (Pair, Valve) {
    let valve = Valve::default();
    let p = pair_over(OPEN, {
        let valve = valve.clone();
        move |inner| Throttled { inner, valve }
    });
    (suspended(connect(p).await).await, valve)
}

/// Answers the `SuspendCount` check, then lets through only the header and [`CUT`] body bytes
/// of the link's `Instances`, and reads them.
async fn cut_command(p: &mut Pair, valve: &Valve, fail: bool) -> Header {
    let check = read_packet(&mut p.jvm).await;
    let h = header(&check);
    assert_eq!((h.command(), &check[HEADER_LEN..]), ((11, 12), &THREAD.to_be_bytes()[..]));
    valve.limit(HEADER_LEN + CUT, fail);
    p.jvm.write_all(&reply(h.id, 0, &1i32.to_be_bytes())).await.unwrap();
    let mut head = [0; HEADER_LEN + CUT];
    within("cut packet", p.jvm.read_exact(&mut head)).await.unwrap();
    let h = header(&head);
    assert_eq!((h.command(), h.length as usize), ((2, 16), HEADER_LEN + instances_body().len()));
    assert_eq!(&head[HEADER_LEN..], &instances_body()[..CUT]);
    h
}

async fn read_rest(p: &mut Pair) {
    let mut rest = vec![0; instances_body().len() - CUT];
    within("rest of the cut packet", p.jvm.read_exact(&mut rest)).await.unwrap();
    assert_eq!(rest, &instances_body()[CUT..]);
}

/// The cut command's reply is the link's and counted, and the turn comes free with it.
async fn answer_cut_then_run_another(p: &mut Pair, cut: u32) {
    p.jvm.write_all(&reply(cut, 0, &tagged(&[0x66]))).await.unwrap();
    let next = spawn_command(&p.link, WAIT);
    let id = own_instances(p).await;
    p.jvm.write_all(&reply(id, 0, &tagged(&[0x77]))).await.unwrap();
    assert_eq!(result(next).await, Ok(tagged(&[0x77])));
    assert_eq!(entries(&resume(p).await), vec![vec![(0x66, 1), (0x77, 1)]]);
}

#[tokio::test]
async fn timed_out_write_ends_its_packet_before_the_adapter_writes() {
    let (mut p, valve) = throttled().await;
    let task = spawn_command(&p.link, Duration::from_millis(300));
    let cut = cut_command(&mut p, &valve, false).await;
    // the relay waits for the writer with the adapter's packet when the caller gives up
    let marker = command(0x99, 1, 1, &[]);
    p.adapter.write_all(&marker).await.unwrap();
    assert_eq!(result(task).await, Err(LinkError::TimedOut));
    valve.open();
    read_rest(&mut p).await;
    assert_eq!(read_packet(&mut p.jvm).await, marker);
    answer_cut_then_run_another(&mut p, cut.id).await;
}

#[tokio::test]
async fn cancelled_write_is_finished_without_another_writer() {
    let (mut p, valve) = throttled().await;
    let task = spawn_command(&p.link, WAIT);
    let cut = cut_command(&mut p, &valve, false).await;
    task.abort();
    assert!(within("abort", task).await.unwrap_err().is_cancelled());
    valve.open();
    read_rest(&mut p).await;
    answer_cut_then_run_another(&mut p, cut.id).await;
    // nothing but the link's own task holds the JVM stream
    let Pair { link, adapter: _adapter, mut jvm } = p;
    drop(link);
    assert_eof(&mut jvm, "jvm").await;
}

#[tokio::test]
async fn failed_write_closes_the_link() {
    let (mut p, valve) = throttled().await;
    let task = spawn_command(&p.link, WAIT);
    cut_command(&mut p, &valve, true).await;
    assert_eq!(result(task).await, Err(LinkError::Closed));
    wait_state(&p.link, LinkState::Closed).await;
    // writes work again, but no adapter byte may follow the cut packet
    valve.open();
    let _ = p.adapter.write_all(&command(0x99, 1, 1, &[])).await;
    let mut rest = Vec::new();
    within("jvm eof", p.jvm.read_to_end(&mut rest)).await.unwrap();
    assert_eq!(rest, Vec::<u8>::new());
    assert_eof(&mut p.adapter, "adapter").await;
    let refused = p.link.command(2, 16, instances_body(), ReplyIds::TaggedObjects, WAIT).await;
    assert_eq!(refused, Err(LinkError::Closed));
}

#[tokio::test]
async fn a_stop_while_the_resume_is_flushed_is_kept() {
    let (mut p, valve) = throttled().await;
    let resume = command(50, 1, 9, &[]);
    valve.stall_flush_after(resume.len());
    p.adapter.write_all(&resume).await.unwrap();
    assert_eq!(read_packet(&mut p.jvm).await, resume);
    // The JVM runs and stops again before the link's flush of the resume returns.
    stop(&mut p, 2, THREAD).await;
    valve.open();
    adapter_marker(&mut p).await;
    assert_eq!(p.link.state(), LinkState::Suspended { generation: 2, thread: Some(THREAD) });
}
