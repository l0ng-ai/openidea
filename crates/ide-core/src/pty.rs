//! The PTY backend shared by terminals, Run consoles and debugger launchers.

pub fn native_pty_system() -> Box<dyn portable_pty::PtySystem + Send> {
    #[cfg(windows)]
    windows::initialize();
    portable_pty::native_pty_system()
}

#[cfg(windows)]
mod windows {
    use std::fs;
    use std::io::{self, Write};
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::sync::OnceLock;
    use std::sync::atomic::{AtomicU64, Ordering};
    use windows_sys::Win32::Foundation::FreeLibrary;
    use windows_sys::Win32::System::LibraryLoader::{
        GetProcAddress, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, LOAD_LIBRARY_SEARCH_SYSTEM32, LoadLibraryExW,
    };

    const VERSION: &str = "1.25.260930003";
    #[cfg(target_arch = "x86_64")]
    const RUNTIME: (&str, &[u8], &[u8]) = (
        "x64",
        include_bytes!("../resources/conpty/x64/conpty.dll"),
        include_bytes!("../resources/conpty/x64/OpenConsole.exe"),
    );
    #[cfg(target_arch = "aarch64")]
    const RUNTIME: (&str, &[u8], &[u8]) = (
        "arm64",
        include_bytes!("../resources/conpty/arm64/conpty.dll"),
        include_bytes!("../resources/conpty/arm64/OpenConsole.exe"),
    );
    #[cfg(target_arch = "x86")]
    const RUNTIME: (&str, &[u8], &[u8]) = (
        "x86",
        include_bytes!("../resources/conpty/x86/conpty.dll"),
        include_bytes!("../resources/conpty/x86/OpenConsole.exe"),
    );

    pub(super) fn initialize() -> bool {
        static BUNDLED: OnceLock<bool> = OnceLock::new();
        *BUNDLED.get_or_init(|| {
            if !crate::platform::windows_build_number().is_some_and(|build| build >= 19041) {
                return false;
            }
            match load() {
                Ok(()) => true,
                Err(error) => {
                    tracing::warn!(%error, "bundled ConPTY unavailable; using the system terminal backend");
                    false
                }
            }
        })
    }

    fn load() -> io::Result<()> {
        let cache = dirs::cache_dir().ok_or_else(|| io::Error::other("no user cache directory"))?;
        let directory = cache.join("OpenIDEA").join("conpty").join(VERSION).join(RUNTIME.0);
        fs::create_dir_all(&directory)?;
        install(&directory.join("LICENSE.txt"), include_bytes!("../resources/conpty/LICENSE"))?;
        install(&directory.join("OpenConsole.exe"), RUNTIME.2)?;
        let library = directory.join("conpty.dll");
        install(&library, RUNTIME.1)?;
        let wide: Vec<u16> = library.as_os_str().encode_wide().chain(Some(0)).collect();
        // portable-pty 0.9 opens conpty.dll by name. Preload our verified absolute path:
        // Windows reuses this module, without adding the project directory to DLL search.
        // SAFETY: the path is terminated and the module is retained for the process lifetime.
        let module = unsafe {
            LoadLibraryExW(
                wide.as_ptr(),
                std::ptr::null_mut(),
                LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
            )
        };
        if module.is_null() {
            return Err(io::Error::last_os_error());
        }
        for name in [c"CreatePseudoConsole", c"ResizePseudoConsole", c"ClosePseudoConsole"] {
            // SAFETY: `module` is loaded and each name is a terminated export name.
            if unsafe { GetProcAddress(module, name.as_ptr().cast()) }.is_none() {
                // SAFETY: no PTY uses this rejected module yet; release our load reference.
                unsafe { FreeLibrary(module) };
                return Err(io::Error::other("bundled ConPTY lacks the portable-pty exports"));
            }
        }
        // Keep this reference for the process lifetime, including between PTY sessions.
        tracing::info!(path = %library.display(), version = VERSION, "loaded bundled ConPTY");
        Ok(())
    }

    fn install(path: &Path, data: &[u8]) -> io::Result<()> {
        if fs::read(path).is_ok_and(|existing| existing == data) {
            return Ok(());
        }
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let pending =
            path.with_extension(format!("{}-{}.tmp", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        let result = (|| {
            let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&pending)?;
            file.write_all(data)?;
            file.sync_all()?;
            drop(file);
            match fs::rename(&pending, path) {
                Ok(()) => Ok(()),
                Err(_) if fs::read(path).is_ok_and(|existing| existing == data) => Ok(()),
                Err(error) => Err(error),
            }
        })();
        let _ = fs::remove_file(pending);
        result
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn installs_atomically_and_repairs_incomplete_files() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("conpty.dll");
            fs::write(&path, b"partial").unwrap();
            std::thread::scope(|scope| {
                for _ in 0..8 {
                    let path = &path;
                    scope.spawn(move || install(path, b"complete runtime").unwrap());
                }
            });
            assert_eq!(fs::read(&path).unwrap(), b"complete runtime");
            assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
        }

        #[test]
        fn loads_the_bundled_backend() {
            assert!(initialize());
        }

        #[test]
        fn conpty_output_child() {
            if std::env::var_os("OPENIDEA_CONPTY_TEST_CHILD").is_none() {
                return;
            }
            use windows_sys::Win32::System::Console::{
                ENABLE_VIRTUAL_TERMINAL_PROCESSING, GetConsoleMode, GetStdHandle, STD_OUTPUT_HANDLE, SetConsoleMode,
            };
            // SAFETY: the inherited console output handle and a local writable mode word.
            unsafe {
                let output = GetStdHandle(STD_OUTPUT_HANDLE);
                let mut mode = 0;
                assert_ne!(GetConsoleMode(output, &mut mode), 0);
                assert_ne!(SetConsoleMode(output, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING), 0);
            }
            std::io::stdout()
                .write_all(b"\x1b[?1049h\x1b[2J\x1b[HWorking (3m 19s)\x1b[1;1H\x1b[2KWorking (2m 59s)\x1b[?1049l\r\nVT_DONE\r\n")
                .unwrap();
            std::io::stdout().flush().unwrap();
        }

        #[test]
        fn conpty_preserves_alternate_screen_transitions() {
            use std::io::Read;
            use std::sync::mpsc;
            use std::time::{Duration, Instant};
            let pair = super::super::native_pty_system().openpty(portable_pty::PtySize::default()).unwrap();
            let mut reader = pair.master.try_clone_reader().unwrap();
            let mut writer = pair.master.take_writer().unwrap();
            let mut command = portable_pty::CommandBuilder::new(std::env::current_exe().unwrap());
            command.args(["--exact", "pty::windows::tests::conpty_output_child", "--nocapture"]);
            command.env("OPENIDEA_CONPTY_TEST_CHILD", "1");
            let mut child = pair.slave.spawn_command(command).unwrap();
            drop(pair.slave);
            let (tx, rx) = mpsc::channel();
            let reading = std::thread::spawn(move || {
                let mut bytes = [0; 4096];
                while let Ok(count) = reader.read(&mut bytes) {
                    if count == 0 || tx.send(bytes[..count].to_vec()).is_err() {
                        break;
                    }
                }
            });
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut output = Vec::new();
            let mut cursor_replied = false;
            while Instant::now() < deadline {
                if let Ok(bytes) = rx.recv_timeout(Duration::from_millis(50)) {
                    output.extend_from_slice(&bytes);
                    if !cursor_replied && output.windows(4).any(|s| s == b"\x1b[6n") {
                        writer.write_all(b"\x1b[1;1R").unwrap();
                        cursor_replied = true;
                    }
                    if output.windows(7).any(|s| s == b"VT_DONE") {
                        break;
                    }
                }
            }
            let _ = child.kill();
            let _ = child.wait();
            drop(writer);
            drop(pair.master);
            reading.join().unwrap();
            let output = String::from_utf8_lossy(&output);
            assert!(output.contains("\x1b[?1049h"), "alternate screen entry missing: {output:?}");
            assert!(output.contains("\x1b[?1049l"), "alternate screen exit missing: {output:?}");
        }
    }
}
