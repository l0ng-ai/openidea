//! Project-scoped GitHub CLI (`gh`) account selection and opt-in `GH_TOKEN` injection.
//!
//! Each project may pin a GitHub login in `vcs.github.account` (`.openidea/settings.toml`) or
//! leave it empty (`Automatic`). `Automatic` leaves `gh`'s own behaviour untouched—no `GH_TOKEN`
//! is injected into [`ide_core::project_env`] and opening a project makes no GitHub API calls.
//! When the user inspects GitHub settings or Pull Requests with multiple `gh` keyring accounts,
//! OpenIDEA probes the repository remote (`owner/repo`) to suggest a matching non-active account
//! ("Use <login> for this project"). Only when an account is explicitly chosen does OpenIDEA
//! resolve its token into [`ide_core::project_env`] (for both `project.root` and `.worktrees`).

use crate::Project;
use ide_agent::GhAuthAccount;
use ide_core::cli_process::{CliTool, Decoding};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

const AMBIENT_GH_VARS: [&str; 3] = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];
const GH_TOOL: CliTool = CliTool::new("gh", Decoding::Utf8Lossy);
const LOCAL_TIMEOUT: Duration = Duration::from_secs(5);
const PROBE_TIMEOUT: Duration = Duration::from_secs(6);
const CACHE_TTL: Duration = Duration::from_secs(10 * 60);

/// GitHub CLI accounts available on this machine and which one applies to the project.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GhProjectAccountStatus {
    pub gh_installed: bool,
    pub accounts: Vec<GhAuthAccount>,
    /// Value of `vcs.github.account` (`""` = Automatic).
    pub configured_account: String,
    /// Account login currently used (`configured_account` if signed in, else `gh`'s active account).
    pub effective_account: Option<String>,
    /// Non-active `gh` account with access to this project's GitHub remote when `configured_account` is empty.
    pub suggested_account: Option<String>,
}

#[derive(Clone)]
struct CachedAutoAccount {
    login: Option<String>,
    at: Instant,
}

type AutoCacheMap = HashMap<(String, Vec<String>), CachedAutoAccount>;
static AUTO_CACHE: LazyLock<Mutex<AutoCacheMap>> = LazyLock::new(|| Mutex::new(HashMap::new()));

pub(crate) fn is_valid_github_login(login: &str) -> bool {
    let bytes = login.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 39
        && bytes[0].is_ascii_alphanumeric()
        && bytes.iter().all(|b| b.is_ascii_alphanumeric() || *b == b'-' || *b == b'_')
}

fn find_gh_executable() -> Option<PathBuf> {
    ide_core::tool_path::find_gh_executable()
}

fn clean_gh_command(program: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new(program);
    cmd.current_dir(std::env::temp_dir())
        .args(args)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .env("CLICOLOR", "0");
    // Strip ambient tokens by setting empty then removing after `prepare`: `CliTool::run` calls
    // `ide_core::process::prepare`, which skips keys already present in `cmd.get_envs()`.
    for key in AMBIENT_GH_VARS {
        cmd.env_remove(key);
    }
    cmd
}

fn gh_token_for_account(program: &Path, login: &str) -> Option<String> {
    if !is_valid_github_login(login) {
        return None;
    }
    let cmd = clean_gh_command(program, &["auth", "token", "--hostname", "github.com", "--user", login]);
    let out = GH_TOOL.run(cmd, LOCAL_TIMEOUT, None).ok().filter(|o| o.success)?;
    let token = out.stdout.trim();
    (!token.is_empty()).then(|| token.to_owned())
}

/// Access level of an account for a specific `owner/repo` on `github.com`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum RepoAccess {
    None = 0,
    Read = 1,
    Push = 2,
}

fn probe_repo_access(program: &Path, token: &str, owner: &str, name: &str) -> RepoAccess {
    let endpoint = format!("repos/{owner}/{name}");
    let mut cmd =
        clean_gh_command(program, &["api", "--hostname", "github.com", &endpoint, "--jq", ".permissions.push"]);
    cmd.env("GH_TOKEN", token);
    let Ok(out) = GH_TOOL.run(cmd, PROBE_TIMEOUT, None) else {
        return RepoAccess::None;
    };
    if !out.success {
        return RepoAccess::None;
    }
    if out.stdout.trim() == "true" { RepoAccess::Push } else { RepoAccess::Read }
}

fn pick_best_account(candidates: &[(GhAuthAccount, RepoAccess)]) -> Option<(&GhAuthAccount, bool)> {
    let active_access =
        candidates.iter().find(|(a, _)| a.active).map(|(_, access)| *access).unwrap_or(RepoAccess::None);
    // Prefer higher RepoAccess; break ties in favor of the globally active account.
    let (best, best_access) = candidates.iter().max_by_key(|(acc, access)| (*access, acc.active))?;
    if *best_access == RepoAccess::None {
        // Nobody could reach the repo (offline or SSO required): keep the active account.
        return candidates.iter().find(|(a, _)| a.active).or_else(|| candidates.first()).map(|(a, _)| (a, false));
    }
    let auto_detected = !best.active && *best_access > active_access;
    Some((best, auto_detected))
}

/// Parses `github.com` `(owner, repo)` from HTTPS, SSH, or SCP-style remote URLs.
pub(crate) fn parse_github_owner_repo(url: &str) -> Option<(String, String)> {
    let url = url.trim();
    let path = if let Some(rest) =
        url.strip_prefix("https://github.com/").or_else(|| url.strip_prefix("http://github.com/"))
    {
        rest
    } else if let Some(rest) = url.strip_prefix("ssh://") {
        rest.strip_prefix("git@github.com/").or_else(|| rest.strip_prefix("github.com/"))?
    } else {
        url.strip_prefix("git@github.com:")?
    };
    let path = path.trim_matches('/');
    let (owner, rest) = path.split_once('/')?;
    let repo = rest.split('/').next()?;
    let repo = repo.strip_suffix(".git").unwrap_or(repo);
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner.to_owned(), repo.to_owned()))
}

fn primary_github_repo(project: &Project) -> Option<(String, String)> {
    let repos = project.repos();
    let mut ordered = Vec::new();
    if let Some(primary) = repos.primary() {
        ordered.push(primary);
    }
    for repo in repos.all() {
        if ordered.first().is_none_or(|p| p.root() != repo.root()) {
            ordered.push(repo);
        }
    }
    for repo in ordered {
        let Ok(mut remotes) = repo.remotes() else { continue };
        remotes.sort_by_key(|r| r.name != "origin");
        for remote in remotes {
            let url = remote.resolved_url.as_deref().unwrap_or(&remote.url);
            if let Some(coords) = parse_github_owner_repo(url) {
                return Some(coords);
            }
        }
    }
    None
}

fn auto_detect_account(program: &Path, accounts: &[GhAuthAccount], owner: &str, repo: &str) -> Option<(String, bool)> {
    // Fast path: the repository owner matches one of the signed-in accounts directly.
    if let Some(matched) = accounts.iter().find(|a| a.login.eq_ignore_ascii_case(owner)) {
        return Some((matched.login.clone(), !matched.active));
    }
    let key_repo = format!("{}/{}", owner.to_ascii_lowercase(), repo.to_ascii_lowercase());
    let key_logins: Vec<String> = accounts.iter().map(|a| format!("{}:{}", a.login, a.active)).collect();
    let cache_key = (key_repo, key_logins);
    if let Some(cached) = AUTO_CACHE.lock().get(&cache_key).cloned()
        && cached.at.elapsed() < CACHE_TTL
    {
        if let Some(login) = cached.login {
            let is_active = accounts.iter().any(|a| a.login == login && a.active);
            return Some((login, !is_active));
        }
        return None;
    }

    let tokens: Vec<(GhAuthAccount, Option<String>)> =
        accounts.iter().map(|acc| (acc.clone(), gh_token_for_account(program, &acc.login))).collect();
    let results: Vec<(GhAuthAccount, RepoAccess)> = std::thread::scope(|s| {
        let handles: Vec<_> = tokens
            .into_iter()
            .map(|(acc, token)| {
                s.spawn(move || {
                    let access = match token {
                        Some(tok) => probe_repo_access(program, &tok, owner, repo),
                        None => RepoAccess::None,
                    };
                    (acc, access)
                })
            })
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    });
    let picked = pick_best_account(&results).map(|(acc, auto)| (acc.login.clone(), auto));
    AUTO_CACHE
        .lock()
        .insert(cache_key, CachedAutoAccount { login: picked.as_ref().map(|(l, _)| l.clone()), at: Instant::now() });
    picked
}

/// Resolves global status when no project is open.
pub fn global_status(configured_account: String) -> GhProjectAccountStatus {
    let configured_account = configured_account.trim().to_owned();
    let (gh_installed, accounts) = ide_agent::gh_authenticated_accounts();
    let effective_account = if !configured_account.is_empty() {
        accounts.iter().any(|a| a.login == configured_account).then(|| configured_account.clone())
    } else {
        accounts.iter().find(|a| a.active).or_else(|| accounts.first()).map(|a| a.login.clone())
    };
    GhProjectAccountStatus { gh_installed, accounts, configured_account, effective_account, suggested_account: None }
}

/// Applies the project's explicit `vcs.github.account` setting to [`ide_core::project_env`]
/// without making any network requests. `Automatic` (`""`) clears any injected `GH_TOKEN` so
/// processes use `gh`'s own behaviour.
pub fn apply_to_project(project: &Project) {
    if project.light || !project.is_trusted() {
        clear_project_env(project);
        return;
    }
    let configured_account = project.settings.effective().vcs.github.account.trim().to_owned();
    if configured_account.is_empty() {
        set_project_token(project, None);
        return;
    }
    let token = find_gh_executable().and_then(|program| gh_token_for_account(&program, &configured_account));
    set_project_token(project, token);
}

/// Applies the project's explicit account setting and returns the full account status,
/// probing the project's GitHub remote to suggest a matching non-active `gh` account when
/// `vcs.github.account` is `Automatic` (`""`) and multiple `gh` accounts are signed in.
pub fn project_status(project: &Project) -> GhProjectAccountStatus {
    let configured_account = project.settings.effective().vcs.github.account.trim().to_owned();
    if project.light || !project.is_trusted() {
        clear_project_env(project);
        return GhProjectAccountStatus { configured_account, ..GhProjectAccountStatus::default() };
    }
    apply_to_project(project);
    let Some(program) = find_gh_executable() else {
        return GhProjectAccountStatus { configured_account, ..GhProjectAccountStatus::default() };
    };
    let (gh_installed, accounts) = ide_agent::gh_authenticated_accounts();
    let active_login = accounts.iter().find(|a| a.active).or_else(|| accounts.first()).map(|a| a.login.clone());

    let effective_account = if !configured_account.is_empty() {
        accounts.iter().any(|a| a.login == configured_account).then(|| configured_account.clone())
    } else {
        active_login
    };

    let suggested_account = if configured_account.is_empty() && accounts.len() >= 2 {
        primary_github_repo(project)
            .and_then(|(owner, repo)| auto_detect_account(&program, &accounts, &owner, &repo))
            .and_then(|(login, non_active_match)| non_active_match.then_some(login))
    } else {
        None
    };

    GhProjectAccountStatus { gh_installed, accounts, configured_account, effective_account, suggested_account }
}

fn set_project_token(project: &Project, token: Option<String>) {
    let os_tok = token.map(std::ffi::OsString::from);
    let changed_root = ide_core::project_env::set_github_token(&project.root, os_tok.clone());
    let changed_wt = ide_core::project_env::set_github_token(project.agents.worktrees_dir(), os_tok);
    if changed_root || changed_wt {
        project.agents.notify_mcp_servers_changed();
    }
}

pub fn clear_project_env(project: &Project) {
    ide_core::project_env::remove_all(&project.root);
    ide_core::project_env::remove_all(project.agents.worktrees_dir());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_github_owner_repo_across_https_ssh_and_scp_remotes() {
        assert_eq!(
            parse_github_owner_repo("https://github.com/l0ng-ai/openidea.git"),
            Some(("l0ng-ai".into(), "openidea".into()))
        );
        assert_eq!(
            parse_github_owner_repo("git@github.com:acme-corp/payments.git"),
            Some(("acme-corp".into(), "payments".into()))
        );
        assert_eq!(parse_github_owner_repo("ssh://git@github.com/alice/demo/"), Some(("alice".into(), "demo".into())));
        assert_eq!(parse_github_owner_repo("https://gitlab.com/foo/bar.git"), None);
    }

    #[test]
    fn validates_github_logins_against_flag_injection() {
        assert!(is_valid_github_login("alice"));
        assert!(is_valid_github_login("alice-work"));
        assert!(is_valid_github_login("l0ng-ai"));
        assert!(!is_valid_github_login(""));
        assert!(!is_valid_github_login("--hostname"));
        assert!(!is_valid_github_login("bad space"));
    }

    #[test]
    fn picks_account_with_push_or_private_access_and_preserves_active_on_ties() {
        let personal = GhAuthAccount { login: "alice".into(), active: true };
        let work = GhAuthAccount { login: "alice-work".into(), active: false };

        // Private org repo: personal gets 404 (None), work gets Push -> auto-detects work.
        let private_org = vec![(personal.clone(), RepoAccess::None), (work.clone(), RepoAccess::Push)];
        let (picked, auto) = pick_best_account(&private_org).unwrap();
        assert_eq!(picked.login, "alice-work");
        assert!(auto);

        // Public org repo: personal gets Read, work gets Push -> auto-detects work.
        let public_org = vec![(personal.clone(), RepoAccess::Read), (work.clone(), RepoAccess::Push)];
        let (picked, auto) = pick_best_account(&public_org).unwrap();
        assert_eq!(picked.login, "alice-work");
        assert!(auto);

        // Third-party public repo: both get Read -> keeps active personal account without auto flag.
        let oss = vec![(personal.clone(), RepoAccess::Read), (work.clone(), RepoAccess::Read)];
        let (picked, auto) = pick_best_account(&oss).unwrap();
        assert_eq!(picked.login, "alice");
        assert!(!auto);
    }
}
