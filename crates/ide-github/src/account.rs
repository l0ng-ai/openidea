//! The signed-in GitHub account, independent of any project: its repositories for
//! "Get from Version Control" › GitHub.

use crate::{GhAvailability, QUICK, classify_failure, command, gh_executable, process};
use serde::{Deserialize, Serialize};
use specta::Type;

/// A repository of the signed-in account (owned, collaborator, or organization member).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GhAccountRepo {
    /// `owner/name`.
    pub name_with_owner: String,
    pub description: Option<String>,
    pub private: bool,
    pub fork: bool,
    pub archived: bool,
    /// What `git clone` takes: HTTPS, or SSH when gh's `git_protocol` is `ssh`.
    pub clone_url: String,
}

/// The account's repositories, or why they can't be listed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum GhAccountRepos {
    Ready {
        login: String,
        repos: Vec<GhAccountRepo>,
    },
    /// No `gh` executable was found.
    NotInstalled,
    /// `gh auth login` has not been run (or the token expired).
    NotLoggedIn {
        message: String,
    },
    Error {
        message: String,
    },
}

#[derive(Deserialize)]
struct RestRepo {
    full_name: String,
    description: Option<String>,
    #[serde(default)]
    private: bool,
    #[serde(default)]
    fork: bool,
    #[serde(default)]
    archived: bool,
    clone_url: String,
    ssh_url: String,
}

/// `gh api --paginate --slurp user/repos` output: one array per page.
pub fn parse_account_repos(slurped: &str, ssh: bool) -> Result<Vec<GhAccountRepo>, serde_json::Error> {
    let pages: Vec<Vec<RestRepo>> = serde_json::from_str(slurped)?;
    Ok(pages
        .into_iter()
        .flatten()
        .map(|r| GhAccountRepo {
            name_with_owner: r.full_name,
            description: r.description.filter(|d| !d.trim().is_empty()),
            private: r.private,
            fork: r.fork,
            archived: r.archived,
            clone_url: if ssh { r.ssh_url } else { r.clone_url },
        })
        .collect())
}

/// Lists the repositories of the account gh is signed in to, most recently pushed first.
pub fn account_repositories() -> GhAccountRepos {
    if gh_executable().is_none() {
        return GhAccountRepos::NotInstalled;
    }
    let dir = std::env::temp_dir();
    let gh = |args: &[&str]| -> Result<String, GhAccountRepos> {
        let out = command(&dir, args)
            .and_then(|cmd| process::run(cmd, QUICK, None))
            .map_err(|e| GhAccountRepos::Error { message: e.message })?;
        if out.success {
            return Ok(out.stdout);
        }
        let message = if out.stderr.trim().is_empty() { out.stdout } else { out.stderr };
        Err(match classify_failure(&message) {
            GhAvailability::NotLoggedIn { message } => GhAccountRepos::NotLoggedIn { message },
            _ => GhAccountRepos::Error { message: message.trim().to_owned() },
        })
    };
    let result = (|| {
        let login = gh(&["api", "user", "--jq", ".login"])?.trim().to_owned();
        let ssh = gh(&["config", "get", "git_protocol", "--host", "github.com"]).is_ok_and(|p| p.trim() == "ssh");
        let pages = gh(&[
            "api",
            "user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member",
            "--paginate",
            "--slurp",
        ])?;
        let repos = parse_account_repos(&pages, ssh)
            .map_err(|e| GhAccountRepos::Error { message: format!("unexpected gh output: {e}") })?;
        Ok(GhAccountRepos::Ready { login, repos })
    })();
    result.unwrap_or_else(|e| e)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_every_page_and_picks_the_configured_protocol() {
        let pages = r#"[
          [{"full_name":"me/app","description":"An app","private":true,"fork":false,"archived":false,
            "clone_url":"https://github.com/me/app.git","ssh_url":"git@github.com:me/app.git"}],
          [{"full_name":"org/lib","description":"","fork":true,
            "clone_url":"https://github.com/org/lib.git","ssh_url":"git@github.com:org/lib.git"}]
        ]"#;
        let https = parse_account_repos(pages, false).unwrap();
        assert_eq!(
            https,
            vec![
                GhAccountRepo {
                    name_with_owner: "me/app".into(),
                    description: Some("An app".into()),
                    private: true,
                    fork: false,
                    archived: false,
                    clone_url: "https://github.com/me/app.git".into(),
                },
                GhAccountRepo {
                    name_with_owner: "org/lib".into(),
                    description: None,
                    private: false,
                    fork: true,
                    archived: false,
                    clone_url: "https://github.com/org/lib.git".into(),
                },
            ]
        );
        let ssh = parse_account_repos(pages, true).unwrap();
        assert_eq!(ssh[1].clone_url, "git@github.com:org/lib.git");
        assert!(parse_account_repos("[]", false).unwrap().is_empty());
    }
}
