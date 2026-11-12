//! `p4 opened` / `p4 fstat` tagged-output parsing → [`OpenedFile`].
//!
//! `p4 -ztag` emits one record per file as `... <name> <value>` lines ending in
//! a blank line. `opened` reports `depotFile`, `rev`, `action`, `change`,
//! `client`, `type` plus lock fields (`ourLock`, `otherLock`, `otherOpen`);
//! `fstat` reports the same `depotFile`/`action` plus `clientFile`/`isMapped`
//! for files not yet opened.

use crate::client::{ChangeAction, OpenedFile};
use std::path::{Path, PathBuf};

/// One `-ztag` record's fields.
fn records(out: &str) -> Vec<Vec<(String, String)>> {
    let mut all = Vec::new();
    let mut cur = Vec::new();
    for line in out.lines() {
        if let Some(f) = line.strip_prefix("... ") {
            let (name, value) = f
                .split_once(' ')
                .map(|(a, b)| (a.to_string(), b.to_string()))
                .unwrap_or((f.to_string(), String::new()));
            cur.push((name, value));
        } else if line.trim().is_empty() && !cur.is_empty() {
            all.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        all.push(cur);
    }
    all
}

fn field<'a>(rec: &'a [(String, String)], name: &str) -> Option<&'a str> {
    rec.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
}

fn field_all<'a>(rec: &'a [(String, String)], name: &str) -> Vec<&'a str> {
    rec.iter().filter(|(n, _)| n == name).map(|(_, v)| v.as_str()).collect()
}

/// `p4 opened -ztag` records → opened files, local paths resolved under `root`.
pub fn parse(out: &str, root: &str) -> Vec<OpenedFile> {
    records(out).iter().filter(|rec| field(rec, "depotFile").is_some()).map(|rec| to_opened(rec, root)).collect()
}

/// `p4 fstat -ztag` records → opened files (files with an `action`), plus
/// mapped-but-unopened entries when `clientFile` is present.
pub fn parse_fstat(out: &str, root: &str) -> Vec<OpenedFile> {
    records(out)
        .iter()
        .filter(|rec| field(rec, "depotFile").is_some() || field(rec, "clientFile").is_some())
        .map(|rec| to_opened(rec, root))
        .collect()
}

fn to_opened(rec: &[(String, String)], root: &str) -> OpenedFile {
    let depot = field(rec, "depotFile").unwrap_or_default().to_string();
    let client_file = field(rec, "clientFile").or_else(|| field(rec, "depotFile")).unwrap_or_default();
    let path = local_path(root, client_file, &depot);
    OpenedFile {
        path: ide_core::IpcPath(path),
        depot_file: depot,
        rev: field(rec, "rev").and_then(|r| r.trim_start_matches('#').parse().ok()),
        action: ChangeAction::parse(field(rec, "action").unwrap_or("")),
        change: field(rec, "change").and_then(|c| c.parse().ok()).unwrap_or(0),
        file_type: field(rec, "type").map(str::to_string),
        locked: field(rec, "ourLock").is_some() || field(rec, "otherLock").is_some(),
        other_open: field_all(rec, "otherOpen").into_iter().map(str::to_string).collect(),
    }
}

/// `clientFile` is a local absolute path on the client; `depotFile` is
/// `//depot/…` and must be mapped through the client view. Without a view we
/// fall back to the depot path minus its `//depot/` prefix under `root`.
fn local_path(root: &str, client_file: &str, depot_file: &str) -> PathBuf {
    let cf = client_file.trim();
    if !cf.is_empty() && !cf.starts_with("//") {
        let p = PathBuf::from(cf);
        if p.is_absolute() {
            return p;
        }
    }
    // depot → client: strip the leading `//<depot>/` and join under root.
    let rel = depot_file.trim_start_matches("//").split_once('/').map(|(_, r)| r).unwrap_or(depot_file);
    Path::new(root).join(rel)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_opened_records() {
        let out = "... depotFile //depot/src/a.rs\n... rev 3\n... action edit\n\
            ... change default\n... type text\n... user dev\n... client dev-ws\n\n\
            ... depotFile //depot/src/b.rs\n... rev 1\n... action add\n\
            ... change 42\n... type text\n... ourLock\n\n";
        let files = parse(out, "/ws/dev");
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].depot_file, "//depot/src/a.rs");
        assert_eq!(files[0].action, ChangeAction::Edit);
        assert_eq!(files[0].rev, Some(3));
        assert_eq!(files[1].action, ChangeAction::Add);
        assert_eq!(files[1].change, 42);
        assert!(files[1].locked);
    }

    #[test]
    fn local_path_prefers_client_file() {
        assert_eq!(local_path("/ws", "/ws/src/a.rs", "//depot/src/a.rs"), PathBuf::from("/ws/src/a.rs"));
        assert_eq!(local_path("/ws", "", "//depot/src/a.rs"), PathBuf::from("/ws/src/a.rs"));
    }

    #[test]
    fn parses_fstat_unopened() {
        let out = "... depotFile //depot/src/c.rs\n... clientFile /ws/src/c.rs\n\
            ... isMapped\n... headRev 5\n... type text\n\n";
        let files = parse_fstat(out, "/ws");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path.0, PathBuf::from("/ws/src/c.rs"));
        assert_eq!(files[0].action, ChangeAction::Other);
    }
}
