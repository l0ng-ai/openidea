//! JVM → adapter.

use super::{HANDSHAKE, Shared, check_handshake};
use crate::codec::{HEADER_LEN, Header};
use std::io;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Largest event packet parsed for a stop; a larger one is forwarded unread.
const MAX_EVENT: usize = 1024 * 1024;

pub(super) async fn run(
    shared: &Shared,
    mut jvm: impl AsyncRead + Unpin,
    mut adapter: impl AsyncWrite + Unpin,
) -> io::Result<()> {
    let mut handshake = [0; HANDSHAKE.len()];
    jvm.read_exact(&mut handshake).await?;
    check_handshake(&handshake)?;
    adapter.write_all(&handshake).await?;
    adapter.flush().await?;
    shared.update(|core| core.handshaken = true);
    let mut header = [0; HEADER_LEN];
    loop {
        jvm.read_exact(&mut header).await?;
        let h = Header::parse(&header);
        let len = h.length as usize;
        let body_len = len
            .checked_sub(HEADER_LEN)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, format!("invalid JDWP packet length {len}")))?;
        if h.is_reply() {
            if let Some(own) = shared.update(|core| core.own.remove(&h.id)) {
                let body = read_body(&mut jvm, body_len).await?;
                shared.update(|core| core.own_reply(own, &h, &body));
                continue;
            }
            shared.update(|core| core.invokes.remove(&h.id));
        } else if h.command() == (64, 100) && len <= MAX_EVENT {
            let mut packet = vec![0; len];
            packet[..HEADER_LEN].copy_from_slice(&header);
            jvm.read_exact(&mut packet[HEADER_LEN..]).await?;
            // The state changes before the adapter can react to the event.
            shared.update(|core| core.event(&packet[HEADER_LEN..]));
            adapter.write_all(&packet).await?;
            adapter.flush().await?;
            continue;
        }
        adapter.write_all(&header).await?;
        let copied = tokio::io::copy(&mut (&mut jvm).take(body_len as u64), &mut adapter).await?;
        if copied != body_len as u64 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        adapter.flush().await?;
    }
}

/// Grows the buffer as bytes arrive instead of trusting the length up front.
async fn read_body(jvm: &mut (impl AsyncRead + Unpin), len: usize) -> io::Result<Vec<u8>> {
    let mut body = Vec::new();
    jvm.take(len as u64).read_to_end(&mut body).await?;
    if body.len() != len {
        return Err(io::ErrorKind::UnexpectedEof.into());
    }
    Ok(body)
}
