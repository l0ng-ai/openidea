//! Integrated terminal sessions over a native PTY. Rendering is xterm.js.

mod integration;
mod utf8;

pub use utf8::Utf8Decoder;

use ide_core::{IdeError, IdeEvent, IdeResult, SharedSink, TerminalId};
use parking_lot::Mutex;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

/// Output is flushed to the UI at most this long after the first unsent byte.
const BATCH_INTERVAL: Duration = Duration::from_millis(4);
/// …or as soon as this much text is pending.
const BATCH_BYTES: usize = 64 * 1024;
/// After the shell exits, how long to keep draining output still in flight.
const EXIT_DRAIN: Duration = Duration::from_millis(250);
/// Grace period between SIGHUP and SIGKILL on [`TerminalManager::kill`].
#[cfg(unix)]
const KILL_GRACE: Duration = Duration::from_millis(1500);

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOptions {
    pub cwd: ide_core::IpcPath,
    /// Defaults to the user's login shell (passwd entry, then `$SHELL`; PowerShell or `COMSPEC` on Windows).
    pub shell: Option<String>,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cols: u16,
    pub rows: u16,
    /// Make zsh / bash / fish report their working directory (OSC 7) at every prompt.
    #[serde(default)]
    #[specta(optional)]
    pub shell_integration: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: TerminalId,
    pub title: String,
    pub pid: Option<u32>,
}

struct Session {
    info: TerminalInfo,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    exited: Arc<AtomicBool>,
}

type Sessions = Arc<Mutex<HashMap<TerminalId, Arc<Session>>>>;

#[derive(Default)]
pub struct TerminalManager {
    sessions: Sessions,
}

enum Msg {
    Data(Vec<u8>),
    Exited(Option<i32>),
}

impl TerminalManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Starts a shell; output goes to `on_output` from a reader thread, batched
    /// (~4ms) to limit IPC chatter and always split on UTF-8 boundaries.
    /// Emits `IdeEvent::TerminalExited` to `sink` (the starter's) only.
    pub fn spawn(
        &self,
        options: TerminalOptions,
        sink: SharedSink,
        on_output: Box<dyn Fn(String) + Send>,
    ) -> IdeResult<TerminalInfo> {
        let size = pty_size(options.cols, options.rows);
        let pair = native_pty_system().openpty(size).map_err(|e| IdeError::internal(format!("openpty failed: {e}")))?;

        let (shell, mut args) = resolve_shell(options.shell.as_deref(), &options.args);
        let mut env = terminal_env(&options.env);
        if options.shell_integration {
            integration::apply(&shell_title(&shell), &mut args, &mut env);
        }
        let mut cmd = CommandBuilder::new(&shell);
        cmd.args(&args);
        cmd.cwd(resolve_cwd(&options.cwd));
        for (k, v) in ide_core::process::host_env_fixes() {
            match v {
                Some(v) => cmd.env(k, v),
                None => cmd.env_remove(k),
            }
        }
        for (k, v) in env {
            cmd.env(k, v);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| IdeError::unavailable(format!("failed to start shell `{shell}`: {e}")))?;
        // The child holds its own copy of the slave; dropping ours lets reads hit EOF on exit.
        drop(pair.slave);

        let reader = pair.master.try_clone_reader().map_err(|e| IdeError::internal(format!("pty reader: {e}")))?;
        let writer = pair.master.take_writer().map_err(|e| IdeError::internal(format!("pty writer: {e}")))?;

        let id = TerminalId::next();
        let info = TerminalInfo { id, title: shell_title(&shell), pid: child.process_id() };
        let exited = Arc::new(AtomicBool::new(false));
        let session = Arc::new(Session {
            info: info.clone(),
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(child.clone_killer()),
            exited: exited.clone(),
        });
        self.sessions.lock().insert(id, session);

        let (tx, rx) = mpsc::channel::<Msg>();
        let spawned = spawn_reader(id, reader, tx.clone())
            .and_then(|_| spawn_waiter(id, child, tx))
            .and_then(|_| spawn_pump(id, rx, on_output, exited, self.sessions.clone(), sink));
        if let Err(e) = spawned {
            if let Some(s) = self.sessions.lock().remove(&id) {
                let _ = s.killer.lock().kill();
            }
            return Err(IdeError::internal(format!("failed to start terminal threads: {e}")));
        }
        tracing::debug!(%id, shell, pid = ?info.pid, "terminal spawned");
        Ok(info)
    }

    pub fn write(&self, id: TerminalId, data: &str) -> IdeResult<()> {
        let session = self.session(id)?;
        let mut w = session.writer.lock();
        w.write_all(data.as_bytes())?;
        w.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: TerminalId, cols: u16, rows: u16) -> IdeResult<()> {
        let session = self.session(id)?;
        session
            .master
            .lock()
            .resize(pty_size(cols, rows))
            .map_err(|e| IdeError::internal(format!("resize failed: {e}")))
    }

    pub fn kill(&self, id: TerminalId) -> IdeResult<()> {
        let session = self.sessions.lock().remove(&id).ok_or_else(|| not_found(id))?;
        terminate(&session);
        Ok(())
    }

    /// Whether the shell is running a command, so closing its tab should ask first
    /// (as IDEA does). On Unix: the PTY's foreground process
    /// group isn't the shell's, i.e. a job is in the foreground (background helpers
    /// such as prompt daemons don't count). On Windows: the shell has child processes.
    pub fn is_busy(&self, id: TerminalId) -> IdeResult<bool> {
        let session = self.session(id)?;
        if session.exited.load(Ordering::Acquire) {
            return Ok(false);
        }
        let Some(pid) = session.info.pid else { return Ok(false) };
        Ok(foreground_busy(&session, pid))
    }

    pub fn list(&self) -> Vec<TerminalInfo> {
        let mut out: Vec<TerminalInfo> = self.sessions.lock().values().map(|s| s.info.clone()).collect();
        out.sort_by_key(|i| i.id);
        out
    }

    /// Current PTY size of a session (for diagnostics and tests).
    pub fn size(&self, id: TerminalId) -> IdeResult<(u16, u16)> {
        let session = self.session(id)?;
        let size = session.master.lock().get_size().map_err(|e| IdeError::internal(e.to_string()))?;
        Ok((size.cols, size.rows))
    }

    fn session(&self, id: TerminalId) -> IdeResult<Arc<Session>> {
        self.sessions.lock().get(&id).cloned().ok_or_else(|| not_found(id))
    }

    /// Terminates every session (shutting down).
    pub fn kill_all(&self) {
        let sessions: Vec<_> = self.sessions.lock().drain().map(|(_, s)| s).collect();
        for s in sessions {
            terminate(&s);
        }
    }
}

impl Drop for TerminalManager {
    fn drop(&mut self) {
        self.kill_all();
    }
}

fn not_found(id: TerminalId) -> IdeError {
    IdeError::not_found(format!("no such terminal: {id}"))
}

#[cfg(unix)]
fn foreground_busy(session: &Session, pid: u32) -> bool {
    let leader = session.master.lock().process_group_leader();
    leader.is_some_and(|fg| u32::try_from(fg).ok() != Some(pid))
}

#[cfg(windows)]
fn foreground_busy(_session: &Session, pid: u32) -> bool {
    win::has_child_processes(pid)
}

#[cfg(not(any(unix, windows)))]
fn foreground_busy(_session: &Session, _pid: u32) -> bool {
    false
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;

    const TH32CS_SNAPPROCESS: u32 = 0x2;
    const INVALID_HANDLE_VALUE: isize = -1;

    /// `PROCESSENTRY32W` from `<tlhelp32.h>`.
    #[repr(C)]
    struct ProcessEntry32W {
        dw_size: u32,
        cnt_usage: u32,
        th32_process_id: u32,
        th32_default_heap_id: usize,
        th32_module_id: u32,
        cnt_threads: u32,
        th32_parent_process_id: u32,
        pc_pri_class_base: i32,
        dw_flags: u32,
        sz_exe_file: [u16; 260],
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> *mut c_void;
        fn Process32FirstW(snapshot: *mut c_void, entry: *mut ProcessEntry32W) -> i32;
        fn Process32NextW(snapshot: *mut c_void, entry: *mut ProcessEntry32W) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    pub fn has_child_processes(pid: u32) -> bool {
        // SAFETY: plain Win32 calls on a locally owned snapshot handle and entry buffer.
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot.is_null() || snapshot as isize == INVALID_HANDLE_VALUE {
                return false;
            }
            let mut entry: ProcessEntry32W = std::mem::zeroed();
            entry.dw_size = std::mem::size_of::<ProcessEntry32W>() as u32;
            let mut found = false;
            let mut ok = Process32FirstW(snapshot, &mut entry);
            while ok != 0 {
                if entry.th32_parent_process_id == pid && entry.th32_process_id != pid {
                    found = true;
                    break;
                }
                ok = Process32NextW(snapshot, &mut entry);
            }
            CloseHandle(snapshot);
            found
        }
    }
}

/// Hangs up the shell (and its process group), escalating to SIGKILL if it lingers.
fn terminate(session: &Session) {
    if session.exited.load(Ordering::Acquire) {
        return;
    }
    if let Err(e) = session.killer.lock().kill() {
        tracing::debug!(id = %session.info.id, "terminal kill: {e}");
    }
    #[cfg(unix)]
    if let Some(pid) = session.info.pid.and_then(|p| i32::try_from(p).ok()).filter(|p| *p > 0) {
        // The shell is a session leader, so its pid is also its process group id.
        unsafe {
            libc::kill(-pid, libc::SIGHUP);
        }
        let exited = session.exited.clone();
        let _ = std::thread::Builder::new().name("openidea-term-reaper".into()).spawn(move || {
            let deadline = Instant::now() + KILL_GRACE;
            while Instant::now() < deadline {
                if exited.load(Ordering::Acquire) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            if !exited.load(Ordering::Acquire) {
                unsafe {
                    libc::kill(-pid, libc::SIGKILL);
                    libc::kill(pid, libc::SIGKILL);
                }
            }
        });
    }
}

fn spawn_reader(id: TerminalId, mut reader: Box<dyn Read + Send>, tx: mpsc::Sender<Msg>) -> std::io::Result<()> {
    std::thread::Builder::new().name(format!("openidea-term-read-{}", id.0)).spawn(move || {
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(Msg::Data(buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                // EIO is how Linux/macOS report "slave side closed".
                Err(_) => break,
            }
        }
    })?;
    Ok(())
}

fn spawn_waiter(
    id: TerminalId,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    tx: mpsc::Sender<Msg>,
) -> std::io::Result<()> {
    std::thread::Builder::new().name(format!("openidea-term-wait-{}", id.0)).spawn(move || {
        let code = match child.wait() {
            Ok(status) if status.signal().is_none() => Some(status.exit_code() as i32),
            Ok(_) => None,
            Err(e) => {
                tracing::warn!(%id, "waiting for shell failed: {e}");
                None
            }
        };
        let _ = tx.send(Msg::Exited(code));
    })?;
    Ok(())
}

fn spawn_pump(
    id: TerminalId,
    rx: mpsc::Receiver<Msg>,
    on_output: Box<dyn Fn(String) + Send>,
    exited: Arc<AtomicBool>,
    sessions: Sessions,
    sink: SharedSink,
) -> std::io::Result<()> {
    std::thread::Builder::new().name(format!("openidea-term-pump-{}", id.0)).spawn(move || {
        let mut decoder = Utf8Decoder::new();
        let mut pending = String::new();
        let mut batch_started: Option<Instant> = None;
        let mut exit: Option<Option<i32>> = None;
        let mut drain_deadline: Option<Instant> = None;

        let flush = |pending: &mut String, batch_started: &mut Option<Instant>| {
            if !pending.is_empty() {
                on_output(std::mem::take(pending));
            }
            *batch_started = None;
        };

        loop {
            let now = Instant::now();
            let batch_wait = batch_started.map(|t| (t + BATCH_INTERVAL).saturating_duration_since(now));
            let drain_wait = drain_deadline.map(|t| t.saturating_duration_since(now));
            let wait = match (batch_wait, drain_wait) {
                (Some(a), Some(b)) => a.min(b),
                (Some(a), None) | (None, Some(a)) => a,
                (None, None) => Duration::from_secs(3600),
            };
            match rx.recv_timeout(wait) {
                Ok(Msg::Data(bytes)) => {
                    decoder.decode_into(&bytes, &mut pending);
                    if !pending.is_empty() && batch_started.is_none() {
                        batch_started = Some(Instant::now());
                    }
                    if pending.len() >= BATCH_BYTES {
                        flush(&mut pending, &mut batch_started);
                    }
                }
                Ok(Msg::Exited(code)) => {
                    exit = Some(code);
                    drain_deadline = Some(Instant::now() + EXIT_DRAIN);
                }
                Err(RecvTimeoutError::Timeout) => {
                    if drain_deadline.is_some_and(|d| Instant::now() >= d) {
                        break;
                    }
                    if batch_started.is_some_and(|t| t.elapsed() >= BATCH_INTERVAL) {
                        flush(&mut pending, &mut batch_started);
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        pending.push_str(&decoder.finish());
        flush(&mut pending, &mut batch_started);
        exited.store(true, Ordering::Release);
        sessions.lock().remove(&id);
        let code = exit.flatten();
        tracing::debug!(%id, ?code, "terminal exited");
        sink.emit(IdeEvent::TerminalExited { terminal: id, code });
    })?;
    Ok(())
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols: if cols == 0 { 80 } else { cols },
        rows: if rows == 0 { 24 } else { rows },
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn resolve_cwd(cwd: &Path) -> PathBuf {
    if cwd.is_dir() {
        return cwd.to_path_buf();
    }
    home_dir().filter(|h| h.is_dir()).unwrap_or_else(|| PathBuf::from("/"))
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let var = "USERPROFILE";
    #[cfg(not(windows))]
    let var = "HOME";
    std::env::var_os(var).filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// The shell a terminal starts with when no shell path is configured.
pub fn default_shell_path() -> String {
    default_shell()
}

/// Installed shells for "New Predefined Session", the login shell first. On
/// Unix: `/etc/shells` plus `$PATH`, so Homebrew shells show up too.
pub fn available_shells() -> Vec<String> {
    let mut found: Vec<PathBuf> = Vec::new();
    let mut add = |p: PathBuf| {
        let key = p.canonicalize().unwrap_or_else(|_| p.clone());
        if p.is_file() && !found.iter().any(|f| f.canonicalize().unwrap_or_else(|_| f.clone()) == key) {
            found.push(p);
        }
    };
    add(PathBuf::from(default_shell()));
    #[cfg(unix)]
    {
        const NAMES: [&str; 5] = ["zsh", "bash", "fish", "nu", "pwsh"];
        let listed = std::fs::read_to_string("/etc/shells").unwrap_or_default();
        for name in NAMES {
            for line in listed.lines().map(str::trim).filter(|l| l.starts_with('/')) {
                if shell_title(line) == name {
                    add(PathBuf::from(line));
                }
            }
            if let Some(p) = find_in_path(name) {
                add(p);
            }
        }
    }
    #[cfg(windows)]
    {
        for exe in ["pwsh.exe", "powershell.exe", "cmd.exe", "wsl.exe"] {
            if let Some(p) = find_in_path(exe) {
                add(p);
            }
        }
        for var in ["ProgramFiles", "ProgramW6432"] {
            if let Some(dir) = std::env::var_os(var) {
                add(PathBuf::from(dir).join("Git").join("bin").join("bash.exe"));
            }
        }
    }
    found.into_iter().map(|p| p.to_string_lossy().into_owned()).collect()
}

/// Picks the shell binary and its arguments. A default (or explicitly chosen but
/// argument-less) POSIX shell is started as a login shell, like Terminal.app/IDEA.
fn resolve_shell(shell: Option<&str>, args: &[String]) -> (String, Vec<String>) {
    let shell = shell.map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned).unwrap_or_else(default_shell);
    if !args.is_empty() {
        return (shell, args.to_vec());
    }
    let login =
        matches!(shell_title(&shell).as_str(), "zsh" | "bash" | "sh" | "fish" | "ksh" | "dash" | "tcsh" | "csh");
    let args = if login && cfg!(unix) { vec!["-l".to_owned()] } else { Vec::new() };
    (shell, args)
}

/// The account's login shell comes first: `$SHELL` is inherited from whatever
/// launched the app (a terminal running another shell, `tauri dev`), so it may
/// not be the shell the user picked.
#[cfg(unix)]
fn default_shell() -> String {
    let usable = |s: &String| !s.is_empty() && Path::new(s).exists();
    if let Some(shell) = login_shell().filter(usable).or_else(|| std::env::var("SHELL").ok().filter(usable)) {
        return shell;
    }
    ["/bin/zsh", "/bin/bash", "/bin/sh"].into_iter().find(|p| Path::new(p).exists()).unwrap_or("/bin/sh").to_owned()
}

/// `pw_shell` of the current user's passwd entry.
#[cfg(unix)]
fn login_shell() -> Option<String> {
    let mut buf = vec![0 as libc::c_char; 4096];
    let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    // SAFETY: every pointer refers to a live local buffer of the stated size.
    let rc = unsafe { libc::getpwuid_r(libc::getuid(), &mut pwd, buf.as_mut_ptr(), buf.len(), &mut result) };
    if rc != 0 || result.is_null() || pwd.pw_shell.is_null() {
        return None;
    }
    // SAFETY: on success `pw_shell` is a NUL-terminated string inside `buf`.
    let shell = unsafe { std::ffi::CStr::from_ptr(pwd.pw_shell) };
    Some(shell.to_string_lossy().into_owned())
}

#[cfg(windows)]
fn default_shell() -> String {
    for candidate in ["pwsh.exe", "powershell.exe"] {
        if let Some(path) = find_in_path(candidate) {
            return path.to_string_lossy().into_owned();
        }
    }
    std::env::var("COMSPEC").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "cmd.exe".to_owned())
}

fn find_in_path(exe: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|dir| dir.join(exe)).find(|p| p.is_file())
}

/// Shell basename without extension, e.g. `zsh`, `pwsh`.
fn shell_title(shell: &str) -> String {
    let name = shell.rsplit(['/', '\\']).next().unwrap_or(shell);
    let name = name.strip_suffix(".exe").or_else(|| name.strip_suffix(".EXE")).unwrap_or(name);
    if name.is_empty() { shell.to_owned() } else { name.to_owned() }
}

/// Variables layered over the inherited process environment.
fn terminal_env(user: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    env.insert("TERM".to_owned(), "xterm-256color".to_owned());
    env.insert("COLORTERM".to_owned(), "truecolor".to_owned());
    env.insert("TERM_PROGRAM".to_owned(), "OpenIDEA".to_owned());
    env.insert("TERM_PROGRAM_VERSION".to_owned(), env!("CARGO_PKG_VERSION").to_owned());
    let has_lang = user.contains_key("LANG") || std::env::var_os("LANG").is_some_and(|v| !v.is_empty());
    if !has_lang {
        env.insert("LANG".to_owned(), "en_US.UTF-8".to_owned());
    }
    env.extend(user.iter().map(|(k, v)| (k.clone(), v.clone())));
    env
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn login_shell_reads_the_passwd_entry() {
        let shell = login_shell().expect("passwd entry");
        assert!(shell.starts_with('/'), "{shell}");
    }

    #[cfg(unix)]
    #[test]
    fn available_shells_start_with_the_default_and_are_distinct() {
        let shells = available_shells();
        assert_eq!(shells.first(), Some(&default_shell_path()));
        let unique: std::collections::HashSet<_> = shells.iter().collect();
        assert_eq!(unique.len(), shells.len());
    }
    use std::sync::mpsc::Receiver;

    struct Harness {
        manager: TerminalManager,
        sink: SharedSink,
        events: Receiver<IdeEvent>,
    }

    fn channel_sink() -> (SharedSink, Receiver<IdeEvent>) {
        let (tx, events) = mpsc::channel();
        let tx = Mutex::new(tx);
        let sink: SharedSink = Arc::new(move |e: IdeEvent| {
            let _ = tx.lock().send(e);
        });
        (sink, events)
    }

    fn harness() -> Harness {
        let (sink, events) = channel_sink();
        Harness { manager: TerminalManager::new(), sink, events }
    }

    fn sh(script: &str) -> TerminalOptions {
        TerminalOptions {
            cwd: std::env::temp_dir().into(),
            shell: Some("/bin/sh".into()),
            args: vec!["-c".into(), script.into()],
            env: BTreeMap::new(),
            cols: 80,
            rows: 24,
            shell_integration: false,
        }
    }

    fn spawn_collect(h: &Harness, opts: TerminalOptions) -> (TerminalInfo, Receiver<String>) {
        let (tx, rx) = mpsc::channel();
        let info = h
            .manager
            .spawn(
                opts,
                h.sink.clone(),
                Box::new(move |s| {
                    let _ = tx.send(s);
                }),
            )
            .expect("spawn");
        (info, rx)
    }

    fn wait_exit(h: &Harness, id: TerminalId) -> Option<i32> {
        loop {
            match h.events.recv_timeout(Duration::from_secs(10)).expect("exit event") {
                IdeEvent::TerminalExited { terminal, code } if terminal == id => return code,
                _ => {}
            }
        }
    }

    fn read_until(rx: &Receiver<String>, needle: &str) -> String {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut all = String::new();
        while !all.contains(needle) {
            let left = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(left) {
                Ok(s) => all.push_str(&s),
                Err(_) => panic!("timed out waiting for {needle:?}; got {all:?}"),
            }
        }
        all
    }

    #[test]
    fn output_and_exit_code() {
        let h = harness();
        let (info, rx) = spawn_collect(&h, sh("printf 'hello \\344\\270\\255\\346\\226\\207\\n'; exit 3"));
        assert_eq!(info.title, "sh");
        assert!(info.pid.is_some());
        assert_eq!(wait_exit(&h, info.id), Some(3));
        let out: String = rx.try_iter().collect();
        assert!(out.contains("hello 中文"), "{out:?}");
        assert!(h.manager.list().iter().all(|t| t.id != info.id));
    }

    #[test]
    fn env_is_applied() {
        let h = harness();
        let mut opts = sh("printf '%s|%s|%s' \"$TERM\" \"$TERM_PROGRAM\" \"$OPENIDEA_X\"");
        opts.env.insert("OPENIDEA_X".into(), "42".into());
        let (info, rx) = spawn_collect(&h, opts);
        assert_eq!(wait_exit(&h, info.id), Some(0));
        let out: String = rx.try_iter().collect();
        assert!(out.contains("xterm-256color|OpenIDEA|42"), "{out:?}");
    }

    #[cfg(unix)]
    #[test]
    fn bash_integration_reports_cwd() {
        if !Path::new("/bin/bash").exists() {
            return;
        }
        let h = harness();
        let home = std::env::temp_dir();
        let mut opts = sh("");
        opts.shell = Some("/bin/bash".into());
        opts.args = Vec::new();
        opts.shell_integration = true;
        opts.env.insert("HOME".into(), home.to_string_lossy().into_owned());
        let (info, rx) = spawn_collect(&h, opts);
        h.manager.write(info.id, "cd / && exit\n").unwrap();
        let out = read_until(&rx, "\x1b]7;file://");
        let _ = wait_exit(&h, info.id);
        let rest: String = rx.try_iter().collect();
        assert!(format!("{out}{rest}").contains("\x1b]7;file://"), "{out:?}");
    }

    #[test]
    fn write_echo_round_trip() {
        let h = harness();
        let mut opts = sh("exec cat");
        opts.shell = Some("/bin/sh".into());
        let (info, rx) = spawn_collect(&h, opts);
        h.manager.write(info.id, "ping é\n").unwrap();
        read_until(&rx, "ping é");
        h.manager.write(info.id, "\u{4}").unwrap();
        assert_eq!(wait_exit(&h, info.id), Some(0));
    }

    #[test]
    fn resize_is_visible_to_child() {
        let h = harness();
        let (info, rx) = spawn_collect(&h, sh("read _; stty size"));
        h.manager.resize(info.id, 132, 40).unwrap();
        assert_eq!(h.manager.size(info.id).unwrap(), (132, 40));
        h.manager.write(info.id, "\n").unwrap();
        read_until(&rx, "40 132");
        assert_eq!(wait_exit(&h, info.id), Some(0));
    }

    #[test]
    fn kill_terminates_and_emits_exit() {
        let h = harness();
        let (info, _rx) = spawn_collect(&h, sh("sleep 30"));
        assert!(h.manager.list().iter().any(|t| t.id == info.id));
        h.manager.kill(info.id).unwrap();
        assert!(h.manager.list().iter().all(|t| t.id != info.id));
        let start = Instant::now();
        let _ = wait_exit(&h, info.id);
        assert!(start.elapsed() < Duration::from_secs(5));
        assert!(h.manager.write(info.id, "x").is_err());
        assert!(h.manager.kill(info.id).is_err());
    }

    #[test]
    fn busy_while_a_command_runs_in_the_foreground() {
        let h = harness();
        let mut opts = sh("");
        opts.args = vec!["-i".into()];
        opts.env.insert("PS1".into(), "$ ".into());
        opts.env.insert("ENV".into(), "/dev/null".into());
        let (info, _rx) = spawn_collect(&h, opts);
        let wait_for = |want: bool| {
            let deadline = Instant::now() + Duration::from_secs(10);
            while h.manager.is_busy(info.id).unwrap() != want {
                assert!(Instant::now() < deadline, "is_busy never became {want}");
                std::thread::sleep(Duration::from_millis(20));
            }
        };
        wait_for(false);
        h.manager.write(info.id, "sleep 30\n").unwrap();
        wait_for(true);
        h.manager.write(info.id, "\u{3}").unwrap();
        wait_for(false);
        h.manager.write(info.id, "exit\n").unwrap();
        let _ = wait_exit(&h, info.id);
        assert!(h.manager.is_busy(info.id).is_err());
    }

    #[test]
    fn large_output_is_batched_and_complete() {
        let h = harness();
        let (info, rx) = spawn_collect(
            &h,
            sh("i=0; while [ $i -lt 2000 ]; do printf '%05d-\\342\\224\\200\\n' $i; i=$((i+1)); done"),
        );
        assert_eq!(wait_exit(&h, info.id), Some(0));
        let chunks: Vec<String> = rx.try_iter().collect();
        let all: String = chunks.concat();
        assert!(!all.contains('\u{FFFD}'));
        assert!(all.contains("01999-─"), "tail missing");
        assert!(chunks.len() < 2000, "output was not batched: {} chunks", chunks.len());
    }

    #[test]
    fn exit_event_goes_to_the_spawners_sink_only() {
        let h = harness();
        let (other_sink, other_events) = channel_sink();
        let (mine, _rx) = spawn_collect(&h, sh("exit 1"));
        let theirs = h.manager.spawn(sh("exit 2"), other_sink, Box::new(|_| {})).expect("spawn");
        match h.events.recv_timeout(Duration::from_secs(10)).expect("exit event") {
            IdeEvent::TerminalExited { terminal, code } => assert_eq!((terminal, code), (mine.id, Some(1))),
            e => panic!("unexpected {e:?}"),
        }
        match other_events.recv_timeout(Duration::from_secs(10)).expect("exit event") {
            IdeEvent::TerminalExited { terminal, code } => assert_eq!((terminal, code), (theirs.id, Some(2))),
            e => panic!("unexpected {e:?}"),
        }
        std::thread::sleep(Duration::from_millis(100));
        assert!(h.events.try_recv().is_err() && other_events.try_recv().is_err(), "no cross delivery");
    }

    #[test]
    fn shell_resolution() {
        let (shell, args) = resolve_shell(Some("/bin/zsh"), &[]);
        assert_eq!((shell.as_str(), args), ("/bin/zsh", vec!["-l".to_owned()]));
        let (_, args) = resolve_shell(Some("/usr/bin/python3"), &[]);
        assert!(args.is_empty());
        let (_, args) = resolve_shell(None, &[]);
        assert_eq!(args, vec!["-l".to_owned()]);
        assert_eq!(shell_title("C:\\Program Files\\PowerShell\\7\\pwsh.exe"), "pwsh");
        let env = terminal_env(&BTreeMap::from([("TERM".into(), "dumb".into())]));
        assert_eq!(env["TERM"], "dumb");
        assert_eq!(env["COLORTERM"], "truecolor");
    }
}
