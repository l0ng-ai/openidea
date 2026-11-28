use ide_core::CancellationToken;
use ide_vcs::Repo;
use std::{fs, path::Path, process::Command};

fn git(root: &Path, args: &[&str]) -> String {
    let result = Command::new("git").current_dir(root).args(args).output().unwrap();
    assert!(result.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&result.stderr));
    String::from_utf8(result.stdout).unwrap().trim().to_owned()
}

fn init(root: &Path) {
    fs::create_dir(root).unwrap();
    git(root, &["init", "-qb", "main"]);
    git(root, &["config", "user.name", "Submodule fixture"]);
    git(root, &["config", "user.email", "test@example.com"]);
}

#[test]
fn initializes_missing_submodules_and_syncs_their_urls() {
    // Git refuses local submodule clones by default; the IDE's git inherits this.
    // SAFETY: this test binary has a single test, so no other thread reads the environment.
    unsafe {
        std::env::set_var("GIT_CONFIG_COUNT", "1");
        std::env::set_var("GIT_CONFIG_KEY_0", "protocol.file.allow");
        std::env::set_var("GIT_CONFIG_VALUE_0", "always");
    }
    let temp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(temp.path()).unwrap();
    let (library, workspace, clone) = (root.join("library"), root.join("workspace"), root.join("clone"));
    init(&library);
    fs::write(library.join("library.txt"), "library\n").unwrap();
    git(&library, &["add", "-A"]);
    git(&library, &["commit", "--no-gpg-sign", "-qm", "library"]);
    init(&workspace);
    git(&workspace, &["submodule", "add", "-q", "--", library.to_str().unwrap(), "modules/library"]);
    git(&workspace, &["commit", "--no-gpg-sign", "-qm", "parent"]);
    git(&root, &["clone", "-q", "workspace", "clone"]);

    let repo = Repo::discover(&clone).unwrap().unwrap();
    assert_eq!(repo.uninitialized_submodules().unwrap(), [Path::new("modules/library")]);
    let (cancel, out) = (CancellationToken::default(), |_: String| {});
    assert!(repo.init_submodules(&cancel, &out).is_err(), "untrusted projects run no submodule commands");
    repo.set_execution_allowed(true);
    repo.init_submodules(&cancel, &out).unwrap();
    assert_eq!(fs::read_to_string(clone.join("modules/library/library.txt")).unwrap(), "library\n");
    assert!(repo.uninitialized_submodules().unwrap().is_empty());

    let moved = root.join("moved");
    fs::rename(&library, &moved).unwrap();
    git(&clone, &["config", "-f", ".gitmodules", "submodule.modules/library.url", moved.to_str().unwrap()]);
    repo.sync_submodules(&cancel, &out).unwrap();
    assert_eq!(git(&clone, &["config", "submodule.modules/library.url"]), moved.to_str().unwrap());
    assert_eq!(git(&clone.join("modules/library"), &["remote", "get-url", "origin"]), moved.to_str().unwrap());
}
