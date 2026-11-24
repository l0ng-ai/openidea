use super::{Helper, io};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::net::{SocketAddr, SocketAddrV4};
use std::sync::Arc;

pub(super) async fn owns_socket(helper: &Arc<Helper>, local: SocketAddr, peer: Option<SocketAddr>) -> io::Result<bool> {
    let helper = Arc::clone(helper);
    tokio::task::spawn_blocking(move || {
        let (SocketAddr::V4(local), peer) = (local, peer) else { return Ok(false) };
        let peer = match peer {
            Some(SocketAddr::V4(peer)) => Some(peer),
            None => None,
            _ => return Ok(false),
        };
        let state = if peer.is_some() { "01" } else { "0A" };
        for (table, ipv6) in [("/proc/net/tcp", false), ("/proc/net/tcp6", true)] {
            let file = match File::open(table) {
                Ok(file) => file,
                Err(error) if ipv6 && error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error),
            };
            let local = address(local, ipv6);
            let peer = peer.map(|peer| address(peer, ipv6));
            // Kernel rows are small, but bound the time spent scanning a busy host's table.
            for line in BufReader::new(file.take(8 * 1024 * 1024)).lines().skip(1) {
                let line = line?;
                let mut fields = line.split_ascii_whitespace().skip(1);
                let (Some(left), Some(right), Some(current_state)) = (fields.next(), fields.next(), fields.next())
                else {
                    continue;
                };
                if left != local || current_state != state || peer.as_deref().is_some_and(|peer| peer != right) {
                    continue;
                }
                let Some(inode) = fields.nth(5).and_then(|inode| inode.parse::<u64>().ok()).filter(|inode| *inode != 0)
                else {
                    continue;
                };
                if group_holds_socket(helper.pid(), inode)? {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    })
    .await
    .map_err(io::Error::other)?
}

fn address(address: SocketAddrV4, ipv6: bool) -> String {
    let ip = address.ip();
    let port = address.port();
    if !ipv6 {
        return format!("{:08X}:{port:04X}", u32::from_ne_bytes(ip.octets()));
    }
    let octets = ip.to_ipv6_mapped().octets();
    let [a, b, c, d] = octets.as_chunks::<4>().0 else { unreachable!() };
    format!(
        "{:08X}{:08X}{:08X}{:08X}:{port:04X}",
        u32::from_ne_bytes(*a),
        u32::from_ne_bytes(*b),
        u32::from_ne_bytes(*c),
        u32::from_ne_bytes(*d)
    )
}

fn group_holds_socket(group: u32, inode: u64) -> io::Result<bool> {
    let group = i32::try_from(group).map_err(io::Error::other)?;
    let target = format!("socket:[{inode}]");
    for process in fs::read_dir("/proc")? {
        let Ok(process) = process else { continue };
        let name = process.file_name();
        let Some(pid) = name.to_str().and_then(|name| name.parse::<libc::pid_t>().ok()).filter(|pid| *pid > 0) else {
            continue;
        };
        // SAFETY: this only queries the process group of the enumerated pid.
        if unsafe { libc::getpgid(pid) } != group {
            continue;
        }
        let Ok(descriptors) = fs::read_dir(process.path().join("fd")) else { continue };
        for descriptor in descriptors.flatten() {
            if fs::read_link(descriptor.path()).is_ok_and(|link| link.as_os_str() == target.as_str()) {
                // SAFETY: check membership again after examining the fd directory.
                if unsafe { libc::getpgid(pid) } == group {
                    return Ok(true);
                }
            }
        }
    }
    Ok(false)
}
