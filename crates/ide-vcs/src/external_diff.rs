//! Show Diff in External Tool: starts the user's diff program on the two sides of a diff.

use ide_core::{IdeError, IdeResult, settings::ExternalDiffSettings};
use serde::Deserialize;
use specta::Type;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// One side of the diff: a file on disk, or text written to a temporary file.
#[derive(Clone, Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExternalDiffSide {
    /// A saved file, passed to the tool as it is.
    pub path: Option<PathBuf>,
    /// Content without a file of its own (a revision, a text), written to a temporary file.
    pub text: Option<String>,
    /// The temporary file's name; its extension lets the tool pick a syntax.
    pub name: String,
}

/// Splits a parameter line like a shell does for plain words: whitespace separates
/// arguments, double or single quotes keep one together, a backslash escapes the next
/// character inside double quotes and outside quotes.
pub fn split_parameters(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_arg = false;
    let mut quote: Option<char> = None;
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some('\''), '\'') | (Some('"'), '"') => quote = None,
            (Some('"') | None, '\\') => {
                if let Some(next) = chars.next() {
                    cur.push(next);
                }
                in_arg = true;
            }
            (None, '"' | '\'') => {
                quote = Some(c);
                in_arg = true;
            }
            (None, c) if c.is_whitespace() => {
                if in_arg {
                    out.push(std::mem::take(&mut cur));
                    in_arg = false;
                }
            }
            (_, c) => {
                cur.push(c);
                in_arg = true;
            }
        }
    }
    if in_arg {
        out.push(cur);
    }
    out
}

/// The tool's arguments: `%1` the left file, `%2` the right file, `%3` the title.
pub fn expand_parameters(parameters: &str, left: &str, right: &str, title: &str) -> Vec<String> {
    split_parameters(parameters)
        .into_iter()
        .map(|arg| arg.replace("%1", left).replace("%2", right).replace("%3", title))
        .collect()
}

fn side_file(side: &ExternalDiffSide, dir: &Path, sub: &str) -> IdeResult<PathBuf> {
    if let Some(path) = &side.path {
        return Ok(path.clone());
    }
    let name = Path::new(&side.name).file_name().map(|n| n.to_owned()).unwrap_or_else(|| "content".into());
    let folder = dir.join(sub);
    std::fs::create_dir_all(&folder)?;
    let file = folder.join(name);
    std::fs::write(&file, side.text.as_deref().unwrap_or_default())?;
    Ok(file)
}

/// Starts the configured tool on `left` ↔ `right` and returns once it runs; the tool
/// lives on after the diff closes, as it would started from a shell.
pub fn launch_external_diff(
    settings: &ExternalDiffSettings,
    left: &ExternalDiffSide,
    right: &ExternalDiffSide,
    title: &str,
) -> IdeResult<()> {
    let program = settings.path.trim();
    if program.is_empty() {
        return Err(IdeError::invalid("no external diff tool is set (Settings › Tools › External Diff Tools)"));
    }
    let needs_temp = left.path.is_none() || right.path.is_none();
    // Kept after the call: the tool reads the files after it starts.
    let dir = if needs_temp { Some(tempfile::Builder::new().prefix("openidea-diff-").tempdir()?.keep()) } else { None };
    let temp = dir.as_deref().unwrap_or_else(|| Path::new(""));
    let a = side_file(left, temp, "left")?;
    let b = side_file(right, temp, "right")?;
    let args = expand_parameters(&settings.parameters, &a.to_string_lossy(), &b.to_string_lossy(), title);
    let mut cmd = Command::new(program);
    ide_core::process::prepare(&mut cmd);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = cmd
        .spawn()
        .map_err(|e| IdeError::unavailable(format!("cannot start the external diff tool {program}: {e}")))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_quoted_parameters() {
        assert_eq!(split_parameters("%1 %2 %3"), ["%1", "%2", "%3"]);
        assert_eq!(split_parameters(r#"--title "%3"  -L 'a b' x\ y"#), ["--title", "%3", "-L", "a b", "x y"]);
        assert_eq!(split_parameters(r#"--empty "" end"#), ["--empty", "", "end"]);
    }

    #[test]
    fn expands_placeholders_inside_arguments() {
        let args = expand_parameters("--left=%1 %2 --title %3", "/t/a b.rs", "/t/b.rs", "a.rs (HEAD ↔ Your version)");
        assert_eq!(args, ["--left=/t/a b.rs", "/t/b.rs", "--title", "a.rs (HEAD ↔ Your version)"]);
    }

    #[test]
    fn writes_text_sides_to_named_temporary_files() {
        let dir = tempfile::tempdir().unwrap();
        let side = ExternalDiffSide { path: None, text: Some("x\n".into()), name: "../Main.java".into() };
        let file = side_file(&side, dir.path(), "left").unwrap();
        assert_eq!(file, dir.path().join("left/Main.java"));
        assert_eq!(std::fs::read_to_string(file).unwrap(), "x\n");
        let saved = ExternalDiffSide { path: Some("/p/a.rs".into()), text: None, name: "a.rs".into() };
        assert_eq!(side_file(&saved, dir.path(), "right").unwrap(), PathBuf::from("/p/a.rs"));
    }

    #[test]
    fn needs_a_program() {
        let side = ExternalDiffSide { path: Some("/p/a".into()), text: None, name: "a".into() };
        assert!(launch_external_diff(&ExternalDiffSettings::default(), &side, &side, "t").is_err());
    }
}
