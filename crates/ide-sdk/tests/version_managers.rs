//! mise / asdf installs: detection and the project's pinned versions. One test in its
//! own binary: it points `MISE_DATA_DIR` / `ASDF_DATA_DIR` at a fake layout.
#![cfg(unix)]

use ide_core::settings::Settings;
use ide_run::RunConfig;
use ide_sdk::{Sdk, SdkKind, detect};
use std::collections::BTreeMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

/// An executable that prints `out` (a `--version` answer).
fn script(path: &Path, out: &str) {
    write(path, &format!("#!/bin/sh\necho '{out}'\n"));
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

fn jdk(home: &Path, version: &str) {
    write(&home.join("release"), &format!("IMPLEMENTOR=\"Eclipse Adoptium\"\nJAVA_VERSION=\"{version}\"\n"));
    script(&home.join("bin/java"), version);
}

fn find<'a>(sdks: &'a [Sdk], dir: &Path) -> &'a Sdk {
    sdks.iter().find(|s| s.path.starts_with(dir)).unwrap_or_else(|| panic!("{} not in {sdks:#?}", dir.display()))
}

#[test]
fn mise_and_asdf_installs_are_detected_and_pinned_versions_used() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp = dunce::canonicalize(tmp.path()).unwrap();
    let mise = tmp.join("mise");
    let asdf = tmp.join("asdf");
    // SAFETY: the only test in this binary; nothing else reads the environment yet.
    unsafe {
        std::env::set_var("HOME", tmp.join("home"));
        std::env::set_var("MISE_DATA_DIR", &mise);
        std::env::set_var("ASDF_DATA_DIR", &asdf);
        std::env::set_var("MISE_GLOBAL_CONFIG_FILE", tmp.join("no-global.toml"));
        std::env::remove_var("JAVA_HOME");
    }

    let installs = mise.join("installs");
    jdk(&installs.join("java/21.0.2/Contents/Home"), "21.0.2"); // macOS bundle
    jdk(&asdf.join("installs/java/temurin-17.0.10+7"), "17.0.10");
    for v in ["20.11.1", "22.1.0"] {
        script(&installs.join("node").join(v).join("bin/node"), &format!("v{v}"));
    }
    std::os::unix::fs::symlink("./22.1.0", installs.join("node/22")).unwrap();
    script(&installs.join("python/3.12.1/bin/python3"), "Python 3.12.1");
    let goroot = asdf.join("installs/golang/1.22.1/go");
    write(&goroot.join("VERSION"), "go1.22.1\n");
    script(&goroot.join("bin/go"), "go version go1.22.1");
    let maven = installs.join("maven/3.9.6");
    script(&maven.join("bin/mvn"), "Apache Maven 3.9.6");
    write(&maven.join("lib/maven-core-3.9.6.jar"), "");
    script(&installs.join("gradle/8.7/bin/gradle"), "Gradle 8.7");

    let project = tmp.join("project");
    write(
        &project.join("mise.toml"),
        "[tools]\njava = '21'\nnode = '20'\npython = '3.12'\nmaven = '3.9'\ngradle = '8.7'\n",
    );
    write(&project.join(".tool-versions"), "golang 1.22.1\nnodejs 22.1.0\n");

    let jdks = detect(SdkKind::Jdk, Some(&project));
    let mise_jdk = find(&jdks, &installs.join("java/21.0.2"));
    assert_eq!((mise_jdk.source.as_str(), mise_jdk.name.as_str()), ("mise", "Eclipse Adoptium 21.0.2"));
    assert_eq!(find(&jdks, &asdf.join("installs/java")).source, "asdf");
    assert_eq!(jdks[0].path, mise_jdk.path, "the pinned JDK first");

    let nodes = detect(SdkKind::Node, Some(&project));
    assert_eq!(nodes[0].path, installs.join("node/20.11.1/bin/node"), "mise.toml over .tool-versions");
    assert_eq!(find(&nodes, &installs.join("node/22.1.0")).source, "mise");
    assert_eq!(nodes.iter().filter(|s| s.source == "mise").count(), 2, "the `22` alias is not listed again");

    let pythons = detect(SdkKind::Python, Some(&project));
    assert_eq!(find(&pythons, &installs.join("python")).name, "Python 3.12 (mise)");

    let gos = detect(SdkKind::Go, Some(&project));
    let go = find(&gos, &goroot);
    assert_eq!((go.source.as_str(), go.version.as_deref()), ("asdf", Some("1.22.1")));

    let mavens = detect(SdkKind::Maven, Some(&project));
    let mvn = find(&mavens, &maven);
    assert_eq!((mvn.source.as_str(), mvn.version.as_deref()), ("mise", Some("3.9.6")));

    // Nothing configured in Settings: the pinned versions apply.
    let s = Settings::default();
    let jdk = ide_sdk::apply::project_jdk(&project, &s).expect("pinned JDK");
    assert_eq!((jdk.major, jdk.home.clone()), (21, installs.join("java/21.0.2/Contents/Home")));
    assert_eq!(ide_sdk::apply::python_interpreter(&project, &s), Some(installs.join("python/3.12.1/bin/python3")));
    assert_eq!(ide_sdk::apply::maven_command(&project, &s), Some(maven.join("bin/mvn")));

    let run = |kind: &str, command: &str| RunConfig {
        id: format!("{kind}:x"),
        name: "x".into(),
        kind: kind.into(),
        command: command.into(),
        args: vec![],
        cwd: None,
        env: BTreeMap::new(),
        detected: true,
        is_test: false,
        debug_adapter: None,
        allow_parallel: false,
        extras: Default::default(),
    };
    let mut configs = [run("npm", "npm"), run("go", "go"), run("gradle", "gradle"), run("maven", "mvn")];
    ide_sdk::apply::apply_to_run_configs(&mut configs, &project, &s);
    let path_of = |c: &RunConfig| -> Vec<PathBuf> { std::env::split_paths(&c.env["PATH"]).collect() };
    assert_eq!(path_of(&configs[0])[0], installs.join("node/20.11.1/bin"));
    assert_eq!(configs[1].command, goroot.join("bin/go").to_string_lossy());
    assert_eq!(configs[1].env["GOROOT"], goroot.to_string_lossy());
    assert_eq!(path_of(&configs[2])[0], installs.join("gradle/8.7/bin"));
    assert_eq!(configs[2].env["JAVA_HOME"], jdk.home.to_string_lossy());
    assert_eq!(configs[3].command, maven.join("bin/mvn").to_string_lossy());

    // The project's Maven wrapper keeps precedence over a pinned Maven.
    script(&project.join("mvnw"), "");
    assert_eq!(ide_sdk::apply::maven_command(&project, &s), None);

    // A version the project pins but that isn't installed: nothing is made up.
    write(&project.join("mise.toml"), "[tools]\njava = '25'\n");
    assert_eq!(ide_sdk::apply::project_jdk(&project, &s), None);
}
