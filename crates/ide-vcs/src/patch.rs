//! Unified-diff patches: creating them from local changes or commits, previewing
//! and applying them (falling back to a 3-way merge that leaves conflicts for the
//! merge UI), as Create Patch / Apply Patch / Shelve do in IDEA.

use crate::cli::{self, run, run_env};
use crate::repo::gx;
use crate::{ApplyOutcome, ChangeKind, ChangedFile, PatchFile, Repo};
use ide_core::{IdeError, IdeResult};
use std::ffi::OsStr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// A throwaway index file in `.git`, removed on drop.
struct TempIndex(PathBuf);

impl TempIndex {
    fn new(r: &Repo) -> Self {
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        TempIndex(r.git_dir.join(format!("openidea-index-{}-{n}", std::process::id())))
    }
    fn env(&self) -> [(&'static str, &OsStr); 1] {
        [("GIT_INDEX_FILE", self.0.as_os_str())]
    }
}

impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        let _ = std::fs::remove_file(self.0.with_extension("lock"));
    }
}

/// Binary-safe patch of the working-tree changes (staged or not, untracked files
/// included) of `rel_paths` against HEAD, plus the files it touches (renames split
/// into delete + add). The real index is left untouched.
pub(crate) fn working_patch(r: &Repo, rel_paths: &[String], reverse: bool) -> IdeResult<(String, Vec<ChangedFile>)> {
    if rel_paths.is_empty() {
        return Err(IdeError::invalid("no files selected"));
    }
    let tmp = TempIndex::new(r);
    let env = tmp.env();
    if r.has_head()? {
        run_env(r.root(), &["read-tree", "HEAD"], None, &env)?;
    } else {
        run_env(r.root(), &["read-tree", "--empty"], None, &env)?;
    }
    let mut add: Vec<&str> = vec!["--literal-pathspecs", "add", "-A", "--"];
    add.extend(rel_paths.iter().map(String::as_str));
    run_env(r.root(), &add, None, &env)?;
    let mut diff =
        vec!["diff", "--cached", "--binary", "--full-index", "-M", "--no-color", "--no-ext-diff", "--no-textconv"];
    if reverse {
        diff.push("-R");
    }
    let patch = lossless_diff(r, &diff, &env)?;
    let names = run_env(r.root(), &["diff", "--cached", "--name-status", "-z", "--no-renames"], None, &env)?;
    Ok((patch, crate::ops::parse_name_status(&names.stdout_str())))
}

/// The changes of `commits` (oldest first), each against its first parent.
pub(crate) fn commits_patch(r: &Repo, commits: &[String], reverse: bool) -> IdeResult<String> {
    if commits.is_empty() {
        return Err(IdeError::invalid("no commits selected"));
    }
    let mut out = String::new();
    let ordered: Vec<&String> = if reverse { commits.iter().rev().collect() } else { commits.iter().collect() };
    for c in ordered {
        let (parent, id) = {
            let repo = r.gix()?;
            let id = crate::repo::resolve(&repo, c)?;
            let commit = repo.find_object(id).map_err(gx)?.peel_to_commit().map_err(gx)?;
            let parent = commit.parent_ids().next().map(|p| p.detach().to_string());
            (parent.unwrap_or_else(|| EMPTY_TREE.to_string()), id.to_string())
        };
        let mut args = vec!["diff", "--binary", "--full-index", "-M", "--no-color", "--no-ext-diff", "--no-textconv"];
        if reverse {
            args.push("-R");
        }
        args.extend([parent.as_str(), id.as_str(), "--"]);
        out.push_str(&lossless_diff(r, &args, &[])?);
    }
    Ok(out)
}

fn normalized(patch: &str) -> IdeResult<String> {
    if patch.trim().is_empty() {
        return Err(IdeError::invalid("the patch is empty"));
    }
    let mut p = patch.replace("\r\n", "\n");
    if !p.ends_with('\n') {
        p.push('\n');
    }
    Ok(p)
}

/// The files of a patch, whether each applies cleanly to the working tree.
pub(crate) fn preview(r: &Repo, patch: &str) -> IdeResult<Vec<PatchFile>> {
    let patch = normalized(patch)?;
    let mut files = parse_patch(&patch);
    if files.is_empty() {
        return Err(IdeError::invalid("no file changes found in the patch"));
    }
    let out = cli::run_raw(r.root(), &["apply", "--check", "--binary", "-"], Some(patch.as_bytes()))?;
    if out.code != Some(0) {
        let err = String::from_utf8_lossy(&out.stderr).into_owned();
        let failing = failing_paths(&err);
        for f in &mut files {
            let hit = |p: &str| failing.iter().any(|x| x == p);
            f.applies = !(hit(&f.path) || f.old_path.as_deref().is_some_and(hit));
        }
        // An error we could not attribute to a file: nothing applies cleanly.
        if files.iter().all(|f| f.applies) {
            files.iter_mut().for_each(|f| f.applies = false);
        }
    }
    Ok(files)
}

/// Paths named in `git apply` errors (`error: path: …`, `error: patch failed: path:12`).
fn failing_paths(stderr: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in stderr.lines() {
        let Some(rest) = line.strip_prefix("error: ") else { continue };
        if let Some(p) = rest.strip_prefix("patch failed: ") {
            if let Some((path, _line)) = p.rsplit_once(':') {
                out.push(path.to_string());
            }
        } else if let Some((path, _)) = rest.split_once(": ") {
            out.push(path.to_string());
        }
    }
    out
}

/// Applies a patch to the working tree. When it does not apply cleanly, a 3-way
/// merge is attempted; conflicting files are left with conflict markers and index
/// stages for the merge UI and returned in [`ApplyOutcome::conflicts`].
pub(crate) fn apply(r: &Repo, patch: &str) -> IdeResult<ApplyOutcome> {
    let patch = normalized(patch)?;
    let files = parse_patch(&patch);
    let paths: Vec<String> = files.iter().map(|f| f.path.clone()).collect();
    let check = cli::run_raw(r.root(), &["apply", "--check", "--binary", "-"], Some(patch.as_bytes()))?;
    if check.code == Some(0) {
        run(r.root(), &["apply", "--binary", "-"], Some(patch.as_bytes()))?;
        return Ok(ApplyOutcome { applied: paths, conflicts: Vec::new() });
    }
    let out = cli::run_raw(r.root(), &["apply", "--3way", "--binary", "-"], Some(patch.as_bytes()))?;
    let conflicts = unmerged(r)?;
    if out.code != Some(0) && conflicts.is_empty() {
        return Err(cli::failure(&["apply"], &out.stderr, &out.stdout, out.code));
    }
    // `--3way` stages what it applied; keep the index as it was for the clean files.
    let clean: Vec<String> = paths.iter().filter(|p| !conflicts.contains(p)).cloned().collect();
    if !clean.is_empty() && r.has_head()? {
        let mut args = vec!["--literal-pathspecs", "reset", "-q", "--"];
        args.extend(clean.iter().map(String::as_str));
        run(r.root(), &args, None)?;
    }
    Ok(ApplyOutcome { applied: clean, conflicts })
}

fn unmerged(r: &Repo) -> IdeResult<Vec<String>> {
    let out = run(r.root(), &["diff", "--name-only", "--diff-filter=U", "-z"], None)?;
    Ok(out.stdout_str().split('\0').filter(|s| !s.is_empty()).map(str::to_string).collect())
}

fn strip_prefix(p: &str) -> Option<String> {
    let p = p.split('\t').next().unwrap_or(p).trim_end();
    if p == "/dev/null" {
        return None;
    }
    let p = p.strip_prefix("\"").and_then(|q| q.strip_suffix('"')).unwrap_or(p);
    Some(p.strip_prefix("a/").or_else(|| p.strip_prefix("b/")).unwrap_or(p).to_string())
}

/// Files changed by a unified diff (git extended headers or plain `---`/`+++`).
pub(crate) fn parse_patch(patch: &str) -> Vec<PatchFile> {
    let mut out: Vec<PatchFile> = Vec::new();
    let mut cur: Option<PatchFile> = None;
    // From a `diff --git` header and no hunk seen yet: `---` belongs to it.
    let mut fresh_header = false;
    let (mut old_left, mut new_left) = (0u32, 0u32);
    let new_file = |path: String| PatchFile {
        path,
        old_path: None,
        kind: ChangeKind::Modified,
        added: 0,
        removed: 0,
        binary: false,
        applies: true,
    };
    for line in patch.lines() {
        if old_left > 0 || new_left > 0 {
            let Some(c) = cur.as_mut() else { break };
            match line.as_bytes().first() {
                Some(b'+') => {
                    c.added += 1;
                    new_left = new_left.saturating_sub(1);
                }
                Some(b'-') => {
                    c.removed += 1;
                    old_left = old_left.saturating_sub(1);
                }
                Some(b'\\') => {}
                _ => {
                    old_left = old_left.saturating_sub(1);
                    new_left = new_left.saturating_sub(1);
                }
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("diff --git ") {
            out.extend(cur.take());
            let path = rest.rsplit_once(" b/").map(|(_, b)| b.to_string()).unwrap_or_else(|| rest.to_string());
            cur = Some(new_file(path));
            fresh_header = true;
        } else if let Some(rest) = line.strip_prefix("--- ") {
            if !fresh_header {
                out.extend(cur.take());
                cur = Some(new_file(String::new()));
            }
            fresh_header = false;
            if let Some(c) = cur.as_mut() {
                match strip_prefix(rest) {
                    Some(p) if c.path.is_empty() => c.path = p,
                    Some(_) => {}
                    None => c.kind = ChangeKind::Added,
                }
            }
        } else if let Some(c) = cur.as_mut() {
            if let Some(rest) = line.strip_prefix("+++ ") {
                match strip_prefix(rest) {
                    Some(p) => c.path = p,
                    None => c.kind = ChangeKind::Deleted,
                }
            } else if let Some(range) = line.strip_prefix("@@ ") {
                fresh_header = false;
                let count = |spec: &str| -> u32 {
                    let spec = &spec[1..];
                    match spec.split_once(',') {
                        Some((_, n)) => n.parse().unwrap_or(0),
                        None => 1,
                    }
                };
                let mut parts = range.split_whitespace();
                old_left = parts.next().filter(|p| p.starts_with('-')).map(count).unwrap_or(0);
                new_left = parts.next().filter(|p| p.starts_with('+')).map(count).unwrap_or(0);
            } else if line.starts_with("new file mode") {
                c.kind = ChangeKind::Added;
            } else if line.starts_with("deleted file mode") {
                c.kind = ChangeKind::Deleted;
            } else if let Some(p) = line.strip_prefix("rename from ") {
                c.old_path = Some(p.to_string());
                c.kind = ChangeKind::Renamed;
            } else if let Some(p) = line.strip_prefix("rename to ") {
                c.path = p.to_string();
            } else if line.starts_with("GIT binary patch") || line.starts_with("Binary files ") {
                c.binary = true;
            }
        }
    }
    out.extend(cur);
    out.retain(|f| !f.path.is_empty());
    out
}

/// A patch crosses the string IPC boundary. Non-UTF-8 content must travel as a
/// Git binary patch, not replacement characters or an encoding-dependent string.
fn lossless_diff(r: &Repo, args: &[&str], env: &[(&str, &OsStr)]) -> IdeResult<String> {
    let output = run_env(r.root(), args, None, env)?.stdout;
    if let Ok(text) = String::from_utf8(output) {
        return Ok(text);
    }
    // info/attributes has highest precedence. Isolate it from the real repository
    // so concurrent Git operations and user attributes are never modified.
    let temp = tempfile::tempdir()?;
    let git_dir = temp.path().to_string_lossy().into_owned();
    let format = run(r.root(), &["rev-parse", "--show-object-format"], None)?.stdout_str();
    run(r.root(), &["init", "--bare", "--quiet", &format!("--object-format={}", format.trim()), &git_dir], None)?;
    std::fs::write(temp.path().join("info/attributes"), "* -diff\n")?;
    if let Some(head) = r.head()?.1 {
        std::fs::write(temp.path().join("HEAD"), format!("{head}\n"))?;
    }
    let objects = run(r.root(), &["rev-parse", "--path-format=absolute", "--git-path", "objects"], None)?.stdout_str();
    let mut isolated = env.to_vec();
    isolated.extend([
        ("GIT_DIR", temp.path().as_os_str()),
        ("GIT_WORK_TREE", r.root().as_os_str()),
        ("GIT_OBJECT_DIRECTORY", OsStr::new(objects.trim())),
    ]);
    String::from_utf8(run_env(r.root(), args, None, &isolated)?.stdout)
        .map_err(|_| IdeError::invalid("Git produced a non-UTF-8 binary patch"))
}

/// Encode only hunk payloads; patch headers and Git paths always remain UTF-8.
pub(crate) fn encode_text_patch(
    r: &Repo,
    patch: &str,
    encoding: &dyn Fn(&std::path::Path) -> IdeResult<&'static encoding_rs::Encoding>,
) -> IdeResult<Vec<u8>> {
    let mut out = Vec::new();
    let mut header = String::new();
    let mut enc = None;
    for line in patch.split_inclusive('\n') {
        if line.starts_with("diff --git ") {
            header.clear();
            enc = None;
        }
        if line.starts_with("@@ ") {
            let file = parse_patch(&header)
                .into_iter()
                .next()
                .ok_or_else(|| IdeError::invalid("patch hunk has no file header"))?;
            enc = Some(encoding(&r.abs_path(&file.path))?);
        } else if let Some(enc) = enc {
            if line.starts_with(['+', '-', ' ']) {
                out.push(line.as_bytes()[0]);
                out.extend(crate::text_encoding::encode(&line[1..], enc, false)?);
                continue;
            }
        } else {
            header.push_str(line);
        }
        out.extend_from_slice(line.as_bytes());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_git_and_plain_patches() {
        let patch = "diff --git a/src/a.rs b/src/a.rs\nindex 1..2 100644\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1,2 +1,2 @@\n-old\n+new\n ctx\n\
diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+hi\n\
diff --git a/x b/y\nsimilarity index 90%\nrename from x\nrename to y\n\
diff --git a/gone b/gone\ndeleted file mode 100644\n--- a/gone\n+++ /dev/null\n@@ -1 +0,0 @@\n--- dashes\n";
        let files = parse_patch(patch);
        let got: Vec<(&str, ChangeKind, u32, u32)> =
            files.iter().map(|f| (f.path.as_str(), f.kind, f.added, f.removed)).collect();
        assert_eq!(
            got,
            vec![
                ("src/a.rs", ChangeKind::Modified, 1, 1),
                ("n.txt", ChangeKind::Added, 1, 0),
                ("y", ChangeKind::Renamed, 0, 0),
                ("gone", ChangeKind::Deleted, 0, 1),
            ]
        );
        assert_eq!(files[2].old_path.as_deref(), Some("x"));

        let plain = "--- a/one.txt\t2024-01-01\n+++ b/one.txt\t2024-01-02\n@@ -1 +1 @@\n-a\n+b\n--- a/two.txt\n+++ b/two.txt\n@@ -1 +1,2 @@\n a\n+c\n";
        let files = parse_patch(plain);
        assert_eq!(files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["one.txt", "two.txt"]);
        assert_eq!((files[1].added, files[1].removed), (1, 0));
    }

    #[test]
    fn failing_paths_from_git_apply() {
        let err = "error: patch failed: src/a.rs:3\nerror: src/a.rs: patch does not apply\nerror: n.txt: already exists in working directory\n";
        assert_eq!(failing_paths(err), vec!["src/a.rs", "src/a.rs", "n.txt"]);
    }
}
