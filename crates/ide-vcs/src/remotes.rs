//! Remotes and arbitrary-ref fetches, for hosting integrations (pull requests):
//! fetching `refs/pull/<n>/head`, comparing two fetched revisions.

use crate::cli;
use crate::{ChangedFile, Repo};
use gix::bstr::ByteSlice;
use ide_core::error::ErrorKind;
use ide_core::workflow_settings::FetchTagsMode;
use ide_core::{CancellationToken, IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashSet;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub name: String,
    /// Fetch URL.
    pub url: String,
    /// Fetch URL with any `~/.ssh/config` host alias resolved, when different from `url`.
    #[serde(default)]
    pub resolved_url: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct FetchReport {
    pub remotes: Vec<FetchRemoteResult>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct FetchRemoteResult {
    pub remote: String,
    pub pruned: Vec<String>,
    pub error: Option<IdeError>,
}

fn pruned_ref(line: &str) -> Option<&str> {
    // Git emits human-readable status in the C locale, including when submodule fetch is enabled.
    let deleted = line.trim_ascii_start().strip_prefix('-')?.trim_ascii_start().strip_prefix("[deleted]")?;
    let (from, to) = deleted.split_once("->")?;
    let to = to.trim_ascii();
    (from.trim_ascii() == "(none)" && !to.is_empty() && !to.bytes().any(|byte| byte.is_ascii_whitespace()))
        .then_some(to)
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
        let Some((name, url)) = line.split_once('\t') else { continue };
        let Some(url) = url.strip_suffix(" (fetch)") else { continue };
        if out.iter().any(|r| r.name == name) {
            continue;
        }
        out.push(Remote { name: name.to_owned(), url: url.to_owned(), resolved_url: None });
    }
    out
}

pub(crate) fn fetch_tag_args(mode: FetchTagsMode, prune: bool) -> Vec<&'static str> {
    let mut args = Vec::new();
    if prune || mode == FetchTagsMode::Sync {
        args.push("--prune");
    }
    args.extend(match mode {
        FetchTagsMode::Auto => &[][..],
        FetchTagsMode::Sync => &["--prune-tags"][..],
        FetchTagsMode::Always => &["--tags", "--no-prune-tags"][..],
        FetchTagsMode::Never => &["--no-tags", "--no-prune-tags"][..],
    });
    args
}

/// Pull forwards --tags and --prune, but reads tag pruning from Git configuration.
pub(crate) fn pull_tag_config(r: &Repo, mode: FetchTagsMode) -> IdeResult<Vec<String>> {
    let prune = match mode {
        FetchTagsMode::Auto => return Ok(Vec::new()),
        FetchTagsMode::Sync => "true",
        FetchTagsMode::Always | FetchTagsMode::Never => "false",
    };
    let mut config = vec![format!("fetch.pruneTags={prune}")];
    let repo = r.gix()?;
    if let Some(remote) = repo.head_name().map_err(crate::repo::gx)?.and_then(|head| {
        let branch = head.as_ref().shorten().to_str_lossy();
        repo.branch_remote_name(branch.as_ref(), gix::remote::Direction::Fetch)
    }) {
        config.push(format!("remote.{}.pruneTags={prune}", remote.as_bstr().to_str_lossy()));
    }
    Ok(config)
}

impl Repo {
    /// Whether any remotes are configured, even before their branches have been fetched.
    pub fn has_remotes(&self) -> IdeResult<bool> {
        Ok(!self.gix()?.remote_names().is_empty())
    }

    /// Configured remotes with their fetch URLs.
    pub fn remotes(&self) -> IdeResult<Vec<Remote>> {
        let _scope = self.execution_scope();
        let out = cli::run(self.root(), &["remote", "-v"], None)?;
        Ok(parse_remotes(&out.stdout_str()))
    }

    /// Refreshes only the selected remote's tracking branches.
    pub fn fetch_remote(&self, remote: &str, cancel: &CancellationToken, on_output: &dyn Fn(String)) -> IdeResult<()> {
        self.fetch_with_tags(Some(remote), FetchTagsMode::Auto, cancel, on_output)
    }

    /// Fetches the named remote, or all remotes, using the project's tag policy.
    pub fn fetch_with_tags(
        &self,
        remote: Option<&str>,
        mode: FetchTagsMode,
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<()> {
        let _scope = self.execution_scope();
        let mut args = vec!["fetch", "--progress"];
        args.extend(fetch_tag_args(mode, true));
        if let Some(remote) = remote {
            if !self.gix()?.remote_names().iter().any(|name| name.as_bstr() == remote) {
                return Err(IdeError::invalid("Unknown remote"));
            }
            args.extend(["--", remote]);
        } else {
            args.push("--all");
        }
        cli::run_streaming(self.root(), &args, cancel, on_output)
    }

    /// Interactive fetch. Each remote is attempted even if another fails, so the caller can
    /// report both the actual deletions and the failures for this repository.
    pub fn fetch_report(
        &self,
        remote: Option<&str>,
        mode: FetchTagsMode,
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<FetchReport> {
        self.fetch_remotes_report(remote, mode, None, cancel, on_output)
    }

    /// Fetches the project's remotes without asking for new credentials.
    pub fn fetch_in_background(
        &self,
        skip: &[String],
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<FetchReport> {
        self.fetch_remotes_report(None, FetchTagsMode::Auto, Some(skip), cancel, on_output)
    }

    fn fetch_remotes_report(
        &self,
        remote: Option<&str>,
        mode: FetchTagsMode,
        background_skip: Option<&[String]>,
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<FetchReport> {
        let _scope = self.execution_scope();
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let mut remotes = if let Some(remote) = remote {
            if !self.gix()?.remote_names().iter().any(|name| name.as_bstr() == remote) {
                return Err(IdeError::invalid("Unknown remote"));
            }
            vec![remote.to_owned()]
        } else {
            self.fetch_all_remotes()?
        };
        if let Some(skip) = background_skip {
            remotes.retain(|name| !skip.contains(name));
        }

        let mut results = Vec::with_capacity(remotes.len());
        let mut base_args = vec!["fetch", "--progress"];
        base_args.extend(fetch_tag_args(mode, true));
        for (i, remote) in remotes.iter().enumerate() {
            let mut args = base_args.clone();
            if i > 0 {
                args.push("--append");
            }
            if remotes.len() > 1 {
                on_output(format!("Fetching {remote}"));
            }
            args.extend(["--", remote]);
            let mut pruned = Vec::new();
            let mut capture = |line: &str| {
                if let Some(reference) = pruned_ref(line) {
                    pruned.push(reference.to_owned());
                }
            };
            let result = cli::run_streaming_stderr(
                self.root(),
                &args,
                cancel,
                on_output,
                &mut capture,
                background_skip.is_some(),
            );
            let error = result.err();
            if error.as_ref().is_some_and(|error| error.kind == ErrorKind::Cancelled) {
                return Err(IdeError::cancelled());
            }
            if error.is_some() && !pruned.is_empty() {
                // Git can print a deletion before discovering that the ref could not be removed.
                let repo = self.gix();
                pruned.retain(|name| {
                    repo.as_ref().is_ok_and(|repo| repo.try_find_reference(name.as_str()).is_ok_and(|r| r.is_none()))
                });
            }
            results.push(FetchRemoteResult { remote: remote.clone(), pruned, error });
        }
        Ok(FetchReport { remotes: results })
    }

    fn fetch_all_remotes(&self) -> IdeResult<Vec<String>> {
        // Keep Git's configuration order since multiple remotes can update the same tags.
        let args = ["config", "--null", "--get-regexp", r"^remote\..+\.[^.]+$"];
        let output = cli::run_raw(self.root(), &args, None)?;
        if output.code != Some(0) && !(output.code == Some(1) && output.stderr.is_empty()) {
            return Err(cli::failure(&args, &output.stderr, b"", output.code));
        }
        let config = output.stdout_str();
        let mut remotes = Vec::new();
        let mut seen = HashSet::new();
        let mut skipped = HashSet::new();
        for item in config.split('\0') {
            let (key, value) = item.split_once('\n').map_or((item, None), |(key, value)| (key, Some(value)));
            let Some((name, setting)) = key.strip_prefix("remote.").and_then(|key| key.rsplit_once('.')) else {
                continue;
            };
            if name.starts_with('/') {
                continue;
            }
            if seen.insert(name) {
                remotes.push(name);
            }
            if !matches!(setting, "skipfetchall" | "skipdefaultupdate") {
                continue;
            }
            let skip = value
                .map(gix::config::Boolean::try_from)
                .transpose()
                .map_err(|error| IdeError::invalid(format!("{key}: {error}")))?
                .is_none_or(gix::config::Boolean::is_true);
            if skip {
                skipped.insert(name);
            } else {
                skipped.remove(name);
            }
        }
        Ok(remotes.into_iter().filter(|name| !skipped.contains(name)).map(str::to_owned).collect())
    }

    /// Whether `rev` names a commit present in the object database.
    pub fn has_commit(&self, rev: &str) -> bool {
        let _scope = self.execution_scope();
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
        let _scope = self.execution_scope();
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
        let _scope = self.execution_scope();
        check_rev(a)?;
        check_rev(b)?;
        let out = cli::run_raw(self.root(), &["merge-base", a, b], None)?;
        Ok((out.code == Some(0)).then(|| out.stdout_str().trim().to_owned()).filter(|s| !s.is_empty()))
    }

    /// Files changed between two revisions (renames detected).
    pub fn diff_files(&self, from: &str, to: &str) -> IdeResult<Vec<ChangedFile>> {
        let _scope = self.execution_scope();
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
                    upstream/test\tC:/Git Remote/app.git (fetch)\nupstream/test\tno_push (push)\n";
        assert_eq!(
            parse_remotes(text),
            [
                Remote { name: "origin".into(), url: "git@github.com:me/app.git".into(), resolved_url: None },
                Remote { name: "upstream/test".into(), url: "C:/Git Remote/app.git".into(), resolved_url: None },
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
