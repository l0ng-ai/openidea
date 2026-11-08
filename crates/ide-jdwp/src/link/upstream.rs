//! Adapter → JVM.

use super::{HANDSHAKE, OWN_IDS, OwnCommand, RESERVED_ID, Shared, check_handshake};
use crate::codec::{HEADER_LEN, Header, MAX_ADAPTER_PACKET};
use std::io;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::sync::watch;

const MAX_HELD: usize = 1024;

pub(super) async fn run(
    shared: &Shared,
    mut adapter: impl AsyncRead + Unpin,
    mut released: watch::Receiver<bool>,
    hold: bool,
) -> io::Result<()> {
    let mut handshake = [0; HANDSHAKE.len()];
    adapter.read_exact(&mut handshake).await?;
    check_handshake(&handshake)?;
    {
        let mut jvm = shared.jvm.lock().await;
        let jvm = jvm.as_mut().ok_or_else(closed)?;
        jvm.write_all(&handshake).await?;
        let id = shared.update(|core| core.register_own(OwnCommand::IdSizes));
        jvm.write_all(&Header::command_bytes(id, 1, 7, 0)).await?;
        jvm.flush().await?;
    }
    let mut open = !hold;
    let mut held: Vec<Vec<u8>> = Vec::new();
    loop {
        // Keep the in-flight read across a release, including a partly read packet.
        let read = packet(&mut adapter);
        tokio::pin!(read);
        let packet = tokio::select! {
            packet = &mut read => packet?,
            result = async { released.wait_for(|released| *released).await.map(drop) }, if !open => {
                result.map_err(|_| io::Error::new(io::ErrorKind::ConnectionAborted, "link dropped"))?;
                open = true;
                for packet in held.drain(..) {
                    forward(shared, &packet).await?;
                }
                read.await?
            }
        };
        // Everything else must go through: attach itself queries threads and sets requests.
        if !open && is_resume(&packet) {
            if held.len() >= MAX_HELD {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "too many held JDWP resumes"));
            }
            held.push(packet);
        } else {
            forward(shared, &packet).await?;
        }
    }
}

async fn packet(reader: &mut (impl AsyncRead + Unpin)) -> io::Result<Vec<u8>> {
    let mut header = [0; HEADER_LEN];
    reader.read_exact(&mut header).await?;
    let len = Header::parse(&header).length as usize;
    if !(HEADER_LEN..=MAX_ADAPTER_PACKET).contains(&len) {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("invalid JDWP packet length {len}")));
    }
    let mut packet = vec![0; len];
    packet[..HEADER_LEN].copy_from_slice(&header);
    reader.read_exact(&mut packet[HEADER_LEN..]).await?;
    Ok(packet)
}

fn header(packet: &[u8]) -> Header {
    Header::parse(packet[..HEADER_LEN].try_into().expect("packet() returns at least a header"))
}

fn is_resume(packet: &[u8]) -> bool {
    let h = header(packet);
    // VirtualMachine.Resume, ThreadReference.Resume
    !h.is_reply() && matches!(h.command(), (1, 9) | (11, 3))
}

/// ClassType.InvokeMethod, ClassType.NewInstance, InterfaceType.InvokeMethod,
/// ObjectReference.InvokeMethod.
fn is_invoke(command: (u8, u8)) -> bool {
    matches!(command, (3, 3) | (3, 4) | (5, 1) | (9, 6))
}

async fn forward(shared: &Shared, packet: &[u8]) -> io::Result<()> {
    let h = header(packet);
    if OWN_IDS.contains(&h.id) {
        shared.update(|core| {
            core.degraded.get_or_insert_with(|| RESERVED_ID.to_string());
        });
    }
    let command = (!h.is_reply()).then(|| h.command());
    let mut jvm = loop {
        let answered = shared.own_answered.notified();
        tokio::pin!(answered);
        answered.as_mut().enable();
        let jvm = shared.jvm.lock().await;
        // Before the write: the reply may be read before this task runs again.
        let registered = shared.update(|core| {
            if command.is_some() && OWN_IDS.contains(&h.id) {
                // A reply carries only its id. The link never invokes, so the JVM answers its
                // command without waiting on anything; until then this command waits.
                if core.own.contains_key(&h.id) {
                    return false;
                }
                *core.adapter_reserved.entry(h.id).or_default() += 1;
            }
            if command.is_some_and(is_invoke) {
                core.invokes.insert(h.id);
            }
            true
        });
        if registered {
            break jvm;
        }
        drop(jvm);
        answered.await;
    };
    let jvm = jvm.as_mut().ok_or_else(closed)?;
    jvm.write_all(packet).await?;
    jvm.flush().await?;
    // Still under the writer lock, so no command of the link's own can slip in between the
    // write and the state change.
    match command {
        Some((1, 9) | (11, 3)) => shared.update(|core| core.end_stop()),
        // VirtualMachine.Dispose, VirtualMachine.Exit: the session is over, but the adapter
        // still gets the JVM's answer.
        Some((1, 6) | (1, 10)) => shared.update(|core| core.closed = true),
        _ => {}
    }
    Ok(())
}

fn closed() -> io::Error {
    io::Error::new(io::ErrorKind::NotConnected, "JDWP link closed")
}
