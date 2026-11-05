// Ported from JetBrains intellij-community plugins/mcp-server (src/com/intellij/mcpserver/util/text.util.kt,
// mcpserver.toolsets/src/util/OutputCollector.kt), Apache-2.0.
//! Output of commands and runs: truncation, the run output collector and the private
//! directory of full output files.

use ide_core::{IdeError, IdeResult};
use std::io::Write as _;
use std::path::{Path, PathBuf};

/// Marker of text cut by [`truncate_text`].
pub const TRUNCATED_MARKER: &str = "<<<...content truncated...>>>";
/// Longest text [`truncate_text`] returns (before its marker).
pub const MAX_TEXT_LENGTH: usize = 64 * 1024;
/// Characters of a run's output returned inline.
pub const RUN_PREVIEW_MAX_LENGTH: usize = 10_000;
pub const RUN_PREVIEW_TRUNCATED_MARKER: &str = "<truncated>";

/// Which lines [`truncate_text`] keeps (the JetBrains names: START keeps the first lines).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TruncateMode {
    /// The first lines, then the marker.
    Start,
    /// The first and the last lines around the marker.
    Middle,
    /// The marker, then the last lines.
    End,
    None,
}

impl TruncateMode {
    pub fn parse(s: Option<&str>) -> IdeResult<Self> {
        match s.map(|s| s.trim().to_ascii_uppercase()).as_deref() {
            None | Some("") | Some("START") => Ok(Self::Start),
            Some("MIDDLE") => Ok(Self::Middle),
            Some("END") => Ok(Self::End),
            Some("NONE") => Ok(Self::None),
            Some(other) => {
                Err(IdeError::invalid(format!("`truncateMode` must be START, MIDDLE, END or NONE, not {other}")))
            }
        }
    }
}

/// `text` limited to `max_lines` lines (more than 2) and then to `max_length` characters;
/// a cut is shown by `marker` in place of the left-out lines (or after the cut text).
pub fn truncate_text(text: &str, max_lines: usize, max_length: usize, mode: TruncateMode, marker: &str) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let by_lines = if lines.len() <= max_lines {
        text.to_owned()
    } else {
        match mode {
            TruncateMode::Start => [&lines[..max_lines - 1], &[marker]].concat().join("\n"),
            TruncateMode::End => [&[marker], &lines[lines.len() - (max_lines - 1)..]].concat().join("\n"),
            TruncateMode::Middle => {
                let head = &lines[..max_lines / 2];
                let tail = &lines[lines.len() - (max_lines / 2 - 1)..];
                [head, &[marker], tail].concat().join("\n")
            }
            TruncateMode::None => text.to_owned(),
        }
    };
    match by_lines.char_indices().nth(max_length) {
        Some((cut, _)) => format!("{}{marker}", &by_lines[..cut]),
        None => by_lines,
    }
}

/// A run's output: all of it to a file, its first [`RUN_PREVIEW_MAX_LENGTH`] characters
/// in memory (then [`RUN_PREVIEW_TRUNCATED_MARKER`]).
pub struct OutputCollector {
    pub path: PathBuf,
    preview: String,
    preview_chars: usize,
    pub truncated: bool,
    file: Option<std::fs::File>,
}

impl OutputCollector {
    pub fn create(name: &str) -> IdeResult<Self> {
        let (path, file) = temp_output_file(&format!("run-{name}"))?;
        Ok(Self { path, preview: String::new(), preview_chars: 0, truncated: false, file: Some(file) })
    }

    pub fn append(&mut self, text: &str) {
        // A failed write keeps the preview going; the file is then incomplete.
        if let Some(f) = &mut self.file
            && f.write_all(text.as_bytes()).is_err()
        {
            self.file = None;
        }
        if self.truncated {
            return;
        }
        // As JetBrains: reaching the limit marks the preview truncated, even without more output.
        let room = RUN_PREVIEW_MAX_LENGTH - self.preview_chars;
        let chars = text.chars().count();
        if chars < room {
            self.preview_chars += chars;
            self.preview.push_str(text);
        } else {
            let cut = text.char_indices().nth(room).map_or(text.len(), |(i, _)| i);
            self.preview.push_str(&text[..cut]);
            self.preview.push_str(RUN_PREVIEW_TRUNCATED_MARKER);
            self.preview_chars = RUN_PREVIEW_MAX_LENGTH;
            self.truncated = true;
        }
    }

    pub fn preview(&self) -> &str {
        &self.preview
    }
}

/// Output files older than this are removed when a new one is created.
const OUTPUT_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

pub fn temp_output_file(prefix: &str) -> IdeResult<(PathBuf, std::fs::File)> {
    let dir = output_dir()?;
    remove_old_logs(&dir, OUTPUT_MAX_AGE);
    let safe: String =
        prefix.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).take(40).collect();
    let path = dir.join(format!("{safe}-{}.log", uuid::Uuid::new_v4().simple()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let file = options.open(&path)?;
    Ok((path, file))
}

/// Best effort: removes `*.log` files in `dir` last modified more than `max_age` ago.
fn remove_old_logs(dir: &Path, max_age: std::time::Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "log") {
            continue;
        }
        let old = entry
            .metadata()
            .ok()
            .filter(std::fs::Metadata::is_file)
            .and_then(|m| m.modified().ok())
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > max_age);
        if old {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// A directory only this user can read: output may hold secrets, and `/tmp` is shared on Linux.
fn output_dir() -> IdeResult<PathBuf> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, MetadataExt};
        // SAFETY: getuid has no preconditions.
        let uid = unsafe { libc::getuid() };
        let dir = std::env::temp_dir().join(format!("openidea-mcp-{uid}"));
        match std::fs::DirBuilder::new().mode(0o700).create(&dir) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
        let meta = std::fs::symlink_metadata(&dir)?;
        if !meta.is_dir() || meta.uid() != uid || meta.mode() & 0o077 != 0 {
            return Err(IdeError::new(
                ide_core::error::ErrorKind::PermissionDenied,
                format!("{} is not a private directory of this user", dir.display()),
            ));
        }
        Ok(dir)
    }
    #[cfg(not(unix))]
    {
        let dir = std::env::temp_dir().join("openidea-mcp");
        std::fs::create_dir_all(&dir)?;
        Ok(dir)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn truncates_like_jetbrains() {
        let text = "1\n2\n3\n4\n5";
        let t = |max, mode| truncate_text(text, max, MAX_TEXT_LENGTH, mode, "M");
        assert_eq!(t(5, TruncateMode::Start), text);
        assert_eq!(t(3, TruncateMode::Start), "1\n2\nM");
        assert_eq!(t(3, TruncateMode::End), "M\n4\n5");
        assert_eq!(t(4, TruncateMode::Middle), "1\n2\nM\n5");
        assert_eq!(t(3, TruncateMode::None), text);
        assert_eq!(truncate_text("abcdef", 10, 3, TruncateMode::Start, "M"), "abcM");
    }

    #[test]
    fn preview_line_keeps_a_fixed_length() {
        // JetBrains' `truncateRunConfigurationPreviewLine`: 1000 characters including the marker.
        let line = "a".repeat(2000);
        let cut = truncate_text(
            &line,
            3,
            1000 - RUN_PREVIEW_TRUNCATED_MARKER.len(),
            TruncateMode::None,
            RUN_PREVIEW_TRUNCATED_MARKER,
        );
        assert!(cut.ends_with("<truncated>"));
        assert_eq!(cut.len(), 1000);
    }

    #[test]
    fn collector_limits_the_preview_and_keeps_everything_in_the_file() {
        let mut c = OutputCollector::create("test").unwrap();
        let output = "a".repeat(RUN_PREVIEW_MAX_LENGTH + 1);
        c.append(&output[..10]);
        c.append(&output[10..]);
        assert_eq!(c.preview(), format!("{}{RUN_PREVIEW_TRUNCATED_MARKER}", &output[..RUN_PREVIEW_MAX_LENGTH]));
        assert!(c.truncated);
        assert_eq!(std::fs::read_to_string(&c.path).unwrap(), output);
        let _ = std::fs::remove_file(&c.path);
    }

    #[test]
    fn removes_day_old_logs() {
        let dir = tempfile::tempdir().unwrap();
        let old = std::time::SystemTime::now() - Duration::from_secs(25 * 60 * 60);
        for name in ["old.log", "new.log", "old.txt"] {
            let file = std::fs::File::create(dir.path().join(name)).unwrap();
            if name.starts_with("old") {
                file.set_modified(old).unwrap();
            }
        }
        remove_old_logs(dir.path(), OUTPUT_MAX_AGE);
        assert!(!dir.path().join("old.log").exists());
        assert!(dir.path().join("new.log").exists());
        assert!(dir.path().join("old.txt").exists(), "only logs are removed");
    }
}
