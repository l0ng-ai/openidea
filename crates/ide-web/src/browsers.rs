use ide_core::{IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;

/// An installed browser.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Browser {
    /// `chrome`, `firefox`, `safari`, `edge`, `brave`, `chromium`.
    pub id: String,
    pub name: String,
}

struct Known {
    id: &'static str,
    name: &'static str,
    /// macOS application bundle names.
    mac: &'static [&'static str],
    /// Windows executables relative to Program Files / Local AppData.
    windows: &'static [&'static str],
    /// Linux commands on `PATH`.
    linux: &'static [&'static str],
}

const KNOWN: &[Known] = &[
    Known {
        id: "chrome",
        name: "Chrome",
        mac: &["Google Chrome"],
        windows: &[r"Google\Chrome\Application\chrome.exe"],
        linux: &["google-chrome", "google-chrome-stable"],
    },
    Known {
        id: "firefox",
        name: "Firefox",
        mac: &["Firefox", "Firefox Developer Edition"],
        windows: &[r"Mozilla Firefox\firefox.exe"],
        linux: &["firefox"],
    },
    Known { id: "safari", name: "Safari", mac: &["Safari"], windows: &[], linux: &[] },
    Known {
        id: "edge",
        name: "Edge",
        mac: &["Microsoft Edge"],
        windows: &[r"Microsoft\Edge\Application\msedge.exe"],
        linux: &["microsoft-edge", "microsoft-edge-stable"],
    },
    Known {
        id: "brave",
        name: "Brave",
        mac: &["Brave Browser"],
        windows: &[r"BraveSoftware\Brave-Browser\Application\brave.exe"],
        linux: &["brave-browser", "brave"],
    },
    Known {
        id: "chromium",
        name: "Chromium",
        mac: &["Chromium"],
        windows: &[r"Chromium\Application\chrome.exe"],
        linux: &["chromium", "chromium-browser"],
    },
];

/// Where browser `k` is installed, if it is.
fn locate(k: &Known) -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        let mut dirs = vec![PathBuf::from("/Applications")];
        if let Some(home) = std::env::var_os("HOME") {
            dirs.push(PathBuf::from(home).join("Applications"));
        }
        // Safari moved into the cryptex; /Applications keeps a link to it.
        dirs.push(PathBuf::from("/System/Volumes/Preboot/Cryptexes/App/System/Applications"));
        k.mac.iter().flat_map(|app| dirs.iter().map(move |d| d.join(format!("{app}.app")))).find(|p| p.exists())
    } else if cfg!(windows) {
        let bases: Vec<PathBuf> = ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
            .iter()
            .filter_map(std::env::var_os)
            .map(PathBuf::from)
            .collect();
        k.windows.iter().flat_map(|exe| bases.iter().map(move |b| b.join(exe))).find(|p| p.is_file())
    } else {
        let path = std::env::var_os("PATH")?;
        let dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
        k.linux.iter().flat_map(|cmd| dirs.iter().map(move |d| d.join(cmd))).find(|p| p.is_file())
    }
}

/// The known browsers installed on this machine, in a fixed order.
pub fn installed() -> Vec<Browser> {
    KNOWN.iter().filter(|k| locate(k).is_some()).map(|k| Browser { id: k.id.into(), name: k.name.into() }).collect()
}

/// Opens `url` in browser `id`, or in the system default browser.
pub fn open(url: &str, id: Option<&str>) -> IdeResult<()> {
    if !(url.starts_with("http://") || url.starts_with("https://") || url.starts_with("file://")) {
        return Err(IdeError::invalid(format!("not a web URL: {url}")));
    }
    let app = match id {
        None => None,
        Some(id) => {
            let known =
                KNOWN.iter().find(|k| k.id == id).ok_or_else(|| IdeError::invalid(format!("unknown browser: {id}")))?;
            Some(locate(known).ok_or_else(|| IdeError::unavailable(format!("{} is not installed", known.name)))?)
        }
    };
    #[cfg(target_os = "linux")]
    let result = spawn_with_host_env(match &app {
        None => open::commands(url),
        Some(app) => vec![open::with_command(url, app.to_string_lossy())],
    });
    #[cfg(not(target_os = "linux"))]
    let result = match &app {
        None => open::that_detached(url),
        Some(app) => open::with_detached(url, app.to_string_lossy().as_ref()),
    };
    result.map_err(|e| IdeError::unavailable(format!("cannot open the browser: {e}")))
}

/// Starts the first launcher that runs (`xdg-open`, `gio`, ...), with the host's environment
/// rather than an AppImage's, and reaps it in the background.
#[cfg(target_os = "linux")]
fn spawn_with_host_env(commands: Vec<std::process::Command>) -> std::io::Result<()> {
    use std::process::Stdio;
    let mut last_err = None;
    for mut cmd in commands {
        ide_core::process::prepare(&mut cmd).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        match cmd.spawn() {
            Ok(mut child) => {
                std::thread::spawn(move || child.wait());
                return Ok(());
            }
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or_else(|| std::io::Error::other("no launcher available")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique() {
        let mut ids: Vec<_> = KNOWN.iter().map(|k| k.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), KNOWN.len());
    }

    #[test]
    fn refuses_non_web_urls() {
        assert!(open("/etc/passwd", None).is_err());
        assert!(open("javascript:alert(1)", None).is_err());
        assert!(open("http://127.0.0.1/", Some("netscape")).is_err());
    }
}
