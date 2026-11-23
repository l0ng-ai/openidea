//! `git blame --porcelain` parsing.

use crate::BlameLine;
use ide_core::IpcPath;
use std::collections::HashMap;
use std::path::{Component, Path};

#[derive(Default, Clone)]
struct CommitMeta {
    author: String,
    time_ms: f64,
    summary: String,
    origin_path: Option<IpcPath>,
}

/// Parses `git blame --porcelain` output into one entry per final line.
pub(crate) fn parse_porcelain(out: &str, root: &Path, relative_path: &str) -> Vec<BlameLine> {
    let mut metas: HashMap<String, CommitMeta> = HashMap::new();
    let mut lines: Vec<(u32, String, Option<IpcPath>)> = Vec::new();
    let mut current: Option<(u32, String)> = None;
    for line in out.split('\n') {
        if line.starts_with('\t') {
            if let Some((number, id)) = current.take() {
                let origin = metas.get(&id).and_then(|m| m.origin_path.clone());
                lines.push((number, id, origin));
            }
            continue;
        }
        if let Some((_, id)) = current.as_ref() {
            let meta = metas.entry(id.clone()).or_default();
            if let Some(v) = line.strip_prefix("author ") {
                meta.author = v.to_string();
            } else if let Some(v) = line.strip_prefix("author-time ") {
                meta.time_ms = v.trim().parse::<f64>().unwrap_or(0.0) * 1000.0;
            } else if let Some(v) = line.strip_prefix("summary ") {
                meta.summary = v.to_string();
            } else if let Some(v) = line.strip_prefix("filename ") {
                // Porcelain repeats the filename at group boundaries when one commit
                // contributed lines from multiple files, even when it omits other metadata.
                let name = crate::patch::git_path(v);
                let path = Path::new(&name);
                meta.origin_path = (name != relative_path
                    && !name.is_empty()
                    && path.components().all(|c| matches!(c, Component::Normal(_))))
                .then(|| root.join(path).into());
            }
            continue;
        }
        // Header: <sha> <orig-line> <final-line> [<group-count>]
        let mut parts = line.split(' ');
        let (Some(sha), Some(_orig), Some(final_line)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        if sha.len() < 40 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        let Ok(final_line) = final_line.parse::<u32>() else { continue };
        metas.entry(sha.to_string()).or_default();
        current = Some((final_line, sha.to_string()));
    }
    lines.sort_by_key(|(n, ..)| *n);
    lines
        .into_iter()
        .map(|(_, sha, origin_path)| {
            let meta = metas.get(&sha).cloned().unwrap_or_default();
            BlameLine { commit: sha, author: meta.author, time_ms: meta.time_ms, summary: meta.summary, origin_path }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_groups_and_repeats() {
        let sha_a = "a".repeat(40);
        let sha_z = "0".repeat(40);
        let out = format!(
            "{sha_a} 1 1 2\nauthor Ann\nauthor-mail <a@x>\nauthor-time 100\nauthor-tz +0000\nsummary first\nfilename f\n\tl1\n\
             {sha_a} 2 2\n\tl2\n\
             {sha_z} 3 3 1\nauthor Not Committed Yet\nauthor-time 200\nsummary Version of f from f\nfilename f\n\tl3\n"
        );
        let lines = parse_porcelain(&out, Path::new("root"), "f");
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[1].author, "Ann");
        assert_eq!(lines[1].time_ms, 100_000.0);
        assert_eq!(lines[2].author, "Not Committed Yet");
    }
}
