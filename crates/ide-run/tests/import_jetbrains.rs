//! JetBrains run configuration import. The fixtures are synthetic: they follow the structure
//! PyCharm and WebStorm write (`.run/*.run.xml`, `.idea/workspace.xml`), with invented names and values.

use ide_run::RunConfig;
use ide_run::import::{RunImport, RunImportSource, SkipReason, available, import};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// IDEA joins `ENV_FILES` with `File.pathSeparator`.
const SEP: char = if cfg!(windows) { ';' } else { ':' };
const VENV_PYTHON: &str = if cfg!(windows) { ".venv/Scripts/python.exe" } else { ".venv/bin/python" };

fn env() -> BTreeMap<String, String> {
    BTreeMap::from([("HOME".into(), "/home/me".into()), ("USERPROFILE".into(), "/home/me".into())])
}

fn write(root: &Path, rel: &str, text: &str) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn run_file(name: &str, body: &str) -> String {
    format!(
        "<component name=\"ProjectRunConfigurationManager\">\n  {}\n</component>\n",
        body.replace("name=\"NAME\"", &format!("name=\"{name}\""))
    )
}

fn workspace(configs: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<project version=\"4\">\n  <component name=\"ChangeListManager\" />\n  \
         <component name=\"RunManager\" selected=\"Python.App\">\n{configs}\n    <list>\n      <item itemvalue=\"Python.App\" />\n    \
         </list>\n  </component>\n</project>\n"
    )
}

fn import_from(root: &Path, existing: &[RunConfig]) -> RunImport {
    import(root, RunImportSource::Jetbrains, existing, &env()).unwrap()
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

/// A Django project in `src/` with a root virtualenv.
fn django_project() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "src/manage.py", "");
    write(dir.path(), VENV_PYTHON, "");
    dir
}

const PY_COMMON: &str = r#"<module name="shop" />
    <option name="ENV_FILES" value="" />
    <option name="INTERPRETER_OPTIONS" value="" />
    <option name="PARENT_ENVS" value="true" />
    <option name="SDK_HOME" value="" />
    <option name="IS_MODULE_SDK" value="true" />
    <option name="ADD_CONTENT_ROOTS" value="true" />
    <option name="ADD_SOURCE_ROOTS" value="true" />"#;

#[test]
fn django_server_and_tests_from_shared_run_files() {
    let dir = django_project();
    write(
        dir.path(),
        ".run/Server.run.xml",
        &run_file(
            "Server",
            &format!(
                r#"<configuration default="false" name="NAME" type="Python.DjangoServer" factoryName="Django server">
    {PY_COMMON}
    <envs>
      <env name="PYTHONUNBUFFERED" value="1" />
      <env name="DJANGO_SETTINGS_MODULE" value="shop.settings.dev" />
    </envs>
    <option name="WORKING_DIRECTORY" value="$PROJECT_DIR$/src" />
    <option name="launchJavascriptDebuger" value="false" />
    <option name="port" value="8001" />
    <option name="host" value="0.0.0.0" />
    <option name="additionalOptions" value="--insecure" />
    <option name="browserUrl" value="" />
    <option name="runTestServer" value="false" />
    <option name="runNoReload" value="true" />
    <option name="useCustomRunCommand" value="true" />
    <option name="customRunCommand" value="runserver_plus" />
    <method v="2" />
  </configuration>"#
            ),
        ),
    );
    write(
        dir.path(),
        ".run/Tests.run.xml",
        &run_file(
            "Tests",
            &format!(
                r#"<configuration default="false" name="NAME" type="DjangoTestsConfigurationType">
    {PY_COMMON}
    <option name="WORKING_DIRECTORY" value="$PROJECT_DIR$/src" />
    <EXTENSION ID="PythonCoverageRunConfigurationExtension" runner="coverage.py" />
    <option name="TARGET" value="orders.tests catalog" />
    <option name="SETTINGS_FILE" value="$PROJECT_DIR$/src/shop/settings/test.py" />
    <option name="CUSTOM_SETTINGS" value="true" />
    <option name="USE_OPTIONS" value="false" />
    <option name="OPTIONS" value="--keepdb" />
    <method v="2" />
  </configuration>"#
            ),
        ),
    );
    let r = import_from(dir.path(), &[]);
    assert!(r.skipped.is_empty(), "{r:#?}");
    assert_eq!(r.file, ".run, .idea");

    let server = get(&r, "Server");
    assert_eq!(server.kind, "python");
    assert_eq!(server.command, format!("../{VENV_PYTHON}"));
    assert_eq!(server.args, s(&["manage.py", "runserver_plus", "0.0.0.0:8001", "--noreload", "--insecure"]));
    assert_eq!(cwd(server), Some(PathBuf::from("src")));
    assert_eq!(server.env["DJANGO_SETTINGS_MODULE"], "shop.settings.dev");
    assert_eq!(server.debug_adapter.as_deref(), Some("debugpy"));
    assert!(server.extras.include_system_env && !server.extras.local);

    let tests = get(&r, "Tests");
    assert_eq!(tests.kind, "django-test");
    assert!(tests.is_test);
    // OPTIONS count only with USE_OPTIONS, as in PyCharm; the settings file becomes its module.
    assert_eq!(tests.args, s(&["manage.py", "test", "orders.tests", "catalog", "--settings", "shop.settings.test"]));
}

#[test]
fn workspace_run_manager_skips_templates_and_temporary_configurations() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "web/package.json", r#"{ "name": "web", "scripts": { "dev": "vite", "test": "vitest" } }"#);
    write(dir.path(), "web/pnpm-lock.yaml", "");
    write(dir.path(), "tests/__init__.py", "");
    write(dir.path(), "tests/test_money.py", "");
    write(
        dir.path(),
        ".idea/workspace.xml",
        &workspace(&format!(
            r#"    <configuration default="true" type="PythonConfigurationType" factoryName="Python">
      {PY_COMMON}
      <option name="SCRIPT_NAME" value="" />
      <method v="2" />
    </configuration>
    <configuration name="build" type="js.build_tools.npm" temporary="true" nameIsGenerated="true">
      <package-json value="$PROJECT_DIR$/web/package.json" />
      <command value="run" />
      <scripts><script value="build" /></scripts>
      <node-interpreter value="project" />
      <envs />
      <method v="2" />
    </configuration>
    <configuration name="App" type="PythonConfigurationType" factoryName="Python" folderName="Tools" singleton="false">
      <module name="shop" />
      <option name="ENV_FILES" value="$PROJECT_DIR$/.env{SEP}$PROJECT_DIR$/.env.local" />
      <option name="INTERPRETER_OPTIONS" value="-X dev" />
      <option name="PARENT_ENVS" value="false" />
      <envs><env name="LOG_LEVEL" value="debug" /></envs>
      <option name="SDK_HOME" value="$USER_HOME$/.virtualenvs/shop/bin/python" />
      <option name="WORKING_DIRECTORY" value="$PROJECT_DIR$" />
      <option name="IS_MODULE_SDK" value="false" />
      <option name="RUN_TOOL" value="" />
      <option name="SCRIPT_NAME" value="shop.tools.sync" />
      <option name="PARAMETERS" value="--since 2024-01-01 --out $PROJECT_DIR$/out" />
      <option name="SHOW_COMMAND_LINE" value="false" />
      <option name="EMULATE_TERMINAL" value="true" />
      <option name="MODULE_MODE" value="true" />
      <option name="REDIRECT_INPUT" value="false" />
      <option name="INPUT_FILE" value="" />
      <method v="2">
        <option name="RunConfigurationTask" enabled="true" run_configuration_name="Migrate" run_configuration_type="PythonConfigurationType" />
      </method>
    </configuration>
    <configuration name="Unit" type="tests" factoryName="py.test">
      {PY_COMMON}
      <option name="WORKING_DIRECTORY" value="" />
      <option name="_new_keywords" value="&quot;not slow&quot;" />
      <option name="_new_parameters" value="&quot;&quot;" />
      <option name="_new_additionalArguments" value="&quot;-x --tb=short&quot;" />
      <option name="_new_target" value="&quot;$PROJECT_DIR$/tests/test_orders.py&quot;" />
      <option name="_new_targetType" value="&quot;PATH&quot;" />
      <method v="2" />
    </configuration>
    <configuration name="Case" type="tests" factoryName="py.test">
      {PY_COMMON}
      <option name="_new_parameters" value="&quot;eur-2&quot;" />
      <option name="_new_target" value="&quot;tests.test_money.test_round&quot;" />
      <option name="_new_targetType" value="&quot;PYTHON&quot;" />
      <method v="2" />
    </configuration>
    <configuration name="Path params" type="tests" factoryName="py.test">
      {PY_COMMON}
      <option name="_new_keywords" value="&quot;'slow or fast'&quot;" />
      <option name="_new_parameters" value="&quot;eur-2&quot;" />
      <option name="_new_target" value="&quot;$PROJECT_DIR$/tests/test_money.py&quot;" />
      <option name="_new_targetType" value="&quot;PATH&quot;" />
      <method v="2" />
    </configuration>
    <configuration name="Custom" type="tests" factoryName="py.test">
      {PY_COMMON}
      <option name="_new_keywords" value="&quot;slow&quot;" />
      <option name="_new_additionalArguments" value="&quot;tests/a.py --maxfail=2&quot;" />
      <option name="_new_target" value="&quot;&quot;" />
      <option name="_new_targetType" value="&quot;CUSTOM&quot;" />
      <method v="2" />
    </configuration>
    <configuration name="Unittests in tests" type="tests" factoryName="Unittests">
      {PY_COMMON}
      <option name="_new_target" value="&quot;tests&quot;" />
      <method v="2" />
    </configuration>
    <configuration name="dev" type="js.build_tools.npm">
      <package-json value="$PROJECT_DIR$/web/package.json" />
      <command value="run" />
      <scripts><script value="dev" /><script value="test" /></scripts>
      <arguments value="--host 0.0.0.0" />
      <node-interpreter value="/opt/node22/bin/node" />
      <envs><env name="VITE_API" value="http://localhost:8000" /></envs>
      <method v="2" />
    </configuration>
    <configuration name="Main" type="Application" factoryName="Application">
      <option name="MAIN_CLASS_NAME" value="shop.Main" />
      <method v="2" />
    </configuration>"#
        )),
    );
    let r = import_from(dir.path(), &[]);
    let names: Vec<&str> = r.imported.iter().map(|c| c.config.name.as_str()).collect();
    assert_eq!(names, ["App", "Unit", "Case", "Path params", "Custom", "dev"]);

    let app = get(&r, "App");
    // `$USER_HOME$` is this machine's: the configuration goes to run.local.toml.
    assert!(app.extras.local);
    assert_eq!(app.command, "/home/me/.virtualenvs/shop/bin/python");
    assert_eq!(app.args, s(&["-X", "dev", "-m", "shop.tools.sync", "--since", "2024-01-01", "--out", "out"]));
    assert_eq!(app.extras.env_files, s(&[".env", ".env.local"]));
    assert!(!app.extras.include_system_env && app.extras.emulate_terminal && app.allow_parallel);
    assert_eq!(app.extras.folder.as_deref(), Some("Tools"));
    assert_eq!(ignored(&r, "App"), ["before launch"]);

    let unit = get(&r, "Unit");
    assert_eq!(unit.kind, "pytest");
    assert!(unit.is_test);
    let py = if cfg!(windows) { "python" } else { "python3" };
    assert_eq!(unit.command, py);
    assert_eq!(unit.args, s(&["-m", "pytest", "tests/test_orders.py", "-k", "not slow", "-x", "--tb=short"]));
    // intellij-community PyTest.kt: parameters follow only a Python target; keywords lose their
    // quotes and are left out for a custom target; additional arguments split like a command line.
    assert_eq!(get(&r, "Case").args, s(&["-m", "pytest", "tests/test_money.py::test_round[eur-2]"]));
    assert_eq!(get(&r, "Path params").args, s(&["-m", "pytest", "tests/test_money.py", "-k", "slow or fast"]));
    assert_eq!(get(&r, "Custom").args, s(&["-m", "pytest", "tests/a.py", "--maxfail=2"]));

    assert_eq!(reason(&r, "Unittests in tests"), &SkipReason::UnsupportedType { type_: "tests (Unittests)".into() });
    assert_eq!(reason(&r, "Main"), &SkipReason::UnsupportedType { type_: "Application".into() });

    let dev = get(&r, "dev");
    assert_eq!((dev.kind.as_str(), dev.command.as_str()), ("npm", "pnpm"));
    assert_eq!(dev.args, s(&["run", "dev", "--host", "0.0.0.0"]));
    assert_eq!(cwd(dev), Some(PathBuf::from("web")));
    assert_eq!(dev.env["VITE_API"], "http://localhost:8000");
    assert_eq!(ignored(&r, "dev"), ["node-interpreter", "scripts"]);
    // Neither the template nor the temporary `build` is listed as skipped.
    assert_eq!(r.skipped.len(), 2);
}

#[test]
fn javascript_tests_node_shell_and_compounds() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        ".idea/workspace.xml",
        &workspace(
            r#"    <configuration name="cart total" type="JavaScriptTestRunnerVitest">
      <node-interpreter value="project" />
      <vitest-package value="$PROJECT_DIR$/web/node_modules/vitest" />
      <working-dir value="$PROJECT_DIR$/web" />
      <vitest-options value="--reporter verbose" />
      <envs />
      <scope-kind value="TEST" />
      <test-file value="$PROJECT_DIR$/web/src/cart.test.ts" />
      <test-names>
        <test-name value="cart" />
        <test-name value="total (with tax)" />
      </test-names>
      <method v="2" />
    </configuration>
    <configuration name="api tests" type="JavaScriptTestRunnerJest">
      <node-interpreter value="project" />
      <jest-package value="$PROJECT_DIR$/node_modules/jest" />
      <working-dir value="$PROJECT_DIR$" />
      <jest-options value="--runInBand" />
      <config-file value="$PROJECT_DIR$/jest.config.js" />
      <envs><env name="NODE_ENV" value="test" /></envs>
      <scope-kind value="DIRECTORY" />
      <test-directory value="$PROJECT_DIR$/api/__tests__" />
      <method v="2" />
    </configuration>
    <configuration name="server.js" type="NodeJSConfigurationType" path-to-js-file="server/index.js" working-dir="$PROJECT_DIR$" node-parameters="--enable-source-maps" application-parameters="--port 3000">
      <envs><env name="PORT" value="3000" /></envs>
      <method v="2" />
    </configuration>
    <configuration name="seed" type="ShConfigurationType">
      <option name="SCRIPT_TEXT" value="" />
      <option name="INDEPENDENT_SCRIPT_PATH" value="true" />
      <option name="SCRIPT_PATH" value="$PROJECT_DIR$/scripts/seed.sh" />
      <option name="SCRIPT_OPTIONS" value="--small" />
      <option name="INDEPENDENT_SCRIPT_WORKING_DIRECTORY" value="true" />
      <option name="SCRIPT_WORKING_DIRECTORY" value="$PROJECT_DIR$" />
      <option name="INDEPENDENT_INTERPRETER_PATH" value="true" />
      <option name="INTERPRETER_PATH" value="/bin/bash" />
      <option name="INTERPRETER_OPTIONS" value="-e" />
      <option name="EXECUTE_IN_TERMINAL" value="true" />
      <option name="EXECUTE_SCRIPT_FILE" value="true" />
      <envs />
      <method v="2" />
    </configuration>
    <configuration name="clean" type="ShConfigurationType">
      <option name="SCRIPT_TEXT" value="cd $PROJECT_DIR$/web &amp;&amp; npm run dev &amp;&amp; echo $HOME$PATH $1 $HOME" />
      <option name="EXECUTE_IN_TERMINAL" value="false" />
      <option name="EXECUTE_SCRIPT_FILE" value="false" />
      <envs />
      <method v="2" />
    </configuration>
    <configuration name="Stack" type="CompoundRunConfigurationType">
      <toRun name="server.js" type="NodeJSConfigurationType" />
      <toRun name="seed" type="ShConfigurationType" />
      <method v="2" />
    </configuration>
    <configuration name="Broken" type="CompoundRunConfigurationType">
      <toRun name="Gone" type="NodeJSConfigurationType" />
      <method v="2" />
    </configuration>"#,
        ),
    );
    let r = import_from(dir.path(), &[]);

    let vitest = get(&r, "cart total");
    assert_eq!((vitest.kind.as_str(), vitest.command.as_str()), ("node", "npx"));
    assert_eq!(
        vitest.args,
        s(&["vitest", "run", "--reporter", "verbose", "src/cart.test.ts", "-t", r"^cart total \(with tax\)$"])
    );
    assert_eq!(cwd(vitest), Some(PathBuf::from("web")));
    assert!(vitest.is_test);

    let jest = get(&r, "api tests");
    assert_eq!(jest.args, s(&["jest", "--config", "jest.config.js", "--runInBand", "api/__tests__"]));
    assert_eq!(jest.env["NODE_ENV"], "test");

    let node = get(&r, "server.js");
    assert_eq!((node.kind.as_str(), node.command.as_str()), ("node", "node"));
    assert_eq!(node.args, s(&["--enable-source-maps", "server/index.js", "--port", "3000"]));
    assert_eq!(node.debug_adapter.as_deref(), Some("js-debug"));

    let seed = get(&r, "seed");
    assert_eq!((seed.kind.as_str(), seed.command.as_str()), ("shell", "/bin/bash"));
    assert_eq!(seed.args, s(&["-e", "scripts/seed.sh", "--small"]));
    assert_eq!(seed.extras.params["mode"], "file");
    assert_eq!(seed.extras.params["path"], "scripts/seed.sh");
    assert!(seed.extras.emulate_terminal);

    // Script text is the shell's own: `$HOME$` there is not a macro.
    let clean = get(&r, "clean");
    // IDEA writes `$PROJECT_DIR$` into script text too; the shell's own `$HOME`, `$1`, `$HOME$PATH` stay.
    let root = dir.path().to_string_lossy();
    let line = format!("cd {root}/web && npm run dev && echo $HOME$PATH $1 $HOME");
    assert_eq!(clean.command, line);
    assert_eq!(clean.extras.params["script"], line);
    assert_eq!(clean.extras.params["mode"], "text");
    assert!(!clean.extras.local);

    let stack = get(&r, "Stack");
    assert_eq!(stack.kind, "compound");
    assert_eq!(stack.extras.compound, s(&["user:server-js", "user:seed"]));
    assert_eq!(reason(&r, "Broken"), &SkipReason::MissingMember { member: "Gone".into() });
}

#[test]
fn shared_files_win_and_reimport_adds_nothing() {
    let dir = django_project();
    let tests = |name: &str, target: &str| {
        run_file(
            name,
            &format!(
                r#"<configuration name="NAME" type="DjangoTestsConfigurationType">
    {PY_COMMON}
    <option name="WORKING_DIRECTORY" value="$PROJECT_DIR$/src" />
    <option name="TARGET" value="{target}" />
    <method v="2" />
  </configuration>"#
            ),
        )
    };
    write(dir.path(), ".run/Tests.run.xml", &tests("Tests", "shared"));
    write(dir.path(), ".idea/runConfigurations/Other.xml", &tests("Other", "other"));
    let mine = tests("Tests", "mine").replace("ProjectRunConfigurationManager", "RunManager");
    write(dir.path(), ".idea/workspace.xml", &format!("<project version=\"4\">{mine}</project>"));
    write(dir.path(), ".run/Broken.run.xml", "<component name=\"ProjectRunConfigurationManager\"><configuration");

    let r = import_from(dir.path(), &[]);
    assert_eq!(get(&r, "Tests").args.last().map(String::as_str), Some("shared"));
    assert_eq!(get(&r, "Other").args.last().map(String::as_str), Some("other"));
    assert_eq!(reason(&r, "Tests"), &SkipReason::NameTaken);
    // The parser's message says where the file breaks.
    assert!(matches!(reason(&r, ".run/Broken.run.xml"), SkipReason::InvalidFile { detail } if !detail.is_empty()));

    let existing: Vec<RunConfig> = r.imported.iter().map(|c| c.config.clone()).collect();
    assert!(import_from(dir.path(), &existing).imported.is_empty());
}

#[test]
fn macros_env_files_and_missing_manage_py() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        ".run/Sync.run.xml",
        &run_file(
            "Sync",
            &format!(
                r#"<configuration name="NAME" type="PythonConfigurationType" factoryName="Python">
    {PY_COMMON}
    <option name="WORKING_DIRECTORY" value="$MODULE_DIR$/jobs" />
    <option name="SCRIPT_NAME" value="$MODULE_WORKING_DIR$/jobs/sync.py" />
    <option name="PARAMETERS" value="" />
    <extension name="net.ashald.envfile">
      <option name="IS_ENABLED" value="true" />
      <option name="IS_SUBST" value="false" />
      <ENTRIES>
        <ENTRY IS_ENABLED="true" PARSER="runconfig" IS_EXECUTABLE="false" />
        <ENTRY IS_ENABLED="true" PARSER="env" IS_EXECUTABLE="false" PATH=".env" />
        <ENTRY IS_ENABLED="false" PARSER="env" IS_EXECUTABLE="false" PATH=".env.off" />
        <ENTRY IS_ENABLED="true" PARSER="yaml" IS_EXECUTABLE="false" PATH="secrets.yml" />
      </ENTRIES>
    </extension>
    <method v="2" />
  </configuration>"#
            ),
        ),
    );
    write(
        dir.path(),
        ".run/Repo.run.xml",
        &run_file(
            "Repo",
            &format!(
                r#"<configuration name="NAME" type="PythonConfigurationType" factoryName="Python">
    {PY_COMMON}
    <option name="SCRIPT_NAME" value="$MAVEN_REPOSITORY$/tool.py" />
    <method v="2" />
  </configuration>"#
            ),
        ),
    );
    write(
        dir.path(),
        ".run/Server.run.xml",
        &run_file(
            "Server",
            &format!(
                r#"<configuration name="NAME" type="Python.DjangoServer" factoryName="Django server">
    {PY_COMMON}
    <method v="2" />
  </configuration>"#
            ),
        ),
    );
    let r = import_from(dir.path(), &[]);
    let sync = get(&r, "Sync");
    assert_eq!(cwd(sync), Some(PathBuf::from("jobs")));
    assert_eq!(sync.args, s(&["sync.py"]));
    assert_eq!(sync.extras.env_files, s(&[".env"]));
    assert_eq!(ignored(&r, "Sync"), ["EnvFile secrets.yml"]);
    assert!(!sync.extras.local);
    assert_eq!(reason(&r, "Repo"), &SkipReason::PathVariable { variable: "$MAVEN_REPOSITORY$".into() });
    assert_eq!(reason(&r, "Server"), &SkipReason::MissingFile { file: "manage.py".into() });
}

#[test]
fn sources_are_offered_when_their_files_exist() {
    let dir = tempfile::tempdir().unwrap();
    assert!(available(dir.path()).is_empty());
    assert!(import(dir.path(), RunImportSource::Jetbrains, &[], &env()).is_err());
    // IDEA writes a workspace.xml everywhere: without configurations to import there's nothing to offer.
    write(dir.path(), ".idea/workspace.xml", &workspace(""));
    assert!(available(dir.path()).is_empty());
    write(
        dir.path(),
        ".idea/workspace.xml",
        &workspace(
            r#"<configuration default="true" type="PythonConfigurationType" factoryName="Python" />
    <configuration name="once" type="js.build_tools.npm" temporary="true" />"#,
        ),
    );
    assert!(available(dir.path()).is_empty());
    write(dir.path(), ".idea/workspace.xml", &workspace(r#"<configuration name="App" type="Application" />"#));
    assert_eq!(available(dir.path()), [RunImportSource::Jetbrains]);
    write(dir.path(), ".vscode/launch.json", "{}");
    assert_eq!(available(dir.path()), [RunImportSource::Vscode, RunImportSource::Jetbrains]);
    assert_eq!(
        reason(&import_from(dir.path(), &[]), "App"),
        &SkipReason::UnsupportedType { type_: "Application".into() }
    );
}

#[test]
fn imported_configurations_round_trip_through_run_toml() {
    let dir = django_project();
    write(
        dir.path(),
        ".run/Seed.run.xml",
        &run_file(
            "Seed",
            r#"<configuration name="NAME" type="ShConfigurationType" folderName="Data">
    <option name="SCRIPT_PATH" value="$PROJECT_DIR$/scripts/seed.sh" />
    <option name="INTERPRETER_PATH" value="" />
    <option name="EXECUTE_SCRIPT_FILE" value="true" />
    <envs />
    <method v="2" />
  </configuration>"#,
        ),
    );
    let r = import_from(dir.path(), &[]);
    let configs: Vec<RunConfig> = r.imported.iter().map(|c| c.config.clone()).collect();
    assert_eq!(configs[0].command, "./scripts/seed.sh");
    ide_run::save_user_configs(dir.path(), &configs).unwrap();
    assert_eq!(ide_run::load_user_configs(dir.path()).unwrap(), configs);
}

#[test]
fn module_macros_need_a_single_module_project() {
    let launch = |root: &Path| {
        write(
            root,
            ".run/Job.run.xml",
            &run_file(
                "Job",
                &format!(
                    r#"<configuration name="NAME" type="PythonConfigurationType" factoryName="Python">
    {PY_COMMON}
    <option name="SCRIPT_NAME" value="$MODULE_DIR$/job.py" />
    <method v="2" />
  </configuration>"#
                ),
            ),
        )
    };
    let modules = |names: &[&str]| {
        let items: String = names
            .iter()
            .map(|n| format!("<module fileurl=\"file://$PROJECT_DIR$/{n}.iml\" filepath=\"$PROJECT_DIR$/{n}.iml\" />"))
            .collect();
        format!(
            "<project version=\"4\"><component name=\"ProjectModuleManager\"><modules>{items}</modules></component></project>"
        )
    };
    let one = tempfile::tempdir().unwrap();
    launch(one.path());
    write(one.path(), ".idea/modules.xml", &modules(&["shop"]));
    assert_eq!(get(&import_from(one.path(), &[]), "Job").args, s(&["job.py"]));

    let two = tempfile::tempdir().unwrap();
    launch(two.path());
    write(two.path(), ".idea/modules.xml", &modules(&["shop", "worker"]));
    let r = import_from(two.path(), &[]);
    assert_eq!(reason(&r, "Job"), &SkipReason::SeveralModules { variable: "$MODULE_DIR$".into() });
}

#[test]
fn pytest_python_targets_become_node_ids() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "tests/__init__.py", "");
    write(dir.path(), "tests/test_money.py", "");
    write(dir.path(), "api/tests/test_views.py", "");
    write(dir.path(), "pkg/sub/__init__.py", "");
    let case = |name: &str, target: &str, params: &str, wd: &str| {
        format!(
            r#"<configuration name="{name}" type="tests" factoryName="py.test">
      {PY_COMMON}
      <option name="WORKING_DIRECTORY" value="{wd}" />
      <option name="_new_parameters" value="&quot;{params}&quot;" />
      <option name="_new_target" value="&quot;{target}&quot;" />
      <option name="_new_targetType" value="&quot;PYTHON&quot;" />
      <method v="2" />
    </configuration>"#
        )
    };
    let configs = [
        case("Function", "tests.test_money.test_round", "", ""),
        case("Method", "tests.test_money.TestRound.test_eur", "", ""),
        case("Parametrized", "tests.test_money.TestRound.test_eur", "eur-2", ""),
        case("Module", "tests.test_money", "", ""),
        case("Package", "pkg.sub", "", ""),
        case("From api", "tests.test_views.test_list", "", "$PROJECT_DIR$/api"),
        case("Root from api", "tests.test_money.test_round", "", "$PROJECT_DIR$/api/tests"),
        case("Installed", "somelib.tests.test_core", "x", ""),
    ];
    write(dir.path(), ".idea/workspace.xml", &workspace(&configs.join("\n")));
    let r = import_from(dir.path(), &[]);
    let target = |name: &str| get(&r, name).args[2..].to_vec();
    assert_eq!(target("Function"), s(&["tests/test_money.py::test_round"]));
    assert_eq!(target("Method"), s(&["tests/test_money.py::TestRound::test_eur"]));
    assert_eq!(target("Parametrized"), s(&["tests/test_money.py::TestRound::test_eur[eur-2]"]));
    assert_eq!(target("Module"), s(&["tests/test_money.py"]));
    assert_eq!(target("Package"), s(&["pkg/sub"]));
    // From the working directory first, then the project root (relative to the working directory).
    assert_eq!(target("From api"), s(&["tests/test_views.py::test_list"]));
    assert_eq!(target("Root from api"), s(&["../../tests/test_money.py::test_round"]));
    // Not in the project: pytest looks the module up by name; the parameters can't follow it.
    assert_eq!(target("Installed"), s(&["--pyargs", "somelib.tests.test_core"]));
    assert_eq!(ignored(&r, "Installed"), ["_new_parameters"]);
}

#[test]
fn flags_defaults_inherited_variables_and_nested_django_tests() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "backend/manage.py", "");
    write(
        dir.path(),
        ".idea/workspace.xml",
        &workspace(&format!(
            r#"    <configuration name="Old script" type="ShConfigurationType">
      <option name="SCRIPT_PATH" value="$PROJECT_DIR$/run.sh" />
      <option name="INTERPRETER_PATH" value="" />
      <envs><env name="PYTHONPATH" value="$PYTHONPATH$:src" /><env name="TAG" value="$NOT_SET$" /></envs>
      <method v="2" />
    </configuration>
    <configuration name="Tool off" type="PythonConfigurationType" factoryName="Python">
      {PY_COMMON}
      <option name="RUN_TOOL" value="false" />
      <option name="SCRIPT_NAME" value="app.py" />
      <method v="2" />
    </configuration>
    <configuration name="Tool on" type="PythonConfigurationType" factoryName="Python">
      {PY_COMMON}
      <option name="RUN_TOOL" value="true" />
      <option name="SCRIPT_NAME" value="app.py" />
      <method v="2" />
    </configuration>
    <configuration name="Backend tests" type="DjangoTestsConfigurationType">
      {PY_COMMON}
      <option name="WORKING_DIRECTORY" value="" />
      <option name="TARGET" value="orders" />
      <method v="2" />
    </configuration>"#
        )),
    );
    let mut env = env();
    env.insert("PYTHONPATH".into(), "/opt/lib".into());
    let r = import(dir.path(), RunImportSource::Jetbrains, &[], &env).unwrap();

    // Written before EXECUTE_SCRIPT_FILE / EXECUTE_IN_TERMINAL existed: both default to true.
    let old = get(&r, "Old script");
    // Run directly: `./run.sh`, not a `run.sh` looked up on the PATH.
    assert_eq!(old.command, "./run.sh");
    assert_eq!(old.extras.params["path"], "./run.sh");
    assert!(old.extras.emulate_terminal);
    // Environment values as written, as the Shell and Python types pass them: `$NAME$` isn't inlined,
    // even for a variable runs inherit, and doesn't make the configuration this machine's.
    assert_eq!(old.env["PYTHONPATH"], "$PYTHONPATH$:src");
    assert_eq!(old.env["TAG"], "$NOT_SET$");
    assert!(!old.extras.local);

    assert!(ignored(&r, "Tool off").is_empty());
    assert_eq!(ignored(&r, "Tool on"), ["RUN_TOOL"]);

    // `backend/manage.py test` from the root: a Python run, still a test configuration.
    let tests = get(&r, "Backend tests");
    assert_eq!((tests.kind.as_str(), tests.is_test), ("python", true));
    assert_eq!(tests.args[..3], s(&["backend/manage.py", "test", "orders"]));
}
