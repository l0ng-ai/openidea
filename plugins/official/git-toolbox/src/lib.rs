//! Git Toolbox for OpenIDEA: background fetch of every open project's
//! repository (on the plugin's `on-schedule`, which also fires after the
//! instance was reclaimed while idle), and the focused file's branch with
//! its ahead/behind counts in the status bar.

use openidea_plugin::host::{self, storage};
use openidea_plugin::{
    Error, Event, Invocation, NotificationLevel, Plugin, Project, RepositoryStatus, StatusItem, register_plugin,
};

const ITEM: &str = "branch";
const LAST_FETCH: &str = "last-fetch:";
/// Root of the project shown in the status bar.
const SHOWN: &str = "shown-root";

#[derive(Default)]
pub struct GitToolbox {
    /// The focused editor's file path, from the last `editor-focused` event.
    /// Kept across events: the status bar keeps following that file's
    /// repository until another file takes focus.
    focused: Option<String>,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// `main ↑1 ↓2`; a detached HEAD shows its commit.
pub fn label(s: &RepositoryStatus) -> String {
    let mut out = match (&s.branch, &s.commit) {
        (Some(b), _) => b.clone(),
        (None, Some(c)) => c.chars().take(8).collect(),
        (None, None) => "(no commits)".to_owned(),
    };
    if s.upstream.is_some() {
        if s.ahead > 0 {
            out.push_str(&format!(" ↑{}", s.ahead));
        }
        if s.behind > 0 {
            out.push_str(&format!(" ↓{}", s.behind));
        }
    }
    if let Some(op) = &s.operation {
        out.push_str(&format!(" ({op})"));
    }
    out
}

fn ago(secs: u64) -> String {
    match secs {
        0..60 => "just now".into(),
        60..3600 => format!("{} min ago", secs / 60),
        _ => format!("{} h ago", secs / 3600),
    }
}

fn tooltip(s: &RepositoryStatus) -> String {
    let mut lines = vec![s.root.clone()];
    match &s.upstream {
        Some(up) => lines.push(format!("{} ahead, {} behind {up}", s.ahead, s.behind)),
        None => lines.push("No upstream branch".into()),
    }
    if s.changed_files > 0 {
        lines.push(format!("{} changed files", s.changed_files));
    }
    let last = storage::get(&format!("{LAST_FETCH}{}", s.root)).ok().flatten().and_then(|v| v.parse::<u64>().ok());
    lines.push(match last {
        Some(t) => format!("Fetched {}", ago(now_secs().saturating_sub(t))),
        None => "Not fetched yet".into(),
    });
    lines.push("Click to fetch now".into());
    lines.join("\n")
}

/// Shows the first of `projects` that has a repository in the status bar (the
/// item hides when none has). Returns the index of the one shown.
fn show(projects: &[Project]) -> Result<Option<usize>, Error> {
    for (i, project) in projects.iter().enumerate() {
        if let Some(s) = project.vcs_status()? {
            let _ = storage::set(SHOWN, &project.root()?);
            host::set_status_item(
                ITEM,
                &StatusItem { text: label(&s), tooltip: Some(tooltip(&s)), command: Some("fetch".into()) },
            );
            return Ok(Some(i));
        }
    }
    host::remove_status_item(ITEM);
    Ok(None)
}

impl GitToolbox {
    /// The projects the status bar may follow, most specific first: the
    /// focused file's repository (a workspace window's project is the
    /// container folder, and its focused files belong to member
    /// repositories), the invoking window's, the one shown last, else the
    /// first open one.
    fn candidates(&self, ctx: &Invocation) -> Vec<Project> {
        let mut out: Vec<Project> = Vec::new();
        let editor = ctx.editor().map(|e| e.path());
        let mut push = |project: Option<Project>| {
            if let Some(p) = project
                && let Ok(root) = p.root()
                && out.iter().all(|q| q.root() != Ok(root.clone()))
            {
                out.push(p);
            }
        };
        push(self.focused.as_deref().or(editor.as_deref()).and_then(host::project_of));
        push(ctx.project());
        let projects = host::projects().unwrap_or_default();
        let shown = storage::get(SHOWN).ok().flatten();
        let index = projects.iter().position(|p| p.root().ok().as_deref() == shown.as_deref()).unwrap_or(0);
        let mut rest = projects;
        if index < rest.len() {
            push(Some(rest.swap_remove(index)));
        }
        out
    }
}

/// Fetches `projects` in one cancellable task. Returns how many were fetched.
fn fetch(projects: &[Project]) -> Result<usize, Error> {
    let task = host::begin_task("Fetching", true);
    let total = projects.len() as u32;
    let mut fetched = 0;
    let mut last_error = None;
    for (i, p) in projects.iter().enumerate() {
        if task.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let root = p.root()?;
        let name = root.rsplit(['/', '\\']).next().unwrap_or(&root).to_owned();
        task.report(i as u32, Some(total), Some(&name));
        if p.vcs_status()?.is_none() {
            continue;
        }
        match p.vcs_fetch() {
            Ok(()) => {
                fetched += 1;
                let _ = storage::set(&format!("{LAST_FETCH}{root}"), &now_secs().to_string());
            }
            Err(Error::Cancelled) => return Err(Error::Cancelled),
            Err(e) => {
                host::log(openidea_plugin::LogLevel::Warn, &format!("fetch {root}: {e}"));
                last_error = Some(e);
            }
        }
    }
    task.report(total, Some(total), None);
    match last_error {
        Some(e) if fetched == 0 => Err(e),
        _ => Ok(fetched),
    }
}

impl Plugin for GitToolbox {
    fn run_command(&mut self, id: &str, ctx: &Invocation, _arg: Option<&str>) -> Result<Option<String>, Error> {
        let projects = self.candidates(ctx);
        if projects.is_empty() {
            return Err("no project is open".into());
        }
        match id {
            "fetch" => {
                // Only the repository the status bar shows, not every candidate.
                let Some(i) = show(&projects)? else {
                    return Ok(Some("The project is not in a git repository.".to_owned()));
                };
                let n = fetch(std::slice::from_ref(&projects[i]))?;
                show(&projects)?;
                Ok((n == 0).then(|| "The project is not in a git repository.".to_owned()))
            }
            "refresh" => {
                show(&projects)?;
                Ok(None)
            }
            _ => Err(Error::NotFound(format!("command {id}"))),
        }
    }

    fn handle_events(&mut self, events: &[Event], ctx: &Invocation) {
        if events.contains(&Event::Scheduled) {
            let projects = host::projects().unwrap_or_default();
            if let Err(e) = fetch(&projects)
                && e != Error::Cancelled
            {
                host::notify(NotificationLevel::Warning, "Git Toolbox: fetch failed", &e.to_string());
            }
        }
        for e in events {
            if let Event::EditorFocused(Some(path)) = e {
                self.focused = Some(path.clone());
            }
        }
        let _ = show(&self.candidates(ctx));
    }
}

register_plugin!(GitToolbox);

#[cfg(test)]
mod tests {
    use super::*;
    use openidea_plugin::mock::MockHost;

    fn status(ahead: u32, behind: u32) -> RepositoryStatus {
        RepositoryStatus {
            root: "/project".into(),
            branch: Some("main".into()),
            commit: Some("0123456789abcdef".into()),
            upstream: Some("origin/main".into()),
            ahead,
            behind,
            ..RepositoryStatus::default()
        }
    }

    #[test]
    fn labels() {
        assert_eq!(label(&status(0, 0)), "main");
        assert_eq!(label(&status(1, 2)), "main ↑1 ↓2");
        let detached = RepositoryStatus { branch: None, ..status(0, 0) };
        assert_eq!(label(&detached), "01234567");
        let rebasing = RepositoryStatus { operation: Some("rebase".into()), ..status(0, 3) };
        assert_eq!(label(&rebasing), "main ↓3 (rebase)");
    }

    #[test]
    fn scheduled_fetch_updates_the_status_bar() {
        let host = MockHost::install();
        host.add_project("/other");
        host.set_vcs_status(Some(status(0, 4)));
        GitToolbox::default().handle_events(&[Event::Scheduled], &host.invocation());
        assert_eq!(host.fetches(), 2, "every open project");
        let item = &host.status_items()["branch"];
        assert_eq!(item.text, "main ↓4");
        assert!(item.tooltip.as_deref().unwrap().contains("Fetched just now"));
        assert_eq!(item.command.as_deref(), Some("fetch"));
        let task = &host.tasks()[0];
        assert!(task.ended && task.reports.last() == Some(&(2, Some(2), None)));
    }

    #[test]
    fn focus_changes_only_refresh() {
        let host = MockHost::install();
        let mut plugin = GitToolbox::default();
        host.set_vcs_status(Some(status(1, 0)));
        plugin.handle_events(&[Event::EditorFocused(Some("/project/a.rs".into()))], &host.invocation());
        assert_eq!(host.fetches(), 0);
        assert_eq!(host.status_items()["branch"].text, "main ↑1");
        host.set_vcs_status(None);
        plugin.handle_events(&[Event::VcsChanged("/project".into())], &host.invocation());
        assert!(host.status_items().is_empty(), "not a repository any more");
    }

    /// A workspace window's project is the container folder, which is no
    /// repository: the focused file's member repository is shown instead, and
    /// follows the focus between members.
    #[test]
    fn workspace_windows_follow_the_focused_members_repository() {
        let host = MockHost::install();
        let mut plugin = GitToolbox::default();
        host.set_project_root(Some("/workspace"));
        host.add_project("/repos/a");
        host.add_project("/repos/b");
        host.set_vcs_status(Some(status(1, 2)));
        plugin.handle_events(&[Event::EditorFocused(Some("/repos/a/src/main.rs".into()))], &host.invocation());
        assert_eq!(host.storage()["shown-root"], "/repos/a", "the focused file's member, not the container");
        assert_eq!(host.status_items()["branch"].text, "main ↑1 ↓2");
        plugin.handle_events(&[Event::EditorFocused(Some("/repos/b/src/lib.rs".into()))], &host.invocation());
        assert_eq!(host.storage()["shown-root"], "/repos/b", "the focus moved to the other member");
        // A scheduled tick keeps following the focused member.
        plugin.handle_events(&[Event::Scheduled], &host.invocation());
        assert_eq!(host.storage()["shown-root"], "/repos/b");
    }

    /// Fetch Now fetches the repository the status bar shows, not every
    /// other open project.
    #[test]
    fn fetch_now_fetches_only_the_shown_repository() {
        let host = MockHost::install();
        host.add_project("/other");
        storage::set(SHOWN, "/other").unwrap();
        host.set_vcs_status(Some(status(0, 0)));
        GitToolbox::default().run_command("fetch", &host.invocation(), None).unwrap();
        assert_eq!(host.fetches(), 1);
        assert_eq!(host.storage()["shown-root"], "/project");
    }

    /// A focused path outside every open project falls back to the window's
    /// project, whose repository is shown as before.
    #[test]
    fn an_unresolvable_focused_path_falls_back_to_the_window_project() {
        let host = MockHost::install();
        host.set_vcs_status(Some(status(0, 0)));
        GitToolbox::default().handle_events(&[Event::EditorFocused(Some("src/main.rs".into()))], &host.invocation());
        assert_eq!(host.storage()["shown-root"], "/project");
        assert_eq!(host.status_items()["branch"].text, "main");
    }

    #[test]
    fn failures_and_cancellation() {
        let host = MockHost::install();
        host.set_vcs_status(Some(status(0, 0)));
        host.fail_fetch(Some(Error::Failed("no network".into())));
        GitToolbox::default().handle_events(&[Event::Scheduled], &host.invocation());
        assert_eq!(host.notifications()[0].body, "no network");
        let err = GitToolbox::default().run_command("fetch", &host.invocation(), None).unwrap_err();
        assert_eq!(err, Error::Failed("no network".into()));
        host.fail_fetch(Some(Error::Cancelled));
        GitToolbox::default().handle_events(&[Event::Scheduled], &host.invocation());
        assert_eq!(host.notifications().len(), 1, "a cancelled fetch is not an error to report");
    }

    #[test]
    fn without_vcs_write_it_still_shows_the_branch() {
        let host = MockHost::install().with_capabilities(&["project.read", "vcs.read", "storage"]);
        host.set_vcs_status(Some(status(0, 1)));
        GitToolbox::default().handle_events(&[Event::Scheduled], &host.invocation());
        assert!(host.notifications()[0].body.contains("vcs.write"));
        assert_eq!(host.status_items()["branch"].text, "main ↓1");
    }
}
