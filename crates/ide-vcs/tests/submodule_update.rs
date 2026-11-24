use ide_core::{CancellationToken, workflow_settings::FetchTagsMode};
use ide_vcs::{Repo, Repos, SubmoduleRollbackSource};
use std::{fs, path::Path, process::Command};

fn git(root: &Path, args: &[&str]) -> String {
    let result = Command::new("git")
        .current_dir(root)
        .args(["-c", "protocol.file.allow=always", "-c", "core.autocrlf=false"])
        .args(args)
        .output()
        .unwrap();
    assert!(result.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&result.stderr));
    String::from_utf8(result.stdout).unwrap().trim().to_owned()
}

fn init(root: &Path, file: &str) {
    fs::create_dir(root).unwrap();
    git(root, &["init", "-qb", "main"]);
    git(root, &["config", "user.name", "Update fixture"]);
    git(root, &["config", "user.email", "test@example.com"]);
    git(root, &["config", "core.autocrlf", "false"]);
    fs::write(root.join(file), "before\n").unwrap();
}

fn commit(root: &Path, subject: &str) -> String {
    git(root, &["add", "-A"]);
    git(root, &["commit", "--no-gpg-sign", "-qm", subject]);
    git(root, &["rev-parse", "HEAD"])
}

fn follow(root: &Path, commit: &str) {
    git(root, &["fetch", "origin"]);
    git(root, &["checkout", "-q", "--detach", commit]);
}

#[test]
fn submodule_rollback_restores_the_chosen_version_without_discarding_child_edits() {
    let temp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(temp.path()).unwrap();
    let library = root.join("library");
    let workspace = root.join("workspace");
    init(&library, "library.txt");
    let initial = commit(&library, "initial library");
    init(&workspace, "root.txt");
    git(&workspace, &["submodule", "add", "--", library.to_str().unwrap(), "modules/library"]);
    commit(&workspace, "initial parent");

    fs::write(library.join("library.txt"), "updated\n").unwrap();
    let updated = commit(&library, "update library");
    let module = workspace.join("modules/library");
    follow(&module, &updated);
    git(&workspace, &["add", "--", "modules/library"]);
    git(&module, &["checkout", "-q", "--detach", &initial]);
    fs::write(module.join("staged.txt"), "local staging\n").unwrap();
    git(&module, &["add", "staged.txt"]);
    fs::write(module.join("local.txt"), "untracked\n").unwrap();

    let parent = Repo::discover(&workspace).unwrap().unwrap();
    parent.set_execution_allowed(true);
    let child_head = || git(&module, &["rev-parse", "HEAD"]);
    let staged_link = || git(&workspace, &["rev-parse", ":modules/library"]);
    parent.rollback_submodule(&module, SubmoduleRollbackSource::Index, true).unwrap();
    assert_eq!(child_head(), updated);
    assert_eq!(staged_link(), updated);
    assert_eq!(git(&module, &["show", ":staged.txt"]), "local staging");

    fs::write(module.join("library.txt"), "unselected conflicting edit\n").unwrap();
    assert!(parent.rollback_submodule(&module, SubmoduleRollbackSource::Head, true).is_err());
    assert_eq!(child_head(), updated);
    assert_eq!(staged_link(), updated);
    assert_eq!(fs::read_to_string(module.join("library.txt")).unwrap(), "unselected conflicting edit\n");

    parent.rollback_submodule(&module, SubmoduleRollbackSource::Head, false).unwrap();
    assert_eq!(child_head(), updated);
    assert_eq!(staged_link(), initial);
    git(&module, &["restore", "--", "library.txt"]);
    parent.rollback_submodule(&module, SubmoduleRollbackSource::Head, true).unwrap();
    assert_eq!(child_head(), initial);
    assert_eq!(staged_link(), initial);
    assert_eq!(git(&module, &["show", ":staged.txt"]), "local staging");
    assert_eq!(fs::read_to_string(module.join("local.txt")).unwrap(), "untracked\n");

    let new_checkout = workspace.join("new");
    git(&workspace, &["submodule", "add", "--", library.to_str().unwrap(), "new"]);
    parent.rollback_submodule(&new_checkout, SubmoduleRollbackSource::Head, true).unwrap();
    assert!(git(&workspace, &["ls-files", "--", "new"]).is_empty());
    assert_eq!(git(&new_checkout, &["rev-parse", "HEAD"]), updated);
    assert!(parent.rollback_submodule(&workspace.join("root.txt"), SubmoduleRollbackSource::Head, true).is_err());
}

#[test]
fn submodule_rollback_recreates_missing_directories_from_head_or_index() {
    let temp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(temp.path()).unwrap();
    let workspace = root.join("workspace");
    init(&workspace, "root.txt");
    let recorded = commit(&workspace, "root");
    let names = ["modules/from-index", "modules/from-head", "modules/unselected"];
    for name in names {
        git(&workspace, &["update-index", "--add", "--cacheinfo", &format!("160000,{recorded},{name}")]);
    }
    git(&workspace, &["commit", "--no-gpg-sign", "-qm", "record submodules"]);
    git(&workspace, &["update-index", "--force-remove", "modules/from-head"]);

    let parent = Repo::discover(&workspace).unwrap().unwrap();
    parent.set_execution_allowed(true);
    for (name, source) in [(names[0], SubmoduleRollbackSource::Index), (names[1], SubmoduleRollbackSource::Head)] {
        let path = workspace.join(name);
        assert!(!path.exists());
        parent.rollback_submodule(&path, source, true).unwrap();
        assert!(path.is_dir());
        assert!(fs::read_dir(path).unwrap().next().is_none());
        assert_eq!(git(&workspace, &["rev-parse", &format!(":{name}")]), recorded);
        assert!(git(&workspace, &["status", "--short", "--", name]).is_empty());
    }
    assert!(!workspace.join(names[2]).exists());
}

#[test]
fn worktrees_report_the_submodule_checkout_from_either_worktree() {
    let temp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(temp.path()).unwrap();
    let library = root.join("library");
    let workspace = root.join("workspace");
    init(&library, "library.txt");
    commit(&library, "initial library");
    init(&workspace, "root.txt");
    git(&workspace, &["submodule", "add", "--", library.to_str().unwrap(), "modules/library"]);
    commit(&workspace, "initial parent");

    let linked = root.join("linked library");
    let module = workspace.join("modules/library");
    git(&module, &["worktree", "add", "--detach", "--", linked.to_str().unwrap(), "HEAD"]);
    for checkout in [&module, &linked] {
        let repo = ide_vcs::Repo::discover(checkout).unwrap().unwrap();
        repo.set_execution_allowed(true);
        let trees = repo.worktrees().unwrap();
        assert_eq!(trees.len(), 2);
        assert_eq!(trees[0].path.0, module, "worktrees listed from {checkout:?} at {:?}", repo.metadata_dirs());
        assert!(trees[0].main && trees[0].submodule, "{checkout:?}: {trees:?}");
        assert!(!trees[1].main && trees[1].submodule);
        assert_eq!(trees[1].path.0, linked);
    }
    let parent = ide_vcs::Repo::discover(&workspace).unwrap().unwrap();
    parent.set_execution_allowed(true);
    let trees = parent.worktrees().unwrap();
    assert_eq!(trees[0].path.0, workspace);
    assert!(!trees[0].submodule);
}

#[test]
fn diff_entries_keep_committed_index_and_checkout_gitlinks_distinct() {
    let temp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(temp.path()).unwrap();
    let library = root.join("library");
    let workspace = root.join("workspace");
    init(&library, "library.txt");
    let committed = commit(&library, "initial library");
    init(&workspace, "root.txt");
    git(&workspace, &["submodule", "add", "--", library.to_str().unwrap(), "modules/library"]);
    let revision = commit(&workspace, "initial parent");

    fs::write(library.join("library.txt"), "staged revision\n").unwrap();
    let staged = commit(&library, "staged revision");
    fs::write(library.join("library.txt"), "checkout revision\n").unwrap();
    let working = commit(&library, "checkout revision");
    let module = workspace.join("modules/library");
    follow(&module, &staged);
    git(&workspace, &["add", "--", "modules/library"]);
    follow(&module, &working);

    let repos = Repos::discover(&workspace, &|_| false).unwrap();
    let parent = repos.for_path(&module).unwrap();
    assert_eq!(parent.root(), workspace);
    for (rev, expected) in [(revision.as_str(), &committed), ("HEAD", &committed), (":0", &staged), ("WT", &working)] {
        let entry = parent.diff_entry_at(&module, rev).unwrap().unwrap();
        assert_eq!(entry.mode, "160000");
        assert_eq!(entry.gitlink.as_ref(), Some(expected));
        if rev != "WT" {
            assert!(parent.file_bytes_at(&module, Some(rev)).unwrap().is_none());
        }
    }
    let file = parent.diff_entry_at(&workspace.join("root.txt"), "HEAD").unwrap().unwrap();
    assert_eq!(file.mode, "100644");
    assert!(file.gitlink.is_none());

    git(&root, &["clone", "-q", "workspace", "without-checkout"]);
    let clone = root.join("without-checkout");
    let gitlink = clone.join("modules/library");
    let parent = ide_vcs::Repo::discover(&clone).unwrap().unwrap();
    assert_eq!(parent.diff_entry_at(&gitlink, "HEAD").unwrap().unwrap().gitlink, Some(committed));
    let unavailable = parent.diff_entry_at(&gitlink, "WT").unwrap().unwrap();
    assert_eq!(unavailable.mode, "160000");
    assert!(unavailable.gitlink.is_none());
}

#[test]
fn project_update_follows_detached_gitlinks_and_preserves_staged_changes() {
    let temp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(temp.path()).unwrap();
    let upstream = root.join("upstream");
    let library = root.join("library");
    let leaf = root.join("leaf");
    init(&leaf, "leaf.txt");
    let leaf_before = commit(&leaf, "initial leaf");
    init(&library, "library.txt");
    git(&library, &["submodule", "add", "--", leaf.to_str().unwrap(), "vendor/leaf"]);
    let module_before = commit(&library, "initial library");
    init(&upstream, "root.txt");
    git(&upstream, &["submodule", "add", "--", library.to_str().unwrap(), "modules/library"]);
    let root_before = commit(&upstream, "initial root");

    git(&root, &["clone", "-q", "--recurse-submodules", "upstream", "workspace"]);
    let workspace = root.join("workspace");
    let module = workspace.join("modules/library");
    let nested = module.join("vendor/leaf");
    for repo in [&workspace, &module, &nested] {
        git(repo, &["config", "protocol.file.allow", "always"]);
        git(repo, &["config", "core.autocrlf", "false"]);
        git(repo, &["config", "user.name", "Update fixture"]);
        git(repo, &["config", "user.email", "test@example.com"]);
    }
    // Even when configured to recurse, Update Project owns sequencing and preservation.
    git(&workspace, &["config", "submodule.recurse", "true"]);
    fs::write(module.join("local.txt"), "staged local work\n").unwrap();
    git(&module, &["add", "local.txt"]);
    fs::write(module.join("local.txt"), "staged local work\nextra unstaged line\n").unwrap();
    fs::write(nested.join("untracked.txt"), "untracked local work\n").unwrap();

    fs::write(leaf.join("leaf.txt"), "updated leaf\n").unwrap();
    let leaf_after = commit(&leaf, "update leaf");
    follow(&library.join("vendor/leaf"), &leaf_after);
    fs::write(library.join("library.txt"), "updated library\n").unwrap();
    let module_after = commit(&library, "update library and leaf pointer");
    follow(&upstream.join("modules/library"), &module_after);
    fs::write(upstream.join("root.txt"), "updated root\n").unwrap();
    let root_after = commit(&upstream, "update root and library pointer");

    let repos = Repos::discover(&workspace, &|_| false).unwrap();
    assert_eq!(repos.roots(), [workspace.clone(), module.clone(), nested.clone()]);
    for repo in repos.all() {
        repo.set_execution_allowed(true);
    }
    let plan = repos.project_update_plan(&[Some(workspace.clone())]).unwrap();
    let paths = plan.iter().map(|target| target.root.0.as_path()).collect::<Vec<_>>();
    assert_eq!(paths, [workspace.as_path(), module.as_path(), nested.as_path()]);
    assert!(!plan[0].detached_submodule);
    assert!(plan[1].detached_submodule && plan[2].detached_submodule);
    assert_eq!(plan[1].parent.as_ref().unwrap().0, workspace);
    assert_eq!(plan[2].parent.as_ref().unwrap().0, module);
    assert_eq!(repos.project_update_plan(&[Some(nested.clone())]).unwrap().len(), 1);

    let parent = repos.at_root(&workspace).unwrap();
    let child = repos.at_root(&module).unwrap();
    let grandchild = repos.at_root(&nested).unwrap();
    let cancel = CancellationToken::new();
    let output = |_| {};
    assert_eq!(parent.head().unwrap().1.as_deref(), Some(root_before.as_str()));
    parent.pull_for_project_update(false, FetchTagsMode::Auto, &cancel, &output).unwrap();
    assert_eq!(parent.head().unwrap().1.as_deref(), Some(root_after.as_str()));
    assert_eq!(child.head().unwrap().1.as_deref(), Some(module_before.as_str()));
    assert_eq!(grandchild.head().unwrap().1.as_deref(), Some(leaf_before.as_str()));
    child.update_from_superproject(parent, &cancel, &output).unwrap();
    grandchild.update_from_superproject(child, &cancel, &output).unwrap();
    assert_eq!(child.head().unwrap(), (None, Some(module_after)));
    assert_eq!(grandchild.head().unwrap(), (None, Some(leaf_after)));
    assert_eq!(git(&module, &["show", ":local.txt"]), "staged local work");
    assert_eq!(fs::read_to_string(module.join("local.txt")).unwrap(), "staged local work\nextra unstaged line\n");
    assert_eq!(fs::read_to_string(nested.join("untracked.txt")).unwrap(), "untracked local work\n");
    assert!(git(&module, &["stash", "list"]).is_empty());

    git(&module, &["switch", "-qc", "local-topic"]);
    assert_eq!(repos.project_update_plan(&[Some(workspace.clone())]).unwrap().len(), 1);
    assert_eq!(repos.project_update_plan(&[]).unwrap().len(), 3);
    let attached = repos.project_update_plan(&[Some(module.clone())]).unwrap();
    assert!(!attached[0].detached_submodule);
    assert!(attached[1].detached_submodule);
    assert!(child.update_from_superproject(parent, &cancel, &output).is_err());
    assert_eq!(child.head().unwrap().0.as_deref(), Some("local-topic"));

    git(&module, &["commit", "--no-gpg-sign", "-qam", "local topic work"]);
    git(&module, &["branch", "--set-upstream-to=origin/main", "local-topic"]);
    fs::write(library.join("library.txt"), "next upstream library\n").unwrap();
    let next = commit(&library, "advance library independently");
    child.pull_for_project_update(true, FetchTagsMode::Auto, &cancel, &output).unwrap();
    assert_eq!(child.head().unwrap().0.as_deref(), Some("local-topic"));
    assert_eq!(git(&module, &["rev-parse", "HEAD^"]), next);
    assert_eq!(git(&module, &["show", "HEAD:local.txt"]), "staged local work\nextra unstaged line");
}
