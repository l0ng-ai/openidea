//! Reading files and listing directories.

use crate::tool::{Output, Param, ParamType, Tool};
use ide_core::IdeError;
use ide_core::mcp::McpToolKind;
use ide_search::FileMask;
use ide_vfs::EntryKind;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const READ_DEFAULT_LINES: usize = 2000;
const READ_MAX_LINES: usize = 5000;
/// Longer lines are cut (minified files would flood the context).
const MAX_LINE_CHARS: usize = 2000;
const TREE_DEFAULT_DEPTH: usize = 5;
const TREE_MAX_ENTRIES: usize = 3000;

pub fn tools() -> Vec<Tool> {
    vec![read_file(), list_directory_tree()]
}

fn read_file() -> Tool {
    Tool::new(
        "read_file",
        McpToolKind::Read,
        "Reads a text file of the project (or any file by absolute path), including unsaved changes of open \
editors. Returns numbered lines (1-based), `<line number>\\t<text>`. Reads up to 2000 lines from `offset` by \
default; `limit` accepts up to 5000. Lines longer than 2000 characters are cut.",
        |call| async move {
            let path = call.resolve_readable(&call.str("file_path")?).await?;
            let offset = call.count("offset", 1, usize::MAX)?;
            let limit = call.count("limit", READ_DEFAULT_LINES, READ_MAX_LINES)?;
            let host = call.host();
            if path.is_file() {
                let probe = ide_vfs::probe(&path)?;
                if probe.binary && call.project().documents.by_path(&path).is_none() {
                    return Err(IdeError::invalid(format!(
                        "{} is a binary file ({} bytes); read_file reads text",
                        call.display(&path),
                        probe.size
                    )));
                }
            }
            let text = ide_host::ops::fs::read_text(&host, call.window(), path.clone()).await.map_err(|e| {
                if path.is_dir() {
                    IdeError::invalid(format!("{} is a directory; use list_directory_tree", call.display(&path)))
                } else {
                    e
                }
            })?;
            Ok(Output::text(numbered(&text, offset, limit)))
        },
    )
    .param(Param::required(
        "file_path",
        ParamType::String,
        "Path of the file: project-relative, absolute, or a file:// URL. Paths returned by the other tools can be \
passed as they are.",
    ))
    .param(Param::optional("offset", ParamType::Integer, "1-based line to start reading from (default 1)"))
    .param(Param::optional("limit", ParamType::Integer, "Maximum number of lines (default 2000, at most 5000)"))
}

/// `text`'s lines `offset..offset+limit` as `<n>\t<line>`, with a note when more follow.
pub(crate) fn numbered(text: &str, offset: usize, limit: usize) -> String {
    if text.is_empty() {
        return "(the file is empty)".into();
    }
    let lines: Vec<&str> = text.split('\n').collect();
    // A trailing newline does not start another line.
    let total = if text.ends_with('\n') { lines.len() - 1 } else { lines.len() };
    if offset > total {
        return format!("(the file has {total} lines; offset {offset} is past its end)");
    }
    let end = (offset - 1 + limit).min(total);
    let mut out = String::new();
    for (i, line) in lines[offset - 1..end].iter().enumerate() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let _ = write!(out, "{}\t", offset + i);
        match line.char_indices().nth(MAX_LINE_CHARS) {
            Some((cut, _)) => {
                out.push_str(&line[..cut]);
                out.push_str(" … (line truncated)");
            }
            None => out.push_str(line),
        }
        out.push('\n');
    }
    if end < total {
        let _ = write!(out, "… {} more lines (continue with offset={})", total - end, end + 1);
    }
    out
}

fn list_directory_tree() -> Tool {
    Tool::new(
        "list_directory_tree",
        McpToolKind::Read,
        "Shows a directory of the project as a tree, like the `tree` utility, without ignored and excluded files \
(what search_file leaves out). Directories below `maxDepth` that have contents are shown as `name/ …`. Use it to \
explore the project instead of `ls` / `find`.",
        |call| async move {
            let dir = call.resolve_readable(call.opt_str("directoryPath")?.as_deref().unwrap_or(".")).await?;
            let depth = call.count("maxDepth", TREE_DEFAULT_DEPTH, 50)?;
            if !dir.is_dir() {
                return Err(IdeError::not_found(format!("{} is not a directory", call.display(&dir))));
            }
            let host = call.host();
            let label = call.display(&dir);
            let tree = Tree {
                host: host.clone(),
                window: call.window().to_owned(),
                root: call.root().to_path_buf(),
                // Ignored names and "Exclude files" patterns, which `read_dir` does not flag.
                excludes: FileMask::new(&[], &call.project().search_excludes())?,
            };
            let text = host.blocking(move || Ok(tree.render(&dir, &label, depth))).await?;
            Ok(Output::text(text))
        },
    )
    .param(Param::optional(
        "directoryPath",
        ParamType::String,
        "Directory, relative to the project root (default: the root)",
    ))
    .param(Param::optional("maxDepth", ParamType::Integer, "How many levels to descend (default 5)"))
}

struct Tree {
    host: Arc<ide_host::Host>,
    window: String,
    root: PathBuf,
    excludes: FileMask,
}

impl Tree {
    fn render(&self, dir: &Path, label: &str, depth: usize) -> String {
        let mut out = format!("{label}/\n");
        let mut count = 0usize;
        self.walk(dir, "", depth, &mut out, &mut count);
        if count >= TREE_MAX_ENTRIES {
            let _ =
                writeln!(out, "… (stopped after {TREE_MAX_ENTRIES} entries; list a subdirectory or lower maxDepth)");
        }
        out
    }

    /// The entries of `dir` that are shown, directories first, by name.
    fn entries(&self, dir: &Path) -> Vec<ide_vfs::FileEntry> {
        let Ok(mut entries) = ide_host::ops::fs::read_dir(&self.host, &self.window, dir.to_path_buf()) else {
            return Vec::new();
        };
        entries.retain(|e| {
            if e.ignored || e.excluded || e.name == ".git" {
                return false;
            }
            // Outside the project only the names count.
            let rel = match e.path.strip_prefix(&self.root) {
                Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
                Err(_) => e.name.clone(),
            };
            self.excludes.matches(&rel)
        });
        entries.sort_by(|a, b| {
            (a.kind != EntryKind::Dir, a.name.to_lowercase()).cmp(&(b.kind != EntryKind::Dir, b.name.to_lowercase()))
        });
        entries
    }

    fn walk(&self, dir: &Path, prefix: &str, depth: usize, out: &mut String, count: &mut usize) {
        if depth == 0 || *count >= TREE_MAX_ENTRIES {
            return;
        }
        let entries = self.entries(dir);
        let n = entries.len();
        for (i, entry) in entries.into_iter().enumerate() {
            if *count >= TREE_MAX_ENTRIES {
                return;
            }
            *count += 1;
            let last = i + 1 == n;
            let is_dir = entry.kind == EntryKind::Dir;
            // A directory below the depth limit is marked when it has something to show.
            let suffix = match is_dir {
                false => "",
                true if depth == 1 && !self.entries(&entry.path).is_empty() => "/ …",
                true => "/",
            };
            let _ = writeln!(out, "{prefix}{}{}{suffix}", if last { "└── " } else { "├── " }, entry.name);
            if is_dir {
                let child_prefix = format!("{prefix}{}", if last { "    " } else { "│   " });
                self.walk(&entry.path, &child_prefix, depth - 1, out, count);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::numbered;

    #[test]
    fn numbers_lines_and_pages() {
        assert_eq!(numbered("a\nb\nc\n", 1, 10), "1\ta\n2\tb\n3\tc\n");
        assert_eq!(numbered("a\r\nb", 2, 10), "2\tb\n");
        assert_eq!(numbered("a\nb\nc", 1, 2), "1\ta\n2\tb\n… 1 more lines (continue with offset=3)");
        assert_eq!(numbered("", 1, 10), "(the file is empty)");
        assert!(numbered("a\n", 5, 10).contains("past its end"));
        let long = "x".repeat(2100);
        assert!(numbered(&long, 1, 1).ends_with("(line truncated)\n"));
    }
}
