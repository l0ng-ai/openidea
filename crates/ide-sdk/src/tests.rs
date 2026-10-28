use crate::apply::{
    apply_to_run_configs, configure_server, jdtls_jdk, maven_command, maven_options, project_jdk, python_interpreter,
    terminal_activation, tsdk,
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
        max_java: None,
        launch_error: None,
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
    ];
    apply_to_run_configs(&mut configs, tmp.path(), &s);
    assert_eq!(configs[0].command, "/opt/py/bin/python3");
    assert_eq!(configs[0].args, ["-m", "app"]);
    assert_eq!(configs[1].command, "/opt/py/bin/python3");
    assert_eq!(configs[1].args, ["-m", "pytest"]);
    assert_eq!(configs[2].args, ["-m", "pytest", "-x"]);
    assert_eq!(configs[3].command, "pnpm");
    assert_eq!(configs[4].command, "python3", "shell configs are left alone");
}

fn fake_jdk(dir: &Path) {
    std::fs::create_dir_all(dir.join("bin")).unwrap();
    std::fs::write(dir.join("bin").join(exe("java")), "").unwrap();
    std::fs::write(dir.join("release"), "JAVA_VERSION=\"17.0.9\"\n").unwrap();
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
fn language_server_settings_disable_add_and_override() {
    use crate::apply::{language_servers, server_launch_overrides, server_protocol_overrides, with_custom_servers};
    use ide_core::settings::LanguageServerSettings;
    use serde_json::json;

    let mut s = Settings::default();
    s.language_servers.insert("pylsp".into(), LanguageServerSettings { enabled: false, ..Default::default() });
    s.language_servers.insert(
        "ruff".into(),
        LanguageServerSettings {
            command: "ruff".into(),
            args: Some(vec!["server".into()]),
            languages: vec!["python".into()],
            root_markers: vec!["pyproject.toml".into()],
            ..Default::default()
        },
    );
    let defined = [server("basedpyright"), server("pylsp")];
    let names = |v: Vec<LanguageServerConfig>| v.into_iter().map(|c| c.name).collect::<Vec<_>>();
    assert_eq!(names(language_servers("python", &defined, &s)), ["basedpyright", "ruff"]);
    assert_eq!(names(language_servers("rust", &[server("rust-analyzer")], &s)), ["rust-analyzer"]);

    // Listed with the tools even while disabled.
    let mut langs = ide_language::LanguageRegistry::load(None).unwrap().all();
    with_custom_servers(&mut langs, &s);
    let python = langs.iter().find(|l| l.id.as_str() == "python").unwrap();
    let mut ruff = python.language_servers.iter().find(|c| c.name == "ruff").unwrap().clone();
    assert_eq!(ruff.root_markers, ["pyproject.toml"]);
    server_launch_overrides(&mut ruff, &s);
    assert_eq!((ruff.command.as_str(), ruff.args.as_slice()), ("ruff", &["server".to_string()][..]));

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
    // A chosen path that is not a JDK is an error, not a silent fallback.
    s.languages.java.jdtls_jdk = "missing".into();
    assert!(jdtls_jdk(tmp.path(), &s).unwrap_err().contains("is not a JDK home"));
}

#[test]
fn terminal_activation_for_project_venv() {
    if cfg!(windows) {
        return; // Unix paths and shells
    }
    let tmp = tempfile::tempdir().unwrap();
    let mut s = Settings::default();
    assert_eq!(terminal_activation(tmp.path(), &s, Some("/bin/zsh")), None);
    fake_venv(tmp.path(), ".venv");
    let line = terminal_activation(tmp.path(), &s, Some("/bin/zsh")).unwrap();
    assert!(line.starts_with("source '") && line.ends_with("/activate'"), "{line}");
    assert_eq!(terminal_activation(tmp.path(), &s, Some("/usr/bin/fish")), None, "no activate.fish");
    assert_eq!(terminal_activation(tmp.path(), &s, Some("docker")), None, "not a shell");
    s.languages.python.activate_virtualenv = false;
    assert_eq!(terminal_activation(tmp.path(), &s, Some("/bin/zsh")), None);
}

#[test]
fn pip_list_output_is_parsed() {
    let out = "$ python -m pip list\n[{\"name\": \"requests\", \"version\": \"2.32.0\"}]\n";
    let pkgs = parse_pip_list(out).unwrap();
    assert_eq!(pkgs[0].name, "requests");
    assert_eq!(pkgs[0].version, "2.32.0");
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
    touch(m2.join("com/google/guava/guava/33.0/guava-33.0.jar"));
    let guava_src = touch(m2.join("com/google/guava/guava/33.0/guava-33.0-sources.jar"));
    let junit = touch(m2.join("junit/junit/4.13/junit-4.13.jar"));
    let files = gradle.join("caches/modules-2/files-2.1/org.slf4j/slf4j-api/2.0.9");
    touch(files.join("a1b2/slf4j-api-2.0.9.jar"));
    let slf4j_src = touch(files.join("c3d4/slf4j-api-2.0.9-sources.jar"));
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
            ("Maven: com.google.guava:guava:33.0", "maven", "guava-33.0-sources.jar"),
            ("Maven: junit:junit:4.13", "maven", "junit-4.13.jar"),
            ("Gradle: org.slf4j:slf4j-api:2.0.9", "gradle", "slf4j-api-2.0.9-sources.jar"),
        ]
    );
    assert_eq!(groups[0].roots[0].path, ide_core::IpcPath::from(ide_vfs::archive_root(&guava_src)));
    assert_eq!(groups[1].roots[0].path, ide_core::IpcPath::from(ide_vfs::archive_root(&junit)));
    assert_eq!(groups[2].roots[0].path, ide_core::IpcPath::from(ide_vfs::archive_root(&slf4j_src)));
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
