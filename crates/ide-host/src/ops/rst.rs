//! The reStructuredText preview: docutils, in the project's Python interpreter, turns the
//! edited text into HTML, with everything that reads past the document turned off.

use crate::Host;
use crate::ops::blocking;
use ide_command::command;
use ide_core::cli_process::{CliTool, Decoding, Input};
use ide_core::{IdeError, IdeResult};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

const RENDER: &str = include_str!("rst_render.py");
/// What the script prints when docutils can't be imported.
const NO_DOCUTILS: &str = "no-docutils";
const TIMEOUT: Duration = Duration::from_secs(15);

/// `text`, the reStructuredText file `path` as edited, as the HTML body of its preview, with
/// docutils' problems inline. Runs the project's Python interpreter, so needs a trusted project.
#[command(trust = trusted)]
pub async fn rst_preview(host: &Host, window: &str, path: PathBuf, text: String) -> IdeResult<String> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let config_dir = host.config_dir.clone();
    blocking(move || {
        let python = super::sdk::effective_python(&config_dir, &project, path.parent()).ok_or_else(|| {
            IdeError::unavailable("Choose a Python interpreter for the project to preview reStructuredText.")
        })?;
        render(&python, &path, &text)
    })
    .await
}

fn render(python: &Path, path: &Path, text: &str) -> IdeResult<String> {
    let mut cmd = Command::new(python);
    // Only names the file in docutils' messages: nothing is read relative to it.
    cmd.arg("-c").arg(RENDER).arg(path.file_name().unwrap_or(path.as_os_str()));
    // `-c` puts the working directory first on `sys.path`: an empty one shadows nothing.
    let dir = tempfile::Builder::new().prefix("openidea-rst-").tempdir().ok();
    if let Some(dir) = &dir {
        cmd.current_dir(dir.path());
    }
    let out =
        CliTool::new("Python", Decoding::Utf8Lossy).run_with_input(cmd, Some(Input::Threaded(text)), TIMEOUT, None)?;
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
        let html = render(&python, &dir.path().join("doc.rst"), &text).unwrap();
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
        let script = format!("#!/bin/sh\nPYTHONPATH='{}' exec '{}' \"$@\"\n", blocker.display(), python.display());
        std::fs::write(&fake, script).unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let error = render(&fake, Path::new("doc.rst"), "x").unwrap_err();
        assert!(error.to_string().contains("docutils is not installed"), "{error}");
    }
}
