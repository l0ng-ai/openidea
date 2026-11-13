//! Completion of Maven coordinates in a POM: inside a `<dependency>`, the
//! `<groupId>`, `<artifactId>` and `<version>` values are completed from the
//! local repository layout (`<repo>/<group path>/<artifactId>/<version>/…`).
//! The Maven Central search endpoint tops the lists up remotely; the host op
//! fetches those (cached) and merges them behind the local ones, so this side
//! stays pure text and directory logic and tests build their own repositories.

use super::xml::{self, Element};
use super::{element_path, interpolate, read_properties};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// The coordinate element a POM completion fills.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PomCompletionKind {
    /// The dependency's `<groupId>`.
    GroupId,
    /// The dependency's `<artifactId>`.
    ArtifactId,
    /// The dependency's `<version>`.
    Version,
}

/// One suggestion: the coordinate as inserted, and an optional note shown in
/// the lookup (the owning group of an artifactId, its newest installed version).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PomCompletionOption {
    /// The text the completion inserts (`org.example.lib`, `example-lib`, `1.2.0`).
    pub label: String,
    pub detail: Option<String>,
}

/// The completion offered at a caret of a POM: the replaced value span (UTF-16
/// offsets) and the suggestions, local ones first.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PomCompletion {
    /// UTF-16 offset where the completed text starts: the value's first character.
    pub from: u32,
    /// UTF-16 offset where the replaced value ends: past the caret when the caret
    /// sits inside an existing value, which is then replaced whole.
    pub to: u32,
    /// Which coordinate element the caret is in.
    pub kind: PomCompletionKind,
    /// The suggestions, local repository first.
    pub options: Vec<PomCompletionOption>,
}

/// Where the caret sits in a `<dependency>` coordinate element: what is being
/// completed, the typed prefix, and the sibling coordinates the rest need.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PomCompletionTarget {
    /// UTF-16 offset of the value's first character (the caret in an empty value).
    pub from: u32,
    /// UTF-16 offset past the value's last character (the caret in an empty value).
    pub to: u32,
    /// The value typed so far: the text between `from` and the caret, trimmed.
    pub typed: String,
    pub kind: PomCompletionKind,
    /// The interpolated `<groupId>` sibling, when completing the artifactId and
    /// the group is written out plain (no unresolved `${property}`).
    pub group: Option<String>,
    /// The interpolated `<artifactId>` sibling, when completing the version.
    pub artifact: Option<String>,
}

/// A coordinate element's text, with the POM's own `${properties}` replaced;
/// `None` when the element is missing or a property stays unresolved (the
/// coordinates behind it are not known without the parent chain, which the
/// completion does not follow).
fn coordinate(e: Option<&Element>, props: &HashMap<String, String>) -> Option<String> {
    let text = interpolate(e?.text.trim(), props);
    (!text.is_empty() && !text.contains("${")).then_some(text)
}

fn own_properties(root: &Element) -> HashMap<String, String> {
    read_properties(root.child("properties")).into_iter().collect()
}

/// UTF-16 offset -> byte offset, clamped to `text`.
fn utf16_to_byte(text: &str, offset: u32) -> usize {
    let mut seen = 0u32;
    for (byte, c) in text.char_indices() {
        if seen >= offset {
            return byte;
        }
        seen += c.len_utf16() as u32;
    }
    text.len()
}

/// Byte offset -> UTF-16 offset.
fn utf16_at(text: &str, byte: usize) -> u32 {
    text[..byte].encode_utf16().count() as u32
}

/// Byte offset just past the start tag's `>` of the element at `start`.
fn start_tag_end(text: &str, start: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut i = start.checked_add(1)?;
    let mut quote = None;
    while i < bytes.len() {
        match (quote, bytes[i]) {
            (Some(q), b) if b == q => quote = None,
            (Some(_), _) => {}
            (None, b'"' | b'\'') => quote = Some(bytes[i]),
            (None, b'>') => return Some(i + 1),
            _ => {}
        }
        i += 1;
    }
    None
}

/// What to complete at the caret (`offset`, UTF-16) of the POM `text`: the
/// `<groupId>` / `<artifactId>` / `<version>` element of a `<dependency>` the
/// caret sits in the value of. `None` everywhere else — other elements, carets
/// in an end tag or a `${property}` reference, dependencies without the
/// `<groupId>` (and, for versions, the `<artifactId>`) their completions need.
pub fn completion_target(text: &str, offset: u32) -> Option<PomCompletionTarget> {
    let root = xml::parse(text).filter(|e| e.name == "project")?;
    let at = utf16_to_byte(text, offset);
    // A caret at the very end of the input sits in the element still being
    // typed, whose range reaches to the input's end; step back one character
    // so `element_path` sees it (the caret's own offset stays `at`).
    let probe = if at == text.len() && at > 0 {
        let mut p = at - 1;
        while p > 0 && !text.is_char_boundary(p) {
            p -= 1;
        }
        p
    } else {
        at
    };
    let elements = element_path(&root, probe);
    let e = *elements.last()?;
    let parent = elements.get(elements.len().checked_sub(2)?)?;
    let kind = match e.name.as_str() {
        "groupId" => PomCompletionKind::GroupId,
        "artifactId" => PomCompletionKind::ArtifactId,
        "version" => PomCompletionKind::Version,
        _ => return None,
    };
    if parent.name != "dependency" || at > e.inner_end {
        return None;
    }
    let inner_start = start_tag_end(text, e.start)?;
    let value = &text[inner_start..e.inner_end.max(inner_start)];
    if value.contains("${") {
        return None; // Property references are goto-declaration territory, not completion.
    }
    let lead = value.len() - value.trim_start().len();
    let trail = value.len() - value.trim_end().len();
    let (mut from, mut to) = (inner_start + lead, e.inner_end.max(inner_start) - trail);
    if from > to {
        // A value of whitespace only: complete at the caret.
        from = at.min(to);
        to = to.max(from);
    }
    from = from.min(at);
    to = to.max(from);
    let props = own_properties(&root);
    let group = (kind != PomCompletionKind::GroupId).then(|| coordinate(parent.child("groupId"), &props)).flatten();
    let artifact =
        (kind == PomCompletionKind::Version).then(|| coordinate(parent.child("artifactId"), &props)).flatten();
    let typed = text[from..at].trim().to_owned();
    Some(PomCompletionTarget { from: utf16_at(text, from), to: utf16_at(text, to), typed, kind, group, artifact })
}

/// The suggestions the local repository at `repo` offers for `target`: group
/// ids installed under it, the artifacts of the target's group, or the versions
/// of the target's artifact. Every scan is bounded (see `SCAN_BUDGET`) and
/// reads only directory listings of `repo` — nothing outside it, no jar
/// contents.
pub fn local_options(repo: &Path, target: &PomCompletionTarget) -> Vec<PomCompletionOption> {
    let mut budget = SCAN_BUDGET;
    match target.kind {
        // `org.spr` completes the `spr` part under `org/`, `org.` the next
        // segment under `org/`; every typed segment is validated so POM text
        // cannot walk out of the repository.
        PomCompletionKind::GroupId => {
            let segments: Vec<&str> = target.typed.split('.').collect();
            let (partial, base) = segments.split_last().unwrap_or((&"", &[]));
            if base.iter().all(|s| segment(s)) {
                let dir = base.iter().fold(repo.to_path_buf(), |p, s| p.join(s));
                scan_groups(&dir, &base.join("."), partial, &mut budget)
            } else {
                Vec::new()
            }
        }
        PomCompletionKind::ArtifactId => target
            .group
            .as_deref()
            .and_then(|g| repo_dir(repo, &[g]))
            .map_or_else(Vec::new, |dir| scan_artifacts(&dir, &target.typed, &mut budget)),
        PomCompletionKind::Version => target
            .group
            .as_deref()
            .zip(target.artifact.as_deref())
            .and_then(|(g, a)| repo_dir(repo, &[g, a]))
            .map_or_else(Vec::new, |dir| scan_versions(&dir, &target.typed, &mut budget)),
    }
}

/// Directory listings one completion may read: the scans are interactive, so
/// they stop before they could be felt, and a huge repository simply yields
/// fewer suggestions (its shallowest first — the walk is breadth-preferring).
const SCAN_BUDGET: u32 = 2048;
/// Suggestion caps per kind: group ids and artifact ids fill a lookup page,
/// versions list an artifact's releases.
const MAX_GROUP_OPTIONS: usize = 60;
const MAX_ARTIFACT_OPTIONS: usize = 60;
const MAX_VERSION_OPTIONS: usize = 100;
/// The cap the merged list (local plus Maven Central's) is truncated to.
pub const MAX_OPTIONS: usize = 100;

/// A directory entry whose name passes the repository layout's alphabet
/// (mirrors `sources::artifact`'s): letters, digits, `._-`. Path separators
/// and `..` never pass, so a POM's `${…}`-free text cannot traverse out of
/// the repository.
fn segment(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

/// The subdirectories of `dir` with repository-layout names, spending `budget`
/// on the listing; `None` when the budget ran out before `dir` was listed.
fn subdirs(dir: &Path, budget: &mut u32) -> Option<Vec<String>> {
    if *budget == 0 {
        return None;
    }
    *budget -= 1;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Some(Vec::new());
    };
    let mut names = Vec::new();
    for entry in entries.flatten() {
        // The budget bounds file-type checks too: a plain listing answers.
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false)
            && let Ok(name) = entry.file_name().into_string()
            && segment(&name)
        {
            names.push(name);
        }
    }
    Some(names)
}

/// Whether `dir` holds files — a version directory does (jar, pom, the
/// tracking files), a group path segment never does.
fn holds_files(dir: &Path, budget: &mut u32) -> bool {
    if *budget == 0 {
        return false;
    }
    *budget -= 1;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
}

/// Whether the version directory `dir` holds the version: its `.pom` or a `.jar`. A failed
/// download leaves only `*.lastUpdated` tracking files behind, for a version that may not
/// even exist (one typed while the POM was being edited).
fn installed(dir: &Path, budget: &mut u32) -> bool {
    if *budget == 0 {
        return false;
    }
    *budget -= 1;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|e| {
        e.file_type().map(|t| t.is_file()).unwrap_or(false)
            && e.file_name().to_str().is_some_and(|n| n.ends_with(".pom") || n.ends_with(".jar"))
    })
}

/// Whether `dir` is an artifact directory: it holds versions of one artifact,
/// recognizable by a `maven-metadata*.xml` beside them or a child directory
/// holding files. A group segment's children are directories without files.
fn artifact_dir(dir: &Path, budget: &mut u32) -> bool {
    if *budget == 0 {
        return false;
    }
    *budget -= 1;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else { continue };
        if name.starts_with("maven-metadata") {
            return true;
        }
    }
    let Some(children) = subdirs(dir, budget) else { return false };
    children.iter().any(|c| holds_files(&dir.join(c), budget))
}

/// Whether `dir` is a group directory (holds artifact directories) and whether
/// it also holds deeper group segments worth descending into.
fn group_dir(dir: &Path, budget: &mut u32) -> Option<(bool, bool)> {
    let children = subdirs(dir, budget)?;
    let (mut group, mut descend) = (false, false);
    for child in &children {
        if artifact_dir(&dir.join(child), budget) {
            group = true;
        } else {
            descend = true;
        }
    }
    Some((group, descend))
}

/// The group ids installed under `dir` (which the typed prefix `prefix` —
/// "" for the repository root — already names), completing the partial last
/// segment `partial`, shallower groups first.
fn scan_groups(dir: &Path, prefix: &str, partial: &str, budget: &mut u32) -> Vec<PomCompletionOption> {
    let mut out = Vec::new();
    scan_groups_into(dir, prefix, partial, &mut out, budget);
    out.sort_by(|a, b| a.label.cmp(&b.label));
    out
}

fn scan_groups_into(dir: &Path, prefix: &str, partial: &str, out: &mut Vec<PomCompletionOption>, budget: &mut u32) {
    if out.len() >= MAX_GROUP_OPTIONS {
        return;
    }
    let Some(children) = subdirs(dir, budget) else { return };
    for name in children {
        if !name.starts_with(partial) {
            continue;
        }
        let path = dir.join(&name);
        let label = if prefix.is_empty() { name.clone() } else { format!("{prefix}.{name}") };
        let Some((group, descend)) = group_dir(&path, budget) else { return };
        if group {
            out.push(PomCompletionOption { label: label.clone(), detail: None });
            if out.len() >= MAX_GROUP_OPTIONS {
                return;
            }
        }
        // Deeper groups (org.example under org.example's own parent) follow the
        // shallower ones, so a truncated scan of a huge repository still offers
        // every first-level segment.
        if descend {
            scan_groups_into(&path, &label, "", out, budget);
        }
    }
}

/// The artifact ids installed under the group directory `dir`, completing the
/// typed prefix, each with its newest installed version as the detail.
fn scan_artifacts(dir: &Path, typed: &str, budget: &mut u32) -> Vec<PomCompletionOption> {
    let Some(children) = subdirs(dir, budget) else { return Vec::new() };
    let mut out = Vec::new();
    for name in children {
        if !name.starts_with(typed) || !artifact_dir(&dir.join(&name), budget) {
            continue;
        }
        let detail = newest_version(&dir.join(&name), budget);
        out.push(PomCompletionOption { label: name, detail });
    }
    out.sort_by(|a, b| a.label.cmp(&b.label));
    out.truncate(MAX_ARTIFACT_OPTIONS);
    out
}

/// The newest version directory of the artifact at `dir`, by Maven's ordering.
fn newest_version(dir: &Path, budget: &mut u32) -> Option<String> {
    let children = subdirs(dir, budget)?;
    children.into_iter().filter(|name| installed(&dir.join(name), budget)).max_by(|a, b| compare_versions(a, b))
}

/// The versions installed of the artifact at `dir`, completing the typed
/// prefix, newest first.
fn scan_versions(dir: &Path, typed: &str, budget: &mut u32) -> Vec<PomCompletionOption> {
    let Some(children) = subdirs(dir, budget) else { return Vec::new() };
    let mut out: Vec<_> = children
        .into_iter()
        .filter(|name| name.starts_with(typed) && installed(&dir.join(name), budget))
        .map(|name| PomCompletionOption { label: name, detail: None })
        .collect();
    out.sort_by(|a, b| compare_versions(&b.label, &a.label));
    out.truncate(MAX_VERSION_OPTIONS);
    out
}

/// The repository directory of the `/`-separated `coordinates` (a group id, or
/// a group and an artifact id), each segment validated against the layout's
/// alphabet so POM text cannot walk outside `repo`.
fn repo_dir(repo: &Path, coordinates: &[&str]) -> Option<PathBuf> {
    let segments: Vec<&str> = coordinates.iter().flat_map(|c| c.split('.')).collect();
    segments.iter().all(|s| segment(s)).then(|| segments.iter().fold(repo.to_path_buf(), |p, s| p.join(s)))
}

/// Maven-ish version order, best-effort (a full `ComparableVersion` is out of
/// proportion for ordering a lookup): numeric runs compare numerically, letter
/// runs by their qualifier rank (`alpha < beta < m < rc < snapshot < release <
/// sp`, unknown ones with releases lexically); missing parts rank as zero.
fn compare_versions(a: &str, b: &str) -> Ordering {
    fn tokens(v: &str) -> Vec<String> {
        v.split(|c: char| !c.is_ascii_alphanumeric()).filter(|t| !t.is_empty()).map(str::to_ascii_lowercase).collect()
    }
    fn rank(t: &str) -> Option<u8> {
        match t {
            "a" | "alpha" => Some(0),
            "b" | "beta" => Some(1),
            "m" | "milestone" => Some(2),
            "rc" | "cr" => Some(3),
            "snapshot" => Some(4),
            "" | "ga" | "final" => Some(5),
            "sp" => Some(6),
            _ => None,
        }
    }
    let (a, b) = (tokens(a), tokens(b));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).map(String::as_str), b.get(i).map(String::as_str));
        let (xn, yn) = (x.and_then(|s| s.parse::<u64>().ok()), y.and_then(|s| s.parse::<u64>().ok()));
        let order = match (xn, yn) {
            // Numbers compare numerically; a number outranks a qualifier.
            (Some(xn), Some(yn)) => xn.cmp(&yn),
            (Some(_), None) if y.is_some() => return Ordering::Greater,
            (None, Some(_)) if x.is_some() => return Ordering::Less,
            _ => {
                let xr = x.and_then(rank).unwrap_or(5);
                let yr = y.and_then(rank).unwrap_or(5);
                if xr != yr { xr.cmp(&yr) } else { x.unwrap_or("").cmp(y.unwrap_or("")) }
            }
        };
        if order != Ordering::Equal {
            return order;
        }
    }
    Ordering::Equal
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A small local repository: every file is laid out as Maven installs it,
    /// so the scans recognize group, artifact and version directories.
    fn repo(dir: &Path) -> PathBuf {
        let repo = dir.join("repository");
        for file in [
            "org/apache/maven/maven-core/4.0.0-rc-5/maven-core-4.0.0-rc-5.jar",
            "org/apache/maven/plugins/maven-compiler-plugin/3.8.1/maven-compiler-plugin-3.8.1.jar",
            "org/example/lib/1.0/lib-1.0.jar",
            "org/example/lib/1.9.1/lib-1.9.1.jar",
            "org/example/lib/1.10/lib-1.10.jar",
            "org/example/lib/2.0-beta-1/lib-2.0-beta-1.jar",
            "org/example/lib/2.0/lib-2.0.pom",
            "net/nu/netty/4.1.100/netty-4.1.100.jar",
            // Failed downloads (a version typed while editing): tracking files only, not installed.
            "org/example/lib/2/lib-2.jar.lastUpdated",
            "org/example/lib/3.0/lib-3.0.pom.lastUpdated",
        ] {
            let path = repo.join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, b"").unwrap();
        }
        repo
    }

    fn target(text: &str, needle: &str) -> Option<PomCompletionTarget> {
        completion_target(text, (text.find(needle).unwrap() + needle.len()) as u32)
    }

    #[test]
    fn completes_each_coordinate_element_of_a_dependency() {
        let text = "<project><dependencies><dependency>\
<groupId>org.example</groupId><artifactId>lib</artifactId><version>1.0</version>\
</dependency></dependencies></project>";
        let t = target(text, "<groupId>org.example").unwrap();
        assert_eq!(t.kind, PomCompletionKind::GroupId);
        assert_eq!(t.typed, "org.example");
        assert_eq!((t.from, t.to), (44, 55));
        assert!(t.group.is_none() && t.artifact.is_none());

        let t = target(text, "<artifactId>lib").unwrap();
        assert_eq!(t.kind, PomCompletionKind::ArtifactId);
        assert_eq!(t.typed, "lib");
        assert_eq!(t.group.as_deref(), Some("org.example"));
        assert!(t.artifact.is_none());

        let t = target(text, "<version>1.0").unwrap();
        assert_eq!(t.kind, PomCompletionKind::Version);
        assert_eq!(t.typed, "1.0");
        assert_eq!(t.group.as_deref(), Some("org.example"));
        assert_eq!(t.artifact.as_deref(), Some("lib"));
    }

    #[test]
    fn completes_while_the_element_is_being_typed_and_the_value_is_empty() {
        let empty = "<project><dependencies><dependency><groupId></groupId></dependency></dependencies></project>";
        let t = target(empty, "<groupId>").unwrap();
        assert_eq!(t.kind, PomCompletionKind::GroupId);
        assert_eq!(t.typed, "");
        assert_eq!(t.from, t.to);

        let open = "<project><dependencies><dependency><artifactId>li";
        let t = target(open, "li").unwrap();
        assert_eq!(t.kind, PomCompletionKind::ArtifactId);
        assert_eq!(t.typed, "li");
        // The value under construction ends with the input and is replaced whole.
        assert_eq!(t.to, open.len() as u32);
    }

    #[test]
    fn completes_only_dependency_coordinates() {
        // The same elements outside a <dependency> get nothing: a <plugin> is
        // completed by the repository, not coordinates.
        let plugin =
            "<project><build><plugins><plugin><groupId>org.apache.maven</groupId></plugin></plugins></build></project>";
        assert_eq!(target(plugin, "<groupId>org.apache.maven"), None);
        // A caret in the end tag, or on a `${property}` value, is not a completion.
        let text =
            "<project><dependencies><dependency><groupId>org.example</groupId></dependency></dependencies></project>";
        assert_eq!(target(text, "</groupId>"), None);
        let property = "<project><dependencies><dependency><groupId>${example.group}</groupId></dependency></dependencies></project>";
        assert_eq!(target(property, "${example.group}"), None);
        // A dependency's groupId is required before its artifacts can be listed.
        let no_group =
            "<project><dependencies><dependency><artifactId>lib</artifactId></dependency></dependencies></project>";
        let t = target(no_group, "<artifactId>lib").unwrap();
        assert!(t.group.is_none());
    }

    #[test]
    fn interpolates_the_poms_own_properties_for_siblings() {
        let text = "<project>\
<properties><example.group>org.example</example.group><example.version>2.0</example.version></properties>\
<dependencies><dependency><groupId>${example.group}</groupId><artifactId>lib</artifactId><version>${example.version}</version></dependency></dependencies>\
</project>";
        // The groupId the caret is typing stays a completion; the siblings resolve.
        let t = target(text, "<artifactId>lib").unwrap();
        assert_eq!(t.group.as_deref(), Some("org.example"));
        // A `${property}` under the caret itself gets nothing to complete.
        assert_eq!(target(text, "<version>${example.version}"), None);
    }

    #[test]
    fn local_scan_lists_installed_groups_shallowest_first() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = repo(tmp.path());
        let options = |typed: &str| {
            local_options(
                &repo,
                &PomCompletionTarget {
                    from: 0,
                    to: 0,
                    typed: typed.into(),
                    kind: PomCompletionKind::GroupId,
                    group: None,
                    artifact: None,
                },
            )
            .into_iter()
            .map(|o| o.label)
            .collect::<Vec<_>>()
        };
        // Only directories holding artifacts are group ids: `net` and `org`
        // alone never receive an install, their deeper levels do.
        assert_eq!(options(""), ["net.nu", "org.apache.maven", "org.apache.maven.plugins", "org.example"]);
        assert_eq!(options("org"), ["org.apache.maven", "org.apache.maven.plugins", "org.example"]);
        assert_eq!(options("org."), ["org.apache.maven", "org.apache.maven.plugins", "org.example"]);
        assert_eq!(options("org.spr"), Vec::<String>::new());
        assert_eq!(options("net."), ["net.nu"]);
    }

    #[test]
    fn local_scan_lists_artifacts_of_the_group_with_their_newest_version() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = repo(tmp.path());
        let options = |typed: &str| {
            local_options(
                &repo,
                &PomCompletionTarget {
                    from: 0,
                    to: 0,
                    typed: typed.into(),
                    kind: PomCompletionKind::ArtifactId,
                    group: Some("org.example".into()),
                    artifact: None,
                },
            )
            .into_iter()
            .map(|o| (o.label, o.detail))
            .collect::<Vec<_>>()
        };
        assert_eq!(options(""), [("lib".to_owned(), Some("2.0".to_owned()))]);
        assert_eq!(options("net"), Vec::<(String, Option<String>)>::new());
    }

    #[test]
    fn local_scan_lists_versions_of_the_artifact_newest_first() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = repo(tmp.path());
        let options = |typed: &str| {
            local_options(
                &repo,
                &PomCompletionTarget {
                    from: 0,
                    to: 0,
                    typed: typed.into(),
                    kind: PomCompletionKind::Version,
                    group: Some("org.example".into()),
                    artifact: Some("lib".into()),
                },
            )
            .into_iter()
            .map(|o| o.label)
            .collect::<Vec<_>>()
        };
        assert_eq!(options(""), ["2.0", "2.0-beta-1", "1.10", "1.9.1", "1.0"]);
        assert_eq!(options("1."), ["1.10", "1.9.1", "1.0"]);
    }

    #[test]
    fn a_poms_text_cannot_walk_out_of_the_repository() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = repo(tmp.path());
        for group in ["../../etc", "..", "org/../.."] {
            let options = local_options(
                &repo,
                &PomCompletionTarget {
                    from: 0,
                    to: 0,
                    typed: "".into(),
                    kind: PomCompletionKind::ArtifactId,
                    group: Some(group.into()),
                    artifact: None,
                },
            );
            assert!(options.is_empty(), "{group}");
        }
    }

    #[test]
    fn the_scan_stops_at_the_option_cap() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repository");
        for i in 0..MAX_GROUP_OPTIONS + 10 {
            let group = repo.join(format!("com/example/g{i}"));
            std::fs::create_dir_all(group.join("art/1.0")).unwrap();
            std::fs::write(group.join("art/1.0/art-1.0.jar"), b"").unwrap();
        }
        let options = local_options(
            &repo,
            &PomCompletionTarget {
                from: 0,
                to: 0,
                typed: "".into(),
                kind: PomCompletionKind::GroupId,
                group: None,
                artifact: None,
            },
        );
        assert_eq!(options.len(), MAX_GROUP_OPTIONS);
    }

    #[test]
    fn maven_version_order() {
        let mut versions = ["2.0", "1.0", "2.0-beta-1", "2.0-alpha-2", "1.10", "1.9.1", "4.0.0-rc-5", "4.0.0-rc-13"];
        versions.sort_by(|a, b| compare_versions(a, b));
        assert_eq!(versions, ["1.0", "1.9.1", "1.10", "2.0-alpha-2", "2.0-beta-1", "2.0", "4.0.0-rc-5", "4.0.0-rc-13"]);
    }
}
