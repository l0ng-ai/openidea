//! Native Agent Skill browser, previewer, static security scanner, and subtree installer (#5115).
//!
//! Accepts the same direct GitHub source forms `npx skills add` accepts (`owner/repo`,
//! `owner/repo@ref_or_skill`, `owner/repo#ref`, `owner/repo/subpath[@ref]`,
//! `https://github.com/owner/repo[/tree/<ref>[/<subpath>]]`, and pasted
//! `https://skills.sh/<owner>/<repo>[/<skill>]` links), resolves the repository tree
//! through [`ide_tools::Http`] without spawning `git` or `npx`, scans `SKILL.md` and
//! bundled files before writing to disk, and installs only the selected skill's subtree
//! into `~/.agents/skills/<name>` (User) or `<workspace>/.agents/skills/<name>` (Workspace).

use crate::McpScope;
use base64::Engine as _;
use ide_core::error::ErrorKind;
use ide_core::{CancellationToken, IdeError, IdeResult};
use ide_tools::Http;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Maximum JSON response size for GitHub repository metadata (1 MiB).
const MAX_REPO_META_BYTES: u64 = 1 << 20;
/// Maximum JSON response size for recursive Git tree listing (8 MiB).
const MAX_TREE_JSON_BYTES: u64 = 8 << 20;
/// Maximum total unpacked size of one installed skill subtree (2 MiB).
pub const MAX_SKILL_SUBTREE_BYTES: u64 = 2 << 20;
/// Maximum single blob size inside a skill subtree (1 MiB).
const MAX_SINGLE_BLOB_BYTES: u64 = 1 << 20;
/// Maximum number of files inside one installed skill subtree.
const MAX_SKILL_FILES: usize = 256;

const SCRIPT_EXTENSIONS: &[&str] = &[
    "sh", "bash", "zsh", "fish", "py", "ps1", "bat", "cmd", "js", "mjs", "cjs", "ts", "mts", "cts", "rb", "pl", "exe",
    "dll", "so", "dylib", "wasm",
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSkillCandidate {
    /// Target folder name (`<name>` under `.agents/skills/<name>`).
    pub folder_name: String,
    /// Repository-relative directory holding `SKILL.md` (`""` when at repository root).
    pub subpath: String,
    pub file_count: u32,
    pub total_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSkillBrowseResult {
    pub owner: String,
    pub repo: String,
    pub git_ref: String,
    pub tree_sha: String,
    pub truncated: bool,
    pub skills: Vec<RemoteSkillCandidate>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSkillFile {
    /// Path relative to the skill folder (e.g. `"SKILL.md"`, `"scripts/check.sh"`).
    pub path: String,
    pub size: u64,
    pub executable: bool,
    pub symlink: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SkillScanWarningKind {
    HiddenUnicode,
    OutOfRootSymlink,
    ExecutableScript,
    AllowedToolsShell,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillScanWarning {
    pub kind: SkillScanWarningKind,
    pub file: String,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSkillPreview {
    pub owner: String,
    pub repo: String,
    pub git_ref: String,
    pub tree_sha: String,
    pub subpath: String,
    pub skill_name: String,
    pub description: String,
    pub skill_markdown: String,
    pub files: Vec<RemoteSkillFile>,
    pub scan_warnings: Vec<SkillScanWarning>,
    pub already_installed_user: bool,
    pub already_installed_workspace: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct InstallRemoteSkillRequest {
    pub owner: String,
    pub repo: String,
    pub git_ref: String,
    pub subpath: String,
    pub scope: McpScope,
    /// Must be `true` when the static security scan produces any warnings.
    #[serde(default)]
    pub confirm_warnings: bool,
    /// Must be `true` to replace an existing folder of the same name in `scope`.
    #[serde(default)]
    pub overwrite: bool,
}

/// Parsed user source input (`owner/repo[/subpath][@ref]`, GitHub URL, or `skills.sh` URL).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedSource {
    pub owner: String,
    pub repo: String,
    /// Explicit `#ref`, `/tree/<ref>`, or `subpath@ref`.
    pub explicit_ref: Option<String>,
    /// `@suffix` on bare `owner/repo@suffix`, which may be either a Git ref or a skill name.
    pub ref_or_skill: Option<String>,
    /// Explicit repository subpath filter (normalized forward-slash relative path, no `SKILL.md` leaf).
    pub subpath: Option<String>,
    /// Explicit skill folder name filter (e.g. from `https://skills.sh/owner/repo/skill`).
    pub skill_filter: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct GitTree {
    pub sha: String,
    #[serde(default)]
    pub truncated: bool,
    pub tree: Vec<GitTreeEntry>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct GitTreeEntry {
    pub path: String,
    pub mode: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub sha: String,
    #[serde(default)]
    pub size: Option<u64>,
}

#[derive(Clone, Copy, Debug)]
pub struct RepoRef<'a> {
    pub owner: &'a str,
    pub repo: &'a str,
    pub git_ref: &'a str,
}

pub trait SkillSourceFetcher: Send + Sync {
    fn default_branch(&self, owner: &str, repo: &str, cancel: &CancellationToken) -> IdeResult<String>;
    fn git_tree(&self, target: RepoRef<'_>, cancel: &CancellationToken) -> IdeResult<GitTree>;
    fn read_blob(
        &self,
        target: RepoRef<'_>,
        repo_path: &str,
        blob_sha: &str,
        max_bytes: u64,
        cancel: &CancellationToken,
    ) -> IdeResult<Vec<u8>>;
}

pub struct GitHubHttpFetcher {
    json_http: Http,
    unauth_json_http: Http,
    raw_http: Http,
}

impl GitHubHttpFetcher {
    pub fn new(search_path: &std::ffi::OsStr) -> IdeResult<Self> {
        let json_http = Http::new(search_path)?.https_only().accept("application/vnd.github+json");
        let unauth_json_http =
            Http::new(search_path)?.https_only().without_github_auth().accept("application/vnd.github+json");
        let raw_http = Http::new(search_path)?.https_only().without_github_auth();
        Ok(Self { json_http, unauth_json_http, raw_http })
    }

    /// Retries unauthenticated when an expired ambient `GITHUB_TOKEN` / `gh` login returns HTTP 401 on a public repo.
    fn get_github_json(&self, url: &str, max_bytes: u64, cancel: &CancellationToken) -> IdeResult<String> {
        match self.json_http.get_text_limited(url, Some(max_bytes), cancel) {
            Ok(body) => Ok(body),
            Err(err) if !cancel.is_cancelled() && err.message.contains("401") => {
                self.unauth_json_http.get_text_limited(url, Some(max_bytes), cancel)
            }
            Err(err) => Err(err),
        }
    }
}

#[derive(Deserialize)]
struct RepoMeta {
    default_branch: String,
}

#[derive(Deserialize)]
struct BlobResponse {
    #[serde(default)]
    encoding: String,
    #[serde(default)]
    content: String,
}

impl SkillSourceFetcher for GitHubHttpFetcher {
    fn default_branch(&self, owner: &str, repo: &str, cancel: &CancellationToken) -> IdeResult<String> {
        validate_repo_coord(owner, "owner")?;
        validate_repo_coord(repo, "repository")?;
        let url = format!("https://api.github.com/repos/{owner}/{repo}");
        let body = self.get_github_json(&url, MAX_REPO_META_BYTES, cancel)?;
        let meta: RepoMeta = serde_json::from_str(&body)
            .map_err(|e| IdeError::new(ErrorKind::Protocol, format!("{owner}/{repo}: invalid GitHub metadata: {e}")))?;
        validate_git_ref(&meta.default_branch)?;
        Ok(meta.default_branch)
    }

    fn git_tree(&self, target: RepoRef<'_>, cancel: &CancellationToken) -> IdeResult<GitTree> {
        let RepoRef { owner, repo, git_ref } = target;
        validate_repo_coord(owner, "owner")?;
        validate_repo_coord(repo, "repository")?;
        validate_git_ref(git_ref)?;
        let encoded_ref = encode_url_segment(git_ref);
        let url = format!("https://api.github.com/repos/{owner}/{repo}/git/trees/{encoded_ref}?recursive=1");
        let body = self.get_github_json(&url, MAX_TREE_JSON_BYTES, cancel)?;
        serde_json::from_str(&body)
            .map_err(|e| IdeError::new(ErrorKind::Protocol, format!("{owner}/{repo}@{git_ref}: invalid Git tree: {e}")))
    }

    fn read_blob(
        &self,
        target: RepoRef<'_>,
        repo_path: &str,
        blob_sha: &str,
        max_bytes: u64,
        cancel: &CancellationToken,
    ) -> IdeResult<Vec<u8>> {
        let RepoRef { owner, repo, git_ref } = target;
        validate_repo_coord(owner, "owner")?;
        validate_repo_coord(repo, "repository")?;
        validate_git_ref(git_ref)?;
        if blob_sha.is_empty() || !blob_sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(IdeError::invalid("invalid Git blob SHA"));
        }
        // Base64 expands by ~4/3 plus JSON wrapper.
        let json_limit = max_bytes.saturating_mul(2).saturating_add(4096);
        let blob_url = format!("https://api.github.com/repos/{owner}/{repo}/git/blobs/{blob_sha}");
        match self.get_github_json(&blob_url, json_limit, cancel) {
            Ok(text) => {
                let parsed: BlobResponse = serde_json::from_str(&text)
                    .map_err(|e| IdeError::new(ErrorKind::Protocol, format!("invalid Git blob JSON: {e}")))?;
                if parsed.encoding != "base64" {
                    return Err(IdeError::new(
                        ErrorKind::Protocol,
                        format!("unsupported Git blob encoding {:?}", parsed.encoding),
                    ));
                }
                let cleaned: Vec<u8> = parsed.content.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(cleaned)
                    .map_err(|e| IdeError::new(ErrorKind::Protocol, format!("invalid base64 blob: {e}")))?;
                if bytes.len() as u64 > max_bytes {
                    return Err(IdeError::invalid(format!("{repo_path}: exceeds {} KiB limit", max_bytes >> 10)));
                }
                Ok(bytes)
            }
            Err(api_err) => {
                if cancel.is_cancelled() {
                    return Err(IdeError::cancelled());
                }
                // Fallback for unauthenticated public GitHub API rate limits.
                let encoded_ref = encode_url_segment(git_ref);
                let encoded_path = repo_path.split('/').map(encode_url_segment).collect::<Vec<_>>().join("/");
                let raw_url = format!("https://raw.githubusercontent.com/{owner}/{repo}/{encoded_ref}/{encoded_path}");
                let tmp = tempfile::NamedTempFile::new()?;
                let silent = |_: ide_tools::InstallEvent| {};
                self.raw_http.download(&raw_url, tmp.path(), Some(max_bytes), cancel, &silent).map_err(|_| api_err)?;
                let bytes = std::fs::read(tmp.path())?;
                if bytes.len() as u64 > max_bytes {
                    return Err(IdeError::invalid(format!("{repo_path}: exceeds {} KiB limit", max_bytes >> 10)));
                }
                Ok(bytes)
            }
        }
    }
}

fn encode_url_segment(seg: &str) -> String {
    let mut out = String::with_capacity(seg.len());
    for b in seg.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn validate_repo_coord(value: &str, what: &str) -> IdeResult<()> {
    if value.is_empty()
        || value.len() > 100
        || value == "."
        || value == ".."
        || !value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    {
        return Err(IdeError::invalid(format!("Invalid GitHub {what} {value:?}")));
    }
    Ok(())
}

fn validate_git_ref(git_ref: &str) -> IdeResult<()> {
    if git_ref.is_empty()
        || git_ref.len() > 200
        || git_ref.starts_with('-')
        || git_ref.contains("..")
        || git_ref.bytes().any(|b| b.is_ascii_control() || matches!(b, b' ' | b'?' | b'#' | b'\\' | b'~' | b'^' | b':'))
    {
        return Err(IdeError::invalid(format!("Invalid Git ref {git_ref:?}")));
    }
    Ok(())
}

fn normalize_subpath(raw: &str) -> IdeResult<Option<String>> {
    let trimmed = raw.trim().trim_matches('/');
    if trimmed.is_empty() {
        return Ok(None);
    }
    let stripped = trimmed.strip_suffix("/SKILL.md").unwrap_or(if trimmed == "SKILL.md" { "" } else { trimmed });
    if stripped.is_empty() {
        return Ok(None);
    }
    let mut parts = Vec::new();
    for seg in stripped.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." || seg.contains('\\') {
            return Err(IdeError::invalid(format!("Invalid skill path {raw:?}")));
        }
        parts.push(seg);
    }
    Ok(Some(parts.join("/")))
}

/// Parses `owner/repo[/path][@ref]`, `owner/repo#ref`, GitHub URLs, and `skills.sh` URLs.
pub fn parse_source(input: &str) -> IdeResult<ParsedSource> {
    let s = input.trim();
    if s.is_empty() {
        return Err(IdeError::invalid("Enter a GitHub repository such as owner/repo or owner/repo@skill"));
    }

    // Pasted https://skills.sh/<owner>/<repo>[/<skill>] URL -> resolve directly from GitHub.
    if let Some(rest) = s.strip_prefix("https://skills.sh/").or_else(|| s.strip_prefix("http://skills.sh/")) {
        let rest = rest.split(['?', '#']).next().unwrap_or(rest).trim_matches('/');
        let parts: Vec<&str> = rest.split('/').filter(|p| !p.is_empty()).collect();
        if parts.len() < 2 || parts.len() > 3 {
            return Err(IdeError::invalid("Expected https://skills.sh/<owner>/<repo>[/<skill>]"));
        }
        validate_repo_coord(parts[0], "owner")?;
        validate_repo_coord(parts[1], "repository")?;
        let skill_filter = if parts.len() == 3 {
            let name = parts[2].trim();
            if !valid_skill_name(name) {
                return Err(IdeError::invalid(format!("Invalid skill name {name:?}")));
            }
            Some(name.to_owned())
        } else {
            None
        };
        return Ok(ParsedSource {
            owner: parts[0].to_owned(),
            repo: parts[1].to_owned(),
            explicit_ref: None,
            ref_or_skill: None,
            subpath: None,
            skill_filter,
        });
    }

    // Full GitHub HTTPS URL.
    if let Some(rest) = s.strip_prefix("https://github.com/").or_else(|| s.strip_prefix("http://github.com/")) {
        let (path_part, hash_ref) = match rest.split_once('#') {
            Some((p, h)) if !h.is_empty() => (p, Some(h)),
            _ => (rest.split('?').next().unwrap_or(rest), None),
        };
        let parts: Vec<&str> = path_part.trim_matches('/').split('/').filter(|p| !p.is_empty()).collect();
        if parts.len() < 2 {
            return Err(IdeError::invalid("Expected https://github.com/<owner>/<repo>"));
        }
        let owner = parts[0];
        let repo = parts[1].strip_suffix(".git").unwrap_or(parts[1]);
        validate_repo_coord(owner, "owner")?;
        validate_repo_coord(repo, "repository")?;
        if parts.len() == 2 {
            if let Some(r) = hash_ref {
                validate_git_ref(r)?;
            }
            return Ok(ParsedSource {
                owner: owner.to_owned(),
                repo: repo.to_owned(),
                explicit_ref: hash_ref.map(str::to_owned),
                ref_or_skill: None,
                subpath: None,
                skill_filter: None,
            });
        }
        if matches!(parts[2], "tree" | "blob") {
            if parts.len() < 4 {
                return Err(IdeError::invalid("Expected https://github.com/<owner>/<repo>/tree/<ref>[/<path>]"));
            }
            let git_ref = parts[3];
            validate_git_ref(git_ref)?;
            let subpath = if parts.len() > 4 { normalize_subpath(&parts[4..].join("/"))? } else { None };
            return Ok(ParsedSource {
                owner: owner.to_owned(),
                repo: repo.to_owned(),
                explicit_ref: Some(git_ref.to_owned()),
                ref_or_skill: None,
                subpath,
                skill_filter: None,
            });
        }
        return Err(IdeError::invalid(
            "Unsupported GitHub URL path; use https://github.com/<owner>/<repo>[/tree/<ref>/<path>]",
        ));
    }

    if s.contains("://") {
        return Err(IdeError::invalid("Only GitHub (`owner/repo`) sources are supported"));
    }

    // Shorthand: `owner/repo[/subpath][@ref|#ref]` or `owner/repo@skill`.
    let (lhs, explicit_hash_ref) = match s.split_once('#') {
        Some((l, r)) => {
            validate_git_ref(r)?;
            (l, Some(r.to_owned()))
        }
        None => (s, None),
    };
    let (path_spec, at_suffix) = match lhs.rsplit_once('@') {
        Some((l, r)) if explicit_hash_ref.is_none() => {
            if r.is_empty() {
                return Err(IdeError::invalid("Missing ref or skill name after `@`"));
            }
            validate_git_ref(r)?;
            (l, Some(r.to_owned()))
        }
        _ => (lhs, None),
    };
    let segs: Vec<&str> = path_spec.trim_matches('/').split('/').filter(|p| !p.is_empty()).collect();
    if segs.len() < 2 {
        return Err(IdeError::invalid("Expected `<owner>/<repo>` (for example `vercel-labs/agent-skills`)"));
    }
    let owner = segs[0];
    let repo = segs[1].strip_suffix(".git").unwrap_or(segs[1]);
    validate_repo_coord(owner, "owner")?;
    validate_repo_coord(repo, "repository")?;
    let subpath = if segs.len() > 2 { normalize_subpath(&segs[2..].join("/"))? } else { None };

    // When a subpath is already present (`owner/repo/skills/foo@v1`), `@v1` is unambiguously a Git ref.
    // On bare `owner/repo@suffix`, `suffix` may be either a Git ref (`main`, `v1.0.0`) or a skill name (`find-skills`).
    let (explicit_ref, ref_or_skill) = if let Some(h) = explicit_hash_ref {
        (Some(h), None)
    } else if subpath.is_some() {
        (at_suffix, None)
    } else {
        (None, at_suffix)
    };

    Ok(ParsedSource {
        owner: owner.to_owned(),
        repo: repo.to_owned(),
        explicit_ref,
        ref_or_skill,
        subpath,
        skill_filter: None,
    })
}

fn valid_skill_name(name: &str) -> bool {
    (1..=64).contains(&name.len()) && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Resolves `source` and lists matching `SKILL.md` directories in the repository.
pub fn browse_skills(
    fetcher: &dyn SkillSourceFetcher,
    source: &str,
    cancel: &CancellationToken,
) -> IdeResult<RemoteSkillBrowseResult> {
    let parsed = parse_source(source)?;
    let (git_ref, tree, skill_filter) = if let Some(explicit_ref) = parsed.explicit_ref {
        let tree =
            fetcher.git_tree(RepoRef { owner: &parsed.owner, repo: &parsed.repo, git_ref: &explicit_ref }, cancel)?;
        (explicit_ref, tree, parsed.skill_filter)
    } else if let Some(suffix) = parsed.ref_or_skill {
        // Try `suffix` as a Git ref first; if absent, fall back to the default branch and treat `suffix` as a skill filter.
        match fetcher.git_tree(RepoRef { owner: &parsed.owner, repo: &parsed.repo, git_ref: &suffix }, cancel) {
            Ok(tree) => (suffix, tree, parsed.skill_filter),
            Err(_) => {
                if cancel.is_cancelled() {
                    return Err(IdeError::cancelled());
                }
                let default_branch = fetcher.default_branch(&parsed.owner, &parsed.repo, cancel)?;
                let tree = fetcher
                    .git_tree(RepoRef { owner: &parsed.owner, repo: &parsed.repo, git_ref: &default_branch }, cancel)?;
                (default_branch, tree, Some(suffix))
            }
        }
    } else {
        let default_branch = fetcher.default_branch(&parsed.owner, &parsed.repo, cancel)?;
        let tree =
            fetcher.git_tree(RepoRef { owner: &parsed.owner, repo: &parsed.repo, git_ref: &default_branch }, cancel)?;
        (default_branch, tree, parsed.skill_filter)
    };

    let mut skill_dirs: Vec<(String, String)> = Vec::new();
    for entry in &tree.tree {
        if entry.kind != "blob" {
            continue;
        }
        if entry.path == "SKILL.md" {
            let fallback = sanitize_repo_as_skill_name(&parsed.repo);
            skill_dirs.push((String::new(), fallback));
        } else if let Some(dir) = entry.path.strip_suffix("/SKILL.md")
            && let Some(folder) = dir.rsplit('/').next()
            && !folder.starts_with('.')
        {
            skill_dirs.push((dir.to_owned(), folder.to_owned()));
        }
    }

    let mut candidates = Vec::new();
    for (dir, folder_name) in skill_dirs {
        if let Some(sub) = parsed.subpath.as_deref()
            && dir != sub
            && !dir.starts_with(&format!("{sub}/"))
        {
            continue;
        }
        if let Some(filter) = skill_filter.as_deref()
            && !folder_name.eq_ignore_ascii_case(filter)
            && !dir.eq_ignore_ascii_case(filter)
        {
            continue;
        }
        let prefix = if dir.is_empty() { String::new() } else { format!("{dir}/") };
        let mut file_count = 0u32;
        let mut total_bytes = 0u64;
        for e in &tree.tree {
            if e.kind == "blob" && (dir.is_empty() || e.path.starts_with(&prefix)) {
                file_count = file_count.saturating_add(1);
                total_bytes = total_bytes.saturating_add(e.size.unwrap_or(0));
            }
        }
        candidates.push(RemoteSkillCandidate { folder_name, subpath: dir, file_count, total_bytes });
    }
    candidates.sort_by(|a, b| a.folder_name.cmp(&b.folder_name).then_with(|| a.subpath.cmp(&b.subpath)));

    if candidates.is_empty() {
        return Err(IdeError::not_found(format!("No SKILL.md found in {}/{} ({git_ref})", parsed.owner, parsed.repo)));
    }

    Ok(RemoteSkillBrowseResult {
        owner: parsed.owner,
        repo: parsed.repo,
        git_ref,
        tree_sha: tree.sha,
        truncated: tree.truncated,
        skills: candidates,
    })
}

fn sanitize_repo_as_skill_name(repo: &str) -> String {
    let mut out = String::new();
    for c in repo.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if (c == '-' || c == '_' || c == '.') && !out.ends_with('-') {
            out.push('-');
        }
        if out.len() >= 64 {
            break;
        }
    }
    out.trim_matches('-').to_owned()
}

struct PreparedSkillBundle {
    tree_sha: String,
    skill_name: String,
    description: String,
    skill_markdown: String,
    files: Vec<RemoteSkillFile>,
    scan_warnings: Vec<SkillScanWarning>,
    /// `(relative_path, bytes, executable)` for safe non-symlink files to write on disk;
    /// `in_root_symlinks` holds `(relative_path, relative_target)` for safe internal symlinks.
    regular_files: Vec<(PathBuf, Vec<u8>, bool)>,
    in_root_symlinks: Vec<(PathBuf, PathBuf)>,
}

fn fetch_and_scan_bundle(
    fetcher: &dyn SkillSourceFetcher,
    target: RepoRef<'_>,
    subpath: &str,
    cancel: &CancellationToken,
) -> IdeResult<PreparedSkillBundle> {
    let RepoRef { owner, repo, git_ref } = target;
    validate_repo_coord(owner, "owner")?;
    validate_repo_coord(repo, "repository")?;
    validate_git_ref(git_ref)?;
    let normalized_subpath = normalize_subpath(subpath)?.unwrap_or_default();

    let tree = fetcher.git_tree(target, cancel)?;
    let prefix = if normalized_subpath.is_empty() { String::new() } else { format!("{normalized_subpath}/") };

    let subtree_entries: Vec<&GitTreeEntry> = tree
        .tree
        .iter()
        .filter(|e| {
            e.kind == "blob" && if prefix.is_empty() { !e.path.is_empty() } else { e.path.starts_with(&prefix) }
        })
        .collect();

    if subtree_entries.is_empty() {
        return Err(IdeError::not_found(format!(
            "Skill path {:?} was not found in {owner}/{repo}@{git_ref}",
            normalized_subpath
        )));
    }
    if subtree_entries.len() > MAX_SKILL_FILES {
        return Err(IdeError::invalid(format!(
            "Skill exceeds maximum of {MAX_SKILL_FILES} files ({} found)",
            subtree_entries.len()
        )));
    }

    let declared_total: u64 = subtree_entries.iter().map(|e| e.size.unwrap_or(0)).sum();
    if declared_total > MAX_SKILL_SUBTREE_BYTES {
        return Err(IdeError::invalid(format!("Skill exceeds {} MiB size cap", MAX_SKILL_SUBTREE_BYTES >> 20)));
    }

    let mut files = Vec::with_capacity(subtree_entries.len());
    let mut scan_warnings = Vec::new();
    let mut regular_files = Vec::new();
    let mut in_root_symlinks = Vec::new();
    let mut skill_markdown: Option<String> = None;
    let mut actual_total = 0u64;

    for entry in subtree_entries {
        let rel_str = if prefix.is_empty() {
            entry.path.as_str()
        } else {
            entry.path.strip_prefix(&prefix).unwrap_or(entry.path.as_str())
        };
        let rel_path = validate_rel_skill_file(rel_str)?;
        let is_symlink = entry.mode == "120000";
        let is_exec_mode = entry.mode == "100755";

        let bytes = fetcher.read_blob(
            target,
            &entry.path,
            &entry.sha,
            MAX_SINGLE_BLOB_BYTES.min(MAX_SKILL_SUBTREE_BYTES - actual_total),
            cancel,
        )?;
        actual_total = actual_total.saturating_add(bytes.len() as u64);
        if actual_total > MAX_SKILL_SUBTREE_BYTES {
            return Err(IdeError::invalid(format!("Skill exceeds {} MiB size cap", MAX_SKILL_SUBTREE_BYTES >> 20)));
        }

        if is_symlink {
            let target_raw = String::from_utf8_lossy(&bytes).trim().to_owned();
            match resolve_in_root_symlink(&rel_path, &target_raw) {
                Some(safe_target) => {
                    in_root_symlinks.push((rel_path.clone(), safe_target));
                }
                None => {
                    scan_warnings.push(SkillScanWarning {
                        kind: SkillScanWarningKind::OutOfRootSymlink,
                        file: rel_str.to_owned(),
                        message: format!("Symlink target {target_raw:?} leaves the skill folder (omitted on install)"),
                    });
                }
            }
            files.push(RemoteSkillFile {
                path: rel_str.to_owned(),
                size: bytes.len() as u64,
                executable: false,
                symlink: true,
            });
            continue;
        }

        let has_shebang = bytes.starts_with(b"#!");
        let is_script_path = is_executable_or_script_path(&rel_path);
        if is_exec_mode || has_shebang || is_script_path {
            let reason = if is_exec_mode {
                "executable file mode (100755)"
            } else if has_shebang {
                "script with `#!` interpreter header"
            } else {
                "bundled script or native binary"
            };
            scan_warnings.push(SkillScanWarning {
                kind: SkillScanWarningKind::ExecutableScript,
                file: rel_str.to_owned(),
                message: format!("Contains {reason}"),
            });
        }

        if let Ok(text) = std::str::from_utf8(&bytes) {
            scan_hidden_unicode(rel_str, text, &mut scan_warnings);
            if rel_str == "SKILL.md" {
                skill_markdown = Some(text.to_owned());
            }
        } else if rel_str == "SKILL.md" {
            return Err(IdeError::invalid("SKILL.md is not valid UTF-8 text"));
        }

        files.push(RemoteSkillFile {
            path: rel_str.to_owned(),
            size: bytes.len() as u64,
            executable: is_exec_mode || has_shebang,
            symlink: false,
        });
        regular_files.push((rel_path, bytes, is_exec_mode));
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));
    regular_files.sort_by(|a, b| a.0.cmp(&b.0));

    let Some(skill_markdown) = skill_markdown else {
        return Err(IdeError::invalid("Selected folder does not contain a regular SKILL.md file"));
    };

    let folder_hint = normalized_subpath
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| sanitize_repo_as_skill_name(repo));

    let parsed_meta = parse_skill_markdown_metadata(&folder_hint, &skill_markdown)?;
    for tool in &parsed_meta.shell_tools {
        scan_warnings.push(SkillScanWarning {
            kind: SkillScanWarningKind::AllowedToolsShell,
            file: "SKILL.md".into(),
            message: format!("`allowed-tools` grants shell/command execution (`{tool}`)"),
        });
    }

    Ok(PreparedSkillBundle {
        tree_sha: tree.sha,
        skill_name: parsed_meta.name,
        description: parsed_meta.description,
        skill_markdown,
        files,
        scan_warnings,
        regular_files,
        in_root_symlinks,
    })
}

struct ParsedSkillMetadata {
    name: String,
    description: String,
    shell_tools: Vec<String>,
}

fn parse_skill_markdown_metadata(folder_hint: &str, markdown: &str) -> IdeResult<ParsedSkillMetadata> {
    let mut name: Option<String> = None;
    let mut description: Option<String> = None;
    let mut allowed_tools_raw: Vec<String> = Vec::new();

    let normalized = markdown.strip_prefix('\u{feff}').unwrap_or(markdown);
    if let Some(after_open) = normalized.strip_prefix("---\n").or_else(|| normalized.strip_prefix("---\r\n")) {
        let mut current_list_key: Option<String> = None;
        for raw_line in after_open.lines() {
            let trimmed_end = raw_line.trim_end_matches('\r');
            if matches!(trimmed_end.trim(), "---" | "...") {
                break;
            }
            let trimmed = trimmed_end.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            if (trimmed_end.starts_with(' ') || trimmed_end.starts_with('\t'))
                && let Some(item) = trimmed.strip_prefix('-')
            {
                if matches!(current_list_key.as_deref(), Some("allowed-tools" | "allowed_tools")) {
                    let val = unquote(item.trim());
                    if !val.is_empty() {
                        allowed_tools_raw.push(val.to_owned());
                    }
                }
                continue;
            }
            current_list_key = None;
            if let Some((k, v)) = trimmed.split_once(':') {
                let key = k.trim().to_ascii_lowercase();
                let val = unquote(v.trim());
                match key.as_str() {
                    "name" if !val.is_empty() => name = Some(val.to_owned()),
                    "description" if !val.is_empty() && !matches!(val, ">" | "|" | ">-" | "|-") => {
                        description = Some(val.to_owned());
                    }
                    "allowed-tools" | "allowed_tools" => {
                        if val.is_empty() {
                            current_list_key = Some(key);
                        } else {
                            let inner = val.strip_prefix('[').and_then(|s| s.strip_suffix(']')).unwrap_or(val);
                            for token in split_allowed_tools(inner) {
                                allowed_tools_raw.push(token);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    let skill_name = name.unwrap_or_else(|| folder_hint.to_owned());
    if !valid_skill_name(&skill_name) {
        return Err(IdeError::invalid(format!(
            "Skill name {skill_name:?} must be 1-64 lowercase letters, digits, or hyphens"
        )));
    }
    let description = description.unwrap_or_default();
    let shell_tools = allowed_tools_raw.into_iter().filter(|t| is_shell_tool_entry(t)).collect();
    Ok(ParsedSkillMetadata { name: skill_name, description, shell_tools })
}

fn split_allowed_tools(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut depth = 0usize;
    for ch in raw.chars() {
        match ch {
            '(' => {
                depth += 1;
                cur.push(ch);
            }
            ')' => {
                depth = depth.saturating_sub(1);
                cur.push(ch);
            }
            ',' | ' ' if depth == 0 => {
                let tok = unquote(cur.trim());
                if !tok.is_empty() {
                    out.push(tok.to_owned());
                }
                cur.clear();
            }
            _ => cur.push(ch),
        }
    }
    let tok = unquote(cur.trim());
    if !tok.is_empty() {
        out.push(tok.to_owned());
    }
    out
}

fn is_shell_tool_entry(entry: &str) -> bool {
    let head = entry.split(['(', ':', '/']).next().unwrap_or(entry).trim().to_ascii_lowercase();
    matches!(
        head.as_str(),
        "*" | "bash"
            | "sh"
            | "zsh"
            | "shell"
            | "terminal"
            | "cmd"
            | "powershell"
            | "pwsh"
            | "run_command"
            | "exec"
            | "execute"
    )
}

fn unquote(value: &str) -> &str {
    for q in ['"', '\''] {
        if let Some(inner) = value.strip_prefix(q).and_then(|v| v.strip_suffix(q)) {
            return inner;
        }
    }
    value
}

fn validate_rel_skill_file(rel: &str) -> IdeResult<PathBuf> {
    if rel.is_empty() || rel.contains('\\') {
        return Err(IdeError::invalid(format!("Invalid relative file path {rel:?}")));
    }
    let path = Path::new(rel);
    if !path.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(IdeError::invalid(format!("Path {rel:?} escapes the skill folder")));
    }
    Ok(path.to_path_buf())
}

/// Returns `Some(target_path)` only when `target_raw` is a relative link that stays strictly inside the skill root.
fn resolve_in_root_symlink(link_rel: &Path, target_raw: &str) -> Option<PathBuf> {
    if target_raw.is_empty()
        || target_raw.starts_with('/')
        || target_raw.starts_with('~')
        || target_raw.contains('\\')
        || target_raw.as_bytes().get(1) == Some(&b':')
    {
        return None;
    }
    let mut stack: Vec<&std::ffi::OsStr> = link_rel
        .parent()
        .map(|p| {
            p.components()
                .filter_map(|c| match c {
                    Component::Normal(s) => Some(s),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();
    for seg in target_raw.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                stack.pop()?;
            }
            _ => stack.push(std::ffi::OsStr::new(seg)),
        }
    }
    if stack.is_empty() {
        return None;
    }
    Some(PathBuf::from(target_raw))
}

fn is_executable_or_script_path(rel: &Path) -> bool {
    if rel.components().next().and_then(|c| c.as_os_str().to_str()) == Some("scripts") {
        return true;
    }
    rel.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|ext| SCRIPT_EXTENSIONS.iter().any(|s| ext.eq_ignore_ascii_case(s)))
}

fn is_hidden_or_bidi_unicode(ch: char, at_file_start: bool) -> Option<&'static str> {
    match ch {
        '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{061C}' | '\u{200E}' | '\u{200F}' => {
            Some("bidirectional control character")
        }
        '\u{200B}'..='\u{200D}' | '\u{2060}' => Some("zero-width character"),
        '\u{FEFF}' if !at_file_start => Some("zero-width no-break space"),
        '\u{E0000}'..='\u{E007F}' | '\u{E0100}'..='\u{E01EF}' => Some("invisible Unicode tag/variation character"),
        _ => None,
    }
}

fn scan_hidden_unicode(file: &str, text: &str, warnings: &mut Vec<SkillScanWarning>) {
    for (line_idx, line) in text.lines().enumerate() {
        for (char_idx, ch) in line.chars().enumerate() {
            let at_start = line_idx == 0 && char_idx == 0;
            if let Some(label) = is_hidden_or_bidi_unicode(ch, at_start) {
                warnings.push(SkillScanWarning {
                    kind: SkillScanWarningKind::HiddenUnicode,
                    file: file.to_owned(),
                    message: format!("Line {} contains {} (U+{:04X})", line_idx + 1, label, ch as u32),
                });
                // Report once per file to keep the warning list readable.
                return;
            }
        }
    }
}

/// Previews a single skill from `target` (`subpath`) and runs the static security scan.
pub fn preview_skill(
    fetcher: &dyn SkillSourceFetcher,
    target: RepoRef<'_>,
    subpath: &str,
    user_home: Option<&Path>,
    workspace_root: Option<&Path>,
    cancel: &CancellationToken,
) -> IdeResult<RemoteSkillPreview> {
    let RepoRef { owner, repo, git_ref } = target;
    let bundle = fetch_and_scan_bundle(fetcher, target, subpath, cancel)?;
    let already_installed_user = user_home.is_some_and(|h| h.join(".agents/skills").join(&bundle.skill_name).exists());
    let already_installed_workspace =
        workspace_root.is_some_and(|w| w.join(".agents/skills").join(&bundle.skill_name).exists());
    Ok(RemoteSkillPreview {
        owner: owner.to_owned(),
        repo: repo.to_owned(),
        git_ref: git_ref.to_owned(),
        tree_sha: bundle.tree_sha,
        subpath: normalize_subpath(subpath)?.unwrap_or_default(),
        skill_name: bundle.skill_name,
        description: bundle.description,
        skill_markdown: bundle.skill_markdown,
        files: bundle.files,
        scan_warnings: bundle.scan_warnings,
        already_installed_user,
        already_installed_workspace,
    })
}

/// Downloads only the skill's subtree, enforces static scan confirmation, and installs atomically
/// into `~/.agents/skills/<name>` (`McpScope::User`) or `<workspace>/.agents/skills/<name>` (`McpScope::Workspace`).
pub fn install_skill(
    fetcher: &dyn SkillSourceFetcher,
    req: &InstallRemoteSkillRequest,
    user_home: Option<&Path>,
    workspace_root: Option<&Path>,
    cancel: &CancellationToken,
) -> IdeResult<PathBuf> {
    let target_root = match req.scope {
        McpScope::User => {
            let home = user_home.ok_or_else(|| IdeError::unavailable("Cannot locate user home directory"))?;
            home.join(".agents").join("skills")
        }
        McpScope::Workspace => {
            let ws = workspace_root
                .ok_or_else(|| IdeError::invalid("Open a trusted project to install workspace skills"))?;
            ws.join(".agents").join("skills")
        }
    };

    let bundle = fetch_and_scan_bundle(
        fetcher,
        RepoRef { owner: &req.owner, repo: &req.repo, git_ref: &req.git_ref },
        &req.subpath,
        cancel,
    )?;
    if !bundle.scan_warnings.is_empty() && !req.confirm_warnings {
        return Err(IdeError::invalid(
            "Review and confirm the static security scan warnings before installing this skill",
        ));
    }

    std::fs::create_dir_all(&target_root)?;
    let final_dir = target_root.join(&bundle.skill_name);
    if final_dir.exists() && !req.overwrite {
        return Err(IdeError::new(
            ErrorKind::AlreadyExists,
            format!("Skill `{}` is already installed in {}", bundle.skill_name, target_root.display()),
        ));
    }

    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or_default();
    let staging = target_root.join(format!(".staging-{}-{nonce}-{}", bundle.skill_name, std::process::id()));
    let write_res = (|| -> IdeResult<()> {
        std::fs::create_dir_all(&staging)?;
        for (rel_path, bytes, is_exec) in &bundle.regular_files {
            let dest = staging.join(rel_path);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&dest, bytes)?;
            #[cfg(unix)]
            if *is_exec {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755));
            }
            #[cfg(not(unix))]
            let _ = is_exec;
        }
        for (rel_link, target) in &bundle.in_root_symlinks {
            let dest = staging.join(rel_link);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)?;
            }
            #[cfg(unix)]
            std::os::unix::fs::symlink(target, &dest)?;
            #[cfg(not(unix))]
            {
                let resolved = dest.parent().unwrap_or(&staging).join(target);
                if resolved.is_file() {
                    std::fs::copy(&resolved, &dest)?;
                }
            }
        }
        let backup = if final_dir.exists() {
            let bak = target_root.join(format!(".old-{}-{nonce}", bundle.skill_name));
            std::fs::rename(&final_dir, &bak)?;
            Some(bak)
        } else {
            None
        };
        if let Err(err) = std::fs::rename(&staging, &final_dir) {
            if let Some(bak) = backup {
                let _ = std::fs::rename(&bak, &final_dir);
            }
            return Err(err.into());
        }
        if let Some(bak) = backup {
            let _ = std::fs::remove_dir_all(bak);
        }
        Ok(())
    })();

    if write_res.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    write_res?;
    Ok(final_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    struct FakeFetcher {
        default_branch: String,
        trees: BTreeMap<String, GitTree>,
        blobs: BTreeMap<String, Vec<u8>>,
    }

    impl FakeFetcher {
        fn new() -> Self {
            Self { default_branch: "main".into(), trees: BTreeMap::new(), blobs: BTreeMap::new() }
        }

        fn add_tree(&mut self, git_ref: &str, entries: Vec<(&str, &str, &[u8])>) {
            let mut tree_entries = Vec::new();
            for (idx, (path, mode, content)) in entries.into_iter().enumerate() {
                let sha = format!("{idx:040x}");
                self.blobs.insert(sha.clone(), content.to_vec());
                tree_entries.push(GitTreeEntry {
                    path: path.to_owned(),
                    mode: mode.to_owned(),
                    kind: "blob".into(),
                    sha,
                    size: Some(content.len() as u64),
                });
            }
            self.trees.insert(
                git_ref.to_owned(),
                GitTree { sha: "deadbeef".repeat(5), truncated: false, tree: tree_entries },
            );
        }
    }

    impl SkillSourceFetcher for FakeFetcher {
        fn default_branch(&self, _owner: &str, _repo: &str, _cancel: &CancellationToken) -> IdeResult<String> {
            Ok(self.default_branch.clone())
        }

        fn git_tree(&self, target: RepoRef<'_>, _cancel: &CancellationToken) -> IdeResult<GitTree> {
            self.trees
                .get(target.git_ref)
                .cloned()
                .ok_or_else(|| IdeError::not_found(format!("unknown ref {}", target.git_ref)))
        }

        fn read_blob(
            &self,
            _target: RepoRef<'_>,
            repo_path: &str,
            blob_sha: &str,
            max_bytes: u64,
            _cancel: &CancellationToken,
        ) -> IdeResult<Vec<u8>> {
            let bytes = self.blobs.get(blob_sha).cloned().ok_or_else(|| IdeError::not_found(repo_path))?;
            if bytes.len() as u64 > max_bytes {
                return Err(IdeError::invalid("blob too large"));
            }
            Ok(bytes)
        }
    }

    #[test]
    fn parses_npx_skills_add_inputs_and_rejects_traversal() {
        let plain = parse_source("vercel-labs/agent-skills").unwrap();
        assert_eq!((plain.owner.as_str(), plain.repo.as_str(), plain.subpath), ("vercel-labs", "agent-skills", None));

        let at_skill = parse_source("vercel-labs/agent-skills@find-skills").unwrap();
        assert_eq!(at_skill.ref_or_skill.as_deref(), Some("find-skills"));

        let subpath_ref = parse_source("acme/skills/skills/tdd@v1.2.0").unwrap();
        assert_eq!(subpath_ref.subpath.as_deref(), Some("skills/tdd"));
        assert_eq!(subpath_ref.explicit_ref.as_deref(), Some("v1.2.0"));

        let gh_url = parse_source("https://github.com/acme/skills/tree/release/skills/tdd/SKILL.md").unwrap();
        assert_eq!(gh_url.explicit_ref.as_deref(), Some("release"));
        assert_eq!(gh_url.subpath.as_deref(), Some("skills/tdd"));

        let skills_sh = parse_source("https://skills.sh/vercel-labs/skills/find-skills").unwrap();
        assert_eq!((skills_sh.owner.as_str(), skills_sh.repo.as_str()), ("vercel-labs", "skills"));
        assert_eq!(skills_sh.skill_filter.as_deref(), Some("find-skills"));

        assert!(parse_source("acme/skills/../escape").is_err());
        assert!(parse_source("https://evil.example.com/acme/skills").is_err());
    }

    #[test]
    fn browses_filters_scans_and_installs_only_selected_subtree() {
        let mut fetcher = FakeFetcher::new();
        fetcher.add_tree(
            "main",
            vec![
                ("README.md", "100644", b"# Repo root README (must not be downloaded)\n"),
                (
                    "skills/clean-skill/SKILL.md",
                    "100644",
                    b"---\nname: clean-skill\ndescription: Clean markdown-only skill\n---\nFollow clean steps.\n",
                ),
                ("skills/clean-skill/references/guide.md", "100644", b"# Guide\n"),
                (
                    "skills/risky-skill/SKILL.md",
                    "100644",
                    "---\nname: risky-skill\ndescription: Runs deploy script\nallowed-tools:\n  - Bash(git:*)\n  - Read\n---\nHidden \u{202E}bidi text.\n".as_bytes(),
                ),
                ("skills/risky-skill/scripts/deploy.sh", "100755", b"#!/bin/sh\necho hi\n"),
                ("skills/risky-skill/escape-link", "120000", b"../../README.md"),
            ],
        );
        let cancel = CancellationToken::new();
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let ws = tmp.path().join("ws");

        // Bare `owner/repo` lists both skills; `owner/repo@clean-skill` falls back from ref lookup to skill filter!
        let all = browse_skills(&fetcher, "acme/skills", &cancel).unwrap();
        assert_eq!(all.skills.len(), 2);
        let filtered = browse_skills(&fetcher, "acme/skills@clean-skill", &cancel).unwrap();
        assert_eq!(filtered.skills.len(), 1);
        assert_eq!(filtered.skills[0].folder_name, "clean-skill");

        // Clean skill has 0 warnings and installs into ~/.agents/skills/clean-skill without touching repo root files.
        let clean_preview = preview_skill(
            &fetcher,
            RepoRef { owner: "acme", repo: "skills", git_ref: "main" },
            "skills/clean-skill",
            Some(&home),
            Some(&ws),
            &cancel,
        )
        .unwrap();
        assert!(clean_preview.scan_warnings.is_empty(), "{:?}", clean_preview.scan_warnings);
        assert_eq!(clean_preview.files.len(), 2);

        let installed_dir = install_skill(
            &fetcher,
            &InstallRemoteSkillRequest {
                owner: "acme".into(),
                repo: "skills".into(),
                git_ref: "main".into(),
                subpath: "skills/clean-skill".into(),
                scope: McpScope::User,
                confirm_warnings: false,
                overwrite: false,
            },
            Some(&home),
            Some(&ws),
            &cancel,
        )
        .unwrap();
        assert_eq!(installed_dir, home.join(".agents/skills/clean-skill"));
        assert!(installed_dir.join("SKILL.md").is_file());
        assert!(installed_dir.join("references/guide.md").is_file());
        assert!(!home.join(".agents/skills/README.md").exists());

        // Re-installing without `overwrite: true` is refused.
        let dup_err = install_skill(
            &fetcher,
            &InstallRemoteSkillRequest {
                owner: "acme".into(),
                repo: "skills".into(),
                git_ref: "main".into(),
                subpath: "skills/clean-skill".into(),
                scope: McpScope::User,
                confirm_warnings: false,
                overwrite: false,
            },
            Some(&home),
            Some(&ws),
            &cancel,
        )
        .unwrap_err();
        assert_eq!(dup_err.kind, ErrorKind::AlreadyExists);

        // Risky skill triggers all 4 static security scan categories and requires `confirm_warnings: true`.
        let risky_preview = preview_skill(
            &fetcher,
            RepoRef { owner: "acme", repo: "skills", git_ref: "main" },
            "skills/risky-skill",
            Some(&home),
            Some(&ws),
            &cancel,
        )
        .unwrap();
        let kinds: Vec<SkillScanWarningKind> = risky_preview.scan_warnings.iter().map(|w| w.kind).collect();
        assert!(kinds.contains(&SkillScanWarningKind::HiddenUnicode), "{kinds:?}");
        assert!(kinds.contains(&SkillScanWarningKind::OutOfRootSymlink), "{kinds:?}");
        assert!(kinds.contains(&SkillScanWarningKind::ExecutableScript), "{kinds:?}");
        assert!(kinds.contains(&SkillScanWarningKind::AllowedToolsShell), "{kinds:?}");

        let unconfirmed = install_skill(
            &fetcher,
            &InstallRemoteSkillRequest {
                owner: "acme".into(),
                repo: "skills".into(),
                git_ref: "main".into(),
                subpath: "skills/risky-skill".into(),
                scope: McpScope::Workspace,
                confirm_warnings: false,
                overwrite: false,
            },
            Some(&home),
            Some(&ws),
            &cancel,
        )
        .unwrap_err();
        assert!(unconfirmed.message.contains("confirm"), "{unconfirmed:?}");

        let ws_installed = install_skill(
            &fetcher,
            &InstallRemoteSkillRequest {
                owner: "acme".into(),
                repo: "skills".into(),
                git_ref: "main".into(),
                subpath: "skills/risky-skill".into(),
                scope: McpScope::Workspace,
                confirm_warnings: true,
                overwrite: false,
            },
            Some(&home),
            Some(&ws),
            &cancel,
        )
        .unwrap();
        assert_eq!(ws_installed, ws.join(".agents/skills/risky-skill"));
        assert!(ws_installed.join("SKILL.md").is_file());
        assert!(ws_installed.join("scripts/deploy.sh").is_file());
        assert!(!ws_installed.join("escape-link").exists(), "out-of-root symlink omitted on disk");
    }

    #[test]
    #[ignore = "hits live GitHub API"]
    fn live_github_browse_preview_and_install_smoke() {
        let fetcher = GitHubHttpFetcher::new(&ide_core::tool_path::search_path()).unwrap();
        let cancel = CancellationToken::new();
        let browsed = browse_skills(&fetcher, "l0ng-ai/openidea@verify", &cancel).unwrap();
        assert_eq!(browsed.skills.len(), 1);
        assert_eq!(browsed.skills[0].folder_name, "verify");

        let tmp = tempfile::tempdir().unwrap();
        let preview = preview_skill(
            &fetcher,
            RepoRef { owner: &browsed.owner, repo: &browsed.repo, git_ref: &browsed.git_ref },
            &browsed.skills[0].subpath,
            Some(tmp.path()),
            None,
            &cancel,
        )
        .unwrap();
        assert_eq!(preview.skill_name, "verify");
        assert!(preview.files.iter().any(|f| f.path == "SKILL.md"));

        let dest = install_skill(
            &fetcher,
            &InstallRemoteSkillRequest {
                owner: browsed.owner,
                repo: browsed.repo,
                git_ref: browsed.git_ref,
                subpath: browsed.skills[0].subpath.clone(),
                scope: McpScope::User,
                confirm_warnings: true,
                overwrite: false,
            },
            Some(tmp.path()),
            None,
            &cancel,
        )
        .unwrap();
        assert!(dest.join("SKILL.md").is_file());
    }
}
