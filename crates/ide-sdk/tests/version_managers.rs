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
    // SAFETY: the only test in this binary that writes the environment; the daemon
    // tests below read it, so they run after this one's fixtures are in place.
    unsafe {
        std::env::set_var("HOME", tmp.join("home"));
        std::env::set_var("MISE_DATA_DIR", &mise);
        std::env::set_var("ASDF_DATA_DIR", &asdf);
        std::env::set_var("MISE_GLOBAL_CONFIG_FILE", tmp.join("no-global.toml"));
        std::env::remove_var("JAVA_HOME");
        std::env::remove_var("MVND_HOME");
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
    assert_eq!(configs[2].command, installs.join("gradle/8.7/bin/gradle").to_string_lossy());
    assert_eq!(configs[2].env["JAVA_HOME"], jdk.home.to_string_lossy());
    assert_eq!(configs[3].command, maven.join("bin/mvn").to_string_lossy());

    assert_eq!(ide_sdk::apply::gradle_command(&project, &project, &s), installs.join("gradle/8.7/bin/gradle"));
    script(&project.join("gradlew"), "");
    assert_eq!(ide_sdk::apply::gradle_command(&project, &project, &s), project.join("gradlew"));
    let mut local = s.clone();
    local.languages.java.gradle.distribution = ide_core::settings::GradleDistribution::Local;
    local.languages.java.gradle.home = "local-gradle".into();
    assert_eq!(ide_sdk::apply::gradle_command(&project, &project, &local), project.join("local-gradle/bin/gradle"));
    let mut plain = [run("gradle", "gradle")];
    ide_sdk::apply::apply_to_run_configs(&mut plain, &project, &s);
    assert_eq!(plain[0].command, installs.join("gradle/8.7/bin/gradle").to_string_lossy());

    // The Maven daemon replaces the pinned Maven when it is on and installed; the
    // project JDK (21, from mise.toml) can host its JVM.
    let mut daemon = s.clone();
    daemon.languages.java.maven.daemon = true;
    daemon.languages.java.maven.mvnd_home = tmp.join("missing/mvnd").to_string_lossy().into_owned();
    assert_eq!(
        ide_sdk::apply::maven_command(&project, &daemon),
        Some(maven.join("bin/mvn")),
        "a dead-end mvnd home falls back to the pinned Maven"
    );
    let mvnd = tmp.join("mvnd");
    script(&mvnd.join("bin/mvnd"), "mvnd 1.0-m7");
    daemon.languages.java.maven.mvnd_home = mvnd.to_string_lossy().into_owned();
    assert_eq!(
        ide_sdk::apply::maven_command(&project, &daemon),
        Some(mvnd.join("bin/mvnd")),
        "a bare home resolves to <home>/bin/mvnd"
    );
    // The executable itself, like `maven.home`, also works.
    daemon.languages.java.maven.mvnd_home = mvnd.join("bin/mvnd").to_string_lossy().into_owned();
    assert_eq!(ide_sdk::apply::maven_command(&project, &daemon), Some(mvnd.join("bin/mvnd")));

    // The project's Maven wrapper keeps precedence over a pinned Maven.
    script(&project.join("mvnw"), "");
    assert_eq!(ide_sdk::apply::maven_command(&project, &s), None);
    // ...but not over the daemon.
    assert_eq!(ide_sdk::apply::maven_command(&project, &daemon), Some(mvnd.join("bin/mvnd")));

    // A version the project pins but that isn't installed: nothing is made up.
    write(&project.join("mise.toml"), "[tools]\njava = '25'\n");
    assert_eq!(ide_sdk::apply::project_jdk(&project, &s), None);
}

#[test]
fn maven_daemon_run_configs_follow_the_jdk_and_heal_back() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp = dunce::canonicalize(tmp.path()).unwrap();
    let project = tmp.join("project");
    write(&project.join("pom.xml"), "<project/>");
    let mvnd = tmp.join("mvnd");
    script(&mvnd.join("bin/mvnd"), "mvnd 1.0-m7");
    let mvn = tmp.join("mvn");
    script(&mvn.join("bin/mvn"), "Apache Maven 3.9.6");
    let mvnd_path = mvnd.join("bin/mvnd").to_string_lossy().into_owned();
    let mvn_path = mvn.join("bin/mvn").to_string_lossy().into_owned();

    let mut s = Settings::default();
    s.languages.java.maven.daemon = true;
    s.languages.java.maven.mvnd_home = mvnd_path.clone();
    s.languages.java.maven.home = mvn_path.clone();

    let run = |command: &str, detected: bool| RunConfig {
        id: "maven:x".into(),
        name: "x".into(),
        kind: "maven".into(),
        command: command.into(),
        args: vec!["package".into()],
        cwd: None,
        env: BTreeMap::new(),
        detected,
        is_test: false,
        debug_adapter: None,
        allow_parallel: false,
        extras: Default::default(),
    };

    // No project JDK: the daemon may pick its own, so it stays on mvnd.
    let mut configs = [run("mvn", true), run("mvn", false)];
    ide_sdk::apply::apply_to_run_configs(&mut configs, &project, &s);
    assert_eq!(configs[0].command, mvnd_path, "detected config runs the daemon");
    assert_eq!(configs[1].command, mvnd_path, "saved `mvn` config is pointed at the daemon");

    // A goal config saved from the tool window carries the launcher's absolute
    // path as it was then (`detected: false`); matching by file name redirects
    // it too, and leaves non-Maven commands alone.
    let mut configs = [run(&mvn_path, false), run("/bin/echo", false)];
    ide_sdk::apply::apply_to_run_configs(&mut configs, &project, &s);
    assert_eq!(configs[0].command, mvnd_path, "stale absolute `mvn` path follows the daemon");
    assert_eq!(configs[1].command, "/bin/echo", "non-Maven commands are not rewritten");

    // A project JDK older than the daemon's Java 17 requirement keeps mvn.
    let jdk8 = tmp.join("jdk8");
    jdk(&jdk8, "1.8.0_392");
    s.languages.java.jdk = jdk8.to_string_lossy().into_owned();
    let mut configs = [run("mvn", true), run("mvn", false)];
    ide_sdk::apply::apply_to_run_configs(&mut configs, &project, &s);
    assert_eq!(configs[0].command, mvn_path, "JDK 8 cannot host the daemon JVM");
    assert_eq!(configs[1].command, mvn_path);

    // A config saved while the daemon was on heals back to mvn when it is off.
    s.languages.java.maven.daemon = false;
    let mut configs = [run("mvnd", false)];
    ide_sdk::apply::apply_to_run_configs(&mut configs, &project, &s);
    assert_eq!(configs[0].command, mvn_path, "literal `mvnd` is rewritten to the resolved Maven");

    // And with the daemon back on (and no JDK holding it back), a literal `mvnd`
    // resolves to the configured one.
    s.languages.java.maven.daemon = true;
    s.languages.java.jdk = String::new();
    let mut configs = [run("mvnd", false)];
    ide_sdk::apply::apply_to_run_configs(&mut configs, &project, &s);
    assert_eq!(configs[0].command, mvnd_path);
}
