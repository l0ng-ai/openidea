use crate::apply::{
    apply_to_run_configs, configure_server, jdtls_jdk, maven_command, maven_options, project_jdk, python_interpreter,
    ruff_configuration, terminal_activation, tsdk, without_derived,
};
use crate::python::parse_pip_list;
use crate::{bin_dir, exe, venv_of};
use ide_core::settings::Settings;
use ide_language::LanguageServerConfig;
use ide_run::RunConfig;
use std::collections::BTreeMap;
use std::path::Path;

fn fake_venv(root: &Path, name: &str) -> std::path::PathBuf {
    let venv = root.join(name);
    std::fs::create_dir_all(venv.join(bin_dir())).unwrap();
    std::fs::write(venv.join("pyvenv.cfg"), "home = /usr/bin\nversion = 3.12.1\n").unwrap();
    let py = venv.join(bin_dir()).join(exe("python"));
    std::fs::write(&py, "").unwrap();
    std::fs::write(venv.join(bin_dir()).join("activate"), "").unwrap();
    py
}

fn server(name: &str) -> LanguageServerConfig {
    LanguageServerConfig {
        name: name.into(),
        command: name.into(),
        args: vec![],
        env: BTreeMap::new(),
        root_markers: vec![],
        require_root_marker: false,
        initialization_options: None,
        settings: None,
        install_hint: None,
        connect: None,
        fallback: false,
        features: Vec::new(),
        code_action_kinds: Vec::new(),
        max_java: None,
        launch_error: None,
        tsserver_project: false,
        resync_on_configuration: false,
        pinned: None,
    }
}

fn run(kind: &str, command: &str, args: &[&str]) -> RunConfig {
    RunConfig {
        id: format!("{kind}:x"),
        name: "x".into(),
        kind: kind.into(),
        command: command.into(),
        args: args.iter().map(|s| (*s).to_owned()).collect(),
        cwd: None,
        env: BTreeMap::new(),
        detected: true,
        is_test: false,
        debug_adapter: None,
        allow_parallel: false,
        extras: Default::default(),
    }
}

#[test]
fn project_venv_is_the_default_interpreter() {
    if cfg!(windows) {
        return; // Unix paths and shells
    }
    let tmp = tempfile::tempdir().unwrap();
    let s = Settings::default();
    assert_eq!(python_interpreter(tmp.path(), &s), None);
    let py = fake_venv(tmp.path(), ".venv");
    assert_eq!(python_interpreter(tmp.path(), &s), Some(py.clone()));
    assert_eq!(venv_of(&py), Some(tmp.path().join(".venv")));
    let mut s = Settings::default();
    s.languages.python.interpreter = "/opt/py/bin/python3".into();
    assert_eq!(python_interpreter(tmp.path(), &s).unwrap(), Path::new("/opt/py/bin/python3"));
}

#[test]
fn an_interpreter_outside_detection_is_named_like_a_detected_one() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("shop");
    let member = fake_venv(&root.join("backend"), ".venv");
    let sdk = crate::python_interpreter_sdk(&member, Some(&root)).unwrap();
    assert_eq!(
        (sdk.name.as_str(), sdk.version.as_deref(), sdk.source.as_str()),
        ("Python 3.12 (backend)", Some("3.12.1"), "venv")
    );
    let own = fake_venv(&root, ".venv");
    assert_eq!(crate::python_interpreter_sdk(&own, Some(&root)).unwrap().name, "Python 3.12 (shop)");
    // Outside the project the folder name says which one it is.
    let elsewhere = fake_venv(&tmp.path().join("other"), ".venv");
    assert_eq!(crate::python_interpreter_sdk(&elsewhere, Some(&root)).unwrap().name, "Python 3.12 (.venv)");
}

#[test]
fn pyright_gets_python_path_and_venv_env() {
    let tmp = tempfile::tempdir().unwrap();
    let py = fake_venv(tmp.path(), ".venv");
    let mut cfg = server("basedpyright");
    configure_server(&mut cfg, tmp.path(), tmp.path(), &Settings::default());
    let opts = serde_json::to_value(cfg.initialization_options.unwrap()).unwrap();
    assert_eq!(opts["python"]["pythonPath"], py.to_string_lossy().as_ref());
    assert_eq!(cfg.env["VIRTUAL_ENV"], tmp.path().join(".venv").to_string_lossy());
    assert!(cfg.env["PATH"].starts_with(&*tmp.path().join(".venv").join(bin_dir()).to_string_lossy()));
}

#[test]
fn jdtls_vm_args() {
    let tmp = tempfile::tempdir().unwrap();
    let mut s = Settings::default();
    s.languages.java.jdtls_vm_args = " -Xmx2g  -javaagent:/opt/lombok.jar ".into();
    let mut cfg = server("jdtls");
    configure_server(&mut cfg, tmp.path(), tmp.path(), &s);
    assert_eq!(cfg.args, ["--jvm-arg=-Xmx2g", "--jvm-arg=-javaagent:/opt/lombok.jar"]);
}

#[test]
fn jdtls_honors_the_configured_maven_local_repository() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("m2-repo");
    let mut s = Settings::default();
    s.languages.java.maven.local_repository = repo.to_string_lossy().into_owned();
    let mut cfg = server("jdtls");
    configure_server(&mut cfg, tmp.path(), tmp.path(), &s);
    assert_eq!(cfg.args, [format!("--jvm-arg=-Dmaven.repo.local={}", repo.to_string_lossy())]);
    // A `-Dmaven.repo.local` the user put in their own jdtls VM options wins.
    s.languages.java.jdtls_vm_args = "-Xmx2g -Dmaven.repo.local=/user/repo".into();
    let mut cfg = server("jdtls");
    configure_server(&mut cfg, tmp.path(), tmp.path(), &s);
    assert_eq!(cfg.args, ["--jvm-arg=-Xmx2g", "--jvm-arg=-Dmaven.repo.local=/user/repo"]);
    // Unset: jdtls keeps m2e's own default (no arg at all).
    let mut cfg = server("jdtls");
    configure_server(&mut cfg, tmp.path(), tmp.path(), &Settings::default());
    assert!(cfg.args.iter().all(|a| !a.contains("maven.repo.local")));
}

#[test]
fn rust_analyzer_check_command_and_toolchain() {
    if cfg!(windows) {
        return; // Unix paths and shells
    }
    let tmp = tempfile::tempdir().unwrap();
    let mut s = Settings::default();
    s.languages.rust.check_command = "clippy".into();
    s.languages.rust.stdlib = "/src/rust/library".into();
    s.languages.rust.rustfmt_args = "--edition 2024".into();
    let mut cfg = server("rust-analyzer");
    cfg.initialization_options =
        Some(toml::Value::try_from(serde_json::json!({ "cargo": { "features": "all" } })).unwrap());
    configure_server(&mut cfg, tmp.path(), tmp.path(), &s);
    let opts = serde_json::to_value(cfg.initialization_options.clone().unwrap()).unwrap();
    assert_eq!(opts["check"]["command"], "clippy");
    assert_eq!(opts["cargo"]["features"], "all", "existing options are kept");
    assert_eq!(opts["rustfmt"]["extraArgs"], serde_json::json!(["--edition", "2024"]));
    assert_eq!(cfg.env["RUST_SRC_PATH"], "/src/rust/library");
    // Unchanged settings produce an identical config (no needless restarts).
    let mut again = server("rust-analyzer");
    again.initialization_options =
        Some(toml::Value::try_from(serde_json::json!({ "cargo": { "features": "all" } })).unwrap());
    configure_server(&mut again, tmp.path(), tmp.path(), &s);
    assert_eq!(again, cfg);
}

#[test]
fn typescript_workspace_version() {
    let tmp = tempfile::tempdir().unwrap();
    let lib = tmp.path().join("node_modules/typescript/lib");
    std::fs::create_dir_all(&lib).unwrap();
    std::fs::write(lib.join("tsserver.js"), "").unwrap();
    let mut s = Settings::default();
    assert_eq!(tsdk(tmp.path(), &s), None);
    s.languages.typescript.version = "workspace".into();
    assert_eq!(tsdk(tmp.path(), &s), Some(lib.clone()));
    let mut cfg = server("vtsls");
    configure_server(&mut cfg, tmp.path(), tmp.path(), &s);
    let opts = serde_json::to_value(cfg.initialization_options.unwrap()).unwrap();
    assert_eq!(opts["typescript"]["tsdk"], lib.to_string_lossy().as_ref());
}

#[test]
fn run_configs_use_selected_interpreter_and_package_manager() {
    if cfg!(windows) {
        return; // Unix paths and shells
    }
    let tmp = tempfile::tempdir().unwrap();
    let mut s = Settings::default();
    s.languages.python.interpreter = "/opt/py/bin/python3".into();
    s.languages.node.package_manager = "pnpm".into();
    let mut configs = vec![
        run("python", "uv", &["run", "python", "-m", "app"]),
        run("pytest", ".venv/bin/pytest", &[]),
        run("pytest", "uv", &["run", "pytest", "-x"]),
        run("npm", "npm", &["run", "dev"]),
        run("shell", "python3", &["x.py"]),
        run("django-test", "uv", &["run", "python", "manage.py", "test"]),
        run("django-test", ".venv/bin/python", &["manage.py", "test", "polls"]),
    ];
    apply_to_run_configs(&mut configs, tmp.path(), &s);
    assert_eq!(configs[0].command, "/opt/py/bin/python3");
    assert_eq!(configs[0].args, ["-m", "app"]);
    assert_eq!(configs[1].command, "/opt/py/bin/python3");
    assert_eq!(configs[1].args, ["-m", "pytest"]);
    assert_eq!(configs[2].args, ["-m", "pytest", "-x"]);
    assert_eq!(configs[3].command, "pnpm");
    assert_eq!(configs[4].command, "python3", "shell configs are left alone");
    // Django tests run on the selected interpreter, like `manage.py runserver`.
    assert_eq!(configs[5].command, "/opt/py/bin/python3");
    assert_eq!(configs[5].args, ["manage.py", "test"]);
    assert_eq!(configs[6].command, "/opt/py/bin/python3");
    assert_eq!(configs[6].args, ["manage.py", "test", "polls"]);
}

#[test]
fn npm_config_runs_on_its_own_node_interpreter() {
    if cfg!(windows) {
        return; // Unix paths
    }
    let tmp = tempfile::tempdir().unwrap();
    let mut s = Settings::default();
    s.languages.node.interpreter = "/opt/node22/bin/node".into();
    let mut own = run("npm", "npm", &["run", "dev"]);
    own.extras.params.insert("nodeInterpreter".into(), "/opt/node18/bin/node".into());
    let mut configs = vec![own, run("npm", "npm", &["run", "build"])];
    apply_to_run_configs(&mut configs, tmp.path(), &s);
    let first = |c: &RunConfig| c.env["PATH"].split(':').next().unwrap().to_owned();
    assert_eq!(first(&configs[0]), "/opt/node18/bin");
    assert_eq!(first(&configs[1]), "/opt/node22/bin", "the project's Node.js without one");
    // Saved without the derived PATH, keeping the choice itself.
    let saved = without_derived(&configs[0], tmp.path(), &s);
    assert!(!saved.env.contains_key("PATH"));
    assert_eq!(saved.extras.params["nodeInterpreter"], "/opt/node18/bin/node");
    // Chosen on a configuration loaded with the project's PATH: that PATH isn't kept either.
    let mut edited = configs[1].clone();
    edited.extras.params.insert("nodeInterpreter".into(), "/opt/node18/bin/node".into());
    let saved = without_derived(&edited, tmp.path(), &s);
    assert!(!saved.env.contains_key("PATH"));
    let mut reloaded = vec![saved];
    apply_to_run_configs(&mut reloaded, tmp.path(), &s);
    assert_eq!(first(&reloaded[0]), "/opt/node18/bin");
}

fn fake_jdk(dir: &Path) {
    std::fs::create_dir_all(dir.join("bin")).unwrap();
    std::fs::write(dir.join("bin").join(exe("java")), "").unwrap();
    std::fs::write(
        dir.join("release"),
        "JAVA_VERSION=\"17.0.9\"\nMODULES=\"java.base jdk.compiler jdk.jdi jdk.unsupported\"\n",
    )
    .unwrap();
    std::fs::write(dir.join("bin").join(crate::exe("javac")), "").unwrap();
}

#[test]
fn project_jdk_and_maven_settings() {
    if cfg!(windows) {
        return; // Unix paths and shells
    }
    let tmp = tempfile::tempdir().unwrap();
    let jdk = tmp.path().join("jdk17");
    fake_jdk(&jdk);
    let maven = tmp.path().join("maven");
    std::fs::create_dir_all(maven.join("bin")).unwrap();
    std::fs::write(maven.join("bin/mvn"), "").unwrap();

    let mut s = Settings::default();
    assert_eq!(project_jdk(tmp.path(), &s), None);
    assert_eq!(maven_command(tmp.path(), &s), None);
    assert!(maven_options(tmp.path(), &s).is_empty());

    // Project-relative paths, a JDK's `bin/java`, a Maven home.
    s.languages.java.jdk = "jdk17/bin/java".into();
    s.languages.java.maven.home = maven.to_string_lossy().into_owned();
    s.languages.java.maven.user_settings = "/m2/settings.xml".into();
    s.languages.java.maven.local_repository = "/m2/repo".into();
    assert_eq!(project_jdk(tmp.path(), &s).map(|j| j.major), Some(17));
    assert_eq!(maven_command(tmp.path(), &s), Some(maven.join("bin/mvn")));
    assert_eq!(maven_options(tmp.path(), &s), ["-s", "/m2/settings.xml", "-Dmaven.repo.local=/m2/repo"]);

    let mut configs = vec![run("maven", "./mvnw", &["package"]), run("gradle", "./gradlew", &["build"])];
    apply_to_run_configs(&mut configs, tmp.path(), &s);
    let home = project_jdk(tmp.path(), &s).unwrap().home.to_string_lossy().into_owned();
    assert_eq!(configs[0].command, maven.join("bin/mvn").to_string_lossy());
    assert_eq!(configs[0].args, ["-s", "/m2/settings.xml", "-Dmaven.repo.local=/m2/repo", "package"]);
    assert_eq!(configs[0].env["JAVA_HOME"], home);
    assert_eq!(configs[1].env["JAVA_HOME"], home);
    apply_to_run_configs(&mut configs, tmp.path(), &s);
    assert_eq!(configs[0].args.len(), 4, "applied once");

    s.languages.java.jdk = "missing".into();
    assert_eq!(project_jdk(tmp.path(), &s), None);
}

#[test]
fn saved_maven_goal_configs_take_the_configured_launcher() {
    if cfg!(windows) {
        return; // Unix paths
    }
    let tmp = tempfile::tempdir().unwrap();
    let maven = tmp.path().join("maven");
    std::fs::create_dir_all(maven.join("bin")).unwrap();
    std::fs::write(maven.join("bin/mvn"), "").unwrap();
    let mut s = Settings::default();
    s.languages.java.maven.home = maven.to_string_lossy().into_owned();
    s.languages.java.maven.user_settings = "/m2/settings.xml".into();

    // A goal configuration saved from the tool window (`mvn -s … clean`):
    // the bare launcher resolves to the configured Maven home (#328) and its
    // own args are left alone.
    let mut saved = run("maven", "mvn", &["-s", "/m2/settings.xml", "clean"]);
    saved.detected = false;
    // A custom path / the wrapper stay as configured.
    let mut custom = run("maven", "/opt/other/bin/mvn", &["package"]);
    custom.detected = false;
    let mut wrapper = run("maven", "./mvnw", &["package"]);
    wrapper.detected = false;
    let mut configs = vec![saved, custom, wrapper];
    apply_to_run_configs(&mut configs, tmp.path(), &s);
    assert_eq!(configs[0].command, maven.join("bin/mvn").to_string_lossy());
    assert_eq!(configs[0].args, ["-s", "/m2/settings.xml", "clean"], "saved args are kept");
    assert_eq!(configs[1].command, "/opt/other/bin/mvn");
    assert_eq!(configs[2].command, "./mvnw");
}

#[test]
fn maven_launch_refreshes_legacy_defaults_but_keeps_user_overrides() {
    use crate::apply::prepare_maven_run;

    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("pom.xml"), "<project/>").unwrap();
    let home = tmp.path().join("new-maven");
    std::fs::create_dir_all(home.join("bin")).unwrap();
    let launcher = home.join("bin").join(if cfg!(windows) { "mvn.cmd" } else { "mvn" });
    std::fs::write(&launcher, "").unwrap();
    let mut s = Settings::default();
    s.languages.java.maven.home = home.to_string_lossy().into_owned();
    s.languages.java.maven.user_settings = "new-settings.xml".into();
    s.languages.java.maven.local_repository = "new-repo".into();
    let options = maven_options(tmp.path(), &s);

    for id in [
        "maven:goal:pom.xml:test",
        "maven:test",
        "context:maven:test:src/test/java/ExampleTest.java",
        "context:target:context:maven:test:src/test/java/ExampleTest.java:ExampleTest#example",
        "workspace:abc:maven:test",
        "context:target:context:workspace:abc:maven:test:src/test/java/ExampleTest.java:ExampleTest#example",
    ] {
        let mut config = run(
            "maven",
            "//?/UNC/server/old-maven/bin/mvn.cmd",
            &["-s", "old-settings.xml", "-Dmaven.repo.local=old-repo", "test", "-Dtest=ExampleTest#example"],
        );
        config.id = id.into();
        config.detected = !id.starts_with("maven:goal:");
        let original = config.clone();
        prepare_maven_run(&mut config, tmp.path(), &s);
        assert_eq!(config.command, launcher.to_string_lossy(), "{id}");
        assert_eq!(
            config.args,
            [options.clone(), vec!["test".into(), "-Dtest=ExampleTest#example".into()]].concat(),
            "{id}"
        );
        // Rerunning the stored configuration reads settings again, without changing the stored input.
        s.languages.java.maven.local_repository = "other-repo".into();
        let mut rerun = original;
        prepare_maven_run(&mut rerun, tmp.path(), &s);
        assert!(rerun.args.contains(&format!("-Dmaven.repo.local={}", tmp.path().join("other-repo").display())));
        s.languages.java.maven.local_repository = "new-repo".into();
    }

    for args in [
        vec!["-s", "own-settings.xml", "-Dmaven.repo.local=own-repo", "test"],
        vec!["--settings=own-settings.xml", "-D", "maven.repo.local=own-repo", "test"],
    ] {
        let mut config = run("maven", "mvn", &args);
        config.detected = false;
        prepare_maven_run(&mut config, tmp.path(), &s);
        assert_eq!(config.command, launcher.to_string_lossy());
        assert_eq!(config.args, args);
    }

    let mut explicit = run("maven", "/custom/mvn", &["-s", "own-settings.xml", "-Dmaven.repo.local=own-repo", "test"]);
    explicit.detected = false;
    prepare_maven_run(&mut explicit, tmp.path(), &s);
    assert_eq!(explicit.command, "/custom/mvn");
    assert_eq!(explicit.args, ["-s", "own-settings.xml", "-Dmaven.repo.local=own-repo", "test"]);

    // A gutter configuration derived from a user-edited default must keep that user's choices.
    let mut saved = explicit.clone();
    saved.id = "maven:test".into();
    ide_run::save_user_configs(tmp.path(), &[saved]).unwrap();
    explicit.id = "context:maven:test:src/test/java/ExampleTest.java".into();
    explicit.detected = true;
    prepare_maven_run(&mut explicit, tmp.path(), &s);
    assert_eq!(explicit.command, "/custom/mvn");
    assert_eq!(explicit.args, ["-s", "own-settings.xml", "-Dmaven.repo.local=own-repo", "test"]);

    std::fs::create_dir(tmp.path().join("child")).unwrap();
    std::fs::write(tmp.path().join("child/pom.xml"), "<project/>").unwrap();
    let mut nested = explicit.clone();
    nested.id = "maven:test:child".into();
    nested.detected = false;
    ide_run::save_user_configs(tmp.path(), &[nested]).unwrap();
    explicit.id = "context:maven:test:child:src/test/java/ExampleTest.java".into();
    prepare_maven_run(&mut explicit, tmp.path(), &s);
    assert_eq!(explicit.command, "/custom/mvn", "an edited child must not fall back to the parent's defaults");
    assert_eq!(explicit.args, ["-s", "own-settings.xml", "-Dmaven.repo.local=own-repo", "test"]);
}

#[test]
fn maven_goal_keeps_explicit_settings_and_nested_wrapper() {
    use crate::apply::prepare_maven_run;

    let tmp = tempfile::tempdir().unwrap();
    std::fs::create_dir(tmp.path().join("child")).unwrap();
    let wrapper = tmp.path().join("child").join(if cfg!(windows) { "mvnw.cmd" } else { "mvnw" });
    std::fs::write(&wrapper, "").unwrap();
    let mut config = run("maven", "old-maven", &["-s", "old-settings.xml", "-s", "own-settings.xml", "test"]);
    config.id = "maven:goal:child/pom.xml:-s own-settings.xml test".into();
    config.cwd = Some("child".into());
    config.detected = false;
    let mut s = Settings::default();
    s.languages.java.maven.user_settings = "new-settings.xml".into();
    prepare_maven_run(&mut config, tmp.path(), &s);
    assert_eq!(config.command, wrapper.to_string_lossy());
    assert_eq!(config.args, ["-s", "own-settings.xml", "test"]);
}

#[test]
fn persisting_a_maven_goal_keeps_explicit_options_equal_to_the_defaults() {
    let tmp = tempfile::tempdir().unwrap();
    let mut s = Settings::default();
    s.languages.java.maven.user_settings = tmp.path().join("settings.xml").to_string_lossy().into_owned();
    s.languages.java.maven.local_repository = tmp.path().join("repo").to_string_lossy().into_owned();
    let options = maven_options(tmp.path(), &s);
    for goals in [vec![options[2].clone(), "test".into()], [options.clone(), vec!["test".into()]].concat()] {
        let mut config = run("maven", "mvn", &[]);
        config.id = format!("maven:goal:pom.xml:{}", goals.join(" "));
        config.detected = false;
        config.args = goals.clone();
        apply_to_run_configs(std::slice::from_mut(&mut config), tmp.path(), &s);
        let kept = without_derived(&config, tmp.path(), &s);
        assert_eq!(kept.args, goals);
    }
}

#[test]
fn language_server_settings_disable_add_and_override() {
    use crate::apply::{language_servers, server_launch_overrides, server_protocol_overrides, with_custom_servers};
    use ide_core::settings::LanguageServerSettings;
    use serde_json::json;

    let mut s = Settings::default();
    s.language_servers.insert("pylsp".into(), LanguageServerSettings { enabled: false, ..Default::default() });
    s.language_servers.insert(
        "pylyzer".into(),
        LanguageServerSettings {
            command: "pylyzer".into(),
            args: Some(vec!["--server".into()]),
            languages: vec!["python".into()],
            root_markers: vec!["pyproject.toml".into()],
            ..Default::default()
        },
    );
    let defined = [server("basedpyright"), server("pylsp")];
    let names = |v: Vec<LanguageServerConfig>| v.into_iter().map(|c| c.name).collect::<Vec<_>>();
    assert_eq!(names(language_servers("python", &defined, &s)), ["basedpyright", "pylyzer"]);
    assert_eq!(names(language_servers("rust", &[server("rust-analyzer")], &s)), ["rust-analyzer"]);

    // Listed with the tools even while disabled.
    let mut langs = ide_language::LanguageRegistry::load(None).unwrap().all();
    with_custom_servers(&mut langs, &s);
    let python = langs.iter().find(|l| l.id.as_str() == "python").unwrap();
    let mut pylyzer = python.language_servers.iter().find(|c| c.name == "pylyzer").unwrap().clone();
    assert_eq!(pylyzer.root_markers, ["pyproject.toml"]);
    server_launch_overrides(&mut pylyzer, &s);
    assert_eq!((pylyzer.command.as_str(), pylyzer.args.as_slice()), ("pylyzer", &["--server".to_string()][..]));

    // A hand-defined server named like a built-in one only overrides how it
    // launches: languages and root markers stay the built-in definition's.
    s.language_servers.insert(
        "ruff".into(),
        LanguageServerSettings {
            command: "/opt/ruff".into(),
            args: Some(vec!["server".into(), "--preview".into()]),
            languages: vec!["python".into()],
            root_markers: vec!["pyproject.toml".into()],
            ..Default::default()
        },
    );
    let mut langs = ide_language::LanguageRegistry::load(None).unwrap().all();
    with_custom_servers(&mut langs, &s);
    let python = langs.iter().find(|l| l.id.as_str() == "python").unwrap();
    assert_eq!(python.language_servers.iter().filter(|c| c.name == "ruff").count(), 1);
    let mut ruff = python.language_servers.iter().find(|c| c.name == "ruff").unwrap().clone();
    assert_eq!(ruff.root_markers, ["ruff.toml", ".ruff.toml", "pyproject.toml#tool.ruff"]);
    assert!(ruff.require_root_marker);
    server_launch_overrides(&mut ruff, &s);
    assert_eq!(
        (ruff.command.as_str(), ruff.args.as_slice()),
        ("/opt/ruff", &["server".to_string(), "--preview".to_string()][..])
    );
    s.languages.ruff.configuration_directory = "ruff-config".into();
    let defined = [server("ruff")];
    assert!(!language_servers("python", &defined, &s)[0].require_root_marker);

    s.language_servers.insert(
        "rust-analyzer".into(),
        LanguageServerSettings {
            env: BTreeMap::from([("RA_LOG".into(), "info".into())]),
            initialization_options: Some(json!({ "check": { "command": "clippy" } })),
            settings: Some(json!({ "rust-analyzer": { "cargo": { "features": "all" } } })),
            ..Default::default()
        },
    );
    let mut ra = server("rust-analyzer");
    ra.args = vec!["--stdio".into()];
    ra.initialization_options = Some(toml::Value::Table(toml::toml! { checkOnSave = false }));
    server_launch_overrides(&mut ra, &s);
    assert_eq!(ra.args, ["--stdio"], "no args setting keeps the definition's");
    server_protocol_overrides(&mut ra, &s);
    assert_eq!(ra.env["RA_LOG"], "info");
    let init = serde_json::to_value(ra.initialization_options.unwrap()).unwrap();
    assert_eq!(init, json!({ "checkOnSave": false, "check": { "command": "clippy" } }));
    assert_eq!(ra.settings, Some(json!({ "rust-analyzer": { "cargo": { "features": "all" } } })));
    assert!(ra.features.is_empty() && ra.code_action_kinds.is_empty(), "no setting keeps the definition's");

    // `features` / `codeActionKinds` replace the definition's; empty lifts them.
    let mut pylsp = server("pylsp");
    pylsp.features = vec!["code-action".into()];
    pylsp.code_action_kinds = vec!["refactor".into()];
    s.language_servers.insert(
        "pylsp".into(),
        LanguageServerSettings {
            features: Some(vec!["code-action".into(), "hover".into()]),
            code_action_kinds: Some(vec![]),
            ..Default::default()
        },
    );
    server_protocol_overrides(&mut pylsp, &s);
    assert_eq!(pylsp.features, ["code-action", "hover"]);
    assert!(pylsp.code_action_kinds.is_empty());
    let parsed: LanguageServerSettings =
        serde_json::from_value(json!({ "features": ["code-action"], "codeActionKinds": ["refactor"] })).unwrap();
    assert_eq!(parsed.code_action_kinds, Some(vec!["refactor".to_string()]));
}

#[test]
fn ruff_configuration_directory_resolves_files_and_validates_pyproject() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let dir = root.join("shared ruff");
    std::fs::create_dir_all(&dir).unwrap();
    assert_eq!(ruff_configuration(root, "").unwrap(), None);
    assert!(ruff_configuration(root, &dir.to_string_lossy()).unwrap_err().message.contains("has no"));

    let ruff = dir.join("ruff.toml");
    std::fs::write(&ruff, "line-length = 100\n").unwrap();
    assert_eq!(ruff_configuration(root, &dir.to_string_lossy()).unwrap(), Some(ruff.clone()));
    assert_eq!(ruff_configuration(root, &ruff.to_string_lossy()).unwrap(), Some(ruff));

    std::fs::remove_file(dir.join("ruff.toml")).unwrap();
    let pyproject = dir.join("pyproject.toml");
    std::fs::write(&pyproject, "[project]\nname = \"x\"\n").unwrap();
    assert!(ruff_configuration(root, &dir.to_string_lossy()).unwrap_err().message.contains("has no"));
    std::fs::write(&pyproject, "[tool.ruff]\nline-length = 100\n").unwrap();
    assert_eq!(ruff_configuration(root, &dir.to_string_lossy()).unwrap(), Some(pyproject.clone()));

    let mut settings = Settings::default();
    settings.languages.ruff.configuration_directory = dir.to_string_lossy().into_owned();
    let mut cfg = server("ruff");
    configure_server(&mut cfg, root, root, &settings);
    let configured = dir.join("pyproject.toml").to_string_lossy().into_owned();
    assert_eq!(
        cfg.settings.as_ref().and_then(|s| s.get("configuration")).and_then(|v| v.as_str()),
        Some(configured.as_str())
    );
}

#[test]
fn jdtls_jdk_setting() {
    if cfg!(windows) {
        return; // Unix paths
    }
    let tmp = tempfile::tempdir().unwrap();
    fake_jdk(&tmp.path().join("jdk17"));
    let mut s = Settings::default();
    assert_eq!(jdtls_jdk(tmp.path(), &s), Ok(None));
    // Separate from the project JDK, which run configurations keep using.
    s.languages.java.jdk = "jdk17".into();
    assert_eq!(jdtls_jdk(tmp.path(), &s), Ok(None));
    s.languages.java.jdtls_jdk = "jdk17/bin".into();
    assert_eq!(jdtls_jdk(tmp.path(), &s).unwrap().map(|j| j.major), Some(17));
    std::fs::write(
        tmp.path().join("jdk17/release"),
        "JAVA_VERSION=\"25\"\nIMAGE_TYPE=\"JRE\"\nMODULES=\"java.base jdk.compiler jdk.jdi jdk.unsupported\"\n",
    )
    .unwrap();
    assert!(jdtls_jdk(tmp.path(), &s).unwrap_err().contains("full JDK"));
    // A chosen path that is not a JDK is an error, not a silent fallback.
    std::fs::create_dir(tmp.path().join("not-a-jdk")).unwrap();
    s.languages.java.jdtls_jdk = "not-a-jdk".into();
    assert!(jdtls_jdk(tmp.path(), &s).unwrap_err().contains("is not a JDK home"));
    // A JDK removed after it was chosen (a version manager upgraded it) says so.
    s.languages.java.jdtls_jdk = "jdk17.0.1".into();
    let err = jdtls_jdk(tmp.path(), &s).unwrap_err();
    assert!(err.contains("jdk17.0.1 does not exist") && err.contains("Languages & Frameworks › Java"), "{err}");
}

#[test]
fn terminal_activation_for_project_venv() {
    if cfg!(windows) {
        return; // Unix paths and shells
    }
    let tmp = tempfile::tempdir().unwrap();
    let mut s = Settings::default();
    assert_eq!(terminal_activation(tmp.path(), &s, "/bin/zsh"), None);
    fake_venv(tmp.path(), ".venv");
    let line = terminal_activation(tmp.path(), &s, "/bin/zsh").unwrap();
    assert!(line.starts_with("source '") && line.ends_with("/activate'"), "{line}");
    assert_eq!(terminal_activation(tmp.path(), &s, "/usr/bin/fish"), None, "no activate.fish");
    assert_eq!(terminal_activation(tmp.path(), &s, "docker"), None, "not a shell");
    s.languages.python.activate_virtualenv = false;
    assert_eq!(terminal_activation(tmp.path(), &s, "/bin/zsh"), None);
}

#[test]
fn terminal_activation_for_windows_shell_paths() {
    let tmp = tempfile::tempdir().unwrap();
    let mut s = Settings::default();
    s.languages.python.interpreter = fake_venv(tmp.path(), ".venv with spaces 'quoted'").to_string_lossy().into_owned();
    let bin = tmp.path().join(".venv with spaces 'quoted'").join(bin_dir());
    for (shell, script, powershell) in [
        (r"C:\Program Files\PowerShell\7\pwsh.exe", "Activate.ps1", true),
        (r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe", "Activate.ps1", true),
        (r"C:\Windows\System32\cmd.exe", "activate.bat", false),
    ] {
        assert_eq!(terminal_activation(tmp.path(), &s, shell), None, "missing {script}");
        let path = bin.join(script);
        std::fs::write(&path, "").unwrap();
        let expected = if powershell {
            format!("& '{}'", path.to_string_lossy().replace('\'', "''"))
        } else {
            format!("\"{}\"", path.display())
        };
        assert_eq!(terminal_activation(tmp.path(), &s, shell), Some(expected), "{shell}");
        std::fs::remove_file(path).unwrap();
    }
    assert_eq!(terminal_activation(tmp.path(), &s, ""), None);
    assert_eq!(terminal_activation(tmp.path(), &s, "   "), None);
}

#[test]
fn pip_list_output_is_parsed() {
    let out = "$ python -m pip list\n[{\"name\": \"requests\", \"version\": \"2.32.0\"}]\n";
    let pkgs = parse_pip_list(out).unwrap();
    assert_eq!(pkgs[0].name, "requests");
    assert_eq!(pkgs[0].version, "2.32.0");
}

/// A directory whose `typing.py` breaks any interpreter that imports it from there.
fn shadowing_dir() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("typing.py"), "raise ImportError('shadowed stdlib')\n").unwrap();
    std::fs::write(dir.path().join("logging.py"), "raise ImportError('shadowed stdlib')\n").unwrap();
    dir
}

#[test]
fn venv_creation_ignores_modules_in_the_working_directory() {
    let Some(python) = crate::exec::which("python3") else { return };
    let shadow = shadowing_dir();
    // Precondition: without isolation the shadowing module is picked up.
    let plain =
        std::process::Command::new(&python).args(["-c", "import typing"]).current_dir(shadow.path()).output().unwrap();
    assert!(!plain.status.success());
    let target = tempfile::tempdir().unwrap();
    let location = target.path().join(".venv");
    // `--without-pip` keeps the test fast; the stdlib imports of `venv` still happen.
    let mut args = crate::python::venv_args(&location);
    args.push("--without-pip".into());
    crate::exec::stream(&python, &args, Some(shadow.path()), &[], &Default::default(), &|_| {}).unwrap();
    assert!(location.join("pyvenv.cfg").is_file());
}

#[test]
fn neutral_dir_is_fresh_and_empty() {
    let a = crate::python::neutral_dir().unwrap();
    let b = crate::python::neutral_dir().unwrap();
    assert_ne!(a.path(), b.path());
    assert_eq!(std::fs::read_dir(a.path()).unwrap().count(), 0);
}

#[test]
fn relative_requirements_resolve_against_the_project() {
    use crate::python::resolve_requirement;
    let root = Path::new("/work/app");
    assert_eq!(resolve_requirement("requests==2.0", Some(root)).unwrap(), "requests==2.0");
    assert_eq!(resolve_requirement("./pkg", Some(root)).unwrap(), root.join("./pkg").to_string_lossy());
    assert_eq!(resolve_requirement(".[dev]", Some(root)).unwrap(), root.join(".[dev]").to_string_lossy());
    assert!(resolve_requirement("../lib", None).is_err());
}

#[test]
fn excluded_folders_become_anchored_globs() {
    let mut s = Settings::default();
    s.project_structure.excluded = vec!["build/".into(), " ".into()];
    let globs = s.exclude_globs();
    assert!(globs.contains(&"/build".to_owned()));
    assert_eq!(globs.len(), s.file_excludes().len() + 1);
}

/// Prints what this machine has installed.
#[test]
#[ignore]
fn detect_on_this_machine() {
    for kind in [
        crate::SdkKind::Python,
        crate::SdkKind::Node,
        crate::SdkKind::PackageManager,
        crate::SdkKind::Rust,
        crate::SdkKind::Go,
    ] {
        let t = std::time::Instant::now();
        let found = crate::detect(kind, Some(Path::new(env!("CARGO_MANIFEST_DIR"))));
        eprintln!("{kind:?} ({} ms)", t.elapsed().as_millis());
        for sdk in found {
            eprintln!("  {} {:?} [{}] {}", sdk.name, sdk.version, sdk.source, sdk.path.display());
        }
    }
}

#[test]
fn custom_tool_path_replaces_the_command() {
    let tmp = tempfile::tempdir().unwrap();
    let mut s = Settings::default();
    s.tools.insert("elixir-ls".into(), ide_core::settings::ToolSettings { path: "tools/ls/language_server.sh".into() });
    s.tools.insert("zls".into(), ide_core::settings::ToolSettings { path: "  ".into() });
    let mut cfg = server("elixir-ls");
    configure_server(&mut cfg, tmp.path(), tmp.path(), &s);
    assert_eq!(Path::new(&cfg.command), tmp.path().join("tools/ls/language_server.sh"));
    // A blank path keeps auto-detection.
    let mut cfg = server("zls");
    configure_server(&mut cfg, tmp.path(), tmp.path(), &s);
    assert_eq!(cfg.command, "zls");
}

#[test]
fn the_godot_setting_applies_to_server_debugger_and_run_configurations() {
    let tmp = tempfile::tempdir().unwrap();
    let mut s = Settings::default();
    s.tools.insert("godot".into(), ide_core::settings::ToolSettings { path: "~/Godot/godot".into() });
    let expected = crate::home_dir().unwrap().join("Godot/godot");
    assert_eq!(crate::apply::tool_command(tmp.path(), &s, "godot"), Some(expected.clone()));
    let mut cfg = LanguageServerConfig { command: "godot".into(), ..server("godot") };
    configure_server(&mut cfg, tmp.path(), tmp.path(), &s);
    assert_eq!(Path::new(&cfg.command), expected);
    let mut run = RunConfig {
        id: "godot:project".into(),
        name: "Godot Project".into(),
        kind: "godot".into(),
        command: "godot".into(),
        args: vec!["--path".into(), ".".into()],
        cwd: None,
        env: BTreeMap::new(),
        detected: true,
        is_test: false,
        debug_adapter: Some("godot".into()),
        allow_parallel: false,
        extras: Default::default(),
    };
    apply_to_run_configs(std::slice::from_mut(&mut run), tmp.path(), &s);
    assert_eq!(Path::new(&run.command), expected);
    // Other commands keep their name without a setting.
    assert_eq!(crate::apply::tool_command(tmp.path(), &s, "zls"), None);
}

#[test]
fn python_library_paths_are_parsed_and_deduplicated() {
    let tmp = tempfile::tempdir().unwrap();
    let stdlib = tmp.path().join("lib/python3.12");
    let site = stdlib.join("site-packages");
    std::fs::create_dir_all(&site).unwrap();
    let json = serde_json::to_string(&[Some(&stdlib), Some(&stdlib), Some(&site), None]).unwrap();
    let paths = crate::libraries::parse_python_paths(&format!("warning: something\n{json}"));
    assert_eq!(paths.len(), 3);
    let roots = crate::libraries::library_roots([paths, vec![tmp.path().join("gone")]].concat());
    assert_eq!(roots.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["python3.12", "site-packages"]);
    assert!(crate::libraries::parse_python_paths("not json").is_empty());
}

#[test]
fn no_libraries_without_an_interpreter() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(crate::libraries::project_libraries(tmp.path(), &Settings::default(), &[]).is_empty());
}

#[test]
fn node_libraries_list_direct_dependencies_and_core_typings() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    std::fs::write(
        root.join("package.json"),
        r#"{"dependencies":{"react":"^18","@scope/ui":"1"},"devDependencies":{"vitest":"2","react":"^18"}}"#,
    )
    .unwrap();
    for dir in ["react", "@scope/ui", "@types/node", "transitive"] {
        std::fs::create_dir_all(root.join("node_modules").join(dir)).unwrap();
    }
    let groups = crate::libraries::node_libraries(root, None);
    let summary: Vec<(&str, &str, Vec<&str>)> = groups
        .iter()
        .map(|g| (g.name.as_str(), g.kind.as_str(), g.roots.iter().map(|r| r.name.as_str()).collect()))
        .collect();
    assert_eq!(
        summary,
        [
            ("Node.js Core", "nodeCore", vec!["@types/node"]),
            ("node_modules", "nodeModules", vec!["@scope/ui", "react"])
        ]
    );
    assert_eq!(crate::libraries::package_dependencies("{"), Vec::<String>::new());
}

#[test]
fn cargo_metadata_lists_registry_packages_only() {
    let tmp = tempfile::tempdir().unwrap();
    let serde = tmp.path().join("registry/src/index/serde-1.0.200");
    let json = serde_json::json!({ "packages": [
        { "name": "app", "version": "0.1.0", "source": null, "manifest_path": tmp.path().join("Cargo.toml") },
        { "name": "serde", "version": "1.0.200", "source": "registry+https://github.com/rust-lang/crates.io-index",
          "manifest_path": serde.join("Cargo.toml") },
    ]});
    assert_eq!(crate::libraries::parse_cargo_metadata(&json.to_string()), [("serde 1.0.200".to_owned(), serde)]);
    assert!(crate::libraries::parse_cargo_metadata("error: no Cargo.toml").is_empty());
}

#[test]
fn go_modules_skip_the_main_module_and_missing_downloads() {
    let out = r#"{"Path":"example.com/app","Main":true,"Dir":"/p"}
{"Path":"golang.org/x/text","Version":"v0.14.0","Dir":"/gopath/pkg/mod/golang.org/x/text@v0.14.0"}
{"Path":"example.com/missing","Version":"v1.0.0","Error":{"Err":"module lookup disabled"}}"#;
    assert_eq!(
        crate::libraries::parse_go_modules(out),
        [(
            "golang.org/x/text@v0.14.0".to_owned(),
            std::path::PathBuf::from("/gopath/pkg/mod/golang.org/x/text@v0.14.0")
        )]
    );
}

#[test]
fn jdk_library_is_the_jdk_home() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("temurin-21.jdk/Contents/Home");
    std::fs::create_dir_all(&home).unwrap();
    assert_eq!(crate::libraries::jdk_name(&home).as_deref(), Some("temurin-21"));
    assert_eq!(crate::libraries::jdk_name(&tmp.path().join("jdk-17")).as_deref(), Some("jdk-17"));
    let group = crate::libraries::jdk_library(&crate::java::Jdk { major: 21, home: home.clone() }).unwrap();
    assert_eq!((group.name.as_str(), group.kind.as_str()), ("temurin-21", "jdk"));
    assert_eq!(group.roots[0].path, ide_core::IpcPath::from(home.clone()));
    assert_eq!(group.roots.len(), 1, "no sources archive");

    std::fs::create_dir_all(home.join("lib")).unwrap();
    std::fs::write(home.join("lib/src.zip"), "").unwrap();
    let group = crate::libraries::jdk_library(&crate::java::Jdk { major: 21, home: home.clone() }).unwrap();
    assert_eq!(group.roots[1].name, "src.zip");
    assert_eq!(group.roots[1].path, ide_core::IpcPath::from(ide_vfs::archive_root(&home.join("lib/src.zip"))));
}

#[test]
fn build_dependencies_resolve_to_local_jars() {
    use crate::libraries::{BuildDependency, dependency_libraries};
    let tmp = tempfile::tempdir().unwrap();
    let (m2, gradle) = (tmp.path().join("m2"), tmp.path().join("gradle"));
    let touch = |p: std::path::PathBuf| {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, "").unwrap();
        p
    };
    let guava = touch(m2.join("com/google/guava/guava/33.0/guava-33.0.jar"));
    touch(m2.join("com/google/guava/guava/33.0/guava-33.0-sources.jar"));
    let junit = touch(m2.join("junit/junit/4.13/junit-4.13.jar"));
    let files = gradle.join("caches/modules-2/files-2.1/org.slf4j/slf4j-api/2.0.9");
    let slf4j = touch(files.join("a1b2/slf4j-api-2.0.9.jar"));
    touch(files.join("c3d4/slf4j-api-2.0.9-sources.jar"));
    let dep = |gradle: bool, g: &str, a: &str, v: &str| BuildDependency {
        gradle,
        group: g.into(),
        artifact: a.into(),
        version: v.into(),
    };
    let deps = [
        dep(false, "junit", "junit", "4.13"),
        dep(false, "com.google.guava", "guava", "33.0"),
        dep(false, "com.google.guava", "guava", "33.0"),
        dep(true, "org.slf4j", "slf4j-api", "2.0.9"),
        dep(false, "missing", "nope", "1.0"),
        dep(false, "..", "evil", "1"),
    ];
    let groups = dependency_libraries(&deps, Some(&m2), Some(&gradle));
    let shown: Vec<(&str, &str, &str)> =
        groups.iter().map(|g| (g.name.as_str(), g.kind.as_str(), g.roots[0].name.as_str())).collect();
    assert_eq!(
        shown,
        [
            ("Maven: com.google.guava:guava:33.0", "maven", "guava-33.0.jar"),
            ("Maven: junit:junit:4.13", "maven", "junit-4.13.jar"),
            ("Gradle: org.slf4j:slf4j-api:2.0.9", "gradle", "slf4j-api-2.0.9.jar"),
        ]
    );
    assert_eq!(groups[0].roots[0].path, ide_core::IpcPath::from(ide_vfs::archive_root(&guava)));
    assert_eq!(groups[1].roots[0].path, ide_core::IpcPath::from(ide_vfs::archive_root(&junit)));
    assert_eq!(groups[2].roots[0].path, ide_core::IpcPath::from(ide_vfs::archive_root(&slf4j)));
    // A Gradle build also finds jars installed in the Maven local repository (`mavenLocal()`).
    let groups = dependency_libraries(&[dep(true, "junit", "junit", "4.13")], Some(&m2), Some(&gradle));
    assert_eq!(groups[0].name, "Gradle: junit:junit:4.13");
}

#[test]
fn library_detection_is_cached_until_a_manifest_changes() {
    let tmp = tempfile::tempdir().unwrap();
    let manifest = tmp.path().join("package.json");
    std::fs::write(&manifest, "{}").unwrap();
    let runs = std::cell::Cell::new(0);
    let detect = || {
        runs.set(runs.get() + 1);
        Vec::new()
    };
    let files = [manifest.clone()];
    crate::libraries::cached(tmp.path(), "test", "a".into(), &files, detect);
    crate::libraries::cached(tmp.path(), "test", "a".into(), &files, detect);
    assert_eq!(runs.get(), 1);
    std::fs::write(&manifest, r#"{"dependencies":{}}"#).unwrap();
    crate::libraries::cached(tmp.path(), "test", "a".into(), &files, detect);
    assert_eq!(runs.get(), 2);
    crate::libraries::cached(tmp.path(), "test", "b".into(), &files, detect);
    assert_eq!(runs.get(), 3);
}

#[test]
fn no_ecosystem_libraries_without_manifests() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(tmp.path().join("node_modules/react")).unwrap();
    assert!(crate::libraries::project_libraries(tmp.path(), &Settings::default(), &[]).is_empty());
}

/// Tools dir with vue-language-server and the given TypeScript files, plus a
/// project; returns (tools, project).
fn vue_setup(tmp: &Path, tools_ts: &str, project_ts: &str) -> (std::path::PathBuf, std::path::PathBuf) {
    let tools = tmp.join("tools/node_modules");
    let project = tmp.join("app");
    for (p, content) in [
        (tools.join(".bin/vue-language-server"), ""),
        (tools.join("@vue/language-server/package.json"), "{}"),
        (tools.join("typescript/lib").join(tools_ts), ""),
        (project.join("node_modules/typescript/lib").join(project_ts), ""),
        (project.join("node_modules/typescript/lib/tsserver.js"), ""),
    ] {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    }
    (tools, project)
}

#[test]
fn vue_language_server_gets_a_typescript_with_the_language_service_api() {
    // Issue #25: `typescript@latest` (7.x) in the tools dir has no `ts.server`.
    let s = Settings::default();
    let cases = [
        // (tools TypeScript, project TypeScript, expected --tsdk = project lib, launch error)
        ("typescript.js", "typescript.js", false, false), // own TypeScript 5/6 works
        ("tsc.js", "typescript.js", true, false),         // own TS 7: the project's
        ("tsc.js", "tsc.js", false, true),                // nothing usable: clear error
    ];
    for (tools_ts, project_ts, uses_project, error) in cases {
        let tmp = tempfile::tempdir().unwrap();
        let (tools, project) = vue_setup(tmp.path(), tools_ts, project_ts);
        let mut cfg = server("vue-language-server");
        cfg.command = tools.join(".bin/vue-language-server").to_string_lossy().into_owned();
        configure_server(&mut cfg, &project, &project, &s);
        let tsdk = cfg.args.iter().find_map(|a| a.strip_prefix("--tsdk=")).map(std::path::PathBuf::from);
        let project_lib = project.join("node_modules/typescript/lib");
        assert_eq!(tsdk, uses_project.then_some(project_lib), "{tools_ts} / {project_ts}");
        assert_eq!(cfg.launch_error.is_some(), error, "{tools_ts} / {project_ts}");
    }

    // A selected version wins over the server's own.
    let tmp = tempfile::tempdir().unwrap();
    let (tools, project) = vue_setup(tmp.path(), "typescript.js", "typescript.js");
    let mut s = Settings::default();
    s.languages.typescript.version = "workspace".into();
    let mut cfg = server("vue-language-server");
    cfg.command = tools.join(".bin/vue-language-server").to_string_lossy().into_owned();
    configure_server(&mut cfg, &project, &project, &s);
    let lib = project.join("node_modules/typescript/lib");
    assert_eq!(cfg.args, [format!("--tsdk={}", lib.to_string_lossy())]);
}

/// An npm shim for `name` in `dir`: `name.cmd` on Windows, an executable elsewhere.
fn npm_shim(dir: &Path, name: &str) -> std::path::PathBuf {
    std::fs::create_dir_all(dir).unwrap();
    let shim = dir.join(if cfg!(windows) { format!("{name}.cmd") } else { name.to_owned() });
    std::fs::write(&shim, "").unwrap();
    #[cfg(unix)]
    std::fs::set_permissions(&shim, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    shim
}

#[test]
fn angular_language_server_probes_its_own_package_then_the_project() {
    let tmp = tempfile::tempdir().unwrap();
    let tools = tmp.path().join("tools/node_modules");
    let project = tmp.path().join("app");
    let ngserver = npm_shim(&tools.join(".bin"), "ngserver");
    for (p, content) in [
        (tools.join("@angular/language-server/package.json"), "{}"),
        (project.join("node_modules/@angular/core/package.json"), r#"{"version":"17.3.0"}"#),
        (project.join("node_modules/typescript/lib/tsserver.js"), ""),
    ] {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    }
    let configured = |command: &str, s: &Settings| {
        let mut cfg = server("angular-language-server");
        cfg.command = command.into();
        cfg.args = vec!["--stdio".into()];
        configure_server(&mut cfg, &project, &project, s);
        cfg
    };
    let probes = format!("{},{}", tools.join("@angular/language-server").to_string_lossy(), project.to_string_lossy());
    let cfg = configured(&ngserver.to_string_lossy(), &Settings::default());
    assert_eq!(
        cfg.args,
        [
            "--stdio",
            "--ngProbeLocations",
            &probes,
            "--tsProbeLocations",
            &probes,
            "--angularCoreVersion",
            "17.3.0",
            "--disableLetSyntax"
        ]
    );
    assert_eq!(cfg.launch_error, None);

    // The project's TypeScript when selected.
    let mut s = Settings::default();
    s.languages.typescript.version = "workspace".into();
    let args = configured(&ngserver.to_string_lossy(), &s).args;
    let tsdk = args.iter().position(|a| a == "--tsdk").map(|i| args[i + 1].clone());
    assert_eq!(tsdk, Some(project.join("node_modules/typescript/lib").to_string_lossy().into_owned()));

    // Found on the selected Node.js's PATH like the launcher finds it, and
    // launched from there.
    let mut s = Settings::default();
    s.languages.node.interpreter = tools.join(".bin/node").to_string_lossy().into_owned();
    let cfg = configured("ngserver", &s);
    assert_eq!(dunce::canonicalize(&cfg.command).unwrap(), dunce::canonicalize(&ngserver).unwrap());
    assert!(cfg.args.contains(&probes));

    // Without its package the server can't start; not installed, it asks to be.
    let lone = npm_shim(&tmp.path().join("bin"), "ngserver");
    let cfg = configured(&lone.to_string_lossy(), &Settings::default());
    assert!(cfg.launch_error.is_some_and(|m| m.contains("@angular/language-server")));
    assert_eq!(cfg.args, ["--stdio"]);
    let cfg = configured(&tmp.path().join("nowhere/ngserver").to_string_lossy(), &Settings::default());
    assert_eq!((cfg.launch_error, cfg.args), (None, vec!["--stdio".to_owned()]));
}

#[test]
fn angular_language_server_is_found_behind_version_manager_shims() {
    let tmp = tempfile::tempdir().unwrap();
    let project = tmp.path().join("app");
    std::fs::create_dir_all(&project).unwrap();
    let install = |node_modules: &Path| {
        let package = node_modules.join("@angular/language-server");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(package.join("package.json"), "{}").unwrap();
        package
    };
    let probes = |command: &Path, s: &Settings, env: &[(&str, &str)]| {
        let mut cfg = server("angular-language-server");
        cfg.command = command.to_string_lossy().into_owned();
        cfg.env.extend(env.iter().map(|(k, v)| (k.to_string(), v.to_string())));
        configure_server(&mut cfg, &project, &project, s);
        cfg.args.iter().position(|a| a == "--ngProbeLocations").map(|i| cfg.args[i + 1].clone())
    };
    let with_project = |package: &Path| Some(format!("{},{}", package.to_string_lossy(), project.to_string_lossy()));

    // pnpm: the shim script runs the package from pnpm's global directory.
    let pnpm = tmp.path().join("pnpm");
    let package = install(&pnpm.join("global/v11/abc/node_modules"));
    let shim = npm_shim(&pnpm.join("bin"), "ngserver");
    let script = "exec node \"$basedir/../global/v11/abc/node_modules/@angular/language-server/bin/ngserver\" \"$@\"\n";
    std::fs::write(&shim, format!("#!/bin/sh\n{script}")).unwrap();
    assert_eq!(probes(&shim, &Settings::default(), &[]), with_project(&dunce::canonicalize(&package).unwrap()));

    // Volta: the package's image, next to the shim's directory. Joined as the lookup
    // joins it: the probe locations compare as text, and Windows keeps a `/` as given.
    let volta = tmp.path().join("volta");
    let image = volta.join("tools").join("image").join("packages").join("@angular/language-server");
    let package = install(&image.join("lib").join("node_modules"));
    let shim = npm_shim(&volta.join("bin"), "ngserver");
    assert_eq!(probes(&shim, &Settings::default(), &[]), with_project(&package));

    // asdf, mise: the shim names only the command; the manager's npm shim knows
    // where global packages are, run as the server is: in the project (whose
    // `.tool-versions` picks the Node), with the login shell's and its own variables.
    let root_of = |package: &Path| package.parent().unwrap().parent().unwrap().display().to_string();
    let package = install(&tmp.path().join("asdf/installs/nodejs/24/lib/node_modules"));
    std::fs::write(project.join(".tool-versions"), "nodejs 24\n").unwrap();
    // The only writer in this test binary.
    ide_core::process::set_shell_env(vec![("OPENIDEA_TEST_SHELL".into(), "1".into())]);
    let shims = tmp.path().join(".asdf/shims");
    // The manager's npm runs on the first Node on PATH (`#!/usr/bin/env node`).
    std::fs::write(
        npm_shim(&shims, "npm"),
        if cfg!(windows) {
            "@if exist .tool-versions if \"%OPENIDEA_TEST_SHELL%\"==\"1\" call node\r\n"
        } else {
            "#!/bin/sh\n[ -f .tool-versions ] && [ \"$OPENIDEA_TEST_SHELL\" = 1 ] && exec node\n"
        },
    )
    .unwrap();
    std::fs::write(
        npm_shim(&shims, "node"),
        if cfg!(windows) {
            "@echo %OPENIDEA_TEST_NPM_ROOT%\r\n"
        } else {
            "#!/bin/sh\necho \"$OPENIDEA_TEST_NPM_ROOT\"\n"
        },
    )
    .unwrap();
    // Another installation's npm and Node, first on PATH.
    let node = tmp.path().join("node/bin");
    let other = root_of(&install(&tmp.path().join("node/lib/node_modules")));
    for name in ["npm", "node"] {
        std::fs::write(
            npm_shim(&node, name),
            if cfg!(windows) { format!("@echo {other}\r\n") } else { format!("#!/bin/sh\necho '{other}'\n") },
        )
        .unwrap();
    }
    let mut s = Settings::default();
    s.languages.node.interpreter = node.join("node").to_string_lossy().into_owned();
    let root = root_of(&package);
    let env = [("OPENIDEA_TEST_NPM_ROOT", root.as_str())];
    assert_eq!(probes(&npm_shim(&shims, "ngserver"), &s, &env), with_project(&package));
    // Not without the manager's own npm, nor for an executable elsewhere: the npm
    // on PATH may be another installation's.
    assert_eq!(probes(&npm_shim(&tmp.path().join("mise/shims"), "ngserver"), &s, &env), None);
    assert_eq!(probes(&npm_shim(&tmp.path().join("bin"), "ngserver"), &s, &env), None);
}

#[cfg(unix)]
#[test]
fn query_output_is_read_within_the_deadline() {
    // Keep process startup outside a tight timing budget even under workspace load.
    let timeout = std::time::Duration::from_secs(60);
    let env = [("PATH", "/usr/bin:/bin")];
    let started = std::time::Instant::now();
    let out = crate::exec::query_in(Path::new("/bin/sh"), &["-c", "printf /global/root"], None, &env, timeout);
    assert_eq!(out.as_deref(), Some("/global/root"));
    // EOF must return promptly, without waiting for the generous deadline.
    assert!(started.elapsed() < std::time::Duration::from_secs(30));
}

#[cfg(unix)]
#[test]
fn query_drains_both_pipes_before_the_child_exits() {
    let out = crate::exec::query_in(
        Path::new("/bin/sh"),
        &["-c", "head -c 262144 /dev/zero; head -c 262144 /dev/zero >&2"],
        None,
        &[("PATH", "/usr/bin:/bin")],
        std::time::Duration::from_secs(60),
    )
    .unwrap();
    assert_eq!(out.len(), 262144);
}

#[cfg(unix)]
#[test]
fn query_is_bounded_when_descendants_keep_pipes_open() {
    let tmp = tempfile::tempdir().unwrap();
    let pid = tmp.path().join("pid");
    // The descendant outlives the query; clean it up even if an assertion fails.
    struct Descendant(std::path::PathBuf);
    impl Drop for Descendant {
        fn drop(&mut self) {
            if let Ok(pid) = std::fs::read_to_string(&self.0) {
                let _ = std::process::Command::new("/bin/kill").arg(pid.trim()).status();
            }
        }
    }
    let _descendant = Descendant(pid.clone());
    let started = std::time::Instant::now();
    let out = crate::exec::query_in(
        Path::new("/bin/sh"),
        &["-c", "sleep 120 & echo $! > \"$1\"; printf /global/root", "wrapper", pid.to_str().unwrap()],
        None,
        &[("PATH", "/usr/bin:/bin")],
        std::time::Duration::from_secs(30),
    );
    assert_eq!(out.as_deref(), Some("/global/root"));
    // The descendant keeps both pipes open for longer than the query deadline.
    assert!(started.elapsed() < std::time::Duration::from_secs(90));
}

#[cfg(unix)]
#[test]
fn query_times_out_when_the_child_does_not_exit() {
    // exec avoids leaving a descendant behind when the timed-out child is killed.
    let out = crate::exec::query_in(
        Path::new("/bin/sh"),
        &["-c", "printf /global/root; exec sleep 120"],
        None,
        &[("PATH", "/usr/bin:/bin")],
        std::time::Duration::from_millis(100),
    );
    assert_eq!(out, None);
}

#[test]
fn max_java_picks_an_older_jdk() {
    let dir = tempfile::tempdir().unwrap();
    let jdk = |major: u32| {
        let home = dir.path().join(format!("jdk-{major}"));
        std::fs::create_dir_all(home.join("bin")).unwrap();
        std::fs::write(home.join("release"), format!("JAVA_VERSION=\"{major}.0.1\"\n")).unwrap();
        std::fs::write(home.join("bin").join(exe("java")), "").unwrap();
        crate::java::jdk_at(&home).unwrap()
    };
    let (j17, j21, j25) = (jdk(17), jdk(21), jdk(25));
    let jdks = [j25.clone(), j21.clone(), j17];
    let mut cfg = LanguageServerConfig { max_java: Some(21), ..server("kotlin-language-server") };
    cfg.env.insert("JAVA_HOME".into(), j25.home.to_string_lossy().into_owned());
    crate::java::cap_java_home(&mut cfg, &jdks);
    assert_eq!(cfg.env["JAVA_HOME"], j21.home.to_string_lossy());

    // A JAVA_HOME that fits, or no limit: left alone.
    crate::java::cap_java_home(&mut cfg, &[]);
    assert_eq!(cfg.env["JAVA_HOME"], j21.home.to_string_lossy());
    let mut free = server("other");
    free.env.insert("JAVA_HOME".into(), j25.home.to_string_lossy().into_owned());
    crate::java::cap_java_home(&mut free, &jdks);
    assert_eq!(free.env["JAVA_HOME"], j25.home.to_string_lossy());
}

#[test]
fn gradle_settings_precedence() {
    use crate::apply::{gradle_command, gradle_env};
    use ide_core::settings::GradleDistribution;
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let plain = if cfg!(windows) { "gradle.bat" } else { "gradle" };
    let wrapper = root.join(if cfg!(windows) { "gradlew.bat" } else { "gradlew" });
    let mut settings = Settings::default();
    assert_eq!(gradle_command(root, root, &settings), std::path::PathBuf::from(plain));
    std::fs::write(&wrapper, "").unwrap();
    assert_eq!(gradle_command(root, root, &settings), wrapper);
    let fallback = std::collections::BTreeMap::from([("JAVA_HOME".into(), "project-jdk".into())]);
    assert_eq!(gradle_env(root, &settings, fallback.clone()), fallback);
    settings.languages.java.gradle.jvm = "gradle-jdk".into();
    settings.languages.java.gradle.user_home = "gradle-cache".into();
    settings.languages.java.gradle.home = "local-gradle".into();
    let env = gradle_env(root, &settings, fallback);
    assert_eq!(env["JAVA_HOME"], root.join("gradle-jdk").to_string_lossy());
    assert_eq!(env["GRADLE_USER_HOME"], root.join("gradle-cache").to_string_lossy());
    // A stored local home is inactive in wrapper mode.
    assert_eq!(gradle_command(root, root, &settings), wrapper);
    for local in [false, true] {
        settings.languages.java.gradle.distribution =
            if local { GradleDistribution::Local } else { GradleDistribution::Wrapper };
        let expected = if local { root.join("local-gradle").join("bin").join(plain) } else { plain.into() };
        for explicit_java in [false, true] {
            for is_test in [false, true] {
                let mut configs =
                    [run("gradle", wrapper.to_str().unwrap(), &["test"]), run("gradle", plain, &["test"])];
                for c in &mut configs {
                    c.is_test = is_test;
                    if explicit_java {
                        c.env.insert("JAVA_HOME".into(), "explicit-jdk".into());
                    }
                }
                apply_to_run_configs(&mut configs, root, &settings);
                assert_eq!(configs[0].command, wrapper.to_string_lossy());
                assert_eq!(configs[1].command, expected.to_string_lossy());
                for c in &configs {
                    assert_eq!(
                        c.env["JAVA_HOME"],
                        if explicit_java {
                            "explicit-jdk".into()
                        } else {
                            root.join("gradle-jdk").to_string_lossy().into_owned()
                        }
                    );
                }
            }
        }
        assert_eq!(gradle_command(root, root, &settings), if local { expected } else { wrapper.clone() });
    }
}

/// The reporter of #440 has Node 26 in `~/.local/bin` and an 18 in `/usr/bin`; an SSH
/// exec channel's PATH puts `/usr/bin` first, so only the system's Node was listed.
#[test]
fn node_lists_every_install_on_the_search_path_not_only_the_first() {
    let tmp = tempfile::tempdir().unwrap();
    let (system, user) = (tmp.path().join("usr-bin"), tmp.path().join("local-bin"));
    for dir in [&system, &user] {
        std::fs::create_dir(dir).unwrap();
        std::fs::write(dir.join(exe("node")), "").unwrap();
    }
    let found = crate::exec::executables_in("node", [system.clone(), user.clone()].into_iter());
    assert_eq!(found, [system.join(exe("node")), user.join(exe("node"))]);
    // A directory without the executable contributes nothing.
    let found = crate::exec::executables_in("node", [tmp.path().join("empty"), user.clone()].into_iter());
    assert_eq!(found, [user.join(exe("node"))]);
}

#[test]
fn node_on_the_search_path_keeps_its_version_manager_as_source() {
    let home = Path::new("/home/me");
    let source = |p: &str| crate::discover::node_source(Path::new(p), Some(home));
    assert_eq!(source("/home/me/.nvm/versions/node/v24.0.0/bin/node"), "nvm");
    assert_eq!(source("/home/me/.volta/tools/image/node/24.0.0/bin/node"), "volta");
    assert_eq!(source("/home/me/.local/share/fnm/node-versions/v24/installation/bin/node"), "fnm");
    assert_eq!(source("/home/me/.local/bin/node"), "path");
    assert_eq!(source("/usr/bin/node"), "system");
}

#[test]
fn php_sources_and_selected_interpreter() {
    let home = Path::new("/home/me");
    let source = |p: &str| crate::discover::php_source(Path::new(p), Some(home));
    assert_eq!(source("/home/me/.phpbrew/php/php-8.3.1/bin/php"), "phpbrew");
    assert_eq!(source("/home/me/.config/herd-lite/bin/php"), "herd");
    assert_eq!(source("/opt/homebrew/opt/php@8.2/bin/php"), "homebrew");
    assert_eq!(source("/home/me/bin/php"), "path");

    use crate::discover::{is_versioned_php_name, newest_first, versioned_php_in};
    let sdk = |path: &str, version: &str| crate::Sdk {
        path: std::path::PathBuf::from(path).into(),
        name: format!("PHP {version}"),
        version: Some(version.into()),
        source: "path".into(),
        home: None,
        extra: None,
    };
    let mut sdks = vec![
        sdk("/opt/homebrew/bin/php", "8.4.1"),
        sdk("/opt/homebrew/opt/php@8.1/bin/php", "8.1.31"),
        sdk("/opt/homebrew/opt/php@8.2/bin/php", "8.2.20"),
        sdk("/home/me/.phpbrew/php/php-8.3.9/bin/php", "8.3.9"),
        sdk("/home/me/.phpbrew/php/php-8.3.12/bin/php", "8.3.12"),
        sdk("/home/me/.phpbrew/php/php-7.4.33/bin/php", "7.4.33"),
        sdk("/usr/bin/php", "8.4.1"),
    ];
    newest_first(&mut sdks);
    let order: Vec<_> = sdks.iter().map(|s| s.version.clone().unwrap()).collect();
    assert_eq!(order, ["8.4.1", "8.4.1", "8.3.12", "8.3.9", "8.2.20", "8.1.31", "7.4.33"]);
    // Stable: on equal versions the PATH install stays first.
    assert_eq!(sdks[0].path.0, std::path::PathBuf::from("/opt/homebrew/bin/php"));
    for name in ["php8.1", "php81", "php8", "php8.3.exe"] {
        assert!(is_versioned_php_name(name), "{name}");
    }
    for name in ["php", "php-cgi8.1", "phpize8.1", "phpdbg8.1", "php-fpm8.1", "php8.", "php.8", "php8.1.2x", "phpunit"]
    {
        assert!(!is_versioned_php_name(name), "{name}");
    }

    if cfg!(windows) {
        return; // Unix paths
    }
    let bins = tempfile::tempdir().unwrap();
    for name in ["php", "php8.3", "php8.1", "php-cgi8.1", "phpize8.1", "phpdbg8.1"] {
        std::fs::write(bins.path().join(name), "").unwrap();
    }
    std::fs::create_dir(bins.path().join("php9.0")).unwrap();
    assert_eq!(
        versioned_php_in([bins.path().to_path_buf()]),
        vec![bins.path().join("php8.1"), bins.path().join("php8.3")]
    );

    let tmp = tempfile::tempdir().unwrap();
    let mut s = Settings::default();
    assert_eq!(crate::apply::php_dir(tmp.path(), &s), None);
    s.languages.php.interpreter = "/opt/php82/bin/php".into();
    assert_eq!(crate::apply::php_dir(tmp.path(), &s), Some("/opt/php82/bin".into()));
    let mut configs = vec![
        run("php", "php", &["artisan", "serve"]),
        run("phpunit", "vendor/bin/phpunit", &[]),
        run("composer", "composer", &["run-script", "test"]),
        run("npm", "npm", &["run", "dev"]),
    ];
    apply_to_run_configs(&mut configs, tmp.path(), &s);
    assert_eq!(configs[0].command, "/opt/php82/bin/php");
    // Scripts with a `#!/usr/bin/env php` shebang find the selected PHP first on `PATH`.
    for c in &configs[..3] {
        assert!(c.env["PATH"].starts_with("/opt/php82/bin"), "{}: {:?}", c.kind, c.env.get("PATH"));
    }
    assert_eq!(configs[1].command, "vendor/bin/phpunit");
    assert!(configs[3].env.get("PATH").is_none_or(|p| !p.contains("php82")));
}

#[test]
fn intelephense_gets_the_php_language_level() {
    use serde_json::json;
    let tmp = tempfile::tempdir().unwrap();
    let configured = |name: &str, s: &Settings| {
        let mut cfg = server(name);
        configure_server(&mut cfg, tmp.path(), tmp.path(), s);
        cfg
    };
    let options = |cfg: LanguageServerConfig| serde_json::to_value(cfg.initialization_options).unwrap();

    // Nothing to resolve: the options stay as they were (the rest depends on the machine's tools).
    assert_eq!(configured("intelephense", &Settings::default()).initialization_options, None);

    std::fs::write(tmp.path().join("composer.json"), r#"{"require": {"php": "^7.4 || ^8.0"}}"#).unwrap();
    assert_eq!(
        options(configured("intelephense", &Settings::default())),
        json!({"environment": {"phpVersion": "7.4.0"}})
    );
    for other in ["phpactor", "basedpyright", "vtsls"] {
        assert_eq!(options(configured(other, &Settings::default())).get("environment"), None, "{other}");
    }

    let mut s = Settings::default();
    s.languages.php.language_level = "8.1".into();
    let mut cfg = server("intelephense");
    cfg.initialization_options = Some(toml::Value::try_from(json!({"clearCache": true})).unwrap());
    configure_server(&mut cfg, tmp.path(), tmp.path(), &s);
    assert_eq!(options(cfg), json!({"clearCache": true, "environment": {"phpVersion": "8.1.0"}}));
}

#[test]
fn intelephense_gets_the_required_stubs_and_include_paths() {
    use serde_json::json;
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("composer.json"), r#"{"require": {"php": "^8.1", "ext-redis": "*"}}"#).unwrap();
    let mut s = Settings::default();
    s.languages.php.stubs = vec!["wordpress".into()];
    s.languages.php.include_paths = vec!["../platform".into()];
    let mut cfg = server("intelephense");
    configure_server(&mut cfg, tmp.path(), tmp.path(), &s);
    let options = serde_json::to_value(cfg.initialization_options).unwrap();
    let stubs: Vec<&str> = options["stubs"].as_array().unwrap().iter().filter_map(|v| v.as_str()).collect();
    assert_eq!(stubs.len(), 70);
    assert_eq!((stubs[0], &stubs[68..]), ("apache", &["redis", "wordpress"][..]));
    assert_eq!(
        options["environment"],
        json!({"phpVersion": "8.1.0", "includePaths": [tmp.path().join("../platform").to_string_lossy()]})
    );

    let mut other = server("phpactor");
    configure_server(&mut other, tmp.path(), tmp.path(), &s);
    assert_eq!(other.initialization_options, None);
}

#[test]
fn go_constraints_change_only_protocol_settings() {
    use serde_json::json;
    let tmp = tempfile::tempdir().unwrap();
    let mut settings = Settings::default();
    let mut original = server("gopls");
    original.settings = Some(json!({"analyses":{"unusedparams":true}}));
    let mut defaults = original.clone();
    configure_server(&mut defaults, tmp.path(), tmp.path(), &settings);
    assert_eq!(defaults.settings, Some(json!({"analyses":{"unusedparams":true}, "buildFlags":[], "env":{}})));
    defaults.settings = original.settings.clone();
    assert_eq!(defaults, original);
    settings.languages.go.build_tags.custom = "integration".into();
    settings.languages.go.build_tags.os = "linux".into();
    let mut configured = original.clone();
    configure_server(&mut configured, tmp.path(), tmp.path(), &settings);
    assert_eq!(
        configured.settings.take(),
        Some(json!({
            "analyses":{"unusedparams":true}, "buildFlags":["-tags=integration"], "env":{"GOOS":"linux"}
        }))
    );
    configured.settings = original.settings.clone();
    assert_eq!(configured, original, "launch configuration stays unchanged for in-place reconfiguration");
    let mut other = server("rust-analyzer");
    configure_server(&mut other, tmp.path(), tmp.path(), &settings);
    assert_eq!(other.settings, None);
}

#[test]
fn go_empty_constraints_preserve_explicit_server_defaults() {
    use serde_json::json;
    let tmp = tempfile::tempdir().unwrap();
    let mut cfg = server("gopls");
    cfg.initialization_options =
        Some(toml::Value::try_from(json!({"buildFlags":["-tags=legacy"], "env":{"GOPROXY":"direct"}})).unwrap());
    configure_server(&mut cfg, tmp.path(), tmp.path(), &Settings::default());
    assert_eq!(cfg.settings, Some(json!({"buildFlags":["-tags=legacy"], "env":{"GOPROXY":"direct"}})));
}

#[test]
fn go_modules_configure_gopls_in_place_and_commands_with_explicit_run_overrides() {
    use serde_json::json;
    let tmp = tempfile::tempdir().unwrap();
    let mut settings = Settings::default();
    settings.languages.go.modules.env = BTreeMap::from([
        ("GOPROXY".into(), "https://proxy.example".into()),
        ("GOPRIVATE".into(), "example.com/private".into()),
        ("GOFLAGS".into(), "-race".into()),
    ]);
    settings.languages.go.modules.auto_vendor = false;
    let mut cfg = server("gopls");
    configure_server(&mut cfg, tmp.path(), tmp.path(), &settings);
    let protocol = cfg.settings.take().unwrap();
    assert_eq!(protocol["env"]["GOFLAGS"], "-race -mod=mod");
    assert_eq!(protocol["env"]["GOPRIVATE"], "example.com/private");
    assert!(cfg.env.is_empty(), "module environment changes must not restart gopls");
    let mut run = run("go", "go", &["mod", "tidy"]);
    run.env.insert("GOPROXY".into(), "off".into());
    apply_to_run_configs(std::slice::from_mut(&mut run), tmp.path(), &settings);
    assert_eq!(run.env["GOPROXY"], "off");
    assert_eq!(run.env["GOPRIVATE"], "example.com/private");
    let mut cleared = server("gopls");
    configure_server(&mut cleared, tmp.path(), tmp.path(), &Settings::default());
    assert_eq!(cleared.settings.unwrap()["env"], json!({}));
}

#[test]
fn saving_a_loaded_run_configuration_drops_what_settings_derived() {
    if cfg!(windows) {
        return; // Unix paths
    }
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let touch = |rel: &str| {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, "").unwrap();
        p.to_string_lossy().into_owned()
    };
    let mut s = Settings::default();
    s.languages.python.interpreter = fake_venv(root, ".venv").to_string_lossy().into_owned();
    s.languages.node.interpreter = touch("node/bin/node");
    touch("rustup/toolchains/stable/bin/cargo");
    s.languages.rust.toolchain = root.join("rustup/toolchains/stable").to_string_lossy().into_owned();
    touch("go/bin/go");
    s.languages.go.goroot = root.join("go").to_string_lossy().into_owned();
    s.languages.go.gopath = root.join("gopath").to_string_lossy().into_owned();
    s.languages.go.modules.env = BTreeMap::from([("GOPROXY".into(), "https://proxy.example".into())]);
    fake_jdk(&root.join("jdk17"));
    s.languages.java.jdk = root.join("jdk17").to_string_lossy().into_owned();
    touch("maven/bin/mvn");
    s.languages.java.maven.home = root.join("maven").to_string_lossy().into_owned();
    s.languages.java.maven.user_settings = "/m2/settings.xml".into();
    s.languages.java.maven.local_repository = "/m2/repo".into();
    s.languages.ruby.interpreter = touch("ruby/bin/ruby");
    touch("ruby/bin/bundle");
    s.tools.insert("godot".into(), ide_core::settings::ToolSettings { path: touch("Godot/godot") });

    let saved = |kind: &str, command: &str, args: &[&str], env: &[(&str, &str)]| {
        let mut c = run(kind, command, args);
        c.detected = false;
        c.env = env.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
        c
    };
    // As the user saved them: bare tools, only their own environment.
    let configs = [
        saved("python", "python", &["app.py"], &[]),
        saved("pytest", ".venv/bin/pytest", &["-x"], &[("FOO", "1")]),
        saved("npm", "npm", &["run", "dev"], &[]),
        saved("cargo", "cargo", &["run"], &[]),
        saved("go", "go", &["run", "."], &[]),
        saved("go", "go", &["mod", "tidy"], &[("GOPROXY", "off")]),
        saved("maven", "mvn", &["package"], &[]),
        saved("tomcat", "catalina", &[], &[]),
        saved("ruby", "ruby", &["app.rb"], &[]),
        saved("rake", "bundle", &["exec", "rake"], &[("RAILS_ENV", "test")]),
        saved("godot", "godot", &["--path", "."], &[]),
        // The user's own values that merely look like derived ones stay.
        saved("cargo", "/opt/rust/bin/cargo", &["build"], &[("PATH", "/custom/bin")]),
        saved("maven", "mvn", &["verify"], &[("JAVA_HOME", "/other/jdk")]),
        saved("python", "python", &["x.py"], &[("VIRTUAL_ENV", "/elsewhere/venv")]),
    ];
    for user in configs {
        let mut loaded = user.clone();
        apply_to_run_configs(std::slice::from_mut(&mut loaded), root, &s);
        assert_ne!(loaded, user, "{} {}: settings apply to it", user.kind, user.command);
        let stored = without_derived(&loaded, root, &s);
        assert_eq!(stored, user, "{} {}: saved as the user left it", user.kind, user.command);
        let mut reloaded = stored;
        apply_to_run_configs(std::slice::from_mut(&mut reloaded), root, &s);
        assert_eq!(reloaded, loaded, "{} {}: runs the same after a save", user.kind, user.command);
    }

    // Another bare name for the interpreter comes back as the interpreter's own.
    let mut loaded = saved("python", "python3", &["app.py"], &[]);
    apply_to_run_configs(std::slice::from_mut(&mut loaded), root, &s);
    assert_eq!(without_derived(&loaded, root, &s).command, exe("python"));

    // A saved configuration follows a later interpreter change instead of a frozen PATH.
    let mut loaded = saved("ruby", "ruby", &["app.rb"], &[]);
    apply_to_run_configs(std::slice::from_mut(&mut loaded), root, &s);
    let mut next = without_derived(&loaded, root, &s);
    s.languages.ruby.interpreter = touch("ruby2/bin/ruby");
    apply_to_run_configs(std::slice::from_mut(&mut next), root, &s);
    let ruby2 = root.join("ruby2/bin");
    assert_eq!(next.command, ruby2.join("ruby").to_string_lossy());
    assert!(next.env["PATH"].starts_with(&*ruby2.to_string_lossy()), "{}", next.env["PATH"]);

    // A Maven configuration (a detected one narrowed to a test, a tool window goal) follows a
    // later Maven home, settings file, local repository and JDK; options it sets itself stay.
    for detected in [true, false] {
        let mut goal = saved("maven", "mvn", &["test", "-Dtest=AppTest"], &[]);
        goal.detected = detected;
        let mut own = saved("maven", "mvn", &["-s", "/mine.xml", "test"], &[]);
        own.detected = detected;
        let mut loaded = [goal, own];
        apply_to_run_configs(&mut loaded, root, &s);
        let mut next = loaded.map(|c| without_derived(&c, root, &s));
        touch("maven2/bin/mvn");
        fake_jdk(&root.join("jdk21"));
        let mut s2 = s.clone();
        s2.languages.java.maven.home = root.join("maven2").to_string_lossy().into_owned();
        s2.languages.java.maven.user_settings = "/m3/settings.xml".into();
        s2.languages.java.maven.local_repository = "/m3/repo".into();
        s2.languages.java.jdk = root.join("jdk21").to_string_lossy().into_owned();
        apply_to_run_configs(&mut next, root, &s2);
        assert_eq!(next[0].command, root.join("maven2/bin/mvn").to_string_lossy());
        assert_eq!(next[0].args, ["-s", "/m3/settings.xml", "-Dmaven.repo.local=/m3/repo", "test", "-Dtest=AppTest"]);
        assert!(next[0].env["JAVA_HOME"].ends_with("jdk21"), "{}", next[0].env["JAVA_HOME"]);
        assert_eq!(next[1].args, ["-Dmaven.repo.local=/m3/repo", "-s", "/mine.xml", "test"]);
    }
}

#[test]
fn nested_python_configs_get_their_own_virtualenv_but_explicit_settings_stay_project_relative() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let outer = fake_venv(root, ".venv");
    let nested = fake_venv(&root.join("apps").join("python"), ".venv");
    let mut config = run("python", "python3", &["main.py"]);
    config.extras.module = Some("apps/python".into());
    apply_to_run_configs(std::slice::from_mut(&mut config), root, &Settings::default());
    assert_eq!(config.env["VIRTUAL_ENV"], nested.parent().unwrap().parent().unwrap().to_string_lossy());
    // A workspace member without its own virtualenv uses the one at the project root (uv workspaces).
    let mut member = run("pytest", "python3", &["-m", "pytest"]);
    member.extras.module = Some("packages/lib".into());
    apply_to_run_configs(std::slice::from_mut(&mut member), root, &Settings::default());
    assert_eq!(member.env["VIRTUAL_ENV"], outer.parent().unwrap().parent().unwrap().to_string_lossy());
    let mut settings = Settings::default();
    settings.languages.python.interpreter = "custom/bin/python".into();
    let mut config = run("python", "python3", &["main.py"]);
    config.extras.module = Some("apps/python".into());
    apply_to_run_configs(std::slice::from_mut(&mut config), root, &settings);
    assert_eq!(config.command, root.join("custom/bin/python").to_string_lossy());
}

#[test]
fn file_runtime_uses_nearest_virtualenv_and_explicit_project_settings_win() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let outer = fake_venv(root, ".venv");
    let inner = fake_venv(&root.join("apps/api"), ".venv");
    let near = root.join("apps/api/src/package");
    let mut settings = Settings::default();
    assert_eq!(crate::apply::python_interpreter_near(root, Some(&near), &settings), Some(inner));
    assert_eq!(crate::apply::python_interpreter_near(root, Some(&root.join("apps/other")), &settings), Some(outer));
    settings.languages.python.interpreter = "selected/python".into();
    assert_eq!(crate::apply::python_interpreter_near(root, Some(&near), &settings), Some(root.join("selected/python")));
}
