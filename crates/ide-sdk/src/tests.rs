use crate::apply::{apply_to_run_configs, configure_server, python_interpreter, terminal_activation, tsdk};
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
        initialization_options: None,
        install_hint: None,
        fallback: false,
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
