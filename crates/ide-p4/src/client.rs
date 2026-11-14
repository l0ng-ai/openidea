//! The Perforce client: connection settings and the write operations
//! (`edit`/`add`/`delete`/`revert`/`sync`/`submit`) plus `changelist` handling.
//!
//! Field names follow `p4 -ztag` output: a tagged record is a set of
//! `... <name> <value>` lines terminated by a blank line, and `code`/`severity`
//! mark informational vs error records.

use ide_core::{IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};

use crate::cli;

/// Server, user and client workspace of a `p4 info` — everything the settings
/// page needs to configure and confirm a connection.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    /// `P4PORT` the client talks to (`ssl:host:port` when TLS).
    pub server_address: String,
    /// `P4USER`.
    pub user_name: String,
    /// `P4CLIENT`, the workspace spec name.
    pub client_name: String,
    /// Client root on disk (the local top folder of the view).
    pub client_root: String,
    /// The host the client spec is bound to, when set (`clientHost`).
    pub client_host: Option<String>,
    /// Server version string from `p4 info` (`serverVersion`).
    pub server_version: Option<String>,
}

/// A file opened for a Perforce action (`p4 opened`).
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenedFile {
    /// Local path, resolved against the client root.
    pub path: ide_core::IpcPath,
    /// `depotFile` (`//depot/…`).
    pub depot_file: String,
    /// `rev` (`#3`) without the `#`.
    pub rev: Option<u32>,
    /// `action` — the open operation.
    pub action: ChangeAction,
    /// `change` — the changelist number, `0` for `default`.
    pub change: u32,
    /// `type` (`text`, `binary`, …).
    pub file_type: Option<String>,
    /// Locked by this client (`ourLock`) or another (`otherLock`).
    pub locked: bool,
    /// Other users/clients holding the file open (`otherOpen`).
    pub other_open: Vec<String>,
}

/// What an opened file is being changed for (`p4 opened` / `p4 fstat action`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ChangeAction {
    Edit,
    Add,
    Delete,
    Branch,
    Integrate,
    MoveAdd,
    MoveDelete,
    /// `archive`/`purge` or an action not on this list.
    Other,
}

impl ChangeAction {
    pub fn parse(s: &str) -> Self {
        match s {
            "edit" => Self::Edit,
            "add" => Self::Add,
            "delete" => Self::Delete,
            "branch" => Self::Branch,
            "integrate" => Self::Integrate,
            "move/add" => Self::MoveAdd,
            "move/delete" => Self::MoveDelete,
            _ => Self::Other,
        }
    }
}

/// A Perforce client workspace rooted at `root`, bound to `conn`'s settings.
/// Method calls run `p4` with `-c client -u user -p port` so a `Client` can
/// point at a non-default workspace.
#[derive(Clone)]
pub struct Client {
    pub root: PathBuf,
    pub conn: Connection,
    exe: PathBuf,
}

impl Client {
    /// Binds `exe` (`None` = auto-detect) to the workspace `conn` describes.
    pub fn new(conn: Connection, exe: Option<&Path>) -> IdeResult<Self> {
        let exe = cli::p4(exe)?;
        let root = PathBuf::from(&conn.client_root);
        Ok(Self { root, conn, exe })
    }

    /// `p4 info` in `cwd`: the connection the workspace `cwd` belongs to, or
    /// `Ok(None)` when `cwd` is not inside a Perforce client.
    pub fn info(exe: Option<&Path>, cwd: &Path) -> IdeResult<Option<Connection>> {
        let exe = cli::p4(exe)?;
        let out = match cli::run(&exe, &["-ztag", "info"], Some(cwd)) {
            Ok(o) => o,
            Err(e) if matches!(e.kind, ide_core::error::ErrorKind::Unavailable) => return Err(e),
            Err(_) => return Ok(None),
        };
        Ok(Some(parse_info(&out)))
    }

    fn args(&self, cmd: &str, extra: &[&str]) -> Vec<String> {
        let mut a = vec![
            "-ztag".to_string(),
            "-p".to_string(),
            self.conn.server_address.clone(),
            "-u".to_string(),
            self.conn.user_name.clone(),
            "-c".to_string(),
            self.conn.client_name.clone(),
            cmd.to_string(),
        ];
        a.extend(extra.iter().map(|s| s.to_string()));
        a
    }

    fn run(&self, cmd: &str, extra: &[&str]) -> IdeResult<String> {
        let args = self.args(cmd, extra);
        cli::run(&self.exe, &args.iter().map(|s| s.as_str()).collect::<Vec<_>>(), Some(&self.root))
    }

    /// `p4 opened` of `paths` (`//depot/…` or local paths; `[]` = the whole client).
    pub fn opened(&self, paths: &[&str]) -> IdeResult<Vec<OpenedFile>> {
        let mut extra = vec!["opened"];
        extra.extend_from_slice(paths);
        let out = self.run("opened", &extra[1..])?;
        Ok(crate::opened::parse(&out, &self.conn.client_root))
    }

    /// `p4 fstat` of `paths`: depot metadata for opened checks and status.
    pub fn fstat(&self, paths: &[&str]) -> IdeResult<Vec<OpenedFile>> {
        let out = self.run("fstat", paths)?;
        Ok(crate::opened::parse_fstat(&out, &self.conn.client_root))
    }

    /// `p4 edit` — open for edit, `-c change` when not default.
    pub fn edit(&self, paths: &[&str], change: Option<u32>) -> IdeResult<()> {
        self.open("edit", paths, change)
    }

    /// `p4 add` — open for add.
    pub fn add(&self, paths: &[&str], change: Option<u32>) -> IdeResult<()> {
        self.open("add", paths, change)
    }

    /// `p4 delete` — open for delete.
    pub fn delete(&self, paths: &[&str], change: Option<u32>) -> IdeResult<()> {
        self.open("delete", paths, change)
    }

    fn open(&self, action: &str, paths: &[&str], change: Option<u32>) -> IdeResult<()> {
        let mut extra: Vec<String> = Vec::new();
        if let Some(c) = change.filter(|c| *c != 0) {
            extra.push("-c".to_string());
            extra.push(c.to_string());
        }
        extra.extend(paths.iter().map(|s| s.to_string()));
        let out = self.run(action, &extra.iter().map(|s| s.as_str()).collect::<Vec<_>>())?;
        // `p4 edit` succeeds even when a file is already opened or "not on
        // client"; report those lines so callers don't read silence as success.
        let problems = out
            .lines()
            .filter(|l| l.contains("can't") || l.contains("not on client") || l.contains("not in client view"))
            .collect::<Vec<_>>();
        if !problems.is_empty() {
            return Err(IdeError::invalid(problems.join("\n")));
        }
        Ok(())
    }

    /// `p4 revert` — restore files to the depot revision, `-a` reverts
    /// unchanged files only.
    pub fn revert(&self, paths: &[&str], unchanged_only: bool) -> IdeResult<()> {
        let mut extra = Vec::new();
        if unchanged_only {
            extra.push("-a");
        }
        extra.extend_from_slice(paths);
        self.run("revert", &extra).map(|_| ())
    }

    /// `p4 sync` — bring the workspace to `paths`' head revisions.
    pub fn sync(&self, paths: &[&str], force: bool) -> IdeResult<String> {
        let mut extra = Vec::new();
        if force {
            extra.push("-f");
        }
        extra.extend_from_slice(paths);
        self.run("sync", &extra)
    }

    /// `p4 describe -s change`: files and the description of a submitted or
    /// pending changelist.
    pub fn describe(&self, change: u32) -> IdeResult<String> {
        self.run("describe", &["-s", &change.to_string()])
    }

    /// `p4 changes -m N -s pending -c client` — the client's pending changelists.
    pub fn changelists(&self, max: u32) -> IdeResult<Vec<P4Changelist>> {
        let out = self.run("changes", &["-m", &max.to_string(), "-s", "pending", "-c", &self.conn.client_name])?;
        Ok(parse_changelists(&out))
    }

    /// `p4 submit -d "desc"` — submits the default or `-c change` list.
    pub fn submit(&self, description: &str, change: Option<u32>) -> IdeResult<String> {
        let mut extra = vec!["-d".to_string(), description.to_string()];
        if let Some(c) = change.filter(|c| *c != 0) {
            extra.push("-c".to_string());
            extra.push(c.to_string());
        }
        self.run("submit", &extra.iter().map(|s| s.as_str()).collect::<Vec<_>>())
    }
}

/// A pending changelist summary (`p4 changes`).
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct P4Changelist {
    pub change: u32,
    pub user: String,
    pub client: String,
    /// First line of the description.
    pub description: String,
}

/// `p4 -ztag info` → [`Connection`]. Field names are those `info` emits:
/// `serverAddress`, `userName`, `clientName`, `clientRoot`, `clientHost`,
/// `serverVersion`.
fn parse_info(out: &str) -> Connection {
    let field = |name: &str| -> Option<String> {
        out.lines()
            .find_map(|l| l.strip_prefix(&format!("... {name} ")).map(str::to_string))
            .or_else(|| out.lines().find_map(|l| l.strip_prefix(&format!("{name}: ")).map(str::to_string)))
    };
    Connection {
        server_address: field("serverAddress").unwrap_or_default(),
        user_name: field("userName").unwrap_or_default(),
        client_name: field("clientName").unwrap_or_default(),
        client_root: field("clientRoot").unwrap_or_default(),
        client_host: field("clientHost"),
        server_version: field("serverVersion"),
    }
}

/// `p4 changes -ztag` records: `... change N`, `... user`, `... client`,
/// `... desc` (the description's first line, often followed by `...` continuations).
fn parse_changelists(out: &str) -> Vec<P4Changelist> {
    let mut list = Vec::new();
    let mut cur = P4Changelist { change: 0, user: String::new(), client: String::new(), description: String::new() };
    let mut seen = false;
    for line in out.lines() {
        let Some(f) = line.strip_prefix("... ") else { continue };
        let (name, value) = f.split_once(' ').map(|(a, b)| (a, b.trim())).unwrap_or((f, ""));
        match name {
            "change" => {
                if seen {
                    list.push(std::mem::replace(
                        &mut cur,
                        P4Changelist {
                            change: 0,
                            user: String::new(),
                            client: String::new(),
                            description: String::new(),
                        },
                    ));
                }
                seen = true;
                cur.change = value.parse().unwrap_or(0);
            }
            "user" => cur.user = value.to_string(),
            "client" => cur.client = value.to_string(),
            "desc" if cur.description.is_empty() => cur.description = value.to_string(),
            _ => {}
        }
    }
    if seen {
        list.push(cur);
    }
    list
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tagged_info() {
        let out = "... serverAddress ssl:perforce:1666\n... userName build\n... clientName build-ws\n\
            ... clientRoot /ws/build\n... serverVersion P4D/LINUX26X86_64/2024.1\n\n";
        let c = parse_info(out);
        assert_eq!(c.server_address, "ssl:perforce:1666");
        assert_eq!(c.user_name, "build");
        assert_eq!(c.client_name, "build-ws");
        assert_eq!(c.client_root, "/ws/build");
        assert_eq!(c.server_version.as_deref(), Some("P4D/LINUX26X86_64/2024.1"));
    }

    #[test]
    fn parses_changes() {
        let out = "... change 12\n... user dev\n... client dev-ws\n... desc 'fix login'\n\n\
            ... change 7\n... user dev\n... client dev-ws\n... desc 'wip'\n\n";
        let l = parse_changelists(out);
        assert_eq!(l.len(), 2);
        assert_eq!(l[0].change, 12);
        assert_eq!(l[0].description, "'fix login'");
        assert_eq!(l[1].change, 7);
    }
}
