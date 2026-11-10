//! "Search in comments and strings" for file moves / renames: textual
//! occurrences of the old file name, qualified name or path that no language
//! server updates (comments, string literals, plain-text and config files).

use crate::file_moves::FileMove;
use crate::roots::{ProjectRoots, RootKind};
use ide_core::{FileEdit, Pos, Range, TextEdit, WorkspaceEdit};
use parking_lot::Mutex;
use std::path::{Path, PathBuf};

/// Files above this size are not searched.
const MAX_FILE: u64 = 1024 * 1024;
/// Occurrences reported at most.
const MAX_OCCURRENCES: usize = 5000;

const CODE_EXTENSIONS: &[&str] = &[
    "java", "kt", "kts", "scala", "groovy", "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "rs", "py", "go",
    "c", "h", "cc", "cpp", "hpp", "cs", "swift", "rb", "php", "sh", "bash", "zsh", "dart", "lua",
];
const HASH_COMMENT: &[&str] = &["py", "sh", "bash", "zsh", "rb"];
const CLASS_FILES: &[&str] = &["java", "kt", "kts", "scala", "groovy"];

fn rel(root: &Path, path: &Path) -> Option<String> {
    let r = path.strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/");
    (!r.is_empty()).then_some(r)
}

fn ext(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.rsplit_once('.').map_or("", |(_, e)| e)
}

/// `com.acme.Foo` for `src/main/java/com/acme/Foo.java` (or a package folder).
fn qualified_name(roots: &ProjectRoots, rel: &str, is_dir: bool) -> Option<String> {
    let root = roots.root_for(rel)?;
    if !matches!(root.kind, RootKind::Source | RootKind::Test) {
        return None;
    }
    let inner = if root.path.is_empty() { rel } else { rel.strip_prefix(&root.path)?.trim_start_matches('/') };
    let inner = if is_dir {
        inner
    } else {
        if !CLASS_FILES.contains(&ext(inner)) {
            return None;
        }
        inner.rsplit_once('.')?.0
    };
    let fq = inner.replace('/', ".");
    (fq.contains('.') && fq.split('.').all(|s| !s.is_empty() && !s.contains(' '))).then_some(fq)
}

/// Text replacements (old → new) for `moves`, longest first: file name, class
/// name and qualified name (JVM files), and project-relative path.
pub fn move_replacements(root: &Path, roots: &ProjectRoots, moves: &[FileMove]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut push = |old: String, new: String| {
        if old != new && !old.is_empty() && !new.is_empty() && !out.iter().any(|(o, _)| *o == old) {
            out.push((old, new));
        }
    };
    for m in moves {
        let (Some(from), Some(to)) = (rel(root, &m.from), rel(root, &m.to)) else { continue };
        let is_dir = m.from.is_dir() || m.to.is_dir();
        let name = |p: &str| p.rsplit('/').next().unwrap_or(p).to_owned();
        let (old_name, new_name) = (name(&from), name(&to));
        if !is_dir && old_name.contains('.') {
            push(old_name.clone(), new_name.clone());
            if CLASS_FILES.contains(&ext(&old_name))
                && let (Some((a, _)), Some((b, _))) = (old_name.rsplit_once('.'), new_name.rsplit_once('.'))
            {
                push(a.to_owned(), b.to_owned());
            }
        }
        if let (Some(a), Some(b)) = (qualified_name(roots, &from, is_dir), qualified_name(roots, &to, is_dir)) {
            push(a, b);
        }
        if from.contains('/') || to.contains('/') {
            push(from, to);
        }
    }
    out.sort_by_key(|(old, _)| std::cmp::Reverse(old.len()));
    out
}

fn is_ident(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

/// Whether byte offset `at` of `line` is inside a comment or string literal (line-local heuristic).
fn in_comment_or_string(line: &str, at: usize, hash_comments: bool) -> bool {
    let t = line.trim_start();
    if t.starts_with("/*") || t.starts_with('*') {
        return true;
    }
    let mut quote: Option<char> = None;
    let mut escaped = false;
    let mut prev = '\0';
    for (i, c) in line.char_indices() {
        if i >= at {
            return quote.is_some();
        }
        match quote {
            Some(q) => {
                if escaped {
                    escaped = false;
                } else if c == '\\' {
                    escaped = true;
                } else if c == q {
                    quote = None;
                }
            }
            None => {
                if c == '"' || c == '\'' || c == '`' {
                    quote = Some(c);
                } else if (prev == '/' && matches!(c, '/' | '*')) || (hash_comments && c == '#') {
                    return true;
                }
            }
        }
        prev = c;
    }
    quote.is_some()
}

fn utf16_col(line: &str, byte: usize) -> u32 {
    line[..byte].encode_utf16().count() as u32
}

/// Occurrences in one file's text.
fn occurrences_in(text: &str, extension: &str, replacements: &[(String, String)]) -> Vec<TextEdit> {
    let code = CODE_EXTENSIONS.contains(&extension);
    let hash = HASH_COMMENT.contains(&extension);
    let mut edits = Vec::new();
    for (n, line) in text.lines().enumerate() {
        let mut taken: Vec<(usize, usize)> = Vec::new();
        for (old, new) in replacements {
            let mut from = 0;
            while let Some(i) = line[from..].find(old.as_str()) {
                let start = from + i;
                let end = start + old.len();
                from = end;
                let before = line[..start].chars().next_back();
                let after = line[end..].chars().next();
                if before.is_some_and(is_ident) || after.is_some_and(is_ident) {
                    continue;
                }
                if taken.iter().any(|&(a, b)| start < b && a < end) {
                    continue;
                }
                if code && !in_comment_or_string(line, start, hash) {
                    continue;
                }
                taken.push((start, end));
                let line_no = n as u32;
                edits.push(TextEdit {
                    range: Range::new(
                        Pos::new(line_no, utf16_col(line, start)),
                        Pos::new(line_no, utf16_col(line, end)),
                    ),
                    new_text: new.clone(),
                });
            }
        }
    }
    edits.sort_by_key(|e| (e.range.start.line, e.range.start.col));
    edits
}

/// Searches the project (honouring `excludes` and .gitignore) for `replacements`
/// in comments, strings and non-code files. `cancelled` is polled per file.
pub fn find_text_occurrences(
    root: &Path,
    excludes: &[String],
    replacements: &[(String, String)],
    cancelled: &(dyn Fn() -> bool + Sync),
) -> WorkspaceEdit {
    if replacements.is_empty() {
        return WorkspaceEdit::default();
    }
    let found: Mutex<Vec<(PathBuf, Vec<TextEdit>)>> = Mutex::new(Vec::new());
    let count = std::sync::atomic::AtomicUsize::new(0);
    ide_vfs::walk_files(root, excludes, |path| {
        if cancelled() || count.load(std::sync::atomic::Ordering::Relaxed) >= MAX_OCCURRENCES {
            return;
        }
        if std::fs::metadata(path).map_or(true, |m| m.len() > MAX_FILE) {
            return;
        }
        let Ok(bytes) = std::fs::read(path) else { return };
        let Ok(text) = String::from_utf8(bytes) else { return };
        if !replacements.iter().any(|(old, _)| text.contains(old.as_str())) {
            return;
        }
        let name = path.to_string_lossy();
        let edits = occurrences_in(&text, ext(&name), replacements);
        if !edits.is_empty() {
            count.fetch_add(edits.len(), std::sync::atomic::Ordering::Relaxed);
            found.lock().push((path.to_path_buf(), edits));
        }
    });
    let mut files = found.into_inner();
    files.sort_by(|a, b| a.0.cmp(&b.0));
    WorkspaceEdit {
        files: files
            .into_iter()
            .map(|(path, edits)| FileEdit::Edit { path: path.into(), edits, version: None })
            .collect(),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::roots::SourceFolder;
    use std::fs;

    #[test]
    fn replacements_for_jvm_and_web_files() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("src/main/java/com/acme/web")).unwrap();
        let roots = ProjectRoots::compute(
            vec![SourceFolder { path: "src/main/java".into(), kind: RootKind::Source, detected_from: None }],
            &Default::default(),
        );
        let mv = |a: &str, b: &str| FileMove { from: root.join(a).into(), to: root.join(b).into() };
        let r = move_replacements(
            root,
            &roots,
            &[mv("src/main/java/com/acme/Foo.java", "src/main/java/com/acme/web/Foo.java")],
        );
        assert_eq!(
            r,
            vec![
                ("src/main/java/com/acme/Foo.java".into(), "src/main/java/com/acme/web/Foo.java".into()),
                ("com.acme.Foo".into(), "com.acme.web.Foo".into()),
            ]
        );
        let r = move_replacements(root, &roots, &[mv("src/main/java/com/acme/web", "src/main/java/com/acme/api")]);
        assert!(r.contains(&("com.acme.web".into(), "com.acme.api".into())));
        let r = move_replacements(root, &roots, &[mv("ui/a.ts", "ui/b.ts")]);
        assert_eq!(r, vec![("ui/a.ts".into(), "ui/b.ts".into()), ("a.ts".into(), "b.ts".into())]);
    }

    #[test]
    fn only_comments_and_strings_in_code() {
        let reps = vec![("com.acme.Foo".to_owned(), "com.acme.web.Foo".to_owned())];
        let java = "import com.acme.Foo;\n// see com.acme.Foo\nString s = \"com.acme.Foo\"; com.acme.FooBar x;\n";
        let edits = occurrences_in(java, "java", &reps);
        assert_eq!(edits.len(), 2);
        assert_eq!(edits[0].range, Range::new(Pos::new(1, 7), Pos::new(1, 19)));
        assert_eq!(edits[1].range.start, Pos::new(2, 12));
        // Non-code files: every whole-word occurrence.
        let xml = "<bean class=\"com.acme.Foo\"/> com.acme.Foo";
        assert_eq!(occurrences_in(xml, "xml", &reps).len(), 2);
        // UTF-16 columns.
        let md = "é → a.ts";
        let e = occurrences_in(md, "md", &[("a.ts".into(), "b.ts".into())]);
        assert_eq!(e[0].range.start.col, 4);
        assert!(in_comment_or_string("x = 1 # a.py", 8, true));
        assert!(!in_comment_or_string("x = a.py", 4, true));
    }

    #[test]
    fn searches_the_project() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::write(root.join("README.md"), "Run util.ts first.\n").unwrap();
        fs::write(root.join("main.ts"), "import x from './util';\n// util.ts helpers\n").unwrap();
        fs::write(root.join("other.ts"), "const util = 1;\n").unwrap();
        let reps = vec![("util.ts".to_owned(), "helpers.ts".to_owned())];
        let edit = find_text_occurrences(root, &[], &reps, &|| false);
        let paths: Vec<PathBuf> = edit
            .files
            .iter()
            .map(|f| match f {
                FileEdit::Edit { path, .. } => path.to_path_buf(),
                _ => unreachable!(),
            })
            .collect();
        assert_eq!(paths, vec![root.join("README.md"), root.join("main.ts")]);
        assert!(find_text_occurrences(root, &[], &reps, &|| true).files.is_empty());
    }
}
