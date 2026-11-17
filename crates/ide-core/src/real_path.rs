//! Where a path really lands, and whether it reaches git's own metadata, for writes that must
//! stay inside a project and out of its `.git`.

use std::path::{Path, PathBuf};

/// `joined` after `..`/symlink resolution as far as the file system allows:
/// the canonical path when it exists, else the canonicalized deepest existing
/// ancestor with the still-missing tail resolved textually — so the location
/// of a missing path is still judged where it would really land.
pub fn resolve_real(joined: &Path) -> PathBuf {
    let mut tail = Vec::new();
    let mut candidate = joined.to_path_buf();
    let mut real = loop {
        match dunce::canonicalize(&candidate) {
            Ok(real) => break real,
            Err(_) => {
                let Some(last) = candidate.components().next_back() else {
                    return joined.to_path_buf();
                };
                tail.push(last.as_os_str().to_owned());
                if !candidate.pop() {
                    return joined.to_path_buf();
                }
            }
        }
    };
    for part in tail.iter().rev() {
        if part == ".." {
            real.pop();
        } else if part != "." {
            real.push(part);
        }
    }
    real
}

/// Whether a path (relative to the project root) goes through git's own `.git` folder or file.
/// git runs what it finds in `.git` (hooks, `gpg.program`, filters), so a content write must
/// never reach it. Names are normalized for trailing dots and spaces and NTFS stream suffixes;
/// the caller also checks the short-name-resolved path via [`resolve_real`].
pub fn names_git_dir(rel: &Path) -> bool {
    rel.components().any(|part| {
        let name = part.as_os_str().to_string_lossy();
        let name = name.split(':').next().unwrap_or_default().trim_end_matches(['.', ' ']);
        name.eq_ignore_ascii_case(".git")
    })
}

/// A resolved write destination under `root` that reaches git's own `.git` metadata, judged by
/// the name given and by the name the file system resolves it to.
pub fn reaches_git_dir(root: &Path, real: &Path) -> bool {
    real.strip_prefix(root).is_ok_and(names_git_dir) || resolve_real(real).strip_prefix(root).is_ok_and(names_git_dir)
}
