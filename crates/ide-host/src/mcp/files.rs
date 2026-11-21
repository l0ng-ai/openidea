// Ported from JetBrains intellij-community plugins/mcp-server (mcpserver.toolsets/src/general/ReadToolset.kt,
// the list_directory_tree part of FileToolset.kt, src/com/intellij/mcpserver/util/fs.util.kt), Apache-2.0.
//! Reading files and listing directories.

use crate::mcp::page::{OFFSET, Page};
use crate::mcp::tool::{Call, Output, Param, ParamType, Tool};
use crate::mcp::util::{
    self, RELATIVE_PATH_IN_PROJECT_DESCRIPTION, TIMED_OUT_DESCRIPTION, TIMEOUT_MILLISECONDS_DESCRIPTION,
};
use ide_core::{CancellationToken, IdeError, IdeResult};
use ide_search::FileMask;
use serde::Serialize;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const DEFAULT_READ_LIMIT: i64 = 2000;
const MAX_READ_LIMIT: i64 = 5000;
/// Longer lines are cut (minified files would flood the context), in UTF-16 units.
const MAX_LINE_LENGTH: usize = 2000;
const DEFAULT_TREE_DEPTH: i64 = 5;
/// Entries `list_directory_tree` lists by default.
const TREE_LIMIT: usize = 100;

pub fn tools() -> Vec<Tool> {
    vec![read_file(), list_directory_tree()]
}

// --- read_file -----------------------------------------------------------------

fn read_file() -> Tool {
    Tool::new(
        "read_file",
        "Reads a file in the project directory or from any project dependency or other project source root.
Can read text sources inside jar/zip archives; compiled class files are not decompiled.
Returns numbered lines (1-indexed) as text.
By default, reads up to 2000 lines starting from the beginning of the file; a longer file keeps its first and last
lines with a `…N lines truncated…` marker between them.
With `offset` or `limit`, returns exactly lines `offset` to `offset + limit - 1` (fewer at the end of the file),
followed by `…N more lines; read on with offset=M…` when the file goes on.
The maximum accepted limit is 5000 lines.",
        |call| async move {
            // An explicit range is read as asked; the default read of a whole file keeps its head and tail.
            let window = call.opt_i64("offset")?.is_some() || call.opt_i64("limit")?.is_some();
            let offset = positive(&call, "offset", 1)?;
            let limit = positive(&call, "limit", DEFAULT_READ_LIMIT)?;
            if limit > MAX_READ_LIMIT {
                return Err(IdeError::invalid(format!("limit must be <= {MAX_READ_LIMIT}")));
            }
            let path = util::resolve_read_file(&call, &call.str("file_path")?).await?;
            if call.project().documents.by_path(&path).is_none()
                && let probe = ide_vfs::probe(&path)?
                && probe.binary
            {
                return Err(IdeError::invalid(format!(
                    "{} is a binary file ({} bytes); read_file reads text",
                    call.display(&path),
                    probe.size
                )));
            }
            let text = crate::ops::fs::fs_read_text(&call.host(), call.window(), path).await?;
            Ok(Output::text(render_slice(&text, offset as usize, limit as usize, window)?))
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

/// Lines `start..` of `text` as `L<n>: <line>`, at most `max_lines` of them. A `window` is
/// exactly the lines from `start` on, then how many lines remain; otherwise, when more than
/// `max_lines` remain, the first and the last halves of the budget with a `…N lines truncated…`
/// marker between them.
/// Lines are the editor's: a trailing line break starts an empty last line.
fn render_slice(text: &str, start: usize, max_lines: usize, window: bool) -> IdeResult<String> {
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
    if window {
        let end = start + max_lines - 1;
        return Ok(format!(
            "{}\n\u{2026}{} more lines; read on with offset={}\u{2026}",
            range(start, end),
            count - end,
            end + 1
        ));
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
    /// Entries under the directory within `maxDepth`.
    total: usize,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    more: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_offset: Option<usize>,
}

fn list_directory_tree() -> Tool {
    Tool::new(
        "list_directory_tree",
        "Provides a tree representation of the specified directory in the pseudo graphic format like `tree` utility does.
Use this tool to explore the contents of a directory or the whole project.
You MUST prefer this tool over listing directories via command line utilities like `ls` or `dir`.
A page that starts inside a directory repeats the lines of the directories above it.
What `.gitignore` ignores is marked [git-ignored] and what the project excludes [ide-excluded]; entries inside a
marked directory are not marked again.",
        |call| async move {
            let directory = call.str("directoryPath")?;
            let max_depth = call.opt_i64("maxDepth")?.unwrap_or(DEFAULT_TREE_DEPTH);
            let page = Page::of(&call, TREE_LIMIT)?;
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
            // Matched from the root holding the directory: an attached project has its own exclusions.
            let root = call.project().root_of(&dir);
            let marks = Marks { excludes: FileMask::new(&[], &call.project().search_excludes_in(&root)).ok(), root };
            // The directory itself, when it or one above it is left out.
            let root_mark = marker(ide_index::walk_skips(call.root(), &dir), marks.ide_excluded(&dir, true));
            let mut tree = TreeRender {
                out: String::new(),
                errors: Vec::new(),
                timed_out: false,
                deadline,
                cancel: cancel.clone(),
                page,
                seen: 0,
                above: Vec::new(),
                marks,
            };
            let tree = call
                .host()
                .blocking(move || {
                    tree.render(&dir, "", true, max_depth, true, root_mark, !root_mark.is_empty());
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
                total: tree.seen,
                more: tree.seen > page.end(),
                next_offset: (tree.seen > page.end()).then_some(page.end()),
            })
        },
    )
    .param(Param::required("directoryPath", ParamType::String, RELATIVE_PATH_IN_PROJECT_DESCRIPTION))
    .param(Param::optional("maxDepth", ParamType::Integer, "Maximum recursion depth"))
    .param(Param::optional("limit", ParamType::Integer, "Entries to return at most (default 100)"))
    .param(Param::optional("offset", ParamType::Integer, OFFSET))
    .param(Param::optional("timeout", ParamType::Integer, TIMEOUT_MILLISECONDS_DESCRIPTION))
    .output(json!({
        "type": "object",
        "properties": {
            "traversedDirectory": { "type": "string" },
            "tree": { "type": "string" },
            "errors": { "type": "array", "items": { "type": "string" } },
            "listingTimedOut": { "type": "boolean", "description": TIMED_OUT_DESCRIPTION },
            "total": { "type": "integer" },
            "more": { "type": "boolean" },
            "nextOffset": { "type": "integer" },
        },
        "required": ["traversedDirectory", "tree", "errors", "total"],
    }))
}

/// The `tree`-like listing: the directory's absolute path, then every entry (hidden and
/// ignored ones too) by lower-cased name, directories marked with `/`; entries outside the
/// page are counted, not listed. An entry left out of the project is marked, the entries
/// inside it are not.
struct TreeRender {
    out: String,
    errors: Vec<String>,
    timed_out: bool,
    deadline: Instant,
    cancel: CancellationToken,
    page: Page,
    /// Entries met so far.
    seen: usize,
    /// The lines of the directories above the entry, and whether this page shows them yet.
    above: Vec<(String, bool)>,
    marks: Marks,
}

/// What the project leaves out, to mark in the listing.
struct Marks {
    root: PathBuf,
    /// The project's exclusions (excluded folders, "Exclude files" names), as Find in Files applies them.
    excludes: Option<FileMask>,
}

impl Marks {
    fn ide_excluded(&self, path: &Path, is_dir: bool) -> bool {
        let (Some(mask), Ok(rel)) = (&self.excludes, path.strip_prefix(&self.root)) else { return false };
        let rel = rel.to_string_lossy().replace('\\', "/");
        // A directory is excluded with the files in it.
        !rel.is_empty() && !mask.matches(&if is_dir { format!("{rel}/x") } else { rel })
    }
}

/// Spelled out, so that the listing says what it means.
fn marker(git_ignored: bool, ide_excluded: bool) -> &'static str {
    match (git_ignored, ide_excluded) {
        (true, true) => " [git-ignored] [ide-excluded]",
        (true, false) => " [git-ignored]",
        (false, true) => " [ide-excluded]",
        (false, false) => "",
    }
}

impl TreeRender {
    /// `mark`: the entry's marker; `marked`: it or a directory above it is marked.
    #[allow(clippy::too_many_arguments)]
    fn render(
        &mut self,
        path: &Path,
        indent: &str,
        is_last: bool,
        max_depth: i64,
        is_root: bool,
        mark: &str,
        marked: bool,
    ) {
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
        let is_dir = path.is_dir() && !path.is_symlink();
        let line = format!("{indent}{prefix}{name}{}{mark}\n", if is_dir { "/" } else { "" });
        let shown = if is_root {
            self.out.push_str(&line);
            true
        } else {
            self.entry(&line)
        };
        if !is_dir {
            return;
        }
        // Without exclusions, `ignored` is what `.gitignore` says.
        let mut children: Vec<(PathBuf, bool)> = match ide_vfs::read_dir(path, &[]) {
            Ok(entries) => entries.into_iter().map(|e| (e.path.0, e.ignored)).collect(),
            Err(e) => {
                self.errors.push(format!("Failed to read {}: {}", path.display(), e.message));
                return;
            }
        };
        let key = |p: &PathBuf| p.file_name().unwrap_or_default().to_string_lossy().into_owned();
        children.sort_by_cached_key(|(p, _)| (key(p).to_lowercase(), key(p)));
        let child_indent = format!("{indent}{}", if is_last { "    " } else { "│   " });
        let n = children.len();
        if !is_root {
            self.above.push((line, shown));
        }
        // Inside a marked directory nothing is marked again.
        for (i, (child, git_ignored)) in children.iter().enumerate() {
            let child_mark = if marked {
                ""
            } else {
                let child_dir = child.is_dir() && !child.is_symlink();
                marker(*git_ignored, self.marks.ide_excluded(child, child_dir))
            };
            self.render(
                child,
                &child_indent,
                i + 1 == n,
                max_depth - 1,
                false,
                child_mark,
                marked || !child_mark.is_empty(),
            );
        }
        if !is_root {
            self.above.pop();
        }
    }

    /// Counts an entry and lists it when on the page, after the directories above it.
    fn entry(&mut self, line: &str) -> bool {
        let n = self.seen;
        self.seen += 1;
        if n < self.page.offset || n >= self.page.end() {
            return false;
        }
        for (above, shown) in &mut self.above {
            if !*shown {
                self.out.push_str(above);
                *shown = true;
            }
        }
        self.out.push_str(line);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slice(text: &str, start: usize, max: usize) -> String {
        render_slice(text, start, max, false).unwrap()
    }

    #[test]
    fn numbers_lines_like_the_editor() {
        assert_eq!(slice("a\nb", 1, 10), "L1: a\nL2: b");
        assert_eq!(slice("a\r\nb\n", 1, 10), "L1: a\nL2: b\nL3: ");
        assert_eq!(slice("", 1, 10), "L1: ");
        assert_eq!(slice("a\nb\nc", 2, 10), "L2: b\nL3: c");
        assert!(render_slice("", 2, 10, true).unwrap_err().message.contains("offset exceeds file length"));
        assert!(render_slice("a\nb", 3, 10, true).unwrap_err().message.contains("offset exceeds file length"));
    }

    #[test]
    fn keeps_head_and_tail_of_a_long_default_read() {
        let text = (1..=11).map(|n| format!("line {n}")).collect::<Vec<_>>().join("\n");
        assert_eq!(slice(&text, 1, 4), "L1: line 1\nL2: line 2\n…7 lines truncated…\nL10: line 10\nL11: line 11");
        assert_eq!(slice(&text, 3, 4), "L3: line 3\nL4: line 4\n…5 lines truncated…\nL10: line 10\nL11: line 11");
        assert_eq!(slice(&text, 1, 1), "…10 lines truncated…\nL11: line 11");
    }

    #[test]
    fn reads_an_explicit_range_exactly_and_says_where_to_read_on() {
        let text = (1..=11).map(|n| format!("line {n}")).collect::<Vec<_>>().join("\n");
        let window = |start, max| render_slice(&text, start, max, true).unwrap();
        assert_eq!(window(5, 3), "L5: line 5\nL6: line 6\nL7: line 7\n…4 more lines; read on with offset=8…");
        assert_eq!(window(1, 1), "L1: line 1\n…10 more lines; read on with offset=2…");
        assert_eq!(window(10, 3), "L10: line 10\nL11: line 11", "the end of the file needs no marker");
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

    #[test]
    fn a_tree_page_repeats_the_directories_above_it() {
        let tmp = tempfile::tempdir().unwrap();
        for file in ["a/x.txt", "a/y.txt", "b.txt"] {
            let path = tmp.path().join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "").unwrap();
        }
        let render = |offset, limit| {
            let mut tree = TreeRender {
                out: String::new(),
                errors: Vec::new(),
                timed_out: false,
                deadline: Instant::now() + Duration::from_secs(10),
                cancel: CancellationToken::new(),
                page: Page { offset, limit },
                seen: 0,
                above: Vec::new(),
                marks: Marks { root: tmp.path().to_path_buf(), excludes: None },
            };
            tree.render(tmp.path(), "", true, 5, true, "", false);
            let root = format!("{}/\n", tmp.path().display());
            (tree.out.strip_prefix(&root).unwrap().to_owned(), tree.seen)
        };
        assert_eq!(render(0, 2), ("    ├── a/\n    │   ├── x.txt\n".to_owned(), 4));
        assert_eq!(
            render(2, 2).0,
            "    ├── a/\n    │   └── y.txt\n    └── b.txt\n",
            "the page in `a/` repeats its line"
        );
        assert_eq!(render(0, 100).0, "    ├── a/\n    │   ├── x.txt\n    │   └── y.txt\n    └── b.txt\n");
    }

    #[test]
    fn what_the_project_leaves_out_is_marked_once() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        for file in ["ign/deep/a.txt", "out/b.txt", "both/c.txt", "src/d.txt", "src/e.log"] {
            let path = root.join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "").unwrap();
        }
        std::fs::write(root.join(".gitignore"), "ign/\nboth/\n*.log\n").unwrap();
        let excludes = ["out/**".to_owned(), "both/**".to_owned()];
        let mut tree = TreeRender {
            out: String::new(),
            errors: Vec::new(),
            timed_out: false,
            deadline: Instant::now() + Duration::from_secs(10),
            cancel: CancellationToken::new(),
            page: Page { offset: 0, limit: 100 },
            seen: 0,
            above: Vec::new(),
            marks: Marks { root: root.clone(), excludes: FileMask::new(&[], &excludes).ok() },
        };
        tree.render(&root, "", true, 5, true, "", false);
        let listing = tree.out.strip_prefix(&format!("{}/\n", root.display())).unwrap().to_owned();
        assert_eq!(
            listing,
            [
                "    ├── .gitignore",
                "    ├── both/ [git-ignored] [ide-excluded]",
                "    │   └── c.txt",
                "    ├── ign/ [git-ignored]",
                "    │   └── deep/",
                "    │       └── a.txt",
                "    ├── out/ [ide-excluded]",
                "    │   └── b.txt",
                "    └── src/",
                "        ├── d.txt",
                "        └── e.log [git-ignored]",
                "",
            ]
            .join("\n")
        );
    }
}
