//! Remotes and arbitrary-ref fetches, for hosting integrations (pull requests):
//! fetching `refs/pull/<n>/head`, comparing two fetched revisions.

use crate::cli;
use crate::{ChangedFile, Repo};
use ide_core::{CancellationToken, IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub name: String,
    /// Fetch URL.
    pub url: String,
}

fn check_rev(rev: &str) -> IdeResult<()> {
    if rev.trim().is_empty() || rev.starts_with('-') {
        Err(IdeError::invalid(format!("invalid revision `{rev}`")))
    } else {
        Ok(())
    }
}

/// Parses `git remote -v` (fetch URLs only, in order).
pub(crate) fn parse_remotes(text: &str) -> Vec<Remote> {
    let mut out: Vec<Remote> = Vec::new();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let (Some(name), Some(url), kind) = (parts.next(), parts.next(), parts.next()) else { continue };
        if kind.is_some_and(|k| k != "(fetch)") || out.iter().any(|r| r.name == name) {
            continue;
        }
        out.push(Remote { name: name.to_owned(), url: url.to_owned() });
    }
    out
}

impl Repo {
    /// Configured remotes with their fetch URLs.
    pub fn remotes(&self) -> IdeResult<Vec<Remote>> {
        let _scope = crate::ExecutionScope::enter(self.execution_allowed.load(std::sync::atomic::Ordering::Acquire));
        let out = cli::run(self.root(), &["remote", "-v"], None)?;
        Ok(parse_remotes(&out.stdout_str()))
    }

    /// Whether `rev` names a commit present in the object database.
    pub fn has_commit(&self, rev: &str) -> bool {
        let _scope = crate::ExecutionScope::enter(self.execution_allowed.load(std::sync::atomic::Ordering::Acquire));
        check_rev(rev).is_ok()
            && cli::run_raw(self.root(), &["cat-file", "-e", &format!("{rev}^{{commit}}")], None)
                .is_ok_and(|o| o.code == Some(0))
    }

    /// Fetches `refspecs` from `remote` without touching remote-tracking branches
    /// (objects and `FETCH_HEAD` only), e.g. `refs/pull/12/head`.
    pub fn fetch_refspecs(
        &self,
        remote: &str,
        refspecs: &[String],
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<()> {
        let _scope = crate::ExecutionScope::enter(self.execution_allowed.load(std::sync::atomic::Ordering::Acquire));
        check_rev(remote)?;
        for r in refspecs {
            check_rev(r)?;
        }
        let mut args = vec!["fetch", "--progress", "--no-tags", "--no-write-fetch-head", remote];
        args.extend(refspecs.iter().map(String::as_str));
        cli::run_streaming(self.root(), &args, cancel, on_output)
    }

    /// The best common ancestor of two revisions, if any.
    pub fn merge_base(&self, a: &str, b: &str) -> IdeResult<Option<String>> {
        let _scope = crate::ExecutionScope::enter(self.execution_allowed.load(std::sync::atomic::Ordering::Acquire));
        check_rev(a)?;
        check_rev(b)?;
        let out = cli::run_raw(self.root(), &["merge-base", a, b], None)?;
        Ok((out.code == Some(0)).then(|| out.stdout_str().trim().to_owned()).filter(|s| !s.is_empty()))
    }

    /// Files changed between two revisions (renames detected).
    pub fn diff_files(&self, from: &str, to: &str) -> IdeResult<Vec<ChangedFile>> {
        let _scope = crate::ExecutionScope::enter(self.execution_allowed.load(std::sync::atomic::Ordering::Acquire));
        check_rev(from)?;
        check_rev(to)?;
        let out = cli::run(
            self.root(),
            &["diff", "--name-status", "-z", "-M", "--no-ext-diff", "--no-textconv", from, to, "--"],
            None,
        )?;
        Ok(crate::ops::parse_name_status(&out.stdout_str()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remotes_take_fetch_urls_once() {
        let text = "origin\tgit@github.com:me/app.git (fetch)\norigin\tgit@github.com:me/app.git (push)\n\
                    upstream\thttps://github.com/org/app (fetch)\nupstream\tno_push (push)\n";
        assert_eq!(
            parse_remotes(text),
            [
                Remote { name: "origin".into(), url: "git@github.com:me/app.git".into() },
                Remote { name: "upstream".into(), url: "https://github.com/org/app".into() },
            ]
        );
    }

    #[test]
    fn rejects_option_like_revisions() {
        assert!(check_rev("--upload-pack=x").is_err());
        assert!(check_rev(" ").is_err());
        assert!(check_rev("refs/pull/1/head").is_ok());
    }
}
