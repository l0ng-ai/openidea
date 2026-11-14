//! The native `nav_inheritance` command: it must return every Python class definition
//! in the project — attached dependency roots included — together with the base names
//! written in its source, so the UI can compute inheritance gutter markers without a
//! language server's type-hierarchy provider.

use ide_host::{Host, HostConfig, ops};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

const WINDOW: &str = "main";

struct Opened {
    host: Arc<Host>,
    root: PathBuf,
    _tmp: tempfile::TempDir,
}

/// Opens a synthetic project whose Python files carry known class / base shapes, then
/// waits for the index to settle (it walks content roots, so dependency roots are covered).
async fn open() -> Opened {
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap().join("proj");
    let src = root.join("src");
    let dep = root.join("vendor");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::create_dir_all(&dep).unwrap();

    // Own root: a plain class, a class with two bases + a keyword arg, a qualified base,
    // and a subscripted generic base. A comment / docstring that mentions `class X(Y)`
    // must not be reported.
    std::fs::write(
        src.join("app.py"),
        concat!(
            "class Base:\n",
            "    pass\n",
            "\n",
            "class Mixin:\n",
            "    pass\n",
            "\n",
            "class Child(Base, Mixin, metaclass=Meta):\n",
            "    # class Ghost(Spook): must be ignored\n",
            "    \"\"\"class Phantom(Apparition): must be ignored\"\"\"\n",
            "    pass\n",
            "\n",
            "class Qualified(pkg.mod.Base):\n",
            "    pass\n",
            "\n",
            "class Generic(Generic[T]):\n",
            "    pass\n",
        ),
    )
    .unwrap();
    // A second own-root file to prove the command scans more than one file.
    std::fs::write(src.join("extra.pyi"), "class Stub(Base):\n    ...\n").unwrap();
    // An attached dependency root (content root) — must be covered by the index.
    std::fs::write(dep.join("dep.py"), "class DepBase:\n    pass\n").unwrap();

    let app = tmp.path().join("app");
    let host = Arc::new(Host::new(HostConfig {
        config_dir: app.join("config"),
        data_dir: app.join("data"),
        local_data_dir: app.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(|_| {})),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }));
    host.trust.decide(&root, true, false).unwrap();
    ops::project::open(&host, WINDOW, &root).await.unwrap();

    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let s = ops::nav::index_status(&host, WINDOW).unwrap();
        if !s.indexing && s.files > 0 {
            break;
        }
        assert!(Instant::now() < deadline, "indexing timed out; status: {s:?}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Opened { host, root, _tmp: tmp }
}

fn find<'a>(all: &'a [ide_host::ops::nav::ClassInheritance], name: &str) -> &'a ide_host::ops::nav::ClassInheritance {
    all.iter().find(|c| c.name == name).unwrap_or_else(|| panic!("no class {name:?} in {all:#?}"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn returns_all_python_classes_and_bases() {
    let p = open().await;
    let all = ops::nav::nav_inheritance(&p.host, WINDOW).await.unwrap();

    // Both own-root Python files are scanned (src/app.py + src/extra.pyi).
    let base = find(&all, "Base");
    assert!(base.path.0.ends_with("src/app.py"), "Base path: {:?}", base.path);
    // The location is the class name identifier (selection-range start), i.e. after `class `.
    assert_eq!(base.line, 0);
    assert_eq!(base.col, 6);
    assert!(base.bases.is_empty(), "a bare class has no bases: {:?}", base.bases);

    let child = find(&all, "Child");
    assert_eq!(child.line, 6);
    assert_eq!(child.col, 6);
    // The `metaclass=Meta` keyword argument is not a base.
    assert!(child.bases.contains(&"Base".to_string()), "Child bases: {:?}", child.bases);
    assert!(child.bases.contains(&"Mixin".to_string()), "Child bases: {:?}", child.bases);
    assert!(!child.bases.iter().any(|b| b == "Meta"), "metaclass must be skipped: {:?}", child.bases);

    // A qualified base keeps only its last segment.
    let qualified = find(&all, "Qualified");
    assert_eq!(qualified.bases, vec!["Base".to_string()], "qualified base: {:?}", qualified.bases);

    // A subscripted generic base keeps the identifier.
    let generic = find(&all, "Generic");
    assert_eq!(generic.bases, vec!["Generic".to_string()], "generic base: {:?}", generic.bases);

    // Comments / docstrings are not mistaken for class definitions.
    assert!(!all.iter().any(|c| c.name == "Ghost" || c.name == "Phantom"), "parsed a comment: {all:#?}");

    // The .pyi stub in the second own-root file is included.
    let stub = find(&all, "Stub");
    assert!(stub.path.0.ends_with("src/extra.pyi"), "Stub path: {:?}", stub.path);
    assert_eq!(stub.bases, vec!["Base".to_string()]);

    // The attached dependency root is covered by the project index.
    let dep = find(&all, "DepBase");
    assert!(dep.path.0.starts_with(&p.root), "DepBase path: {:?}", dep.path);

    // Every returned entry is a Python file.
    assert!(all.iter().all(|c| { matches!(c.path.0.extension().and_then(|e| e.to_str()), Some("py" | "pyi")) }));

    // A file changed on disk is parsed again; the others come from the cache.
    let extra = p.root.join("src/extra.pyi");
    std::fs::write(&extra, "class Stub(Child): ...\nclass Added(Base): ...\n").unwrap();
    let again = ops::nav::nav_inheritance(&p.host, WINDOW).await.unwrap();
    assert_eq!(find(&again, "Stub").bases, vec!["Child".to_string()]);
    assert_eq!(find(&again, "Added").bases, vec!["Base".to_string()]);
    assert_eq!(find(&again, "Child").bases, child.bases);
}
