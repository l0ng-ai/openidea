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
    let targets = match args::parse(args, &cwd)? {
        Command::Help => {
            print!("{}", args::USAGE);
            return Ok(());
        }
        Command::Version => {
            println!("OpenIDEA {}", env!("CARGO_PKG_VERSION"));
            return Ok(());
        }
        Command::Open(targets) => targets,
    };
    let socket = socket::socket_path(identifier).ok_or("no cache directory for the OpenIDEA socket")?;
    let request = Request::open(targets);
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
    let mut command = match app_bundle(&exe) {
        Some(bundle) => {
            let mut open = std::process::Command::new("/usr/bin/open");
            open.arg("-a").arg(bundle);
            open
        }
        None => std::process::Command::new(&exe),
    };
    command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
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
    if !cfg!(unix) {
        return;
    }
    let Some(socket) = socket::socket_path(identifier) else { return };
    let app = app.clone();
    let served = socket::serve(&socket, move |request| {
        let handle = app.clone();
        match app.run_on_main_thread(move || crate::windows::open_targets(&handle, request.targets)) {
            Ok(()) => Response::Ok,
            Err(e) => Response::Error { message: format!("OpenIDEA cannot open windows: {e}") },
        }
    });
    if let Err(e) = served {
        tracing::warn!("cannot listen for the openidea command on {}: {e}", socket.display());
    }
}

/// The launcher script of this app's bundle; it must be in a stable location.
fn launcher() -> IdeResult<PathBuf> {
    let exe = std::env::current_exe().map_err(|e| IdeError::internal(e.to_string()))?;
    let launcher = ide_cli::install::bundled_launcher(&exe)
        .ok_or_else(|| IdeError::unavailable("only the packaged macOS app can install the openidea command"))?;
    if ide_cli::install::translocated(&launcher) {
        return Err(IdeError::unavailable("move OpenIDEA to the Applications folder first"));
    }
    Ok(launcher)
}

fn install_error(e: std::io::Error) -> IdeError {
    if e.kind() == ErrorKind::Interrupted { IdeError::cancelled() } else { IdeError::internal(e.to_string()) }
}

/// Links the `openidea` command onto `PATH`; returns the link. Blocks while the
/// administrator password prompt is up.
pub fn install() -> IdeResult<IpcPath> {
    let launcher = launcher()?;
    let dir = ide_cli::install::link_dir(std::env::var_os("PATH").as_deref(), dirs::home_dir().as_deref());
    let link = ide_cli::install::install(&launcher, &dir).map_err(install_error)?;
    tracing::info!("installed the openidea command at {}", link.display());
    Ok(link.into())
}

/// Removes every installed `openidea` command link; returns them.
pub fn uninstall() -> IdeResult<Vec<IpcPath>> {
    let links = ide_cli::install::installed(&ide_cli::install::link_dirs(dirs::home_dir().as_deref()));
    ide_cli::install::uninstall(&links).map_err(install_error)?;
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
