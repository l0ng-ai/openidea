//! A Perforce client workspace on disk and the reads every feature shares:
//! opened files, depot ↔ local paths, file content at a revision.

use crate::cli::{self, Invocation, Output, args, escape, unescape};
use ide_core::{IdeError, IdeResult, IpcPath};
use ide_vcs::{ChangeKind, FileStatus, TextEncoding};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// How long the synced text of a file is trusted before its have revision is checked again.
const BASE_TTL: Duration = Duration::from_secs(5);
/// Files given to one command; more are sent in batches to stay below argument limits.
pub(crate) const BATCH: usize = 200;

/// The server, user and client of a workspace (`p4 info`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub server_address: String,
    pub server_version: String,
    pub user: String,
    pub client: String,
    pub client_root: IpcPath,
    /// The stream of a stream client (`//stream/main`).
    pub stream: Option<String>,
    pub case_sensitive: bool,
}

/// A file opened in the workspace (`p4 opened`, with its resolve state).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenedFile {
    pub path: IpcPath,
    pub rel_path: String,
    pub depot_file: String,
    /// `edit`, `add`, `delete`, `branch`, `integrate`, `move/add`, `move/delete`, `import`, `archive`.
    pub action: String,
    /// The pending changelist holding it; 0 is the default changelist.
    pub change: u32,
    pub file_type: String,
    pub have_rev: Option<u32>,
    pub head_rev: Option<u32>,
    /// A newer revision or an integration waits to be resolved.
    pub unresolved: bool,
    /// Workspace-relative path the file was moved from (`move/add`).
    pub moved_from: Option<String>,
    pub locked: bool,
    /// Others who have it opened, as `user@client`.
    pub other_open: Vec<String>,
}

impl OpenedFile {
    pub fn kind(&self) -> ChangeKind {
        if self.unresolved {
            return ChangeKind::Conflicted;
        }
        match self.action.as_str() {
            "add" | "branch" | "import" => ChangeKind::Added,
            "delete" | "move/delete" => ChangeKind::Deleted,
            "move/add" => ChangeKind::Renamed,
            _ => ChangeKind::Modified,
        }
    }
}

struct Base {
    have: Option<u32>,
    text: Option<Arc<String>>,
    checked: Instant,
}

/// A client workspace. Every command runs in its root, so `P4CONFIG`, tickets
/// and `p4 set` values apply as they do in a terminal there.
pub struct Workspace {
    root: PathBuf,
    connection: Connection,
    run: Invocation,
    bases: Mutex<HashMap<PathBuf, Base>>,
}

impl Workspace {
    /// The workspace `path` lies in, when `p4 info` there names a client whose
    /// root contains it. `Ok(None)` without `p4`, without a client, or outside its root.
    pub fn discover(path: &Path) -> IdeResult<Option<Self>> {
        let Ok(exe) = cli::executable() else { return Ok(None) };
        let start = if path.is_file() { path.parent().unwrap_or(path) } else { path };
        let start = dunce::canonicalize(start).unwrap_or_else(|_| start.to_path_buf());
        let probe = Invocation { exe: exe.clone(), cwd: start.clone(), globals: Vec::new() };
        let info = probe.tagged(&args(["info"]), None)?;
        let Some(info) = info.records.into_iter().next() else { return Ok(None) };
        let client = info.text("clientName");
        let root = info.text("clientRoot");
        if client.is_empty() || client == "*unknown*" || root.is_empty() || root == "null" {
            return Ok(None);
        }
        let root = PathBuf::from(root);
        let root = dunce::canonicalize(&root).unwrap_or(root);
        if !start.starts_with(&root) {
            return Ok(None);
        }
        let user = info.text("userName");
        let connection = Connection {
            server_address: info.text("serverAddress"),
            server_version: info.text("serverVersion"),
            user: user.clone(),
            client: client.clone(),
            client_root: root.clone().into(),
            stream: info.get("clientStream").map(str::to_owned),
            case_sensitive: info.get("caseHandling") != Some("insensitive"),
        };
        // The folder the client was found from keeps supplying the server address and charset.
        let run = Invocation { exe, cwd: start, globals: args(["-u", &user, "-c", &client]) };
        Ok(Some(Self { root, connection, run, bases: Mutex::default() }))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn connection(&self) -> &Connection {
        &self.connection
    }

    pub(crate) fn tagged(&self, args: &[String]) -> IdeResult<Output> {
        self.run.tagged(args, None)
    }

    pub(crate) fn raw(&self, args: &[String]) -> IdeResult<Vec<u8>> {
        self.run.raw(args, None)
    }

    pub(crate) fn raw_with(&self, args: &[String], stdin: &[u8]) -> IdeResult<Vec<u8>> {
        self.run.raw(args, Some(stdin))
    }

    /// `command flags… files…`, run once per batch of files; the outputs joined.
    pub(crate) fn each_batch(&self, head: &[&str], files: &[String]) -> IdeResult<Output> {
        let mut all = Output::default();
        for chunk in files.chunks(BATCH) {
            let mut argv = args(head.iter().copied());
            argv.extend(chunk.iter().cloned());
            let out = self.tagged(&argv)?;
            all.records.extend(out.records);
            all.messages.extend(out.messages);
        }
        Ok(all)
    }

    /// The whole workspace as a file argument.
    pub(crate) fn everything(&self) -> String {
        format!("{}/...", escape(&self.root))
    }

    /// `path` as a file argument; a folder stands for everything below it.
    pub(crate) fn file_arg(&self, path: &Path) -> String {
        if path.is_dir() { format!("{}/...", escape(path)) } else { escape(path) }
    }

    pub(crate) fn file_args(&self, paths: &[PathBuf]) -> Vec<String> {
        paths.iter().filter(|p| p.starts_with(&self.root)).map(|p| self.file_arg(p)).collect()
    }

    pub fn rel(&self, path: &Path) -> String {
        path.strip_prefix(&self.root).unwrap_or(path).to_string_lossy().replace('\\', "/")
    }

    pub(crate) fn abs(&self, rel: &str) -> PathBuf {
        let path = Path::new(rel);
        if path.is_absolute() { path.to_path_buf() } else { self.root.join(path) }
    }

    /// Forgets cached base texts: the have revisions may have moved.
    pub(crate) fn invalidate(&self) {
        self.bases.lock().clear();
    }

    /// Files opened in this workspace below `scope` (file arguments; empty = all of it).
    pub fn opened(&self, scope: &[String]) -> IdeResult<Vec<OpenedFile>> {
        let everything = [self.everything()];
        let scope = if scope.is_empty() { &everything[..] } else { scope };
        let out = match self.each_batch(&["fstat", "-Ro", "-Or", "-Op"], scope) {
            Ok(out) => out,
            Err(e) if e.kind == ide_core::error::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        let mut files: Vec<(OpenedFile, Option<String>)> = Vec::new();
        for r in &out.records {
            let (Some(local), Some(action)) = (r.get("path"), r.get("action")) else { continue };
            let path = PathBuf::from(local);
            let opened = OpenedFile {
                rel_path: self.rel(&path),
                path: path.into(),
                depot_file: unescape(r.get("depotFile").unwrap_or_default()),
                action: action.to_owned(),
                change: r.num("change").unwrap_or(0),
                file_type: r.get("type").or(r.get("headType")).unwrap_or_default().to_owned(),
                have_rev: r.num("haveRev"),
                head_rev: r.num("headRev"),
                unresolved: r.has("unresolved"),
                moved_from: None,
                locked: r.has("ourLock"),
                other_open: r.list("otherOpen"),
            };
            files.push((opened, r.get("movedFile").map(unescape)));
        }
        let by_depot: HashMap<String, String> =
            files.iter().map(|(f, _)| (f.depot_file.clone(), f.rel_path.clone())).collect();
        let mut files: Vec<OpenedFile> = files
            .into_iter()
            .map(|(mut f, moved)| {
                if f.action == "move/add" {
                    f.moved_from = moved.and_then(|depot| by_depot.get(&depot).cloned());
                }
                f
            })
            .collect();
        files.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
        Ok(files)
    }

    /// Opened files as the Changes view shows them. The source of a move is
    /// part of its `Renamed` entry, as Git reports a rename.
    pub(crate) fn status_of(&self, scope: &[String]) -> IdeResult<Vec<FileStatus>> {
        let opened = self.opened(scope)?;
        let moved: Vec<&str> = opened.iter().filter_map(|f| f.moved_from.as_deref()).collect();
        Ok(opened
            .iter()
            .filter(|f| !(f.action == "move/delete" && moved.contains(&f.rel_path.as_str())))
            .map(|f| FileStatus {
                path: f.path.clone(),
                rel_path: f.rel_path.clone(),
                staged: None,
                unstaged: Some(f.kind()),
                renamed_from: f.moved_from.clone(),
            })
            .collect())
    }

    /// Local paths of depot files, in one `p4 where`. Files outside the client view are left out.
    pub fn local_paths(&self, depot_files: &[String]) -> IdeResult<HashMap<String, PathBuf>> {
        let mut map = HashMap::new();
        let escaped: Vec<String> = depot_files.iter().map(|d| escape(Path::new(d))).collect();
        let out = match self.each_batch(&["where"], &escaped) {
            Ok(out) => out,
            Err(e) if e.kind == ide_core::error::ErrorKind::NotFound => return Ok(map),
            Err(e) => return Err(e),
        };
        for r in out.records.iter().filter(|r| !r.has("unmap")) {
            if let (Some(depot), Some(path)) = (r.get("depotFile"), r.get("path")) {
                map.insert(unescape(depot), PathBuf::from(unescape(path)));
            }
        }
        Ok(map)
    }

    /// A revision of `path` as a file argument. `rev` is `None`, `HEAD` or `:0`
    /// for the synced revision; a change number (`120`, or `120^` for the state
    /// before it); `shelved:120`; or Perforce's own `#n`, `#head`, `@label`.
    pub fn revision_arg(&self, path: &Path, rev: Option<&str>) -> String {
        format!("{}{}", escape(path), revision_suffix(rev))
    }

    /// The bytes of a file argument; `None` when no such revision exists (or it is a deletion).
    pub(crate) fn print(&self, file_arg: &str) -> IdeResult<Option<Vec<u8>>> {
        let out = self.tagged(&args(["fstat", "-T", "depotFile,headAction,headRev", file_arg]));
        let record = match out {
            Ok(out) => out.records.into_iter().next(),
            Err(e) if e.kind == ide_core::error::ErrorKind::NotFound => None,
            Err(e) => return Err(e),
        };
        // A shelved file has no head action of its own; `print` decides for it.
        let shelved = file_arg.contains("@=");
        match record {
            None if !shelved => return Ok(None),
            Some(r) if matches!(r.get("headAction"), Some("delete" | "move/delete")) && !shelved => return Ok(None),
            _ => {}
        }
        match self.raw(&args(["print", "-q", file_arg])) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind == ide_core::error::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// The bytes of `path` at `rev` (see [`revision_arg`](Self::revision_arg)); `None` when absent there.
    pub fn file_bytes_at(&self, path: &Path, rev: Option<&str>) -> IdeResult<Option<Vec<u8>>> {
        self.print(&self.revision_arg(path, rev))
    }

    pub(crate) fn text_at(&self, path: &Path, rev: Option<&str>, encoding: TextEncoding) -> IdeResult<Option<String>> {
        if rev == Some("WT") {
            return Ok(std::fs::read(path).ok().map(|b| decode(&b, encoding)));
        }
        Ok(self.print(&self.revision_arg(path, rev))?.map(|b| decode(&b, encoding)))
    }

    /// The synced text of `path` (what its working copy is compared with),
    /// cached while the have revision stays the same.
    pub(crate) fn base_text(&self, path: &Path, encoding: TextEncoding) -> IdeResult<Option<Arc<String>>> {
        if let Some(base) = self.bases.lock().get(path)
            && base.checked.elapsed() < BASE_TTL
        {
            return Ok(base.text.clone());
        }
        let have = match self.tagged(&args(["fstat", "-T", "depotFile,haveRev", &escape(path)])) {
            Ok(out) => out.records.first().and_then(|r| r.num("haveRev")),
            Err(e) if e.kind == ide_core::error::ErrorKind::NotFound => None,
            Err(e) => return Err(e),
        };
        let mut bases = self.bases.lock();
        if let Some(base) = bases.get_mut(path)
            && base.have == have
        {
            base.checked = Instant::now();
            return Ok(base.text.clone());
        }
        drop(bases);
        let text = match have {
            Some(rev) => self
                .raw(&args(["print", "-q", &format!("{}#{rev}", escape(path))]))
                .ok()
                .map(|b| Arc::new(decode(&b, encoding))),
            None => None,
        };
        self.bases.lock().insert(path.to_path_buf(), Base { have, text: text.clone(), checked: Instant::now() });
        Ok(text)
    }

    /// Fails with the paths that are not in this workspace.
    pub(crate) fn require_inside(&self, paths: &[PathBuf]) -> IdeResult<()> {
        match paths.iter().find(|p| !p.starts_with(&self.root)) {
            Some(outside) => Err(IdeError::invalid(format!(
                "{} is outside the Perforce workspace {}",
                outside.display(),
                self.connection.client
            ))),
            None => Ok(()),
        }
    }
}

pub(crate) fn decode(bytes: &[u8], encoding: TextEncoding) -> String {
    encoding.charset.decode(bytes).0.into_owned()
}

/// The `#rev` or `@change` suffix of a revision, see [`Workspace::revision_arg`].
pub(crate) fn revision_suffix(rev: Option<&str>) -> String {
    let rev = rev.map(str::trim).unwrap_or_default();
    if rev.is_empty() || rev == "HEAD" || rev == ":0" {
        return "#have".into();
    }
    if rev.starts_with('#') || rev.starts_with('@') {
        return rev.to_owned();
    }
    if let Some(change) = rev.strip_prefix("shelved:") {
        return format!("@={change}");
    }
    if let Some(before) = rev.strip_suffix('^').and_then(|n| n.parse::<u64>().ok()) {
        return format!("@{}", before.saturating_sub(1));
    }
    format!("@{rev}")
}
