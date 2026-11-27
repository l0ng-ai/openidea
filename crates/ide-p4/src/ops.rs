//! What a user does to files of a workspace: open, revert, move, sync,
//! reconcile, integrate, lock, resolve and submit.

use crate::cli::{Output, args, escape, unescape};
use crate::workspace::{Workspace, decode};
use ide_core::{IdeError, IdeResult, IpcPath, error::ErrorKind};
use ide_vcs::TextEncoding;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};

/// A file a command acted on (`sync`, `reconcile`, `integrate`, `edit`…).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AffectedFile {
    pub path: Option<IpcPath>,
    pub depot_file: String,
    /// `added`, `updated`, `deleted`, `refreshed` for a sync; the open action otherwise.
    pub action: String,
    pub rev: Option<u32>,
}

/// The outcome of a command over many files: what it did and what the server said.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult {
    pub files: Vec<AffectedFile>,
    /// Notes and warnings: "file(s) up-to-date", "must resolve before submitting"…
    pub messages: Vec<String>,
}

/// A file waiting for `p4 resolve`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UnresolvedFile {
    pub path: IpcPath,
    pub rel_path: String,
    /// `content`, `filetype`, `move`, `delete`, `branch`…
    pub resolve_type: String,
    /// The depot file the other side comes from and its revision.
    pub from_file: String,
    pub from_rev: Option<u32>,
    pub base_file: Option<String>,
    pub base_rev: Option<u32>,
}

/// The three texts of a content resolve.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ResolveSides {
    pub base: String,
    /// The depot's side.
    pub theirs: String,
    /// The workspace file.
    pub yours: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ResolveMode {
    /// `-am`: merge, leaving files with conflicts unresolved.
    Merge,
    /// `-as`: accept whichever side changed; skip files both changed.
    Safe,
    /// `-af`: merge and accept the result even with conflict markers.
    ForceMerge,
    /// `-ay`: keep the workspace file.
    Yours,
    /// `-at`: take the depot's file.
    Theirs,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum IntegrateKind {
    /// `p4 integrate`: branch or propagate between two paths.
    Integrate,
    /// `p4 merge`: bring the source's changes in for resolving.
    Merge,
    /// `p4 copy`: make the target identical to the source.
    Copy,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LoginStatus {
    pub logged_in: bool,
    pub user: String,
    /// Seconds until the ticket expires, when the server says.
    pub expires_in: Option<u32>,
}

impl Workspace {
    fn result(&self, out: Output) -> OperationResult {
        let files = out
            .records
            .iter()
            .filter(|r| r.has("depotFile"))
            .map(|r| {
                let local = r.get("path").or(r.get("clientFile")).filter(|p| !p.starts_with("//"));
                AffectedFile {
                    path: local.map(|p| PathBuf::from(unescape(p)).into()),
                    depot_file: unescape(r.get("depotFile").unwrap_or_default()),
                    action: r.text("action"),
                    rev: r.num("rev").or(r.num("workRev")).or(r.num("haveRev")),
                }
            })
            .collect();
        OperationResult { files, messages: out.messages }
    }

    fn change_flag(change: Option<u32>) -> Vec<String> {
        match change {
            Some(number) if number > 0 => args(["-c", &number.to_string()]),
            _ => Vec::new(),
        }
    }

    fn run_on(&self, command: &str, flags: Vec<String>, files: &[String]) -> IdeResult<OperationResult> {
        let mut head = vec![command.to_owned()];
        head.extend(flags);
        let head: Vec<&str> = head.iter().map(String::as_str).collect();
        let out = self.each_batch(&head, files)?;
        self.invalidate();
        Ok(self.result(out))
    }

    /// Opens `paths` in `change` (`None` = default): files of the depot for
    /// edit, the others for add. Files already opened stay as they are.
    pub fn open_for_edit(&self, paths: &[PathBuf], change: Option<u32>) -> IdeResult<OperationResult> {
        self.require_inside(paths)?;
        let scope = self.file_args(paths);
        if scope.is_empty() {
            return Ok(OperationResult::default());
        }
        let opened: Vec<PathBuf> = self.opened(&scope)?.into_iter().map(|f| f.path.0).collect();
        let mut result = self.run_on("edit", Self::change_flag(change), &scope)?;
        let edited: Vec<PathBuf> = result.files.iter().filter_map(|f| f.path.clone()).map(|p| p.0).collect();
        let new: Vec<PathBuf> =
            local_files(paths).into_iter().filter(|p| !opened.contains(p) && !edited.contains(p)).collect();
        result.messages.retain(|m| !crate::cli::is_absent(m));
        if !new.is_empty() {
            let added = self.add(&new, change)?;
            result.files.extend(added.files);
            result.messages.extend(added.messages);
        }
        Ok(result)
    }

    /// Opens files (and the files below folders) for add.
    pub fn add(&self, paths: &[PathBuf], change: Option<u32>) -> IdeResult<OperationResult> {
        self.require_inside(paths)?;
        // `-f` takes names as they are on disk, `@` and `#` included.
        let files: Vec<String> = local_files(paths).iter().map(|p| p.to_string_lossy().into_owned()).collect();
        let mut flags = args(["-f"]);
        flags.extend(Self::change_flag(change));
        self.run_on("add", flags, &files)
    }

    /// Opens files for delete and removes them from the workspace.
    pub fn delete(&self, paths: &[PathBuf], change: Option<u32>) -> IdeResult<OperationResult> {
        self.require_inside(paths)?;
        self.run_on("delete", Self::change_flag(change), &self.file_args(paths))
    }

    /// `p4 revert`; with `keep`, the workspace files are left as they are (`-k`).
    pub fn revert(&self, paths: &[PathBuf], keep: bool) -> IdeResult<()> {
        let scope = self.file_args(paths);
        if scope.is_empty() {
            return Ok(());
        }
        self.run_on("revert", if keep { args(["-k"]) } else { Vec::new() }, &scope).map(|_| ())
    }

    /// Reverts opened files whose content and type did not change (`p4 revert -a`),
    /// in one changelist or the whole workspace.
    pub fn revert_unchanged(&self, change: Option<u32>) -> IdeResult<OperationResult> {
        let mut flags = args(["-a"]);
        if let Some(number) = change {
            flags.extend(args(["-c", &if number == 0 { "default".to_owned() } else { number.to_string() }]));
        }
        self.run_on("revert", flags, &[self.everything()])
    }

    /// Records files or folders that are already gone from disk as deleted.
    pub(crate) fn deleted_on_disk(&self, paths: &[PathBuf]) -> IdeResult<()> {
        let scope: Vec<String> = paths
            .iter()
            .filter(|p| p.starts_with(self.root()))
            .flat_map(|p| [escape(p), format!("{}/...", escape(p))])
            .collect();
        if scope.is_empty() {
            return Ok(());
        }
        // Whatever was opened there is dropped first: an added file simply stops existing.
        self.run_on("revert", args(["-k"]), &scope)?;
        self.run_on("delete", args(["-k"]), &scope).map(|_| ())
    }

    /// Records a move that already happened on disk, so history follows the file.
    pub(crate) fn moved_on_disk(&self, from: &Path, to: &Path) -> IdeResult<()> {
        if !from.starts_with(self.root()) || !to.starts_with(self.root()) {
            return Ok(());
        }
        let folder = to.is_dir();
        let arg = |p: &Path| if folder { format!("{}/...", escape(p)) } else { escape(p) };
        let (source, target) = (arg(from), arg(to));
        self.run_on("edit", args(["-k"]), std::slice::from_ref(&source))?;
        let moved = self.tagged(&args(["move", "-k", &source, &target]))?;
        self.invalidate();
        if moved.records.is_empty() {
            // Nothing of the depot was there: the files at the new place are simply new.
            tracing::debug!("p4 move {source} {target}: {:?}", moved.messages);
        }
        Ok(())
    }

    /// `p4 sync` of `paths` (empty = the workspace) to `rev` (`None` = head).
    pub fn sync(&self, paths: &[PathBuf], rev: Option<&str>, force: bool, preview: bool) -> IdeResult<OperationResult> {
        let suffix = rev.filter(|r| !r.trim().is_empty()).map(|r| crate::workspace::revision_suffix(Some(r)));
        let mut scope = if paths.is_empty() { vec![self.everything()] } else { self.file_args(paths) };
        if let Some(suffix) = suffix {
            scope.iter_mut().for_each(|file| file.push_str(&suffix));
        }
        let mut flags = Vec::new();
        if force {
            flags.push("-f".to_owned());
        }
        if preview {
            flags.push("-n".to_owned());
        }
        self.run_on("sync", flags, &scope)
    }

    /// Finds work done without Perforce (`p4 reconcile`): files edited, added
    /// or deleted outside the IDE. With `preview` nothing is opened.
    pub fn reconcile(&self, paths: &[PathBuf], change: Option<u32>, preview: bool) -> IdeResult<OperationResult> {
        let scope = if paths.is_empty() { vec![self.everything()] } else { self.file_args(paths) };
        let mut flags = Self::change_flag(change);
        if preview {
            flags.push("-n".to_owned());
        }
        self.run_on("reconcile", flags, &scope)
    }

    /// Integrates `source` into `target` (file arguments in depot or local
    /// syntax). On a stream client both may be empty: the stream's parent is the source.
    pub fn integrate(
        &self,
        kind: IntegrateKind,
        source: &str,
        target: &str,
        change: Option<u32>,
        preview: bool,
    ) -> IdeResult<OperationResult> {
        let command = match kind {
            IntegrateKind::Integrate => "integrate",
            IntegrateKind::Merge => "merge",
            IntegrateKind::Copy => "copy",
        };
        let mut argv = vec![command.to_owned()];
        argv.extend(Self::change_flag(change));
        if preview {
            argv.push("-n".to_owned());
        }
        match (source.trim(), target.trim()) {
            ("", "") if kind != IntegrateKind::Integrate => {}
            ("", _) | (_, "") => return Err(IdeError::invalid("integrate needs a source and a target")),
            (source, target) => argv.extend(args([source, target])),
        }
        let out = self.tagged(&argv)?;
        self.invalidate();
        Ok(self.result(out))
    }

    pub fn lock(&self, paths: &[PathBuf], locked: bool) -> IdeResult<OperationResult> {
        self.run_on(if locked { "lock" } else { "unlock" }, Vec::new(), &self.file_args(paths))
    }

    /// Files with a pending resolve, below `paths` (empty = the workspace).
    pub fn unresolved(&self, paths: &[PathBuf]) -> IdeResult<Vec<UnresolvedFile>> {
        let scope = if paths.is_empty() { vec![self.everything()] } else { self.file_args(paths) };
        let out = match self.each_batch(&["fstat", "-Ru", "-Or", "-Op"], &scope) {
            Ok(out) => out,
            Err(e) if e.kind == ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        let mut files = Vec::new();
        for r in &out.records {
            let Some(local) = r.get("path") else { continue };
            let path = PathBuf::from(local);
            files.push(UnresolvedFile {
                rel_path: self.rel(&path),
                path: path.into(),
                resolve_type: r.get("resolveType0").or(r.get("resolveAction0")).unwrap_or("content").to_owned(),
                from_file: unescape(r.get("resolveFromFile0").unwrap_or_default()),
                from_rev: r.num("resolveEndFromRev0"),
                base_file: r.get("resolveBaseFile0").map(unescape),
                base_rev: r.num("resolveBaseRev0"),
            });
        }
        Ok(files)
    }

    /// The base, depot and workspace texts of a file's pending content resolve.
    pub fn resolve_sides(&self, path: &Path, encoding: TextEncoding) -> IdeResult<ResolveSides> {
        let Some(file) = self.unresolved(&[path.to_path_buf()])?.into_iter().next() else {
            return Err(IdeError::not_found(format!("{} has nothing to resolve", path.display())));
        };
        let side = |depot: &str, rev: Option<u32>| -> IdeResult<String> {
            let Some(rev) = rev else { return Ok(String::new()) };
            let bytes = self.print(&format!("{}#{rev}", escape(Path::new(depot))))?;
            Ok(bytes.map(|b| decode(&b, encoding)).unwrap_or_default())
        };
        Ok(ResolveSides {
            base: match &file.base_file {
                Some(base) => side(base, file.base_rev)?,
                None => String::new(),
            },
            theirs: side(&file.from_file, file.from_rev)?,
            yours: decode(&std::fs::read(path)?, encoding),
        })
    }

    /// Resolves `paths` (empty = everything unresolved) automatically.
    pub fn resolve(&self, paths: &[PathBuf], mode: ResolveMode) -> IdeResult<OperationResult> {
        let flag = match mode {
            ResolveMode::Merge => "-am",
            ResolveMode::Safe => "-as",
            ResolveMode::ForceMerge => "-af",
            ResolveMode::Yours => "-ay",
            ResolveMode::Theirs => "-at",
        };
        let scope = if paths.is_empty() { vec![self.everything()] } else { self.file_args(paths) };
        self.run_on("resolve", args([flag]), &scope)
    }

    /// Finishes a resolve with text merged in the IDE: writes it and accepts the workspace file.
    pub fn resolve_with(&self, path: &Path, merged: &[u8]) -> IdeResult<()> {
        self.require_inside(&[path.to_path_buf()])?;
        std::fs::write(path, merged)?;
        self.resolve(&[path.to_path_buf()], ResolveMode::Yours).map(|_| ())
    }

    /// Submits a pending changelist (0 = the default one, which needs a
    /// description); returns the number it was submitted as.
    pub fn submit_change(&self, change: u32, description: Option<&str>) -> IdeResult<u32> {
        let argv = match (change, description) {
            (0, Some(text)) if !text.trim().is_empty() => args(["submit", "-d", text]),
            (0, _) => return Err(IdeError::invalid("a changelist needs a description to be submitted")),
            (number, description) => {
                if let Some(text) = description {
                    self.update_changelist(number, text)?;
                }
                args(["submit", "-c", &number.to_string()])
            }
        };
        let out = self.tagged(&argv);
        self.invalidate();
        let out = out?;
        out.records
            .iter()
            .find_map(|r| r.num("submittedChange"))
            .ok_or_else(|| IdeError::internal(format!("p4 submit reported no change: {}", out.messages.join("; "))))
    }

    /// Submits exactly `paths` with `description`. They are gathered in a new
    /// changelist unless they already are all of one; when the submit fails,
    /// they return to where they were.
    pub fn submit_files(&self, paths: &[PathBuf], description: &str) -> IdeResult<u32> {
        if description.trim().is_empty() {
            return Err(IdeError::invalid("a changelist needs a description to be submitted"));
        }
        let all = self.opened(&[])?;
        let mut chosen: Vec<&crate::OpenedFile> = all.iter().filter(|f| paths.contains(&f.path.0)).collect();
        // The two halves of a move can only be submitted together.
        let partners: Vec<&crate::OpenedFile> = all
            .iter()
            .filter(|f| !chosen.iter().any(|c| c.path == f.path))
            .filter(|f| {
                chosen.iter().any(|c| {
                    c.moved_from.as_deref() == Some(f.rel_path.as_str())
                        || f.moved_from.as_deref() == Some(c.rel_path.as_str())
                })
            })
            .collect();
        chosen.extend(partners);
        let Some(first) = chosen.first() else { return Err(IdeError::invalid("no opened files to submit")) };
        let home = first.change;
        let whole = home != 0
            && chosen.iter().all(|f| f.change == home)
            && all.iter().filter(|f| f.change == home).count() == chosen.len();
        if whole {
            return self.submit_change(home, Some(description));
        }
        let origin: Vec<(PathBuf, u32)> = chosen.iter().map(|f| (f.path.0.clone(), f.change)).collect();
        let files: Vec<PathBuf> = origin.iter().map(|(p, _)| p.clone()).collect();
        let change = self.create_changelist(description, &files)?;
        match self.submit_change(change, None) {
            Ok(submitted) => Ok(submitted),
            Err(error) => {
                for target in origin.iter().map(|(_, c)| *c).collect::<std::collections::BTreeSet<u32>>() {
                    let back: Vec<PathBuf> =
                        origin.iter().filter(|(_, c)| *c == target).map(|(p, _)| p.clone()).collect();
                    if let Err(e) = self.reopen(&back, target) {
                        tracing::warn!("p4 reopen after a failed submit: {e}");
                    }
                }
                if let Err(e) = self.delete_changelist(change) {
                    tracing::warn!("p4 change -d {change} after a failed submit: {e}");
                }
                Err(error)
            }
        }
    }

    /// `p4 login -s`: whether the user holds a valid ticket.
    pub fn login_status(&self) -> IdeResult<LoginStatus> {
        let user = self.connection().user.clone();
        match self.tagged(&args(["login", "-s"])) {
            Ok(out) => Ok(LoginStatus {
                logged_in: true,
                user,
                expires_in: out.records.first().and_then(|r| r.num("TicketExpiration")),
            }),
            Err(e) if e.kind == ErrorKind::Unavailable && crate::cli::is_login_required(&e) => {
                Ok(LoginStatus { logged_in: false, user, expires_in: None })
            }
            Err(e) => Err(e),
        }
    }

    /// `p4 login`, the password given on stdin; the ticket lands in the user's ticket file.
    pub fn login(&self, password: &str) -> IdeResult<LoginStatus> {
        self.raw_with(&args(["login"]), format!("{password}\n").as_bytes())?;
        self.login_status()
    }

    pub fn logout(&self) -> IdeResult<()> {
        self.raw(&args(["logout"])).map(|_| ())
    }
}

/// The files of `paths`: each file, and every file below each folder (links are not followed).
fn local_files(paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut stack: Vec<PathBuf> = paths.to_vec();
    while let Some(path) = stack.pop() {
        let Ok(meta) = path.symlink_metadata() else { continue };
        if meta.is_dir() {
            stack.extend(std::fs::read_dir(&path).into_iter().flatten().flatten().map(|e| e.path()));
        } else {
            files.push(path);
        }
    }
    files.sort();
    files
}
