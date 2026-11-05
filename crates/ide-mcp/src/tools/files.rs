// Ported from JetBrains intellij-community plugins/mcp-server (mcpserver.toolsets/src/general/ReadToolset.kt,
// the list_directory_tree part of FileToolset.kt, src/com/intellij/mcpserver/util/fs.util.kt), Apache-2.0.
//! Reading files and listing directories.

use crate::tool::{Call, Output, Param, ParamType, Tool};
use crate::tools::util::{
    self, RELATIVE_PATH_IN_PROJECT_DESCRIPTION, TIMED_OUT_DESCRIPTION, TIMEOUT_MILLISECONDS_DESCRIPTION,
};
use ide_core::mcp::McpToolKind;
use ide_core::{CancellationToken, IdeError, IdeResult};
use serde::Serialize;
use serde_json::json;
use std::path::Path;
use std::time::{Duration, Instant};

const DEFAULT_READ_LIMIT: i64 = 2000;
const MAX_READ_LIMIT: i64 = 5000;
/// Longer lines are cut (minified files would flood the context), in UTF-16 units.
const MAX_LINE_LENGTH: usize = 2000;
const DEFAULT_TREE_DEPTH: i64 = 5;

pub fn tools() -> Vec<Tool> {
    vec![read_file(), list_directory_tree()]
}

// --- read_file -----------------------------------------------------------------

fn read_file() -> Tool {
    Tool::new(
        "read_file",
        McpToolKind::Read,
        "Reads a file in the project directory or from any project dependency or other project source root.
Can read text sources inside jar/zip archives; compiled class files are not decompiled.
Returns numbered lines (1-indexed) as text.
By default, reads up to 2000 lines starting from the beginning of the file.
The maximum accepted limit is 5000 lines.",
        |call| async move {
            let offset = positive(&call, "offset", 1)?;
            let limit = positive(&call, "limit", DEFAULT_READ_LIMIT)?;
            if limit > MAX_READ_LIMIT {
                return Err(IdeError::invalid(format!("limit must be <= {MAX_READ_LIMIT}")));
            }
            let path = util::resolve_read_file(&call, &call.str("file_path")?).await?;
            let probe = ide_vfs::probe(&path)?;
            if probe.binary && call.project().documents.by_path(&path).is_none() {
                return Err(IdeError::invalid(format!(
                    "{} is a binary file ({} bytes); read_file reads text",
                    call.display(&path),
                    probe.size
                )));
            }
            let text = ide_host::ops::fs::read_text(&call.host(), call.window(), path).await?;
            Ok(Output::text(render_slice(&text, offset as usize, limit as usize)?))
        },
    )
    .param(Param::required("file_path", ParamType::String, util::FILE_PATH_DESCRIPTION))
    .param(Param::optional("offset", ParamType::Integer, "1-based line number to start reading from"))
    .param(Param::optional(
        "limit",
        ParamType::Integer,
        "Maximum number of lines to return (default: 2000, max: 5000)",
    ))
}

/// An integer argument that must be > 0.
fn positive(call: &Call, name: &str, default: i64) -> IdeResult<i64> {
    match call.opt_i64(name)?.unwrap_or(default) {
        n if n <= 0 => Err(IdeError::invalid(format!("{name} must be > 0"))),
        n => Ok(n),
    }
}

/// Lines `start..` of `text` as `L<n>: <line>`; when more than `max_lines` remain, the first
/// and the last halves of the budget with a `…N lines truncated…` marker between them.
/// Lines are the editor's: a trailing line break starts an empty last line.
fn render_slice(text: &str, start: usize, max_lines: usize) -> IdeResult<String> {
    let lines: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    let count = lines.len();
    if start > count {
        return Err(IdeError::invalid("offset exceeds file length"));
    }
    let range = |from: usize, to: usize| {
        (from..=to).map(|n| format!("L{n}: {}", format_line(lines[n - 1]))).collect::<Vec<_>>().join("\n")
    };
    let available = count - start + 1;
    if available <= max_lines {
        return Ok(range(start, count));
    }
    let head = max_lines / 2;
    let tail = max_lines - head;
    let head_end = start + head - 1;
    let tail_start = count - tail + 1;
    let mut out = String::new();
    if head > 0 {
        out.push_str(&range(start, head_end));
        out.push('\n');
    }
    out.push_str(&format!("\u{2026}{} lines truncated\u{2026}", tail_start - head_end - 1));
    if tail > 0 {
        out.push('\n');
        out.push_str(&range(tail_start, count));
    }
    Ok(out)
}

/// `line` cut to [`MAX_LINE_LENGTH`] UTF-16 units, or as many characters when the cut would
/// split a surrogate pair (as JetBrains does).
fn format_line(line: &str) -> &str {
    let mut units = 0;
    for (i, c) in line.char_indices() {
        if units >= MAX_LINE_LENGTH {
            return &line[..i];
        }
        if units + c.len_utf16() > MAX_LINE_LENGTH {
            // A pair across the boundary: keep MAX_LINE_LENGTH characters instead.
            return match line.char_indices().nth(MAX_LINE_LENGTH) {
                Some((cut, _)) => &line[..cut],
                None => line,
            };
        }
        units += c.len_utf16();
    }
    line
}

// --- list_directory_tree -------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryTreeInfo {
    traversed_directory: String,
    tree: String,
    errors: Vec<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    listing_timed_out: bool,
}

fn list_directory_tree() -> Tool {
    Tool::new(
        "list_directory_tree",
        McpToolKind::Read,
        "Provides a tree representation of the specified directory in the pseudo graphic format like `tree` utility does.
Use this tool to explore the contents of a directory or the whole project.
You MUST prefer this tool over listing directories via command line utilities like `ls` or `dir`.",
        |call| async move {
            let directory = call.str("directoryPath")?;
            let max_depth = call.opt_i64("maxDepth")?.unwrap_or(DEFAULT_TREE_DEPTH);
            let timeout = call.opt_i64("timeout")?.unwrap_or(util::MEDIUM_TIMEOUT.as_millis() as i64);
            let dir = call.resolve_readable(&directory).await?;
            if !dir.exists() {
                return Err(IdeError::not_found(format!("No such directory: {}", dir.display())));
            }
            if !dir.is_dir() {
                return Err(IdeError::invalid(format!("Not a directory: {}", dir.display())));
            }
            let deadline = Instant::now() + Duration::from_millis(timeout.max(0) as u64);
            let cancel = call.cancel.clone();
            let mut tree =
                TreeRender { out: String::new(), errors: Vec::new(), timed_out: false, deadline, cancel: cancel.clone() };
            let tree = call
                .host()
                .blocking(move || {
                    tree.render(&dir, "", true, max_depth, true);
                    Ok(tree)
                })
                .await?;
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            Output::json(DirectoryTreeInfo {
                traversed_directory: directory,
                tree: tree.out,
                errors: tree.errors,
                listing_timed_out: tree.timed_out,
            })
        },
    )
    .param(Param::required("directoryPath", ParamType::String, RELATIVE_PATH_IN_PROJECT_DESCRIPTION))
    .param(Param::optional("maxDepth", ParamType::Integer, "Maximum recursion depth"))
    .param(Param::optional("timeout", ParamType::Integer, TIMEOUT_MILLISECONDS_DESCRIPTION))
    .output(json!({
        "type": "object",
        "properties": {
            "traversedDirectory": { "type": "string" },
            "tree": { "type": "string" },
            "errors": { "type": "array", "items": { "type": "string" } },
            "listingTimedOut": { "type": "boolean", "description": TIMED_OUT_DESCRIPTION },
        },
        "required": ["traversedDirectory", "tree", "errors"],
    }))
}

/// The `tree`-like listing: the directory's absolute path, then every entry (hidden and
/// ignored ones too) by lower-cased name, directories marked with `/`.
struct TreeRender {
    out: String,
    errors: Vec<String>,
    timed_out: bool,
    deadline: Instant,
    cancel: CancellationToken,
}

impl TreeRender {
    fn render(&mut self, path: &Path, indent: &str, is_last: bool, max_depth: i64, is_root: bool) {
        if max_depth <= 0 || self.timed_out || self.cancel.is_cancelled() {
            return;
        }
        if Instant::now() >= self.deadline {
            self.timed_out = true;
            return;
        }
        let prefix = match (is_root, is_last) {
            (true, _) => "",
            (false, true) => "└── ",
            (false, false) => "├── ",
        };
        let name = if is_root {
            path.display().to_string()
        } else {
            path.file_name().unwrap_or_default().to_string_lossy().into_owned()
        };
        // Symlinks are followed, like `File.isDirectory`; the depth limit stops loops.
        let is_dir = path.is_dir();
        self.out.push_str(&format!("{indent}{prefix}{name}{}\n", if is_dir { "/" } else { "" }));
        if !is_dir {
            return;
        }
        let mut children: Vec<_> = match std::fs::read_dir(path) {
            Ok(entries) => entries.filter_map(|e| e.ok().map(|e| e.path())).collect(),
            Err(e) => {
                self.errors.push(format!("Failed to read {}: {e}", path.display()));
                return;
            }
        };
        let key = |p: &std::path::PathBuf| p.file_name().unwrap_or_default().to_string_lossy().into_owned();
        children.sort_by_cached_key(|p| (key(p).to_lowercase(), key(p)));
        let child_indent = format!("{indent}{}", if is_last { "    " } else { "│   " });
        let n = children.len();
        for (i, child) in children.iter().enumerate() {
            self.render(child, &child_indent, i + 1 == n, max_depth - 1, false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slice(text: &str, start: usize, max: usize) -> String {
        render_slice(text, start, max).unwrap()
    }

    #[test]
    fn numbers_lines_like_the_editor() {
        assert_eq!(slice("a\nb", 1, 10), "L1: a\nL2: b");
        assert_eq!(slice("a\r\nb\n", 1, 10), "L1: a\nL2: b\nL3: ");
        assert_eq!(slice("", 1, 10), "L1: ");
        assert_eq!(slice("a\nb\nc", 2, 10), "L2: b\nL3: c");
        assert!(render_slice("", 2, 10).unwrap_err().message.contains("offset exceeds file length"));
        assert!(render_slice("a\nb", 3, 10).unwrap_err().message.contains("offset exceeds file length"));
    }

    #[test]
    fn keeps_head_and_tail_of_long_slices() {
        let text = (1..=11).map(|n| format!("line {n}")).collect::<Vec<_>>().join("\n");
        assert_eq!(slice(&text, 1, 4), "L1: line 1\nL2: line 2\n…7 lines truncated…\nL10: line 10\nL11: line 11");
        assert_eq!(slice(&text, 3, 4), "L3: line 3\nL4: line 4\n…5 lines truncated…\nL10: line 10\nL11: line 11");
        assert_eq!(slice(&text, 1, 1), "…10 lines truncated…\nL11: line 11");
    }

    #[test]
    fn cuts_long_lines_at_utf16_units() {
        let long = "x".repeat(2100);
        assert_eq!(format_line(&long).len(), MAX_LINE_LENGTH);
        // A pair across the boundary keeps 2000 characters.
        let pair = format!("{}😀{}", "x".repeat(1999), "y".repeat(10));
        assert_eq!(format_line(&pair).chars().count(), MAX_LINE_LENGTH);
        assert!(format_line(&pair).ends_with('😀'));
        let short = format!("{}😀", "x".repeat(1998));
        assert_eq!(format_line(&short), short);
    }
}
