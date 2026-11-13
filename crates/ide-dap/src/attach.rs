//! Attach to Process: the current user's processes, grouped by the debugger that can
//! attach to them (IDEA's `XAttachDebuggerProvider`s): JVMs with a JDWP agent, Node,
//! Python (debugpy injection), .NET (netcoredbg), Go binaries (Delve) and anything else
//! natively (LLDB).

use crate::adapter;
use ide_core::{IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AttachKind {
    Java,
    Node,
    Python,
    Dotnet,
    Go,
    Native,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AttachableProcess {
    pub pid: u32,
    /// Executable name.
    pub name: String,
    pub command_line: String,
    pub kind: AttachKind,
    /// Debug adapter that attaches to it.
    pub adapter: String,
    /// Debug port the process listens on (JDWP, `--inspect`, `debugpy --listen`).
    pub host: Option<String>,
    pub port: Option<u16>,
}

/// One row of the process table.
#[derive(Clone, Debug)]
pub struct RawProcess {
    pub pid: u32,
    pub exe: String,
    pub args: String,
}

/// `[host:]port` of a debug agent address (`*` and empty hosts mean loopback).
fn host_port(addr: &str) -> Option<(Option<String>, u16)> {
    let addr = addr.trim();
    let (host, port) = match addr.rsplit_once(':') {
        Some((h, p)) => (Some(h), p),
        None => (None, addr),
    };
    let port: u16 = port.parse().ok()?;
    let host = host.filter(|h| !h.is_empty() && *h != "*" && *h != "0.0.0.0").map(str::to_owned);
    Some((host, port))
}

/// `-agentlib:jdwp=transport=dt_socket,server=y,address=*:5005` (or `-Xrunjdwp:`).
pub fn jdwp_address(args: &str) -> Option<(Option<String>, u16)> {
    let opts = args
        .split_whitespace()
        .find_map(|a| a.strip_prefix("-agentlib:jdwp=").or_else(|| a.strip_prefix("-Xrunjdwp:")))?;
    let mut server = false;
    let mut address = None;
    for kv in opts.split(',') {
        match kv.split_once('=') {
            Some(("server", v)) => server = v == "y",
            Some(("address", v)) => address = Some(v),
            _ => {}
        }
    }
    if !server {
        return None;
    }
    host_port(address?)
}

/// `--inspect`, `--inspect-brk=9230`, `--inspect=127.0.0.1:9230` (default port 9229).
fn inspect_address(args: &str) -> Option<(Option<String>, u16)> {
    args.split_whitespace().find_map(|a| {
        let rest = a.strip_prefix("--inspect-brk").or_else(|| a.strip_prefix("--inspect"))?;
        if rest.is_empty() { Some((None, 9229)) } else { host_port(rest.strip_prefix('=')?) }
    })
}

/// `-m debugpy --listen [host:]port`.
fn debugpy_listen(args: &str) -> Option<(Option<String>, u16)> {
    let words: Vec<&str> = args.split_whitespace().collect();
    if !words.contains(&"debugpy") {
        return None;
    }
    let i = words.iter().position(|w| *w == "--listen")?;
    host_port(words.get(i + 1)?)
}

fn file_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

/// A .NET app: the `dotnet` host, or an apphost next to its `<name>.runtimeconfig.json`.
pub fn is_dotnet(exe: &str) -> bool {
    let path = Path::new(exe);
    let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { return false };
    if stem == "dotnet" {
        return true;
    }
    path.is_absolute() && path.with_file_name(format!("{stem}.runtimeconfig.json")).is_file()
}

fn is_python(name: &str) -> bool {
    let n = name.strip_suffix(".exe").unwrap_or(name);
    n == "Python" || n.strip_prefix("python").is_some_and(|v| v.chars().all(|c| c.is_ascii_digit() || c == '.'))
}

/// Classifies a process; `is_dotnet` and `is_go` are asked only for processes no
/// interpreter claims.
pub fn classify(
    p: &RawProcess,
    is_dotnet: impl Fn(&str) -> bool,
    is_go: impl Fn(&str) -> bool,
    native_adapter: &str,
) -> Option<AttachableProcess> {
    let name = file_name(&p.exe).to_owned();
    let make = |kind, adapter: &str, addr: Option<(Option<String>, u16)>| {
        let (host, port) = match addr {
            Some((h, p)) => (h, Some(p)),
            None => (None, None),
        };
        Some(AttachableProcess {
            pid: p.pid,
            name: name.clone(),
            command_line: p.args.clone(),
            kind,
            adapter: adapter.to_owned(),
            host,
            port,
        })
    };
    let base = name.strip_suffix(".exe").unwrap_or(&name);
    if base == "java" || base == "javaw" {
        // Only JVMs started with a JDWP agent can be attached to.
        return jdwp_address(&p.args).and_then(|a| make(AttachKind::Java, "java-debug", Some(a)));
    }
    if base == "node" || base == "nodejs" {
        return make(AttachKind::Node, "js-debug", inspect_address(&p.args));
    }
    if is_python(&name) {
        return make(AttachKind::Python, "debugpy", debugpy_listen(&p.args));
    }
    if is_dotnet(&p.exe) {
        return make(AttachKind::Dotnet, "netcoredbg", None);
    }
    if is_go(&p.exe) {
        return make(AttachKind::Go, "delve", None);
    }
    make(AttachKind::Native, native_adapter, None)
}

const GO_BUILDINFO_MAGIC: &[u8] = b"\xff Go buildinf:";
/// Go binaries carry their build info near the start of the data segment.
const GO_SCAN_LIMIT: u64 = 96 << 20;

/// Whether `exe` is a Go binary (has a `Go buildinf:` header). System locations are skipped.
pub fn is_go_binary(exe: &str) -> bool {
    use std::io::Read;
    let skip = ["/System/", "/usr/", "/bin/", "/sbin/", "/Library/Apple/", "/Applications/"];
    if skip.iter().any(|p| exe.starts_with(p)) || is_windows_system(exe) || !Path::new(exe).is_absolute() {
        return false;
    }
    let Ok(file) = std::fs::File::open(exe) else { return false };
    let mut reader = std::io::BufReader::with_capacity(1 << 20, file.take(GO_SCAN_LIMIT));
    let finder = memchr::memmem::Finder::new(GO_BUILDINFO_MAGIC);
    let mut buf = vec![0u8; 1 << 20];
    let mut carry = Vec::new();
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) | Err(_) => return false,
            Ok(n) => n,
        };
        carry.extend_from_slice(&buf[..n]);
        if finder.find(&carry).is_some() {
            return true;
        }
        let keep = carry.len().min(GO_BUILDINFO_MAGIC.len() - 1);
        carry.drain(..carry.len() - keep);
    }
}

/// Windows' own and installed programs (`C:\Windows\…`, `C:\Program Files…`), like the
/// system locations skipped on Unix.
fn is_windows_system(exe: &str) -> bool {
    let lower = exe.to_ascii_lowercase();
    lower.get(1..).is_some_and(|rest| {
        rest.starts_with(":\\windows\\")
            || rest.starts_with(":\\program files\\")
            || rest.starts_with(":\\program files (x86)\\")
    })
}

/// The current user's processes (without this one).
#[cfg(unix)]
pub fn list_processes() -> IdeResult<Vec<RawProcess>> {
    use std::collections::HashMap;
    let ps = |fields: &str| -> IdeResult<String> {
        let out = ide_core::process::prepare(&mut std::process::Command::new("ps"))
            .args(["-x", "-ww", "-o", fields])
            .output()
            .map_err(|e| IdeError::unavailable(format!("cannot list processes: {e}")))?;
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    };
    let split = |line: &str| -> Option<(u32, String)> {
        let line = line.trim_start();
        let (pid, rest) = line.split_once(char::is_whitespace)?;
        Some((pid.parse().ok()?, rest.trim().to_owned()))
    };
    // `comm` is the executable path as started on macOS; on Linux it is truncated, so read /proc.
    let exes: HashMap<u32, String> =
        if cfg!(target_os = "linux") { HashMap::new() } else { ps("pid=,comm=")?.lines().filter_map(split).collect() };
    let me = std::process::id();
    Ok(ps("pid=,args=")?
        .lines()
        .filter_map(split)
        .filter(|(pid, _)| *pid != me)
        .map(|(pid, args)| {
            let exe = exe_path(pid)
                .or_else(|| exes.get(&pid).cloned())
                .or_else(|| std::fs::read_link(format!("/proc/{pid}/exe")).ok().map(|p| p.display().to_string()))
                .unwrap_or_else(|| args.split_whitespace().next().unwrap_or_default().to_owned());
            RawProcess { pid, exe, args }
        })
        .collect())
}

/// The processes this user may open (without this one): system and other users'
/// processes refuse `PROCESS_QUERY_LIMITED_INFORMATION` and are left out.
#[cfg(windows)]
pub fn list_processes() -> IdeResult<Vec<RawProcess>> {
    windows_processes::list()
}

#[cfg(windows)]
mod windows_processes {
    use super::RawProcess;
    use ide_core::{IdeError, IdeResult};
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Wdk::System::Threading::{NtQueryInformationProcess, ProcessCommandLineInformation};
    use windows_sys::Win32::Foundation::{INVALID_HANDLE_VALUE, UNICODE_STRING};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
    };

    pub fn list() -> IdeResult<Vec<RawProcess>> {
        let me = std::process::id();
        Ok(pids()?
            .into_iter()
            .filter(|&pid| pid != 0 && pid != me)
            .filter_map(|pid| {
                // SAFETY: plain call; a non-null result is a process handle owned here.
                let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
                if handle.is_null() {
                    return None;
                }
                // SAFETY: as above.
                let process = unsafe { OwnedHandle::from_raw_handle(handle) };
                let exe = image_path(&process)?;
                let args = command_line(&process).unwrap_or_else(|| exe.clone());
                Some(RawProcess { pid, exe, args })
            })
            .collect())
    }

    fn pids() -> IdeResult<Vec<u32>> {
        let mut out = Vec::new();
        // SAFETY: a snapshot handle owned here and an entry sized as the API requires.
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot.is_null() || snapshot == INVALID_HANDLE_VALUE {
                return Err(IdeError::unavailable(format!(
                    "cannot list processes: {}",
                    std::io::Error::last_os_error()
                )));
            }
            let snapshot = OwnedHandle::from_raw_handle(snapshot);
            let mut entry = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            let mut more = Process32FirstW(snapshot.as_raw_handle(), &mut entry);
            while more != 0 {
                out.push(entry.th32ProcessID);
                more = Process32NextW(snapshot.as_raw_handle(), &mut entry);
            }
        }
        Ok(out)
    }

    fn image_path(process: &OwnedHandle) -> Option<String> {
        let mut buf = vec![0u16; 32 * 1024];
        let mut len = buf.len() as u32;
        // SAFETY: a live process handle with query access; `len` is the buffer's capacity.
        let ok = unsafe {
            QueryFullProcessImageNameW(process.as_raw_handle(), PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len)
        };
        (ok != 0).then(|| String::from_utf16_lossy(&buf[..len as usize]))
    }

    /// The command line (Windows 8.1+), read with the same limited query access.
    fn command_line(process: &OwnedHandle) -> Option<String> {
        let mut size = 0u32;
        // SAFETY: a size query with no buffer; it fails and reports the size it needs.
        unsafe {
            NtQueryInformationProcess(
                process.as_raw_handle(),
                ProcessCommandLineInformation,
                std::ptr::null_mut(),
                0,
                &mut size,
            )
        };
        if (size as usize) < size_of::<UNICODE_STRING>() {
            return None;
        }
        // u64 elements keep the UNICODE_STRING header aligned.
        let mut buf = vec![0u64; (size as usize).div_ceil(8)];
        // SAFETY: a buffer of at least `size` bytes.
        let status = unsafe {
            NtQueryInformationProcess(
                process.as_raw_handle(),
                ProcessCommandLineInformation,
                buf.as_mut_ptr().cast(),
                size,
                &mut size,
            )
        };
        if status < 0 {
            return None;
        }
        // SAFETY: on success the buffer starts with a UNICODE_STRING whose text lies inside it.
        let text = unsafe {
            let s = &*buf.as_ptr().cast::<UNICODE_STRING>();
            if s.Buffer.is_null() {
                return None;
            }
            std::slice::from_raw_parts(s.Buffer, usize::from(s.Length) / 2)
        };
        Some(String::from_utf16_lossy(text))
    }
}

/// The full executable path: `comm` keeps a relative path a process was started with.
#[cfg(target_os = "macos")]
fn exe_path(pid: u32) -> Option<String> {
    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: the buffer holds `PROC_PIDPATHINFO_MAXSIZE` bytes, as the call requires.
    let n = unsafe { libc::proc_pidpath(i32::try_from(pid).ok()?, buf.as_mut_ptr().cast(), buf.len() as u32) };
    (n > 0).then(|| String::from_utf8_lossy(&buf[..n as usize]).into_owned())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn exe_path(_pid: u32) -> Option<String> {
    None
}

/// Node's default inspector port, which `SIGUSR1` opens.
pub const NODE_INSPECTOR_PORT: u16 = 9229;

/// Turns on the inspector of a running Node process (`SIGUSR1`, as js-debug's process
/// picker does) and waits until it listens. Returns the inspector port.
#[cfg(unix)]
pub async fn enable_node_inspector(pid: u32) -> IdeResult<u16> {
    let mut kill = tokio::process::Command::new("kill");
    ide_core::process::prepare(kill.as_std_mut());
    let status = kill
        .args(["-USR1", &pid.to_string()])
        .status()
        .await
        .map_err(|e| IdeError::unavailable(format!("cannot signal process {pid}: {e}")))?;
    if !status.success() {
        return Err(IdeError::unavailable(format!("cannot signal process {pid}")));
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        if tokio::net::TcpStream::connect(("127.0.0.1", NODE_INSPECTOR_PORT)).await.is_ok() {
            return Ok(NODE_INSPECTOR_PORT);
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    Err(IdeError::unavailable(format!(
        "process {pid} did not open its inspector on port {NODE_INSPECTOR_PORT} (is the port taken?)"
    )))
}

#[cfg(not(unix))]
pub async fn enable_node_inspector(pid: u32) -> IdeResult<u16> {
    Err(IdeError::unavailable(format!("start process {pid} with --inspect to attach to it")))
}

/// Attachable processes, sorted by kind then name. Blocking (runs `ps`, reads binaries).
pub fn attachable_processes() -> IdeResult<Vec<AttachableProcess>> {
    let cwd = std::env::temp_dir();
    let native = if adapter::resolve_binary("codelldb", &cwd).is_some() { "codelldb" } else { "lldb-dap" };
    let mut out: Vec<AttachableProcess> =
        list_processes()?.iter().filter_map(|p| classify(p, is_dotnet, is_go_binary, native)).collect();
    out.sort_by(|a, b| a.kind.cmp(&b.kind).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(exe: &str, args: &str) -> RawProcess {
        RawProcess { pid: 7, exe: exe.into(), args: args.into() }
    }

    fn kind(exe: &str, args: &str) -> Option<(AttachKind, Option<u16>)> {
        classify(&raw(exe, args), |e| e.ends_with("/Api"), |e| e.ends_with("/gosrv"), "codelldb")
            .map(|p| (p.kind, p.port))
    }

    #[test]
    fn parses_jdwp_agents() {
        let a = "java -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005 -jar app.jar";
        assert_eq!(jdwp_address(a), Some((None, 5005)));
        assert_eq!(
            jdwp_address("java -Xrunjdwp:transport=dt_socket,server=y,address=10.0.0.2:8000 X"),
            Some((Some("10.0.0.2".into()), 8000))
        );
        // A client-mode agent connects out; nothing to attach to.
        assert_eq!(jdwp_address("java -agentlib:jdwp=transport=dt_socket,server=n,address=5005 X"), None);
        assert_eq!(kind("/jdk/bin/java", a), Some((AttachKind::Java, Some(5005))));
        assert_eq!(kind("/jdk/bin/java", "java -jar app.jar"), None);
    }

    #[test]
    fn classifies_interpreters() {
        assert_eq!(kind("/usr/local/bin/node", "node --inspect server.js"), Some((AttachKind::Node, Some(9229))));
        assert_eq!(
            kind("/usr/local/bin/node", "node --inspect-brk=127.0.0.1:9333 a.js"),
            Some((AttachKind::Node, Some(9333)))
        );
        assert_eq!(kind("/usr/local/bin/node", "node a.js"), Some((AttachKind::Node, None)));
        assert_eq!(kind("/usr/bin/python3.12", "python3.12 app.py"), Some((AttachKind::Python, None)));
        assert_eq!(
            kind("/usr/bin/python3", "python3 -m debugpy --listen 5678 --wait-for-client app.py"),
            Some((AttachKind::Python, Some(5678)))
        );
        assert_eq!(
            kind("/Library/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python", "x"),
            Some((AttachKind::Python, None))
        );
        assert_eq!(kind("/home/me/Api", "./Api"), Some((AttachKind::Dotnet, None)));
        assert_eq!(kind("/home/me/gosrv", "./gosrv"), Some((AttachKind::Go, None)));
        assert_eq!(kind("/home/me/a.out", "./a.out"), Some((AttachKind::Native, None)));
        assert!(!is_python("pythonista"));
    }

    #[test]
    fn detects_dotnet_hosts_and_apphosts() {
        let dir = std::env::temp_dir().join(format!("openidea-attach-dotnet-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let app = dir.join("Api");
        std::fs::write(&app, b"").unwrap();
        std::fs::write(dir.join("Api.runtimeconfig.json"), b"{}").unwrap();
        let tool = dir.join("tool");
        std::fs::write(&tool, b"").unwrap();
        assert!(is_dotnet(app.to_str().unwrap()));
        assert!(!is_dotnet(tool.to_str().unwrap()));
        assert!(is_dotnet("/usr/local/share/dotnet/dotnet"));
        assert!(is_dotnet("dotnet"));
        assert!(!is_dotnet("Api"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn skips_windows_system_programs() {
        assert!(is_windows_system(r"C:\Windows\System32\svchost.exe"));
        assert!(is_windows_system(r"c:\program files (x86)\App\app.exe"));
        assert!(!is_windows_system(r"D:\src\srv\srv.exe"));
        assert!(!is_windows_system("/usr/bin/true"));
    }

    #[test]
    fn detects_go_binaries_by_buildinfo() {
        let dir = std::env::temp_dir().join(format!("openidea-attach-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let go = dir.join("gobin");
        let mut bytes = vec![0u8; (1 << 20) - 5];
        bytes.extend_from_slice(GO_BUILDINFO_MAGIC);
        std::fs::write(&go, &bytes).unwrap();
        let other = dir.join("cbin");
        std::fs::write(&other, vec![0u8; 4096]).unwrap();
        assert!(is_go_binary(go.to_str().unwrap()));
        assert!(!is_go_binary(other.to_str().unwrap()));
        assert!(!is_go_binary("/usr/bin/true"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn lists_own_processes() {
        let mut child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let list = list_processes().unwrap();
        let _ = child.kill();
        let _ = child.wait();
        let found = list.iter().find(|p| p.pid == child.id()).expect("sleep is listed");
        assert!(found.args.contains("sleep 30"));
        assert!(found.exe.ends_with("sleep"));
        assert!(list.iter().all(|p| p.pid != std::process::id()));
    }
}
