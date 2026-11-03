//! `.vscode/launch.json` import, from launch files written the way the VS Code docs and
//! framework guides (Django, Flask, FastAPI, Next.js) suggest.

use ide_run::RunConfig;
use ide_run::import::{RunImport, RunImportSource, SkipReason, import};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const VENV_PYTHON: &str = if cfg!(windows) { ".venv/Scripts/python.exe" } else { ".venv/bin/python" };

fn env() -> BTreeMap<String, String> {
    BTreeMap::from([("HOME".into(), "/home/me".into()), ("API_TOKEN".into(), "s3cret".into())])
}

fn project(launch: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join(".vscode")).unwrap();
    fs::write(dir.path().join(".vscode/launch.json"), launch).unwrap();
    dir
}

fn import_from(root: &Path, existing: &[RunConfig]) -> RunImport {
    import(root, RunImportSource::Vscode, existing, &env()).unwrap()
}

fn run(launch: &str) -> (tempfile::TempDir, RunImport) {
    let dir = project(launch);
    let result = import_from(dir.path(), &[]);
    (dir, result)
}

fn get<'a>(r: &'a RunImport, name: &str) -> &'a RunConfig {
    &r.imported.iter().find(|c| c.config.name == name).unwrap_or_else(|| panic!("{name} not imported: {r:#?}")).config
}

fn ignored<'a>(r: &'a RunImport, name: &str) -> &'a [String] {
    &r.imported.iter().find(|c| c.config.name == name).unwrap().ignored
}

fn reason<'a>(r: &'a RunImport, name: &str) -> &'a SkipReason {
    &r.skipped.iter().find(|s| s.name == name).unwrap_or_else(|| panic!("{name} not skipped: {r:#?}")).reason
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|a| (*a).to_owned()).collect()
}

fn cwd(c: &RunConfig) -> Option<PathBuf> {
    c.cwd.as_ref().map(|p| p.as_ref().to_path_buf())
}

const DJANGO: &str = r#"{
    // Use IntelliSense to learn about possible attributes.
    "version": "0.2.0",
    "configurations": [
        {
            "name": "Django",
            "type": "debugpy",
            "request": "launch",
            "program": "${workspaceFolder}/manage.py",
            "args": ["runserver", "0.0.0.0:8000", "--noreload"],
            "django": true,
            "justMyCode": false,
            "env": { "DJANGO_SETTINGS_MODULE": "mysite.settings.dev", "DEBUG": true, "PATH": "${env:PATH}" },
        },
        /* the test runner */
        {
            "name": "Django tests",
            "type": "python",
            "request": "launch",
            "python": "${workspaceFolder}/.venv/bin/python",
            "program": "${workspaceFolder}/manage.py",
            "args": ["test", "polls", "--keepdb"],
            "django": true,
        },
    ],
}"#;

#[test]
fn django_runserver_and_tests_with_comments_and_trailing_commas() {
    let dir = project(DJANGO);
    let venv = dir.path().join(VENV_PYTHON);
    fs::create_dir_all(venv.parent().unwrap()).unwrap();
    fs::write(&venv, "").unwrap();
    let r = import_from(dir.path(), &[]);
    assert!(r.skipped.is_empty(), "{r:#?}");
    assert_eq!(r.file, ".vscode/launch.json");

    let server = get(&r, "Django");
    assert_eq!(server.id, "user:django");
    assert_eq!(server.kind, "python");
    // No `python`: the project's virtualenv, which the debugger launches directly.
    assert_eq!(server.command, VENV_PYTHON);
    assert_eq!(server.args, s(&["manage.py", "runserver", "0.0.0.0:8000", "--noreload"]));
    assert_eq!(server.debug_adapter.as_deref(), Some("debugpy"));
    assert_eq!(cwd(server), None);
    // A variable set to its own value is inherited anyway; scalars become strings.
    assert_eq!(
        server.env,
        BTreeMap::from([
            ("DEBUG".into(), "true".into()),
            ("DJANGO_SETTINGS_MODULE".into(), "mysite.settings.dev".into())
        ])
    );
    assert!(!server.extras.local && !server.detected && !server.is_test);
    assert_eq!(ignored(&r, "Django"), ["justMyCode"]);

    let tests = get(&r, "Django tests");
    assert_eq!(tests.kind, "django-test");
    assert!(tests.is_test);
    assert_eq!(tests.command, ".venv/bin/python");
    assert_eq!(tests.args, s(&["manage.py", "test", "polls", "--keepdb"]));
    assert!(ignored(&r, "Django tests").is_empty());
}

#[test]
fn flask_and_fastapi_run_as_modules() {
    let (_dir, r) = run(r#"{
        "configurations": [
            {
                "name": "Python Debugger: Flask",
                "type": "debugpy",
                "request": "launch",
                "module": "flask",
                "python": "/usr/bin/python3.12",
                "env": { "FLASK_APP": "app.py", "FLASK_DEBUG": "1" },
                "args": ["run", "--no-debugger", "--no-reload"],
                "jinja": true,
                "autoStartBrowser": false
            },
            {
                "name": "FastAPI",
                "type": "debugpy",
                "request": "launch",
                "module": "uvicorn",
                "python": "${workspaceFolder}/.venv/bin/python",
                "args": "app.main:app --reload --port 8001",
                "envFile": "${workspaceFolder}/.env.local"
            }
        ]
    }"#);
    let flask = get(&r, "Python Debugger: Flask");
    assert_eq!(flask.kind, "python");
    assert_eq!(flask.command, "/usr/bin/python3.12");
    assert_eq!(flask.args, s(&["-m", "flask", "run", "--no-debugger", "--no-reload"]));
    assert_eq!(flask.env["FLASK_APP"], "app.py");
    assert_eq!(ignored(&r, "Python Debugger: Flask"), ["autoStartBrowser", "jinja"]);

    let api = get(&r, "FastAPI");
    // A string `args` is split like a command line.
    assert_eq!(api.args, s(&["-m", "uvicorn", "app.main:app", "--reload", "--port", "8001"]));
    assert_eq!(api.extras.env_files, s(&[".env.local"]));
}

#[test]
fn pytest_module_in_a_subdirectory_is_a_test_configuration() {
    let (dir, r) = run(r#"{
        "configurations": [{
            "name": "Backend tests",
            "type": "debugpy",
            "request": "launch",
            "module": "pytest",
            "cwd": "${workspaceFolder}/backend",
            "python": "${command:python.interpreterPath}",
            "pythonArgs": ["-X", "dev"],
            "args": ["-x", "${workspaceFolder}/backend/tests", "--ds=${workspaceFolderBasename}.settings"]
        }]
    }"#);
    let c = get(&r, "Backend tests");
    assert_eq!(c.kind, "pytest");
    assert!(c.is_test);
    assert_eq!(cwd(c), Some(PathBuf::from("backend")));
    // The interpreter VS Code has selected is the project's here: no virtualenv, so python3.
    assert_eq!(c.command, if cfg!(windows) { "python" } else { "python3" });
    let base = dir.path().file_name().unwrap().to_string_lossy().into_owned();
    // Paths inside the project are written relative to the working directory.
    assert_eq!(c.args, s(&["-X", "dev", "-m", "pytest", "-x", "tests", &format!("--ds={base}.settings")]));
}

#[test]
fn interpreter_from_the_root_virtualenv_is_relative_to_the_working_directory() {
    let dir = project(
        r#"{ "configurations": [{ "name": "Worker", "type": "debugpy", "request": "launch",
             "program": "${workspaceFolder}/api/worker.py", "cwd": "${workspaceFolder}/api" }] }"#,
    );
    let venv = dir.path().join(VENV_PYTHON);
    fs::create_dir_all(venv.parent().unwrap()).unwrap();
    fs::write(&venv, "").unwrap();
    let r = import_from(dir.path(), &[]);
    let c = get(&r, "Worker");
    assert_eq!(c.command, format!("../{VENV_PYTHON}"));
    assert_eq!(c.args, s(&["worker.py"]));
    assert_eq!(cwd(c), Some(PathBuf::from("api")));
}

const NEXT: &str = r#"{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Next.js: debug server-side",
      "type": "node-terminal",
      "request": "launch",
      "command": "npm run dev"
    },
    {
      "name": "Next.js: debug client-side",
      "type": "chrome",
      "request": "launch",
      "url": "http://localhost:3000"
    },
    {
      "name": "Next.js: debug full stack",
      "type": "node",
      "request": "launch",
      "program": "${workspaceFolder}/node_modules/next/dist/bin/next",
      "runtimeArgs": ["--inspect"],
      "skipFiles": ["<node_internals>/**"],
      "serverReadyAction": { "action": "debugWithEdge", "killOnServerStop": true, "pattern": "- Local:.+(https?://.+)" }
    }
  ]
}"#;

#[test]
fn nextjs_recipes() {
    let (_dir, r) = run(NEXT);
    let server = get(&r, "Next.js: debug server-side");
    assert_eq!((server.kind.as_str(), server.command.as_str()), ("npm", "npm"));
    assert_eq!(server.args, s(&["run", "dev"]));
    assert_eq!(server.debug_adapter.as_deref(), Some("js-debug"));

    assert_eq!(reason(&r, "Next.js: debug client-side"), &SkipReason::UnsupportedType { type_: "chrome".into() });

    let full = get(&r, "Next.js: debug full stack");
    assert_eq!((full.kind.as_str(), full.command.as_str()), ("node", "node"));
    assert_eq!(full.args, s(&["--inspect", "node_modules/next/dist/bin/next"]));
    assert_eq!(ignored(&r, "Next.js: debug full stack"), ["serverReadyAction", "skipFiles"]);
}

#[test]
fn node_runtimes_npm_scripts_and_terminal_commands() {
    let (_dir, r) = run(r#"{
        "configurations": [
            { "name": "Start", "type": "node", "request": "launch", "runtimeExecutable": "npm",
              "runtimeArgs": ["run-script", "start"], "cwd": "${workspaceFolder}/web", "env": { "PORT": 3001 } },
            { "name": "Vite", "type": "pwa-node", "request": "launch", "cwd": "${workspaceFolder}/web",
              "runtimeExecutable": "${workspaceFolder}/web/node_modules/.bin/vite", "runtimeArgs": ["--port", "5173"] },
            { "name": "Script", "type": "node", "request": "launch", "program": "${workspaceFolder}/scripts/seed.js",
              "args": ["--count", 10], "envFile": "${workspaceFolder}/.env", "preLaunchTask": "tsc: build" },
            { "name": "Storybook", "type": "node-terminal", "request": "launch", "command": "pnpm exec storybook dev -p 6006" },
            { "name": "Migrate and serve", "type": "node-terminal", "request": "launch", "command": "npm run migrate && npm start" },
            { "name": "Nothing", "type": "node", "request": "launch" }
        ]
    }"#);
    let start = get(&r, "Start");
    assert_eq!((start.kind.as_str(), start.command.as_str()), ("npm", "npm"));
    assert_eq!(start.args, s(&["run", "start"]));
    assert_eq!(cwd(start), Some(PathBuf::from("web")));
    assert_eq!(start.env["PORT"], "3001");

    let vite = get(&r, "Vite");
    assert_eq!((vite.kind.as_str(), vite.command.as_str()), ("node", "node_modules/.bin/vite"));
    assert_eq!(vite.args, s(&["--port", "5173"]));

    let script = get(&r, "Script");
    assert_eq!(script.args, s(&["scripts/seed.js", "--count", "10"]));
    assert_eq!(script.extras.env_files, s(&[".env"]));
    assert_eq!(ignored(&r, "Script"), ["preLaunchTask"]);

    let storybook = get(&r, "Storybook");
    assert_eq!((storybook.kind.as_str(), storybook.command.as_str()), ("shell", "pnpm"));
    assert_eq!(storybook.args, s(&["exec", "storybook", "dev", "-p", "6006"]));
    assert_eq!(storybook.debug_adapter.as_deref(), Some("js-debug"));

    // A shell line runs through the shell, without the debugger.
    let line = get(&r, "Migrate and serve");
    assert_eq!((line.kind.as_str(), line.command.as_str()), ("shell", "npm run migrate && npm start"));
    assert!(line.args.is_empty() && line.debug_adapter.is_none());

    assert_eq!(reason(&r, "Nothing"), &SkipReason::NothingToRun);
}

#[test]
fn compounds_resolve_members_by_name() {
    let launch = r#"{
        "configurations": [
            { "name": "Django", "type": "debugpy", "request": "launch", "program": "${workspaceFolder}/manage.py", "args": ["runserver"] },
            { "name": "Next.js: debug server-side", "type": "node-terminal", "request": "launch", "command": "npm run dev" },
        ],
        "compounds": [
            { "name": "Full stack", "configurations": ["Django", "Next.js: debug server-side"], "stopAll": true },
            { "name": "With the worker", "configurations": ["Django", { "name": "Celery", "folder": "api" }] },
        ],
    }"#;
    let (dir, r) = run(launch);
    let full = get(&r, "Full stack");
    assert_eq!(full.kind, "compound");
    assert_eq!(full.extras.compound, s(&["user:django", "user:next-js-debug-server-side"]));
    assert_eq!(ignored(&r, "Full stack"), ["stopAll"]);
    assert_eq!(reason(&r, "With the worker"), &SkipReason::MissingMember { member: "Celery".into() });

    // Importing again adds nothing; a compound still finds members that already exist.
    let mut existing: Vec<RunConfig> = r.imported.iter().map(|c| c.config.clone()).collect();
    existing.retain(|c| c.name != "Full stack");
    let again = import_from(dir.path(), &existing);
    assert_eq!(again.imported.iter().map(|c| c.config.name.as_str()).collect::<Vec<_>>(), ["Full stack"]);
    assert_eq!(again.imported[0].config.extras.compound, s(&["user:django", "user:next-js-debug-server-side"]));
    assert_eq!(reason(&again, "Django"), &SkipReason::NameTaken);
    assert_eq!(reason(&again, "Next.js: debug server-side"), &SkipReason::NameTaken);
}

#[test]
fn existing_names_are_skipped_and_ids_stay_unique() {
    let dir = project(
        r#"{ "configurations": [
            { "name": "manage.py runserver", "type": "debugpy", "request": "launch", "program": "manage.py", "args": ["runserver"] },
            { "name": "Server", "type": "debugpy", "request": "launch", "program": "server.py" },
            { "name": "Server", "type": "debugpy", "request": "launch", "program": "other.py" }
        ] }"#,
    );
    let detected = RunConfig {
        id: "django:runserver".into(),
        name: "manage.py runserver".into(),
        kind: "python".into(),
        command: "python3".into(),
        args: s(&["manage.py", "runserver"]),
        cwd: None,
        env: BTreeMap::new(),
        detected: true,
        is_test: false,
        debug_adapter: Some("debugpy".into()),
        allow_parallel: false,
        extras: Default::default(),
    };
    let user = RunConfig { id: "user:server".into(), name: "Old server".into(), detected: false, ..detected.clone() };
    let r = import_from(dir.path(), &[detected, user]);
    assert_eq!(reason(&r, "manage.py runserver"), &SkipReason::NameTaken);
    // Two entries with the same name: the first wins.
    assert_eq!(r.imported.len(), 1);
    assert_eq!(r.imported[0].config.id, "user:server-2");
    assert_eq!(r.imported[0].config.args, s(&["server.py"]));
    assert_eq!(r.skipped.len(), 2);
}

#[test]
fn variables_known_only_at_launch_skip_the_entry() {
    let (_dir, r) = run(r#"{
        "configurations": [
            { "name": "Current file", "type": "debugpy", "request": "launch", "program": "${file}", "console": "integratedTerminal" },
            { "name": "Port", "type": "debugpy", "request": "launch", "module": "app", "args": ["--port", "${input:port}"] },
            { "name": "Home", "type": "debugpy", "request": "launch", "program": "${userHome}/bin/tool.py" },
            { "name": "Token", "type": "debugpy", "request": "launch", "program": "app.py",
              "env": { "TOKEN": "${env:API_TOKEN}", "MISSING": "${env:NOT_SET}x" } }
        ],
        "inputs": [{ "id": "port", "type": "promptString", "description": "Port" }]
    }"#);
    assert_eq!(reason(&r, "Current file"), &SkipReason::Variable { variable: "${file}".into() });
    assert_eq!(reason(&r, "Port"), &SkipReason::Variable { variable: "${input:port}".into() });
    assert_eq!(get(&r, "Home").args, s(&["/home/me/bin/tool.py"]));
    // The home directory is this machine's too: the configuration stays out of run.toml.
    assert!(get(&r, "Home").extras.local);
    let token = get(&r, "Token");
    assert_eq!(token.env["TOKEN"], "s3cret");
    assert_eq!(token.env["MISSING"], "x");
    // Values from this machine's environment go to the workspace-local file, not run.toml.
    assert!(token.extras.local);
}

#[test]
fn attach_requests_become_remote_debug_configurations() {
    let (_dir, r) = run(r#"{
        "configurations": [
            { "name": "Attach (container)", "type": "debugpy", "request": "attach",
              "connect": { "host": "localhost", "port": 5678 }, "justMyCode": true,
              "pathMappings": [{ "localRoot": "${workspaceFolder}", "remoteRoot": "/app" }] },
            { "name": "Attach to Node", "type": "node", "request": "attach", "port": 9230,
              "localRoot": "${workspaceFolder}/web", "remoteRoot": "/usr/src/app", "restart": true },
            { "name": "Attach to PID", "type": "debugpy", "request": "attach", "processId": "${command:pickProcess}" },
            { "name": "Odd", "type": "node", "request": "test" }
        ]
    }"#);
    let py = get(&r, "Attach (container)");
    assert_eq!((py.kind.as_str(), py.command.as_str()), ("python-remote", ""));
    assert_eq!(py.debug_adapter.as_deref(), Some("debugpy"));
    assert_eq!(
        py.extras.params,
        BTreeMap::from([
            ("host".into(), "localhost".into()),
            ("port".into(), "5678".into()),
            ("remoteRoot".into(), "/app".into())
        ])
    );
    assert_eq!(ignored(&r, "Attach (container)"), ["justMyCode"]);

    let node = get(&r, "Attach to Node");
    assert_eq!(node.kind, "node-remote");
    assert_eq!(node.extras.params["port"], "9230");
    assert_eq!(node.extras.params["localRoot"], "web");
    assert_eq!(node.extras.params["remoteRoot"], "/usr/src/app");
    assert_eq!(ignored(&r, "Attach to Node"), ["restart"]);

    assert_eq!(reason(&r, "Attach to PID"), &SkipReason::UnsupportedAttach);
    assert_eq!(reason(&r, "Odd"), &SkipReason::UnsupportedRequest { request: "test".into() });
}

#[test]
fn the_block_for_this_os_overrides_the_entry() {
    let os = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "osx"
    } else {
        "linux"
    };
    let (_dir, r) = run(&format!(
        r#"{{ "configurations": [{{ "name": "App", "type": "debugpy", "request": "launch", "program": "app.py",
             "python": "python3", "{os}": {{ "python": "/opt/py/bin/python" }} }}] }}"#
    ));
    assert_eq!(get(&r, "App").command, "/opt/py/bin/python");
    assert!(ignored(&r, "App").is_empty());
}

#[test]
fn unnamed_entries_are_invalid_and_bad_json_is_an_error() {
    let (_dir, r) = run(r#"{ "configurations": [{ "type": "debugpy", "request": "launch", "program": "a.py" }, 3] }"#);
    assert!(r.imported.is_empty());
    assert!(r.skipped.iter().all(|s| s.reason == SkipReason::Invalid && s.name.is_empty()));

    let dir = project("{ \"configurations\": [ ");
    assert!(import(dir.path(), RunImportSource::Vscode, &[], &env()).is_err());
    let empty = tempfile::tempdir().unwrap();
    assert!(import(empty.path(), RunImportSource::Vscode, &[], &env()).is_err());
    assert!(ide_run::import::available(empty.path()).is_empty());
    assert_eq!(ide_run::import::available(dir.path()), [RunImportSource::Vscode]);
}

#[test]
fn imported_configurations_round_trip_through_run_toml() {
    let (dir, r) = run(DJANGO);
    let configs: Vec<RunConfig> = r.imported.iter().map(|c| c.config.clone()).collect();
    ide_run::save_user_configs(dir.path(), &configs).unwrap();
    assert_eq!(ide_run::load_user_configs(dir.path()).unwrap(), configs);
}

/// Run configurations pass `env` values to the process as written (only `.env` files expand
/// `${VAR}`), so `${env:…}` is resolved when importing; the value stays out of the shared run.toml.
#[test]
fn resolved_environment_values_are_saved_in_the_local_file_only() {
    let (dir, r) = run(r#"{ "configurations": [
        { "name": "Token", "type": "debugpy", "request": "launch", "program": "app.py", "env": { "TOKEN": "${env:API_TOKEN}" } },
        { "name": "Plain", "type": "debugpy", "request": "launch", "program": "app.py" }
    ] }"#);
    let configs: Vec<RunConfig> = r.imported.iter().map(|c| c.config.clone()).collect();
    ide_run::save_user_configs(dir.path(), &configs).unwrap();
    let shared = fs::read_to_string(ide_run::user_configs_path(dir.path())).unwrap();
    assert!(shared.contains("Plain") && !shared.contains("Token") && !shared.contains("s3cret"));
    let local = fs::read_to_string(dir.path().join(".openidea/run.local.toml")).unwrap();
    assert!(local.contains("TOKEN = \"s3cret\""), "{local}");
    let loaded = ide_run::load_user_configs(dir.path()).unwrap();
    assert!(loaded.iter().any(|c| c.name == "Token" && c.extras.local && c.env["TOKEN"] == "s3cret"));
}

#[test]
fn environment_variables_come_from_what_runs_inherit_login_shell_included() {
    // An app started from the Dock lacks what ~/.zshrc exports; runs get it from the login shell.
    ide_core::process::set_shell_env(vec![("OPENIDEA_IMPORT_SHELL_ONLY".into(), "from-shell".into())]);
    let dir = project(
        r#"{ "configurations": [{ "name": "App", "type": "debugpy", "request": "launch", "program": "app.py",
             "env": { "DATABASE_URL": "${env:OPENIDEA_IMPORT_SHELL_ONLY}" } }] }"#,
    );
    let r = ide_run::import_configs(dir.path(), RunImportSource::Vscode, &[]).unwrap();
    assert_eq!(get(&r, "App").env["DATABASE_URL"], "from-shell");
}

#[test]
fn selected_interpreter_keeps_its_options_and_subdirectory_manage_py_stays_python() {
    let (_dir, r) = run(r#"{ "configurations": [
        { "name": "Dev mode", "type": "debugpy", "request": "launch", "program": "app.py",
          "python": ["${command:python.interpreterPath}", "-X", "dev"] },
        { "name": "Default", "type": "debugpy", "request": "launch", "program": "app.py",
          "python": "${config:python.defaultInterpreterPath}" },
        { "name": "Spaces", "type": "debugpy", "request": "launch", "program": "app.py",
          "python": "/opt/My Python/bin/python" },
        { "name": "Dot tests", "type": "debugpy", "request": "launch", "program": "./manage.py", "args": ["test", "polls"] },
        { "name": "Nested tests", "type": "debugpy", "request": "launch",
          "program": "${workspaceFolder}/backend/manage.py", "args": ["test"] }
    ] }"#);
    let py = if cfg!(windows) { "python" } else { "python3" };
    assert_eq!(get(&r, "Dev mode").command, py);
    assert_eq!(get(&r, "Dev mode").args, s(&["-X", "dev", "app.py"]));
    assert_eq!(get(&r, "Default").command, py);
    assert_eq!(get(&r, "Spaces").command, "/opt/My Python/bin/python");
    let dot = get(&r, "Dot tests");
    assert_eq!((dot.kind.as_str(), dot.args.clone()), ("django-test", s(&["manage.py", "test", "polls"])));
    // The Django tests form runs `manage.py` from the working directory: a nested one stays a Python run.
    let nested = get(&r, "Nested tests");
    assert_eq!((nested.kind.as_str(), nested.args.clone()), ("python", s(&["backend/manage.py", "test"])));
}

#[test]
fn existing_names_match_without_surrounding_spaces() {
    let dir = project(
        r#"{ "configurations": [{ "name": " Django ", "type": "debugpy", "request": "launch", "program": "manage.py" }] }"#,
    );
    let existing = RunConfig {
        id: "user:django".into(),
        name: "Django ".into(),
        kind: "python".into(),
        command: "python3".into(),
        args: s(&["manage.py"]),
        cwd: None,
        env: BTreeMap::new(),
        detected: false,
        is_test: false,
        debug_adapter: None,
        allow_parallel: false,
        extras: Default::default(),
    };
    let r = import_from(dir.path(), &[existing]);
    assert_eq!(reason(&r, "Django"), &SkipReason::NameTaken);
}
