//! Read selected worktree files using handle-relative, no-follow operations.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_regular_file_and_rejects_escape_or_missing_file() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/a.txt"), b"hello\r\n").unwrap();
        assert_eq!(read_working_bytes(&root, &root.join("src/a.txt")).unwrap(), b"hello\r\n");
        assert!(read_working_bytes(&root, &tmp.path().join("outside")).is_err());
        assert!(read_working_bytes(&root, &root.join("missing")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_leaf_ancestor_and_dangling_symlinks() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(tmp.path().join("secret"), "private").unwrap();
        symlink(tmp.path().join("secret"), root.join("leaf")).unwrap();
        symlink(tmp.path().join("missing"), root.join("dangling")).unwrap();
        symlink(tmp.path(), root.join("parent")).unwrap();
        assert!(read_working_bytes(&root, &root.join("leaf")).is_err());
        assert!(read_working_bytes(&root, &root.join("dangling")).is_err());
        assert!(read_working_bytes(&root, &root.join("parent/secret")).is_err());
    }
}

use ide_core::{IdeError, IdeResult};
use std::io::Read;
use std::path::{Component, Path};

/// Open each component relative to a retained directory handle without following links.
/// The final handle is verified as a regular file before bounded reading.
pub(super) fn read_working_bytes(root: &Path, path: &Path) -> IdeResult<Vec<u8>> {
    const MAX_BYTES: u64 = 16 * 1024 * 1024;
    use cap_primitives::fs::{self, FollowSymlinks, OpenOptions};
    let relative = path.strip_prefix(root).map_err(|_| IdeError::invalid("File is outside the repository"))?;
    let mut components = relative.components().peekable();
    let mut dir = fs::open_ambient_dir(root, cap_primitives::ambient_authority())?;
    while let Some(component) = components.next() {
        let Component::Normal(name) = component else {
            return Err(IdeError::invalid("Invalid repository file path"));
        };
        if components.peek().is_some() {
            dir = fs::open_dir_nofollow(&dir, Path::new(name))?;
            continue;
        }
        let mut options = OpenOptions::new();
        options.read(true)._cap_fs_ext_follow(FollowSymlinks::No)._cap_fs_ext_nonblock(true);
        let file = fs::open(&dir, Path::new(name), &options)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.len() > MAX_BYTES {
            return Err(IdeError::invalid("Selected file is not a regular file or is too large"));
        }
        let mut bytes = Vec::new();
        file.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err(IdeError::invalid("Selected file is too large"));
        }
        return Ok(bytes);
    }
    Err(IdeError::invalid("A repository file is required"))
}
