use super::{Helper, io};
use std::net::{IpAddr, SocketAddr};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::AsyncReadExt;

const MAX_OUTPUT: u64 = 64 * 1024;

pub(super) async fn owns_socket(helper: &Arc<Helper>, local: SocketAddr, peer: Option<SocketAddr>) -> io::Result<bool> {
    let group = helper.pid().to_string();
    let sockets = format!("-iTCP:{}", local.port());
    let state = if peer.is_some() { "-sTCP:ESTABLISHED" } else { "-sTCP:LISTEN" };
    let mut probe = tokio::process::Command::new("/usr/sbin/lsof")
        .args(["-nP", "-a", "-g", &group, &sockets, state, "-Fgn"])
        .env_clear()
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let mut output = Vec::new();
    probe.stdout.take().expect("stdout is piped").take(MAX_OUTPUT + 1).read_to_end(&mut output).await?;
    if output.len() as u64 > MAX_OUTPUT {
        return Err(io::Error::other("loopback socket ownership output exceeded its limit"));
    }
    let status = probe.wait().await?;
    if !status.success() {
        // lsof uses exit 1 for a successful scan with no matching descriptors.
        return if status.code() == Some(1) && output.is_empty() {
            Ok(false)
        } else {
            Err(io::Error::other("loopback socket ownership query failed"))
        };
    }
    let mut owned = false;
    for line in String::from_utf8_lossy(&output).lines() {
        match line.as_bytes().first() {
            Some(b'p') => owned = false,
            Some(b'g') => owned = line[1..] == group,
            Some(b'n') if owned => {
                let (left, right) =
                    line[1..].split_once("->").map_or((&line[1..], None), |(left, right)| (left, Some(right)));
                if address(left) == Some(local) && right.and_then(address) == peer && right.is_some() == peer.is_some()
                {
                    return Ok(true);
                }
            }
            _ => {}
        }
    }
    Ok(false)
}

fn address(value: &str) -> Option<SocketAddr> {
    let address = value.parse::<SocketAddr>().ok()?;
    let ip = match address.ip() {
        IpAddr::V6(ip) => ip.to_ipv4_mapped().map_or(IpAddr::V6(ip), IpAddr::V4),
        ip => ip,
    };
    Some(SocketAddr::new(ip, address.port()))
}
