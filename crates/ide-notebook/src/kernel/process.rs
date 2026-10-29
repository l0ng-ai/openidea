use ide_core::{IdeError, IdeResult};
use jupyter_protocol::ConnectionInfo;
use parking_lot::Mutex;
use std::collections::VecDeque;
use std::io::Write;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::task::JoinHandle;
use uuid::Uuid;

const STDERR_BYTES: usize = 16 * 1024;

pub(super) struct Process {
    child: Child,
    #[cfg(unix)]
    pid: Option<u32>,
    stderr: Arc<Mutex<VecDeque<u8>>>,
    drains: Vec<JoinHandle<()>>,
    // Kept until the process and sockets have stopped; contains the HMAC secret.
    _directory: tempfile::TempDir,
    #[cfg(windows)]
    windows: windows::Resources,
}

impl Process {
    pub async fn spawn(runtime: &Path, notebook: &Path, python: &Path) -> IdeResult<(Self, ConnectionInfo)> {
        if !python.is_absolute() {
            return Err(IdeError::invalid("select an absolute Python executable path for this notebook"));
        }
        std::fs::create_dir_all(runtime)?;
        let directory = tempfile::Builder::new().prefix("kernel-").tempdir_in(runtime)?;
        make_private(directory.path())?;
        let ip = std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST);
        let (ports, listeners) = jupyter_zmq_client::peek_ports_with_listeners(ip, 5).await.map_err(protocol_error)?;
        let info = ConnectionInfo {
            transport: jupyter_protocol::connection_info::Transport::TCP,
            ip: ip.to_string(),
            stdin_port: ports[0],
            control_port: ports[1],
            hb_port: ports[2],
            shell_port: ports[3],
            iopub_port: ports[4],
            signature_scheme: "hmac-sha256".into(),
            key: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
            kernel_name: Some("openidea-python".into()),
        };
        let connection = directory.path().join("connection.json");
        write_private(&connection, &serde_json::to_vec(&info).map_err(protocol_error)?)?;
        #[cfg(windows)]
        let windows = windows::Resources::new()?;
        let mut argv = vec![python.as_os_str().to_os_string()];
        #[cfg(not(windows))]
        argv.extend(["-m".into(), "ipykernel_launcher".into(), "-f".into(), "{connection_file}".into()]);
        #[cfg(windows)]
        argv.extend(["-c".into(), windows::BOOTSTRAP.into(), "-f".into(), "{connection_file}".into()]);
        // App-owned spec, not registered in user/global Jupyter directories. The
        // argv array is also the launch source of truth, without shell quoting.
        let spec = serde_json::json!({
            "argv": argv.iter().map(|v| v.to_string_lossy().into_owned()).collect::<Vec<_>>(),
            "display_name": "OpenIDEA Python", "language": "python", "interrupt_mode": "signal"
        });
        write_private(&directory.path().join("kernel.json"), &serde_json::to_vec(&spec).map_err(protocol_error)?)?;
        let mut command = Command::new(python);
        for arg in &argv[1..] {
            if arg == "{connection_file}" {
                command.arg(&connection);
            } else {
                command.arg(arg);
            }
        }
        command
            .current_dir(notebook.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or_else(|| Path::new(".")))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .env_remove("JPY_INTERRUPT_EVENT")
            .env_remove("JPY_PARENT_PID")
            .env("PYTHONUNBUFFERED", "1");
        ide_core::process::prepare(command.as_std_mut());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.as_std_mut().process_group(0);
            command.env("JPY_PARENT_PID", std::process::id().to_string());
        }
        #[cfg(windows)]
        windows.configure(&mut command);
        let child = command.spawn().map_err(|e| {
            IdeError::unavailable(format!(
                "cannot start selected Python {}: {e}. Select an executable environment with ipykernel installed",
                python.display()
            ))
        })?;
        drop(listeners);
        #[cfg(unix)]
        let pid = child.id();
        let mut process = Self {
            child,
            #[cfg(unix)]
            pid,
            stderr: Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_BYTES))),
            drains: Vec::new(),
            _directory: directory,
            #[cfg(windows)]
            windows,
        };
        if let Some(mut stderr) = process.child.stderr.take() {
            let tail = process.stderr.clone();
            process.drains.push(tokio::spawn(async move {
                let mut buffer = [0_u8; 4096];
                while let Ok(count) = stderr.read(&mut buffer).await {
                    if count == 0 {
                        break;
                    }
                    let mut tail = tail.lock();
                    for byte in &buffer[..count] {
                        if tail.len() == STDERR_BYTES {
                            tail.pop_front();
                        }
                        tail.push_back(*byte);
                    }
                }
            }));
        }
        if let Some(mut stdout) = process.child.stdout.take() {
            process.drains.push(tokio::spawn(async move {
                let mut buffer = [0_u8; 4096];
                while let Ok(count) = stdout.read(&mut buffer).await {
                    if count == 0 {
                        break;
                    }
                }
            }));
        }
        #[cfg(windows)]
        process.windows.assign_and_release(&process.child)?;
        Ok((process, info))
    }

    pub fn stderr(&self) -> String {
        let bytes = self.stderr.lock().iter().copied().collect::<Vec<_>>();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    pub fn death(&mut self) -> IdeResult<Option<String>> {
        match self.child.try_wait()? {
            None => Ok(None),
            Some(status) => {
                self.kill_tree();
                Ok(Some(format!("kernel exited ({status}); {}", self.stderr())))
            }
        }
    }

    pub fn interrupt(&self) -> IdeResult<()> {
        #[cfg(unix)]
        {
            let pid = self.pid.ok_or_else(|| IdeError::unavailable("kernel is no longer running"))?;
            // SAFETY: this child was created in its own process group. Never
            // signal the host group or a discovered/external kernel.
            if unsafe { libc::kill(-(pid as i32), libc::SIGINT) } != 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            Ok(())
        }
        #[cfg(windows)]
        {
            self.windows.interrupt()
        }
        #[cfg(not(any(unix, windows)))]
        {
            Err(IdeError::unavailable("native kernel interruption is unsupported on this platform"))
        }
    }

    fn kill_tree(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.pid.take() {
            // SAFETY: group ID belongs exclusively to the owned kernel.
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
        #[cfg(windows)]
        self.windows.kill_tree();
    }

    pub async fn shutdown(&mut self) {
        self.kill_tree();
        let _ = self.child.start_kill();
        let _ = tokio::time::timeout(Duration::from_secs(3), self.child.wait()).await;
        for task in self.drains.drain(..) {
            task.abort();
        }
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        self.kill_tree();
        let _ = self.child.start_kill();
        for task in &self.drains {
            task.abort();
        }
        // tokio Child's kill_on_drop also kills/reaps if this future is aborted.
    }
}

fn protocol_error(error: impl std::fmt::Display) -> IdeError {
    IdeError::unavailable(format!("Jupyter kernel setup: {error}"))
}

fn write_private(path: &Path, bytes: &[u8]) -> IdeResult<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    Ok(())
}

fn make_private(path: &Path) -> IdeResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(windows)]
    windows::private_directory(path)?;
    Ok(())
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, HANDLE, LocalFree};
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1, SE_FILE_OBJECT, SetNamedSecurityInfoW,
    };
    use windows_sys::Win32::Security::{
        DACL_SECURITY_INFORMATION, GetSecurityDescriptorDacl, PROTECTED_DACL_SECURITY_INFORMATION, SECURITY_ATTRIBUTES,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation, SetInformationJobObject,
        TerminateJobObject,
    };
    use windows_sys::Win32::System::Threading::{CreateEventW, SetEvent};

    // Launcher glue only. All Jupyter traffic is authenticated native ZeroMQ.
    // Child opens its own handles: no assumption about Rust HANDLE inheritance.
    // The gate prevents any ipykernel imports/descendants before job assignment.
    pub const BOOTSTRAP: &str = r#"import ctypes, os, runpy, sys
k = ctypes.WinDLL('kernel32', use_last_error=True)
k.OpenEventW.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_wchar_p]
k.OpenEventW.restype = ctypes.c_void_p
k.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
k.WaitForSingleObject.restype = ctypes.c_uint32
k.CloseHandle.argtypes = [ctypes.c_void_p]
k.CloseHandle.restype = ctypes.c_int
interrupt = k.OpenEventW(0x00100002, 0, os.environ.pop('OPENIDEA_INTERRUPT_EVENT'))
gate = k.OpenEventW(0x00100000, 0, os.environ.pop('OPENIDEA_LAUNCH_EVENT'))
if not interrupt or not gate:
    raise ctypes.WinError(ctypes.get_last_error())
if k.WaitForSingleObject(gate, 30000) != 0:
    raise RuntimeError('OpenIDEA kernel launch gate failed')
k.CloseHandle(gate)
os.environ['JPY_INTERRUPT_EVENT'] = str(interrupt)
try:
    runpy.run_module('ipykernel_launcher', run_name='__main__')
finally:
    k.CloseHandle(interrupt)
"#;

    struct Handle(usize);
    impl Handle {
        fn new(raw: HANDLE) -> IdeResult<Self> {
            if raw.is_null() { Err(std::io::Error::last_os_error().into()) } else { Ok(Self(raw as usize)) }
        }
        fn raw(&self) -> HANDLE {
            self.0 as HANDLE
        }
        fn signal(&self) -> IdeResult<()> {
            // SAFETY: owned live event handle, retained for this process lifetime.
            if unsafe { SetEvent(self.raw()) } == 0 { Err(std::io::Error::last_os_error().into()) } else { Ok(()) }
        }
    }
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.raw());
            }
        }
    }

    struct Descriptor(*mut std::ffi::c_void);
    impl Descriptor {
        fn new() -> IdeResult<Self> {
            // Protected ACL: owner and SYSTEM only, inherited by runtime files.
            let sddl = "D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)\0".encode_utf16().collect::<Vec<_>>();
            let mut raw = std::ptr::null_mut();
            if unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    SDDL_REVISION_1,
                    &mut raw,
                    std::ptr::null_mut(),
                )
            } == 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
            Ok(Self(raw))
        }
    }
    impl Drop for Descriptor {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0);
            }
        }
    }

    pub fn private_directory(path: &Path) -> IdeResult<()> {
        let descriptor = Descriptor::new()?;
        let mut present = 0;
        let mut defaulted = 0;
        let mut dacl = std::ptr::null_mut();
        if unsafe { GetSecurityDescriptorDacl(descriptor.0, &mut present, &mut dacl, &mut defaulted) } == 0
            || present == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        let path = path.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();
        let error = unsafe {
            SetNamedSecurityInfoW(
                path.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                dacl,
                std::ptr::null_mut(),
            )
        };
        if error != 0 {
            return Err(std::io::Error::from_raw_os_error(error as i32).into());
        }
        Ok(())
    }

    pub struct Resources {
        interrupt: Handle,
        gate: Handle,
        job: Handle,
        interrupt_name: String,
        gate_name: String,
    }
    impl Resources {
        pub fn new() -> IdeResult<Self> {
            let interrupt_name = format!("Local\\OpenIDEA-interrupt-{}", Uuid::new_v4());
            let gate_name = format!("Local\\OpenIDEA-launch-{}", Uuid::new_v4());
            fn event(name: &str) -> IdeResult<Handle> {
                let name = name.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
                // Event-specific rights; owner and SYSTEM only. File inheritance
                // flags/FA are not used for kernel synchronization objects.
                let sddl = "D:P(A;;GA;;;OW)(A;;GA;;;SY)\0".encode_utf16().collect::<Vec<_>>();
                let mut raw = std::ptr::null_mut();
                if unsafe {
                    ConvertStringSecurityDescriptorToSecurityDescriptorW(
                        sddl.as_ptr(),
                        SDDL_REVISION_1,
                        &mut raw,
                        std::ptr::null_mut(),
                    )
                } == 0
                {
                    return Err(std::io::Error::last_os_error().into());
                }
                let descriptor = Descriptor(raw);
                let attrs = SECURITY_ATTRIBUTES {
                    nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                    lpSecurityDescriptor: descriptor.0,
                    bInheritHandle: 0,
                };
                let handle = Handle::new(unsafe { CreateEventW(&attrs, 0, 0, name.as_ptr()) })?;
                if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
                    return Err(IdeError::unavailable("kernel event name collision"));
                }
                Ok(handle)
            }
            let interrupt = event(&interrupt_name)?;
            let gate = event(&gate_name)?;
            let job = Handle::new(unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) })?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if unsafe {
                SetInformationJobObject(
                    job.raw(),
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of_val(&info) as u32,
                )
            } == 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
            Ok(Self { interrupt, gate, job, interrupt_name, gate_name })
        }
        pub fn configure(&self, command: &mut Command) {
            command.env("OPENIDEA_INTERRUPT_EVENT", &self.interrupt_name).env("OPENIDEA_LAUNCH_EVENT", &self.gate_name);
        }
        pub fn assign_and_release(&self, child: &Child) -> IdeResult<()> {
            let handle = child
                .raw_handle()
                .ok_or_else(|| IdeError::unavailable("kernel exited before Windows job assignment"))?;
            if unsafe { AssignProcessToJobObject(self.job.raw(), handle as HANDLE) } == 0 {
                return Err(IdeError::unavailable(format!(
                    "cannot contain kernel process in owned Windows job: {}",
                    std::io::Error::last_os_error()
                )));
            }
            self.gate.signal()
        }
        pub fn interrupt(&self) -> IdeResult<()> {
            self.interrupt.signal()
        }
        pub fn kill_tree(&self) {
            unsafe {
                TerminateJobObject(self.job.raw(), 1);
            }
        }
    }
}
