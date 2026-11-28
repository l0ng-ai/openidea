//! The reStructuredText preview: docutils, in the project's Python interpreter, turns the
//! edited text into HTML, with everything that reads past the document turned off.

use crate::Host;
use crate::ops::blocking;
use ide_command::command;
use ide_core::cli_process::{CliTool, Decoding, Input};
use ide_core::{CancellationToken, IdeError, IdeResult, RequestId};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

const RENDER: &str = include_str!("rst_render.py");
/// What the script prints when docutils can't be imported.
const NO_DOCUTILS: &str = "no-docutils";
const TIMEOUT: Duration = Duration::from_secs(15);

/// `text`, the reStructuredText file `path` as edited, as the HTML body of its preview, with
/// docutils' problems inline. Runs the project's Python interpreter, so needs a trusted project.
/// Cancelling `request` (the text changed again) stops the interpreter.
#[command(trust = trusted)]
pub async fn rst_preview(
    host: &Host,
    window: &str,
    request: RequestId,
    path: PathBuf,
    text: String,
) -> IdeResult<String> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let config_dir = host.config_dir.clone();
    let cancel = host.begin_project_request(window, request);
    let result = blocking(move || {
        let python = super::sdk::effective_python(&config_dir, &project, path.parent()).ok_or_else(|| {
            IdeError::unavailable("Choose a Python interpreter for the project to preview reStructuredText.")
        })?;
        render(&python, &path, &text, Some(&cancel))
    })
    .await;
    host.end_request(request);
    result
}

fn render(python: &Path, path: &Path, text: &str, cancel: Option<&CancellationToken>) -> IdeResult<String> {
    // `-c` puts the working directory first on `sys.path`: an empty one shadows nothing.
    let dir = tempfile::Builder::new()
        .prefix("openidea-rst-")
        .tempdir()
        .map_err(|e| IdeError::internal(format!("cannot create a folder to run docutils in: {e}")))?;
    let mut cmd = Command::new(python);
    // `-E`: `PYTHONPATH` and the like don't apply. The file name only appears in docutils'
    // messages: nothing is read relative to it.
    cmd.arg("-E").arg("-c").arg(RENDER).arg(path.file_name().unwrap_or(path.as_os_str()));
    cmd.current_dir(dir.path());
    let out = CliTool::new("Python", Decoding::Utf8Lossy).run_with_input(
        cmd,
        Some(Input::Threaded(text)),
        TIMEOUT,
        cancel,
    )?;
    if out.success {
        return Ok(out.stdout);
    }
    if out.stdout == NO_DOCUTILS {
        return Err(IdeError::unavailable(format!(
            "docutils is not installed for {}. Install it to preview reStructuredText.",
            python.display()
        )));
    }
    let last = out.stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("docutils failed");
    Err(IdeError::internal(last.trim().to_owned()))
}

ide_command::domain!(rst: rst_preview);

#[cfg(test)]
mod tests {
    use super::*;

    fn python() -> Option<PathBuf> {
        ["python3", "python"].into_iter().map(PathBuf::from).find(|p| Command::new(p).arg("--version").output().is_ok())
    }

    fn has_docutils(python: &Path) -> bool {
        Command::new(python).args(["-c", "import docutils"]).status().is_ok_and(|s| s.success())
    }

    #[test]
    fn renders_without_reading_past_the_document() {
        let Some(python) = python().filter(|p| has_docutils(p)) else {
            eprintln!("skipped: no Python with docutils");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let secret = dir.path().join("secret.txt");
        std::fs::write(&secret, "TOP-SECRET").unwrap();
        let text = format!(
            "Title\n=====\n\n*hi* ünï\n\n.. include:: {0}\n\n.. raw:: html\n\n   <script>x()</script>\n\n\
             .. csv-table::\n   :file: {0}\n\n.. image:: pic.png\n   :scale: 50\n",
            secret.display()
        );
        let html = render(&python, &dir.path().join("doc.rst"), &text, None).unwrap();
        assert!(html.contains("<em>hi</em> ünï"), "{html}");
        assert!(!html.contains("TOP-SECRET"), "{html}");
        assert!(!html.contains("<script>"), "{html}");
        assert!(html.contains("&quot;include&quot; directive disabled"), "{html}");
        assert!(html.contains("&quot;raw&quot; directive disabled"), "{html}");
        assert!(html.contains(r#"src="pic.png""#), "{html}");
    }

    #[cfg(unix)]
    #[test]
    fn says_when_docutils_is_missing() {
        use std::os::unix::fs::PermissionsExt;
        let Some(python) = python() else {
            eprintln!("skipped: no Python");
            return;
        };
        // A stand-in interpreter whose `import docutils` fails, wherever docutils is installed.
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("python");
        let blocker = dir.path().join("block");
        std::fs::create_dir(&blocker).unwrap();
        std::fs::write(blocker.join("docutils.py"), "raise ImportError('blocked')\n").unwrap();
        // Drops `-E`, which would ignore the `PYTHONPATH` that blocks docutils.
        let script = format!(
            "#!/bin/sh\n[ \"$1\" = -E ] && shift\nPYTHONPATH='{}' exec '{}' \"$@\"\n",
            blocker.display(),
            python.display()
        );
        std::fs::write(&fake, script).unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let error = render(&fake, Path::new("doc.rst"), "x", None).unwrap_err();
        assert!(error.to_string().contains("docutils is not installed"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn cancelling_stops_the_interpreter() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let slow = dir.path().join("python");
        std::fs::write(&slow, "#!/bin/sh\nsleep 30\n").unwrap();
        std::fs::set_permissions(&slow, std::fs::Permissions::from_mode(0o755)).unwrap();
        let cancel = CancellationToken::new();
        let later = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            later.cancel();
        });
        let started = std::time::Instant::now();
        let error = render(&slow, Path::new("doc.rst"), "x", Some(&cancel)).unwrap_err();
        assert_eq!(error.kind, ide_core::error::ErrorKind::Cancelled);
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
