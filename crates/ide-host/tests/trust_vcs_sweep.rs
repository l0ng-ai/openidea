//! Security audit lead 2: every `vcs_*` command Restricted Mode allows, run against a
//! repository whose config names a program for a signed commit, an index read, an external
//! diff, a clean filter and a missing object. None may run.
use ide_core::{NullSink, RequestId};
use ide_host::{Host, HostConfig, catalogue::TrustClass, ops, ops::vcs};
use std::collections::BTreeSet;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::{Command, Stdio};
use std::sync::Arc;

/// Allowed in Restricted Mode and not swept: none of them starts git for the project.
const NOT_THE_PROJECT_REPOSITORY: [&str; 8] = [
    "vcs_clone",        // clones a URL the user gives into a new folder
    "vcs_diff_hunks",   // compares two texts
    "vcs_detected_git", // looks for the git executable
    "vcs_shelves",      // the shelf and the changelists are files of the IDE
    "vcs_shelf_patch",
    "vcs_changelists_load",
    "vcs_write_patch", // writes a patch the UI already holds
    "vcs_read_patch",  // reads patch text without running Git
];

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git").current_dir(root).args(args).output().unwrap();
    assert!(output.status.success(), "{args:?}: {}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn spelled(path: &Path) -> String {
    path.to_str().unwrap().replace('\\', "/")
}

struct Armed {
    root: PathBuf,
    first: String,
    head: String,
    /// A commit whose tree is missing: git asks the promisor for it.
    promised: String,
}

/// A repository that starts a program of its own for a signed commit (`gpg`), an index read
/// (`fsmonitor`), a file diff (`extdiff`), a touched file (`filter`) and a missing object
/// (`promisor`). Each program leaves a file named after itself in `markers`. Other ways in
/// (textconv, process filters, merge drivers) are not armed here.
fn arm(root: &Path, markers: &Path) -> Armed {
    std::fs::create_dir_all(root.join("src")).unwrap();
    git(root, &["init", "-q", "-b", "main"]);
    for (key, value) in [("user.name", "Test"), ("user.email", "test@example.com"), ("commit.gpgsign", "false")] {
        git(root, &["config", key, value]);
    }
    std::fs::write(root.join("src/a.txt"), "one\ntwo\n").unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "-qm", "first"]);
    let first = git(root, &["rev-parse", "HEAD"]);
    std::fs::write(root.join("src/a.txt"), "one\ntwo\nthree\n").unwrap();
    git(root, &["commit", "-qam", "second"]);

    // HEAD again, carrying a signature header: `git log` then starts the verifier.
    let body = git(root, &["cat-file", "commit", "HEAD"]);
    let (headers, message) = body.split_once("\n\n").unwrap();
    let signed = format!(
        "{headers}\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEEfake\n -----END PGP SIGNATURE-----\n\n{message}\n"
    );
    let mut child = Command::new("git")
        .current_dir(root)
        .args(["hash-object", "-t", "commit", "-w", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    std::io::Write::write_all(&mut child.stdin.take().unwrap(), signed.as_bytes()).unwrap();
    let head = String::from_utf8(child.wait_with_output().unwrap().stdout).unwrap().trim().to_owned();
    git(root, &["update-ref", "HEAD", &head]);

    // A branch whose tip has a tree of its own, which is then dropped from the object database.
    git(root, &["checkout", "-q", "-b", "promised", &first]);
    std::fs::write(root.join("only-here.txt"), "promised\n").unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "-qm", "promised"]);
    let promised = git(root, &["rev-parse", "HEAD"]);
    let tree = git(root, &["rev-parse", "HEAD^{tree}"]);
    git(root, &["checkout", "-q", "main"]);
    std::fs::remove_file(root.join(".git/objects").join(&tree[..2]).join(&tree[2..])).unwrap();

    let marker = |name: &str| spelled(&markers.join(name));
    let script = |name: &str| {
        let path = root.join(".git").join(format!("{name}.sh"));
        std::fs::write(&path, format!("#!/bin/sh\necho x > '{}'\nexit 1\n", marker(name))).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        spelled(&path)
    };
    let settings = [
        ("log.showSignature", "true".to_owned()),
        ("gpg.program", script("gpg")),
        ("core.fsmonitor", script("fsmonitor")),
        ("diff.external", script("extdiff")),
        ("filter.marker.clean", format!("echo x > '{}'; cat", marker("filter"))),
        ("extensions.partialClone", "origin".to_owned()),
        ("remote.origin.url", spelled(root)),
        ("remote.origin.promisor", "true".to_owned()),
        ("remote.origin.partialclonefilter", "blob:none".to_owned()),
        ("remote.origin.uploadpack", format!("echo x > '{}'; git-upload-pack", marker("promisor"))),
    ];
    std::fs::write(root.join(".gitattributes"), "*.txt filter=marker\n").unwrap();
    // Same length as the committed text: only reading the file tells them apart.
    std::fs::write(root.join("src/a.txt"), "ONE\ntwo\nthree\n").unwrap();
    for (key, value) in &settings {
        git(root, &["config", key, value]);
    }
    Armed { root: root.to_path_buf(), first, head, promised }
}

fn ran(markers: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(markers)
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn clear(markers: &Path) {
    let _ = std::fs::remove_dir_all(markers);
    std::fs::create_dir_all(markers).unwrap();
}

type Call<'a> = (&'static str, &'static str, Pin<Box<dyn Future<Output = bool> + 'a>>);

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restricted_vcs_commands_run_no_program_of_the_repository() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let markers = base.join("markers");
    clear(&markers);
    let project = arm(&base.join("project"), &markers);
    let external = arm(&base.join("external"), &markers);
    let host = Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    });
    host.trust.decide(&project.root, false, false).unwrap();
    clear(&markers);
    assert!(!host.open_project("main", &project.root).unwrap().is_trusted());
    let host = &host;
    let w = "main";
    let file = project.root.join("src/a.txt");
    let root = || Some(project.root.clone());
    let log = || Some(external.root.clone());

    macro_rules! call {
        ($command:literal, $what:literal, $call:expr) => {
            ($command, $what, Box::pin(async { $call.await.is_ok() }) as Pin<Box<dyn Future<Output = bool> + '_>>)
        };
    }
    let calls: Vec<Call> = vec![
        call!("vcs_status", "", ops::vcs::vcs_status(host, w)),
        call!("vcs_ignored_files", "", ops::vcs::vcs_ignored_files(host, w)),
        call!("vcs_status_paths", "", ops::vcs::vcs_status_paths(host, w, vec![file.clone()])),
        call!("vcs_roots", "", vcs::vcs_roots(host, w)),
        call!("vcs_project_update_plan", "", vcs::vcs_project_update_plan(host, w, vec![root()])),
        call!("vcs_detected_roots", "", vcs::vcs_detected_roots(host, w)),
        call!("vcs_branch_info", "", vcs::vcs_branch_info(host, w, root())),
        call!("vcs_line_hunks", "", vcs::vcs_line_hunks(host, w, file.clone())),
        call!("vcs_staging_line_hunks", "", vcs::vcs_staging_line_hunks(host, w, file.clone(), None)),
        call!("vcs_file_at", "", vcs::vcs_file_at(host, w, file.clone(), None)),
        call!(
            "vcs_diff_entries",
            "",
            vcs::vcs_diff_entries(host, w, vec![vcs::DiffEntryRequest { path: file.clone().into(), rev: "WT".into() }])
        ),
        call!("vcs_blame", "", vcs::vcs_blame(host, w, file.clone(), None, None)),
        call!("vcs_block_history", "", vcs::vcs_block_history(host, w, RequestId(1), file.clone(), None, (0, 1))),
        call!("vcs_log", "", vcs::vcs_log(host, w, root(), Default::default())),
        call!("vcs_log_refs", "", vcs::vcs_log_refs(host, w, root())),
        call!("vcs_log_users", "", vcs::vcs_log_users(host, w, root())),
        call!("vcs_log_details", "", vcs::vcs_log_details(host, w, root(), project.head.clone())),
        call!("vcs_invalidate_log_signatures", "", vcs::vcs_invalidate_log_signatures(host, w, project.root.clone())),
        call!("vcs_signing_config", "", vcs::vcs_signing_config(host, w, project.root.clone())),
        call!(
            "vcs_log_details_batch",
            "",
            vcs::vcs_log_details_batch(
                host,
                w,
                root(),
                vec![project.head.clone(), project.first.clone()],
                RequestId(2)
            )
        ),
        call!(
            "vcs_revision_children",
            "",
            vcs::vcs_revision_children(host, w, root(), project.head.clone(), "src".into())
        ),
        call!(
            "vcs_revision_children",
            "missing tree",
            vcs::vcs_revision_children(host, w, root(), project.promised.clone(), String::new())
        ),
        call!("vcs_revision_files", "", vcs::vcs_revision_files(host, w, root(), project.head.clone())),
        call!("vcs_revision_files", "missing tree", vcs::vcs_revision_files(host, w, root(), project.promised.clone())),
        call!("vcs_commit_files", "", vcs::vcs_commit_files(host, w, root(), project.head.clone())),
        call!("vcs_commits_changes", "", vcs::vcs_commits_changes(host, w, root(), vec![project.head.clone()])),
        call!("vcs_branches", "", vcs::vcs_branches(host, w, root())),
        call!("vcs_stashes", "", vcs::vcs_stashes(host, w, root())),
        call!("vcs_conflict_versions", "", vcs::vcs_conflict_versions(host, w, file.clone())),
        call!("vcs_diff_text", "", vcs::vcs_diff_text(host, w, file.clone(), false)),
        call!("vcs_config_get", "", vcs::vcs_config_get(host, w, root(), "user.name".into())),
        call!("vcs_config_get_bool", "", vcs::vcs_config_get_bool(host, w, root(), "log.showSignature".into())),
        call!("vcs_watch_commit_messages", "", async {
            let request = RequestId(30);
            let (send, mut messages) = tokio::sync::mpsc::channel(1);
            let channel = ops::Channel::new(move |message| {
                let _ = send.try_send(message);
            });
            let watch = vcs::vcs_watch_commit_messages(host, w, root(), request, channel);
            let stop = async {
                let initial = tokio::time::timeout(std::time::Duration::from_secs(10), messages.recv()).await;
                host.cancel_request(request);
                assert!(matches!(initial, Ok(Some(_))), "missing initial commit messages");
            };
            let (result, ()) = tokio::join!(watch, stop);
            result
        }),
        call!("vcs_tags", "", vcs::vcs_tags(host, w, root())),
        call!("vcs_remotes", "", vcs::vcs_remotes(host, w, root())),
        call!("vcs_worktrees", "", vcs::vcs_worktrees(host, w, root())),
        call!("vcs_worktree_include", "", vcs::vcs_worktree_include(host, w, root())),
        call!("vcs_diff_with_worktree", "", vcs::vcs_diff_with_worktree(host, w, root(), "HEAD".into())),
        call!("vcs_compare_scope", "", vcs::vcs_compare_scope(host, w, vec![project.root.clone()])),
        call!(
            "vcs_compare_paths",
            "",
            vcs::vcs_compare_paths(host, w, vec![project.root.clone()], "HEAD".into(), None, RequestId(3))
        ),
        call!(
            "vcs_diff_revisions",
            "",
            vcs::vcs_diff_revisions(host, w, root(), project.first.clone(), project.head.clone())
        ),
        call!(
            "vcs_diff_numstat",
            "",
            vcs::vcs_diff_numstat(host, w, root(), project.first.clone(), project.head.clone(), Vec::new())
        ),
        call!("vcs_merge_base", "", vcs::vcs_merge_base(host, w, root(), project.first.clone(), project.head.clone())),
        call!("vcs_has_commit", "", vcs::vcs_has_commit(host, w, root(), project.head.clone())),
        call!(
            "vcs_not_cherry_picked",
            "",
            vcs::vcs_not_cherry_picked(host, w, root(), project.head.clone(), project.first.clone(), RequestId(4))
        ),
        call!(
            "vcs_commit_selection_changes",
            "",
            vcs::vcs_commit_selection_changes(host, w, root(), vec![project.head.clone()], RequestId(5))
        ),
        call!("vcs_default_push_target", "", vcs::vcs_default_push_target(host, w, root(), None)),
        call!(
            "vcs_commit_push_target",
            "",
            vcs::vcs_commit_push_target(host, w, root(), RequestId(6), project.head.clone())
        ),
        call!(
            "vcs_push_target_choices",
            "commit",
            vcs::vcs_push_target_choices(host, w, root(), RequestId(7), None, Some(project.head.clone()))
        ),
        call!("vcs_has_hook", "", vcs::vcs_has_hook(host, w, root(), "pre-push".into())),
        // A worktree outside the project, opened for its history only.
        call!("vcs_open_external_log", "", vcs::vcs_open_external_log(host, w, external.root.clone())),
        call!("vcs_log", "external", vcs::vcs_log(host, w, log(), Default::default())),
        call!("vcs_log_users", "external", vcs::vcs_log_users(host, w, log())),
        call!("vcs_log_details", "external", vcs::vcs_log_details(host, w, log(), external.head.clone())),
        call!(
            "vcs_revision_children",
            "external, missing tree",
            vcs::vcs_revision_children(host, w, log(), external.promised.clone(), String::new())
        ),
        call!("vcs_revision_files", "external", vcs::vcs_revision_files(host, w, log(), external.head.clone())),
        call!("vcs_commit_files", "external", vcs::vcs_commit_files(host, w, log(), external.head.clone())),
        (
            "vcs_review_apply_commit",
            "paused cherry-pick",
            Box::pin(async {
                git(
                    &project.root,
                    &["-c", "core.fsmonitor=false", "-c", "filter.marker.clean=", "add", "--", "src/a.txt"],
                );
                let marker = project.root.join(".git/CHERRY_PICK_HEAD");
                let message = project.root.join(".git/MERGE_MSG");
                std::fs::write(&marker, format!("{}\n", project.head)).unwrap();
                std::fs::write(&message, "Review staged changes\n").unwrap();
                let result = vcs::vcs_review_apply_commit(host, w, root(), RequestId(8)).await;
                std::fs::remove_file(marker).unwrap();
                std::fs::remove_file(message).unwrap();
                git(
                    &project.root,
                    &[
                        "-c",
                        "core.fsmonitor=false",
                        "-c",
                        "filter.marker.clean=",
                        "reset",
                        "-q",
                        "HEAD",
                        "--",
                        "src/a.txt",
                    ],
                );
                result.ok().flatten().is_some_and(|review| review.paths.len() == 1 && review.paths[0].0 == file)
            }),
        ),
        // Last: it rewrites nothing of an existing repository, but it does touch it.
        call!("vcs_init", "", vcs::vcs_init(host, w, project.root.clone())),
    ];

    // The sweep covers every `vcs_*` command declared `trust = always`: a newly allowed one fails
    // here until it is swept or listed as not touching the project's repository.
    let dispatcher = ide_host::rpc::Dispatcher::standard();
    let allowed: BTreeSet<&str> = dispatcher
        .commands()
        .into_iter()
        .filter(|c| c.starts_with("vcs_") && dispatcher.trust(c) == Some(TrustClass::Always))
        .collect();
    let swept: BTreeSet<&str> = calls.iter().map(|(command, _, _)| *command).collect();
    let known: BTreeSet<&str> = swept.iter().copied().chain(NOT_THE_PROJECT_REPOSITORY).collect();
    assert_eq!(allowed, known, "the sweep and Restricted Mode's allowed vcs commands differ");

    let mut executed = Vec::new();
    let mut failed = Vec::new();
    let opening = ran(&markers);
    if !opening.is_empty() {
        executed.push(format!("open_project: {}", opening.join(", ")));
    }
    for (command, what, call) in calls {
        clear(&markers);
        let ok = call.await;
        let name = if what.is_empty() { command.to_owned() } else { format!("{command} ({what})") };
        let programs = ran(&markers);
        if !programs.is_empty() {
            executed.push(format!("{name}: {}", programs.join(", ")));
        }
        if !ok {
            failed.push(name);
        }
    }

    // Control: plain git, in the same repository, starts every one of the fixture's programs.
    clear(&markers);
    for args in [&["log", "-1", "--format=%H"][..], &["status", "--porcelain"], &["ls-tree", &project.promised]] {
        let _ = Command::new("git").current_dir(&project.root).args(args).output().unwrap();
    }
    let _ = Command::new("git").current_dir(&project.root).args(["diff"]).output().unwrap();
    assert_eq!(
        ran(&markers),
        ["extdiff", "filter", "fsmonitor", "gpg", "promisor"],
        "control: the fixture is not live"
    );

    assert!(executed.is_empty(), "Restricted Mode ran a program of the repository:\n{}", executed.join("\n"));
    // Only the listings of the commit whose tree is gone have nothing to return.
    assert_eq!(
        failed,
        [
            "vcs_revision_children (missing tree)",
            "vcs_revision_files (missing tree)",
            "vcs_revision_children (external, missing tree)"
        ]
    );
}
