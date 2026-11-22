//! Repository-scoped patch operations must never fall back to the primary root.
use ide_core::NullSink;
use ide_host::{Host, HostConfig, ops::vcs};
use std::{path::Path, process::Command, sync::Arc, time::Duration};

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git").current_dir(root).args(args).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn patches_read_and_write_the_requested_repository() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let project_root = base.join("project");
    let roots = [project_root.join("front"), project_root.join("back")];
    let mut revisions = Vec::new();
    for (i, root) in roots.iter().enumerate() {
        std::fs::create_dir_all(root).unwrap();
        git(root, &["init", "-b", "main"]);
        git(root, &["config", "user.name", "Test"]);
        git(root, &["config", "user.email", "test@example.com"]);
        git(root, &["config", "core.autocrlf", "false"]);
        std::fs::write(root.join("same.txt"), format!("root {i}\n")).unwrap();
        let source = root.join("located/src");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("settings.txt"), format!("port={}\n", if i == 0 { 900 } else { 100 })).unwrap();
        std::fs::write(source.join("report.txt"), "total=100\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-m", "initial"]);
        std::fs::write(root.join("same.txt"), format!("changed {i}\n")).unwrap();
        git(root, &["commit", "-am", "change"]);
        revisions.push(git(root, &["rev-parse", "HEAD"]));
    }
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
    host.trust.decide(&project_root, true, false).unwrap();
    let project = host.open_project("main", &project_root).unwrap();
    for _ in 0..500 {
        if project.repos().all().len() == 2
            && !project.index.status().indexing
            && project.index.files_named("settings.txt").len() == 2
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(project.repos().all().len(), 2);

    let source = roots[1].join("located/src");
    let original = source.join("report.txt");
    let renamed = source.join("new report.txt");
    git(&roots[1], &["mv", "located/src/report.txt", "located/src/new report.txt"]);
    let patch = vcs::vcs_create_patch(
        &host,
        "main",
        None,
        vcs::PatchSource::Changes { paths: vec![original.into(), renamed.into()], reverse: false },
        Some(roots[1].join("located")),
    )
    .await
    .unwrap();
    assert!(patch.contains("rename from src/report.txt\n"));
    let preview =
        vcs::vcs_patch_preview(&host, "main", Some(roots[1].clone()), patch, Some(vcs::PatchTarget::Repository), None)
            .await
            .unwrap();
    assert_eq!(preview.files.len(), 1);
    assert_eq!(preview.files[0].old_path.as_deref(), Some("src/report.txt"));
    assert_eq!(preview.files[0].path, "src/new report.txt");
    git(&roots[1], &["reset", "--hard", "HEAD"]);

    for (i, root) in roots.iter().enumerate() {
        let patch = vcs::vcs_create_patch(
            &host,
            "main",
            Some(root.clone()),
            vcs::PatchSource::Commits { commits: vec![revisions[i].clone()], reverse: true },
            None,
        )
        .await
        .unwrap();
        assert!(patch.contains(&format!("-changed {i}")));
        let preview =
            vcs::vcs_patch_preview(&host, "main", Some(root.clone()), patch.clone(), None, None).await.unwrap();
        assert!(preview.base.is_none());
        assert_eq!(preview.files.len(), 1);
        vcs::vcs_apply_patch(&host, "main", Some(root.clone()), patch, Some(vec!["same.txt".into()])).await.unwrap();
        assert_eq!(std::fs::read_to_string(root.join("same.txt")).unwrap(), format!("root {i}\n"));
    }
    assert!(vcs::vcs_apply_patch(&host, "main", Some(base.join("outside")), String::new(), None).await.is_err());

    for (i, root) in roots.iter().enumerate() {
        std::fs::write(root.join("same.txt"), format!("project patch {i}\n")).unwrap();
    }
    let entries = roots
        .iter()
        .map(|root| ide_vcs::StagingPatchEntry {
            path: root.join("same.txt").into(),
            renamed_from: None,
            side: ide_vcs::StagingPatchSide::Unstaged,
        })
        .collect();
    let patch = vcs::vcs_create_patch(&host, "main", None, vcs::PatchSource::Staging { entries, reverse: false }, None)
        .await
        .unwrap();
    let selected_changes = || vcs::PatchSource::Changes {
        paths: roots.iter().map(|root| root.join("same.txt").into()).collect(),
        reverse: false,
    };
    let combined =
        vcs::vcs_create_patch(&host, "main", None, selected_changes(), Some(project_root.clone())).await.unwrap();
    assert!(combined.contains("diff --git a/front/same.txt b/front/same.txt"));
    assert!(combined.contains("diff --git a/back/same.txt b/back/same.txt"));
    let error =
        vcs::vcs_create_patch(&host, "main", None, selected_changes(), Some(roots[0].clone())).await.unwrap_err();
    assert_eq!(error.message, "The base directory must contain every selected path");
    for root in &roots {
        git(root, &["restore", "--", "same.txt"]);
    }
    let preview =
        vcs::vcs_patch_preview(&host, "main", Some(roots[0].clone()), patch.clone(), None, None).await.unwrap();
    assert_eq!(preview.base.unwrap(), project_root);
    assert_eq!(
        preview.files.iter().map(|file| file.path.as_str()).collect::<Vec<_>>(),
        ["back/same.txt", "front/same.txt"]
    );
    assert!(preview.files.iter().all(|file| file.applies));
    let diff = vcs::vcs_patch_file_diff(
        &host,
        "main",
        Some(roots[1].clone()),
        Some(project_root.clone()),
        patch.clone(),
        "front/same.txt".into(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(diff.path, roots[0].join("same.txt"));
    assert!(matches!(
        diff.content,
        ide_vcs::PatchDiffContent::Text { before: Some(before), after: Some(after) }
            if before == "changed 0\n" && after == "project patch 0\n"
    ));
    assert_eq!(std::fs::read_to_string(roots[0].join("same.txt")).unwrap(), "changed 0\n");

    let explicit_repo = vcs::vcs_patch_preview(
        &host,
        "main",
        Some(roots[0].clone()),
        patch.clone(),
        Some(vcs::PatchTarget::Repository),
        None,
    )
    .await
    .unwrap();
    assert!(explicit_repo.base.is_none());
    assert!(explicit_repo.files.iter().all(|file| !file.applies));
    assert!(vcs::vcs_apply_project_patch(&host, "main", base.join("outside"), patch.clone(), None).await.is_err());
    let cross_root_rename = "diff --git a/front/same.txt b/back/moved.txt\nsimilarity index 100%\nrename from front/same.txt\nrename to back/moved.txt\n";
    assert!(
        vcs::vcs_apply_project_patch(&host, "main", project_root.clone(), cross_root_rename.into(), None)
            .await
            .is_err()
    );
    let selected = vcs::vcs_apply_project_patch(
        &host,
        "main",
        project_root.clone(),
        patch.clone(),
        Some(vec!["front/same.txt".into()]),
    )
    .await
    .unwrap();
    assert_eq!(selected.outcome.applied, ["front/same.txt"]);
    assert!(selected.failures.is_empty());
    assert_eq!(std::fs::read_to_string(roots[0].join("same.txt")).unwrap(), "project patch 0\n");
    assert_eq!(std::fs::read_to_string(roots[1].join("same.txt")).unwrap(), "changed 1\n");
    git(&roots[0], &["restore", "--", "same.txt"]);
    std::fs::write(roots[1].join("same.txt"), "local edit\n").unwrap();

    let partial = vcs::vcs_apply_project_patch(&host, "main", project_root.clone(), patch.clone(), None).await.unwrap();
    assert_eq!(partial.outcome.applied, ["front/same.txt"]);
    assert!(partial.outcome.conflicts.is_empty());
    assert_eq!(partial.failures.len(), 1);
    assert_eq!(partial.failures[0].root, roots[1]);
    assert_eq!(std::fs::read_to_string(roots[0].join("same.txt")).unwrap(), "project patch 0\n");
    assert_eq!(std::fs::read_to_string(roots[1].join("same.txt")).unwrap(), "local edit\n");
    for root in &roots {
        assert!(git(root, &["diff", "--cached", "--name-only"]).is_empty());
    }
    git(&roots[0], &["restore", "--", "same.txt"]);
    git(&roots[1], &["commit", "-am", "conflicting local commit"]);
    let conflicted = vcs::vcs_apply_project_patch(&host, "main", project_root, patch, None).await.unwrap();
    assert_eq!(conflicted.outcome.applied, ["front/same.txt"]);
    assert_eq!(conflicted.outcome.conflicts, ["back/same.txt"]);
    assert_eq!(conflicted.conflicted_repositories, [roots[1].clone()]);
    assert!(conflicted.failures.is_empty());
    assert_eq!(git(&roots[1], &["diff", "--name-only", "--diff-filter=U"]), "same.txt");
    let conflict = roots[1].join("same.txt");
    let versions = vcs::vcs_conflict_versions(&host, "main", conflict.clone()).await.unwrap();
    assert_eq!(versions.sides.operation.as_deref(), Some("apply-patch"));
    assert!(!versions.sides.reversed);
    assert_eq!(versions.ours.as_deref(), Some("local edit\n"));
    assert_eq!(versions.theirs.as_deref(), Some("project patch 1\n"));
    vcs::vcs_accept_conflict_side(&host, "main", vec![conflict.clone()], ide_vcs::ConflictSide::Theirs).await.unwrap();
    assert_eq!(std::fs::read_to_string(conflict).unwrap(), "project patch 1\n");

    git(&roots[1], &["restore", "--source=HEAD", "--staged", "--worktree", "--", "same.txt"]);
    let target = roots[1].join("moved here");
    std::fs::create_dir_all(&target).unwrap();
    std::fs::write(target.join("before.txt"), "content\n").unwrap();
    let source = "legacy/path/after.txt";
    let patch = concat!(
        "diff --git a/legacy/path/before.txt b/legacy/path/after.txt\n",
        "similarity index 100%\nrename from legacy/path/before.txt\nrename to legacy/path/after.txt\n",
        "diff --git a/same.txt b/same.txt\n--- a/same.txt\n+++ b/same.txt\n",
        "@@ -1 +1 @@\n-project patch 0\n+unselected\n"
    );
    let mapping = || ide_vcs::PatchPathMapping {
        path: source.into(),
        directory: Some(target.clone().into()),
        strip: 2,
        file: None,
    };
    let make_invalid = |directory| ide_vcs::PatchPathMapping {
        path: "same.txt".into(),
        directory: Some(directory),
        strip: 0,
        file: None,
    };
    let preview = vcs::vcs_patch_preview(
        &host,
        "main",
        Some(roots[0].clone()),
        patch.into(),
        Some(vcs::PatchTarget::Repository),
        Some(vec![mapping(), make_invalid(base.clone().into())]),
    )
    .await
    .unwrap();
    assert!(preview.files[0].applies);
    assert!(!preview.files[1].applies);
    let placements = preview.placements.unwrap();
    assert_eq!(placements[0].target.as_ref().unwrap(), &target.join("after.txt"));
    assert!(placements[1].error.is_some());
    let diff = vcs::vcs_patch_file_diff(
        &host,
        "main",
        Some(roots[0].clone()),
        None,
        patch.into(),
        source.into(),
        Some(vec![mapping()]),
    )
    .await
    .unwrap();
    assert_eq!(diff.path, target.join("after.txt"));
    assert_eq!(diff.old_path.unwrap(), target.join("before.txt"));
    assert!(
        matches!(diff.content, ide_vcs::PatchDiffContent::Text { before: Some(before), after: Some(after) } if before == "content\n" && before == after)
    );
    assert!(target.join("before.txt").exists());
    assert!(!target.join("after.txt").exists());
    assert!(
        vcs::vcs_apply_mapped_patch(
            &host,
            "main",
            Some(roots[0].clone()),
            None,
            patch.into(),
            None,
            vec![mapping(), make_invalid(base.into())],
        )
        .await
        .is_err()
    );
    assert!(target.join("before.txt").exists());
    let applied = vcs::vcs_apply_mapped_patch(
        &host,
        "main",
        Some(roots[0].clone()),
        None,
        patch.into(),
        Some(vec![source.into()]),
        vec![mapping()],
    )
    .await
    .unwrap();
    assert!(applied.failures.is_empty());
    assert_eq!(applied.outcome.applied, [ide_core::ipc_path::to_ipc(&target.join("after.txt"))]);
    assert!(!target.join("before.txt").exists());
    assert_eq!(std::fs::read_to_string(target.join("after.txt")).unwrap(), "content\n");
    assert_eq!(std::fs::read_to_string(roots[0].join("same.txt")).unwrap(), "project patch 0\n");

    let patch = concat!(
        "diff --git a/legacy/original.txt b/legacy/renamed.txt\n",
        "similarity index 55%\nrename from legacy/original.txt\nrename to legacy/renamed.txt\n",
        "--- a/legacy/original.txt\n+++ b/legacy/renamed.txt\n",
        "@@ -1 +1 @@\n-content\n+repaired content\n",
    );
    let source = "legacy/renamed.txt";
    let existing = target.join("local name.txt");
    std::fs::write(&existing, "content\n").unwrap();
    let to_file = |path: &std::path::Path| ide_vcs::PatchPathMapping {
        path: source.into(),
        directory: None,
        strip: 0,
        file: Some(path.into()),
    };
    let root = Some(roots[0].clone());
    let preview = vcs::vcs_patch_preview(&host, "main", root.clone(), patch.into(), None, None).await.unwrap();
    assert!(preview.files[0].missing_base);
    let invalid = vcs::vcs_patch_preview(&host, "main", root.clone(), patch.into(), None, Some(vec![to_file(&target)]))
        .await
        .unwrap();
    assert!(invalid.placements.unwrap()[0].error.is_some());
    let mapped =
        vcs::vcs_patch_preview(&host, "main", root.clone(), patch.into(), None, Some(vec![to_file(&existing)]))
            .await
            .unwrap();
    assert_eq!(mapped.files[0].path, source);
    assert!(!mapped.files[0].missing_base);
    assert!(mapped.files[0].applies);
    assert_eq!(mapped.placements.unwrap()[0].target.as_ref().unwrap(), &existing);
    let diff = vcs::vcs_patch_file_diff(
        &host,
        "main",
        root.clone(),
        None,
        patch.into(),
        source.into(),
        Some(vec![to_file(&existing)]),
    )
    .await
    .unwrap();
    assert_eq!(diff.path, existing);
    assert!(diff.old_path.is_none());
    assert!(matches!(diff.content, ide_vcs::PatchDiffContent::Text { before: Some(before), after: Some(after) }
            if before == "content\n" && after == "repaired content\n"));
    let applied = vcs::vcs_apply_mapped_patch(&host, "main", root, None, patch.into(), None, vec![to_file(&existing)])
        .await
        .unwrap();
    assert!(applied.failures.is_empty());
    assert_eq!(applied.outcome.applied, [ide_core::ipc_path::to_ipc(&existing)]);
    assert_eq!(std::fs::read_to_string(&existing).unwrap(), "repaired content\n");
    assert!(!roots[0].join(source).exists() && !target.join("renamed.txt").exists());

    let patch = concat!(
        "diff --git a/checkout/src/settings.txt b/checkout/src/settings.txt\n",
        "--- a/checkout/src/settings.txt\n+++ b/checkout/src/settings.txt\n",
        "@@ -1 +1 @@\n-port=100\n+port=200\n",
        "diff --git a/checkout/src/report.txt b/checkout/src/report.txt\n",
        "--- a/checkout/src/report.txt\n+++ b/checkout/src/report.txt\n",
        "@@ -1 +1 @@\n-total=100\n+total=200\n",
    );
    let root = Some(roots[0].clone());
    let preview = vcs::vcs_patch_preview(&host, "main", root.clone(), patch.into(), None, None).await.unwrap();
    let automatic = preview.automatic_mappings;
    assert_eq!(automatic.len(), 1);
    assert_eq!(automatic[0].path, "checkout/src/settings.txt");
    assert_eq!(automatic[0].directory.as_ref().unwrap(), &roots[1].join("located"));
    assert_eq!(automatic[0].strip, 1);
    assert!(preview.files[0].applies && !preview.files[0].missing_base);
    assert!(preview.files[1].missing_base);
    assert_eq!(preview.directory_matches[0].candidates[0].applies, Some(true));
    assert_eq!(preview.directory_matches[0].candidates[1].applies, Some(false));
    assert_eq!(preview.directory_matches[1].candidates.len(), 2);
    assert!(preview.directory_matches[1].candidates.iter().all(|candidate| candidate.applies == Some(true)));
    let repo_only =
        vcs::vcs_patch_preview(&host, "main", root.clone(), patch.into(), Some(vcs::PatchTarget::Repository), None)
            .await
            .unwrap();
    assert!(repo_only.automatic_mappings.is_empty());
    assert!(repo_only.files.iter().all(|file| file.missing_base));
    assert!(repo_only.directory_matches.iter().all(|matches| matches.candidates.len() == 1));
    let report = preview.directory_matches[1]
        .candidates
        .iter()
        .find(|candidate| candidate.source.starts_with(&roots[0]))
        .unwrap();
    let selected = ide_vcs::PatchPathMapping {
        path: "checkout/src/report.txt".into(),
        directory: Some(report.directory.clone()),
        strip: report.strip,
        file: None,
    };
    let reset = ide_vcs::PatchPathMapping { path: automatic[0].path.clone(), directory: None, strip: 0, file: None };
    let reset_preview =
        vcs::vcs_patch_preview(&host, "main", root.clone(), patch.into(), None, Some(vec![reset])).await.unwrap();
    assert!(reset_preview.automatic_mappings.is_empty());
    assert!(reset_preview.files[0].missing_base);
    let mappings = [automatic, vec![selected]].concat();
    let diff = vcs::vcs_patch_file_diff(
        &host,
        "main",
        root.clone(),
        None,
        patch.into(),
        mappings[0].path.clone(),
        Some(mappings.clone()),
    )
    .await
    .unwrap();
    assert_eq!(diff.path, roots[1].join("located/src/settings.txt"));
    let applied = vcs::vcs_apply_mapped_patch(&host, "main", root, None, patch.into(), None, mappings).await.unwrap();
    assert!(applied.failures.is_empty());
    assert_eq!(applied.outcome.applied.len(), 2);
    assert_eq!(std::fs::read_to_string(&*report.source).unwrap(), "total=200\n");
    assert_eq!(std::fs::read_to_string(roots[1].join("located/src/report.txt")).unwrap(), "total=100\n");
    assert_eq!(std::fs::read_to_string(roots[1].join("located/src/settings.txt")).unwrap(), "port=200\n");
    assert_eq!(std::fs::read_to_string(roots[0].join("located/src/settings.txt")).unwrap(), "port=900\n");

    // Empty folders never appear in the filename index. The patch should still preserve
    // the new subfolder beneath the matched parent and leave a tie at the original path.
    let mail = roots[1].join("modules/mail/templates");
    let ignored = roots[0].join("cache/mail/templates");
    for path in [&mail, &ignored, &roots[0].join("alpha/widgets/templates"), &roots[1].join("beta/widgets/templates")] {
        std::fs::create_dir_all(path).unwrap();
    }
    std::fs::write(roots[0].join(".git/info/exclude"), "/cache/\n").unwrap();
    let new_mail = "checkout/mail/templates/emails/welcome.txt";
    let new_widget = "checkout/widgets/templates/banner.txt";
    let existing_parent = "located/src/new-settings.txt";
    let generic_parent = "checkout/src/new-module.txt";
    let patch = [new_mail, new_widget, existing_parent, generic_parent]
        .iter()
        .map(|path| {
            format!("diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1 @@\n+new content\n")
        })
        .collect::<String>();
    let root = Some(roots[0].clone());
    let preview = vcs::vcs_patch_preview(&host, "main", root.clone(), patch.clone(), None, None).await.unwrap();
    assert!(preview.files.iter().all(|file| file.applies && !file.missing_base));
    assert_eq!(preview.automatic_mappings.len(), 1);
    assert_eq!(preview.automatic_mappings[0].path, new_mail);
    assert_eq!(preview.automatic_mappings[0].strip, 1);
    assert_eq!(preview.automatic_mappings[0].directory.as_ref().unwrap(), &roots[1].join("modules"));
    assert_eq!(preview.directory_matches.len(), 2);
    assert_eq!(preview.directory_matches[0].path, new_mail);
    assert_eq!(preview.directory_matches[0].candidates.len(), 1);
    assert_eq!(preview.directory_matches[1].path, new_widget);
    assert_eq!(preview.directory_matches[1].candidates.len(), 2);
    let expected = mail.join("emails/welcome.txt");
    let placement = |path: &str| {
        let placements = preview.placements.as_ref().unwrap();
        placements.iter().find(|entry| entry.path == path).unwrap().target.as_ref().unwrap()
    };
    assert_eq!(placement(new_mail), &expected);
    assert_eq!(placement(new_widget), &roots[0].join(new_widget));
    assert_eq!(placement(existing_parent), &roots[0].join(existing_parent));
    assert_eq!(placement(generic_parent), &roots[0].join(generic_parent));
    let diff = vcs::vcs_patch_file_diff(
        &host,
        "main",
        root.clone(),
        None,
        patch.clone(),
        new_mail.into(),
        Some(preview.automatic_mappings.clone()),
    )
    .await
    .unwrap();
    assert_eq!(diff.path, expected);
    assert!(
        matches!(diff.content, ide_vcs::PatchDiffContent::Text { before: None, after: Some(after) } if after == "new content\n")
    );
    let applied = vcs::vcs_apply_mapped_patch(
        &host,
        "main",
        root,
        None,
        patch,
        Some(vec![new_mail.into(), new_widget.into()]),
        preview.automatic_mappings,
    )
    .await
    .unwrap();
    assert!(applied.failures.is_empty());
    assert_eq!(applied.outcome.applied.len(), 2);
    assert_eq!(std::fs::read_to_string(expected).unwrap(), "new content\n");
    assert_eq!(std::fs::read_to_string(roots[0].join(new_widget)).unwrap(), "new content\n");
    assert!(!ignored.join("emails/welcome.txt").exists());
    assert!(!roots[0].join(existing_parent).exists());
    host.close_project("main");
}

/// The Changes view also lists attached projects' repositories, and their untracked files
/// offer Add to .gitignore / .git/info/exclude: the guard must follow the window's
/// repository set, not the project folder alone.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_to_ignore_accepts_the_repositories_of_attached_projects() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let project_root = base.join("project");
    let attached_root = base.join("attached");
    for root in [&project_root, &attached_root] {
        std::fs::create_dir_all(root).unwrap();
        git(root, &["init", "-b", "main"]);
        git(root, &["config", "user.name", "Test"]);
        git(root, &["config", "user.email", "test@example.com"]);
        git(root, &["config", "core.autocrlf", "false"]);
        std::fs::write(root.join("tracked.txt"), "x\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-m", "initial"]);
    }
    // Untracked files, one per repository; the attached one is what failed.
    let own = project_root.join("own.ignore-me");
    let attached = attached_root.join("attached.ignore-me");
    std::fs::write(&own, "x").unwrap();
    std::fs::write(&attached, "x").unwrap();

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
    host.trust.decide(&project_root, true, false).unwrap();
    host.trust.decide(&attached_root, true, false).unwrap();
    let project = host.open_project("main", &project_root).unwrap();
    ide_host::ops::project::attach_workspace(&host, "main", &attached_root).unwrap();
    for _ in 0..500 {
        if project.repos().all().len() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(project.repos().all().len(), 2);

    vcs::vcs_add_to_ignore(&host, "main", vec![attached.clone()], ide_vcs::IgnoreDestination::Gitignore).await.unwrap();
    assert!(
        std::fs::read_to_string(attached_root.join(".gitignore")).unwrap().contains("/attached.ignore-me"),
        "the attached repository's .gitignore did not receive the rule"
    );
    vcs::vcs_add_to_ignore(&host, "main", vec![own.clone()], ide_vcs::IgnoreDestination::LocalExclude).await.unwrap();
    assert!(
        std::fs::read_to_string(project_root.join(".git/info/exclude")).unwrap().contains("/own.ignore-me"),
        "the project repository's exclude did not receive the rule"
    );

    // A repository of an unattached sibling folder stays outside.
    let sibling_root = base.join("sibling");
    std::fs::create_dir_all(&sibling_root).unwrap();
    git(&sibling_root, &["init", "-b", "main"]);
    let sibling = sibling_root.join("sibling.ignore-me");
    std::fs::write(&sibling, "x").unwrap();
    let error =
        vcs::vcs_add_to_ignore(&host, "main", vec![sibling], ide_vcs::IgnoreDestination::Gitignore).await.unwrap_err();
    assert!(error.message.contains("outside the project"), "{error:?}");
    assert!(!sibling_root.join(".gitignore").exists());
    host.close_project("main");
}
