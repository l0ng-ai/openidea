use super::{Helper, io, process};
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV4};
use std::os::windows::io::{AsRawHandle, AsRawSocket, FromRawHandle, OwnedHandle};
use std::os::windows::process::CommandExt;
use std::process::Command;
use std::sync::Arc;
use tokio::net::TcpSocket;
use windows_sys::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, INVALID_HANDLE_VALUE, NO_ERROR};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, MIB_TCP_STATE_ESTAB, MIB_TCP_STATE_LISTEN, MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_OWNER_PID,
    TCP_TABLE_OWNER_PID_ALL,
};
use windows_sys::Win32::Networking::WinSock::{
    AF_INET, AF_INET6, SO_EXCLUSIVEADDRUSE, SOCKET_ERROR, SOL_SOCKET, WSAGetLastError, setsockopt,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
};
use windows_sys::Win32::System::Threading::{CREATE_SUSPENDED, OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

pub(super) fn make_exclusive(socket: &TcpSocket) -> io::Result<()> {
    let enabled = 1i32;
    // SAFETY: the socket is open and the option value remains valid for this call.
    let result = unsafe {
        setsockopt(
            socket.as_raw_socket() as usize,
            SOL_SOCKET,
            SO_EXCLUSIVEADDRUSE,
            (&raw const enabled).cast(),
            size_of::<i32>() as i32,
        )
    };
    if result == SOCKET_ERROR {
        // SAFETY: reads the last Winsock error on the calling thread.
        return Err(io::Error::from_raw_os_error(unsafe { WSAGetLastError() }));
    }
    Ok(())
}

pub(super) fn spawn_suspended(mut command: Command) -> io::Result<Helper> {
    let mut child = command.creation_flags(CREATE_SUSPENDED | process::CREATE_NO_WINDOW).spawn()?;
    let Some(job) = process::Job::for_child(&child) else {
        // The child has never executed, so there are no descendants to terminate.
        let _ = child.kill();
        return Err(io::Error::other("could not contain the external tunnel helper in a Windows job"));
    };
    let helper = Helper { child: Some(child), job };
    resume_initial_thread(helper.child().id())?;
    Ok(helper)
}

fn resume_initial_thread(pid: u32) -> io::Result<()> {
    // SAFETY: the snapshot handle is owned here, and each enumeration call writes a sized entry.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let snapshot = OwnedHandle::from_raw_handle(snapshot);
        let mut entry = THREADENTRY32 { dwSize: size_of::<THREADENTRY32>() as u32, ..Default::default() };
        let mut has_entry = Thread32First(snapshot.as_raw_handle(), &mut entry);
        while has_entry != 0 {
            if entry.th32OwnerProcessID == pid {
                let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                if thread.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let thread = OwnedHandle::from_raw_handle(thread);
                return match ResumeThread(thread.as_raw_handle()) {
                    1 => Ok(()),
                    u32::MAX => Err(io::Error::last_os_error()),
                    _ => Err(io::Error::other("external tunnel helper was not in its initial suspended state")),
                };
            }
            entry.dwSize = size_of::<THREADENTRY32>() as u32;
            has_entry = Thread32Next(snapshot.as_raw_handle(), &mut entry);
        }
    }
    Err(io::Error::other("could not find the external tunnel helper's suspended thread"))
}

pub(super) async fn owns_socket(helper: &Arc<Helper>, local: SocketAddr, peer: Option<SocketAddr>) -> io::Result<bool> {
    let helper = Arc::clone(helper);
    tokio::task::spawn_blocking(move || {
        let state = if peer.is_some() { MIB_TCP_STATE_ESTAB as u32 } else { MIB_TCP_STATE_LISTEN as u32 };
        let table = tcp_table(u32::from(AF_INET))?;
        // SAFETY: this is the AF_INET owner-PID table, whose rows contain only integers.
        for row in unsafe { rows::<MIB_TCPROW_OWNER_PID>(&table)? } {
            if row.dwState == state
                && v4_address(row.dwLocalAddr, row.dwLocalPort) == local
                && peer.is_none_or(|peer| v4_address(row.dwRemoteAddr, row.dwRemotePort) == peer)
                && helper.job.contains_pid(row.dwOwningPid)
            {
                return Ok(true);
            }
        }
        let table = tcp_table(u32::from(AF_INET6))?;
        // SAFETY: this is the AF_INET6 owner-PID table, whose rows contain only integers.
        for row in unsafe { rows::<MIB_TCP6ROW_OWNER_PID>(&table)? } {
            if row.dwState == state
                && mapped_address(row.ucLocalAddr, row.dwLocalPort) == Some(local)
                && peer.is_none_or(|peer| mapped_address(row.ucRemoteAddr, row.dwRemotePort) == Some(peer))
                && helper.job.contains_pid(row.dwOwningPid)
            {
                return Ok(true);
            }
        }
        Ok(false)
    })
    .await
    .map_err(io::Error::other)?
}

fn v4_address(address: u32, port: u32) -> SocketAddr {
    SocketAddrV4::new(Ipv4Addr::from(address.to_ne_bytes()), u16::from_be(port as u16)).into()
}

fn mapped_address(address: [u8; 16], port: u32) -> Option<SocketAddr> {
    let address = Ipv6Addr::from(address).to_ipv4_mapped()?;
    Some(SocketAddrV4::new(address, u16::from_be(port as u16)).into())
}

fn tcp_table(family: u32) -> io::Result<Vec<u32>> {
    const MAX_TABLE: u32 = 8 * 1024 * 1024;
    let mut size = 0;
    let mut buffer = Vec::<u32>::new();
    for _ in 0..3 {
        // SAFETY: the buffer has the supplied capacity and u32 alignment for the owner-PID table.
        let result = unsafe {
            GetExtendedTcpTable(
                if buffer.is_empty() { std::ptr::null_mut() } else { buffer.as_mut_ptr().cast() },
                &mut size,
                0,
                family,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            )
        };
        match result {
            NO_ERROR => return Ok(buffer),
            ERROR_INSUFFICIENT_BUFFER if size <= MAX_TABLE => {
                buffer.resize(size.div_ceil(size_of::<u32>() as u32) as usize, 0);
                size = (buffer.len() * size_of::<u32>()) as u32;
            }
            _ => return Err(io::Error::from_raw_os_error(result as i32)),
        }
    }
    Err(io::Error::other("the TCP socket ownership table did not stabilize"))
}

// `T` must be the matching Windows owner-PID row for this table, with no invalid bit patterns.
unsafe fn rows<T>(table: &[u32]) -> io::Result<&[T]> {
    let Some((&count, data)) = table.split_first() else {
        return Err(io::Error::other("missing TCP socket ownership table header"));
    };
    if align_of::<T>() > align_of::<u32>() || count as usize > std::mem::size_of_val(data) / size_of::<T>() {
        return Err(io::Error::other("invalid TCP socket ownership table size"));
    }
    // SAFETY: the caller supplies the matching row layout; alignment and length are checked above.
    Ok(unsafe { std::slice::from_raw_parts(data.as_ptr().cast(), count as usize) })
}
