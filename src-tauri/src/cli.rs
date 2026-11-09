//! The `openidea` command: this executable in CLI mode (started by the bundle's
//! launcher script with [`CLI_FLAG`]), the socket the app answers it on, and
//! installing the command on `PATH`.

use ide_cli::args::{self, Command};
use ide_cli::{Request, Response, socket};
use ide_core::{IdeError, IdeResult, IpcPath};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::AppHandle;

/// First argument from `Contents/Resources/bin/openidea`.
const CLI_FLAG: &str = "--cli";
/// How long a starting app has to open its socket.
const START_TIMEOUT: Duration = Duration::from_secs(30);

/// Runs as the `openidea` command when started with [`CLI_FLAG`]; returns the exit code.
pub fn run(identifier: &str) -> Option<i32> {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some(CLI_FLAG) {
        return None;
    }
    let args: Vec<String> = args.collect();
    #[cfg(windows)]
    ide_cli::attach_console();
    Some(match client(identifier, &args) {
        Ok(()) => 0,
        Err(message) => {
            eprintln!("openidea: {message}");
            1
        }
    })
}

fn client(identifier: &str, args: &[String]) -> Result<(), String> {
    let cwd = std::env::current_dir().map_err(|e| format!("no working directory: {e}"))?;
    let command = args::parse(args, &cwd)?;
    let diff = matches!(command, Command::Diff(_));
    let targets = match command {
        Command::Help => {
            print!("{}", args::USAGE);
            return Ok(());
        }
        Command::Version => {
            println!("OpenIDEA {}", env!("CARGO_PKG_VERSION"));
            return Ok(());
        }
        Command::Open(targets) | Command::Diff(targets) => targets,
    };
    let socket = socket::socket_path(identifier).ok_or("no cache directory for the OpenIDEA socket")?;
    let request = Request { diff, ..Request::open(targets) };
    let response = match socket::send(&socket, &request) {
        Err(e) if matches!(e.kind(), ErrorKind::NotFound | ErrorKind::ConnectionRefused) => {
            start_app()?;
            send_when_started(&socket, &request)?
        }
        sent => sent.map_err(|e| format!("cannot reach OpenIDEA: {e}"))?,
    };
    match response {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
    }
}

/// Starts the app detached from this terminal: through Launch Services for a
/// bundle, else (a development build) this executable without [`CLI_FLAG`].
fn start_app() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let image = if cfg!(target_os = "linux") { std::env::var_os("APPIMAGE").map(PathBuf::from) } else { None };
    let exe = ide_cli::install::stable_executable(&exe, image.as_deref()).map_err(|e| e.to_string())?;
    let mut command = match app_bundle(&exe) {
        Some(bundle) => {
            let mut open = std::process::Command::new("/usr/bin/open");
            open.arg("-a").arg(bundle);
            open
        }
        None => std::process::Command::new(&exe),
    };
    command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    ide_core::process::host_env(&mut command);
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0000_0008 | 0x0000_0200);
    command.spawn().map(drop).map_err(|e| format!("cannot start OpenIDEA: {e}"))
}

fn send_when_started(socket: &Path, request: &Request) -> Result<Response, String> {
    let start = Instant::now();
    loop {
        match socket::send(socket, request) {
            Err(e) if matches!(e.kind(), ErrorKind::NotFound | ErrorKind::ConnectionRefused) => {
                if start.elapsed() > START_TIMEOUT {
                    return Err("OpenIDEA did not start in time".into());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            sent => return sent.map_err(|e| format!("cannot reach OpenIDEA: {e}")),
        }
    }
}

/// `….app` of the bundle executable `exe` (`….app/Contents/MacOS/openidea`).
fn app_bundle(exe: &Path) -> Option<PathBuf> {
    let bundle = exe.parent()?.parent()?.parent()?;
    (cfg!(target_os = "macos") && bundle.extension().is_some_and(|e| e == "app")).then(|| bundle.to_path_buf())
}

/// Answers the `openidea` command for this app: its targets open like paths from Finder.
pub fn serve(app: &AppHandle, identifier: &str) {
    let Some(socket) = socket::socket_path(identifier) else { return };
    let app = app.clone();
    let served = socket::serve(&socket, move |request| {
        let handle = app.clone();
        match app.run_on_main_thread(move || {
            if request.diff {
                let mut targets = request.targets.into_iter();
                if let (Some(left), Some(right)) = (targets.next(), targets.next()) {
                    crate::windows::open_diff_files(
                        &handle,
                        crate::windows::DiffFilesLaunch { left: left.path.into(), right: right.path.into() },
                    );
                }
            } else {
                crate::windows::open_targets(&handle, request.targets);
            }
        }) {
            Ok(()) => Response::Ok,
            Err(e) => Response::Error { message: format!("OpenIDEA cannot open windows: {e}") },
        }
    });
    if let Err(e) = served {
        tracing::warn!("cannot listen for the openidea command on {}: {e}", socket.display());
    }
}

fn install_error(e: std::io::Error) -> IdeError {
    if e.kind() == ErrorKind::Interrupted { IdeError::cancelled() } else { IdeError::internal(e.to_string()) }
}

/// Links the `openidea` command onto `PATH`; returns the link. Blocks while the
/// administrator password prompt is up.
pub fn install() -> IdeResult<crate::commands::window::CliInstallation> {
    let result = ide_cli::install::install_current().map_err(install_error)?;
    Ok(crate::commands::window::CliInstallation {
        path: result.path.into(),
        path_directory: result.path_directory.map(Into::into),
    })
}

/// Removes every installed `openidea` command link; returns them.
pub fn uninstall() -> IdeResult<Vec<IpcPath>> {
    let links = ide_cli::install::uninstall_current().map_err(install_error)?;
    Ok(links.into_iter().map(Into::into).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_of_the_app_executable() {
        let exe = Path::new("/Applications/OpenIDEA.app/Contents/MacOS/openidea");
        let expected = cfg!(target_os = "macos").then(|| PathBuf::from("/Applications/OpenIDEA.app"));
        assert_eq!(app_bundle(exe), expected);
        assert_eq!(app_bundle(Path::new("/repo/target/debug/openidea")), None);
    }
}
