use crate::Repo;
use crate::cli::run;
use crate::ignore::is_link;
use crate::repo::{gx, tree_of};
use gix::bstr::BStr;
use ide_core::{IdeError, IdeResult};
use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Component, Path, PathBuf};

const INCLUDE: &str = ".worktreeinclude";

impl Repo {
    /// The worktree's include file path and whether it is a regular file on disk.
    pub fn worktree_include(&self) -> IdeResult<(PathBuf, bool)> {
        let path = self.root().join(INCLUDE);
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.is_file() && !is_link(&meta) => Ok((path, true)),
            Ok(_) => Err(IdeError::invalid(".worktreeinclude is not a regular file")),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok((path, false)),
            Err(error) => Err(error.into()),
        }
    }

    /// Copies local files listed in the source worktree's .worktreeinclude after checkout.
    pub fn copy_worktree_config(&self, target: &Path) -> IdeResult<()> {
        if !self.worktree_include()?.1 {
            return Ok(());
        }
        let root = self.root();
        let _scope = self.execution_scope();
        let matches = run(
            root,
            &["ls-files", "-z", "--cached", "--others", "--ignored", "--exclude-from=.worktreeinclude"],
            None,
        )?;
        let repo = self.gix()?;
        let head = tree_of(&repo, "HEAD")?;
        let target = root.join(target);
        let meta = fs::symlink_metadata(&target)?;
        if !meta.is_dir() || is_link(&meta) {
            return Err(IdeError::invalid("worktree location is not a regular directory"));
        }
        let mut failures = Vec::new();
        for raw in matches.stdout.split(|&byte| byte == 0).filter(|path| !path.is_empty()) {
            let rel = gix::path::from_bstr(BStr::new(raw)).map_err(gx)?;
            if rel
                .components()
                .any(|part| !matches!(part, Component::Normal(name) if !name.eq_ignore_ascii_case(".git")))
            {
                continue;
            }
            if let Some(tree) = &head
                && tree.lookup_entry_by_path(&rel).map_err(gx)?.is_some()
            {
                continue;
            }
            if let Err(error) = copy_local_file(root, &target, &rel) {
                failures.push(format!("{}: {error}", rel.display()));
            }
        }
        if failures.is_empty() { Ok(()) } else { Err(IdeError::invalid(failures.join("\n"))) }
    }
}

fn ordinary_directories(root: &Path, relative: &Path, create: bool) -> io::Result<PathBuf> {
    let mut path = root.to_path_buf();
    for part in relative.components() {
        path.push(part);
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.is_dir() && !is_link(&meta) => {}
            Ok(_) => return Err(io::Error::new(ErrorKind::AlreadyExists, "path is not a regular directory")),
            Err(error) if create && error.kind() == ErrorKind::NotFound => fs::create_dir(&path)?,
            Err(error) => return Err(error),
        }
    }
    Ok(path)
}

fn copy_local_file(source: &Path, target: &Path, relative: &Path) -> io::Result<()> {
    let source_file = source.join(relative);
    let meta = match fs::symlink_metadata(&source_file) {
        Ok(meta) if meta.is_file() && !is_link(&meta) => meta,
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let dir = relative.parent().unwrap_or(Path::new(""));
    ordinary_directories(source, dir, false)?;
    let destination = target.join(relative);
    match fs::symlink_metadata(&destination) {
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let mut temporary = tempfile::NamedTempFile::new_in(ordinary_directories(target, dir, true)?)?;
    io::copy(&mut fs::File::open(source_file)?, &mut temporary)?;
    temporary.as_file().set_permissions(meta.permissions())?;
    match temporary.persist_noclobber(destination) {
        Ok(_) => Ok(()),
        Err(error) if error.error.kind() == ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error.error),
    }
}
