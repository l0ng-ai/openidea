//! JetBrains run configurations (PyCharm, WebStorm, IntelliJ IDEA): the shared `.run/*.run.xml`
//! files, `.idea/runConfigurations/*.xml`, and the `RunManager` of `.idea/workspace.xml` without
//! its templates (`default="true"`) and temporary configurations. A configuration found in more
//! than one place is taken from the first, in that order.
//!
//! Python, Django server, Django tests, pytest, npm, Jest, Vitest, Node.js, Shell Script,
//! Application, JAR Application, Spring Boot, Go Application / Go Test and compound configurations become the
//! matching kinds; other types are skipped with their type.
//! `$PROJECT_DIR$` (and `$MODULE_DIR$`, `$MODULE_WORKING_DIR$`, `$ContentRoot$`,
//! `$ProjectFileDir$`, all the project directory here) and `$USER_HOME$` are replaced; another
//! path variable skips the configuration.

use super::{
    Entry, Found, SkipReason, command_name, config, env_var, normalize, path_from, project_python, relative_to,
    working_dir,
};
use crate::RunConfig;
use ide_core::IdeResult;
use quick_xml::{Reader, XmlVersion, events::Event};
use std::cell::Cell;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The files read, in order of precedence, with the name the summary gives them.
pub(crate) fn files(root: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    for (dir, suffix) in [(".run", ".run.xml"), (".idea/runConfigurations", ".xml")] {
        let mut found: Vec<PathBuf> = std::fs::read_dir(root.join(dir))
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_file() && p.file_name().is_some_and(|n| n.to_string_lossy().ends_with(suffix)))
            .collect();
        found.sort();
        for p in found {
            let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            out.push((format!("{dir}/{name}"), p));
        }
    }
    // IDEA writes a workspace.xml in every project it opens: it counts only with configurations to import.
    let workspace = root.join(".idea/workspace.xml");
    let has_configurations = std::fs::read_to_string(&workspace).is_ok_and(|text| {
        text.contains("RunManager")
            && parse(&text).map_or(true, |doc| configurations(&doc, "RunManager").next().is_some())
    });
    if has_configurations {
        out.push((".idea/workspace.xml".into(), workspace));
    }
    out
}

/// The configurations of `manager` (`RunManager` in workspace.xml), without IDEA's templates for
/// new configurations and the temporary ones it makes for a single run.
fn configurations<'a>(doc: &'a El, manager: &'a str) -> impl Iterator<Item = &'a El> {
    std::iter::once(doc)
        .chain(doc.children.iter())
        .filter(move |c| c.name == "component" && c.attr("name") == Some(manager))
        .flat_map(|component| component.children_named("configuration"))
        .filter(|c| c.attr("default") != Some("true") && c.attr("temporary") != Some("true"))
}

pub(crate) fn entries(root: &Path, env: &BTreeMap<String, String>) -> IdeResult<Vec<Entry>> {
    let windows = cfg!(windows);
    let homes = if windows { ["USERPROFILE", "HOME"] } else { ["HOME", "USERPROFILE"] };
    let home = homes.into_iter().find_map(|k| env_var(env, k, windows));
    let cx = Cx { root: &normalize(root), home, modules: module_count(root), machine_values: Cell::new(false) };
    let mut out = Vec::new();
    for (label, path) in files(root) {
        let doc = std::fs::read_to_string(&path).map_err(|e| e.to_string()).and_then(|text| parse(&text));
        let doc = match doc {
            Ok(doc) => doc,
            Err(detail) => {
                out.push(Entry { name: label, result: Err(SkipReason::InvalidFile { detail }) });
                continue;
            }
        };
        let workspace = label == ".idea/workspace.xml";
        let manager = if workspace { "RunManager" } else { "ProjectRunConfigurationManager" };
        out.extend(configurations(&doc, manager).map(|c| cx.entry(c)));
    }
    Ok(out)
}

// ------------------------------------------------------------------------- XML

/// An element of the file, with its attributes (values unescaped) and child elements.
#[derive(Debug, Default)]
struct El {
    name: String,
    attrs: Vec<(String, String)>,
    children: Vec<El>,
}

impl El {
    fn attr(&self, key: &str) -> Option<&str> {
        self.attrs.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    fn child(&self, name: &str) -> Option<&El> {
        self.children.iter().find(|c| c.name == name)
    }

    fn children_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a El> {
        self.children.iter().filter(move |c| c.name == name)
    }

    /// `<option name="KEY" value="…"/>`, a direct child.
    fn option(&self, key: &str) -> Option<&str> {
        self.children_named("option").find(|o| o.attr("name") == Some(key)).and_then(|o| o.attr("value"))
    }

    /// `<KEY value="…"/>` (the WebStorm types write their fields so).
    fn value(&self, key: &str) -> Option<&str> {
        self.child(key).and_then(|c| c.attr("value"))
    }

    fn flag(&self, key: &str) -> bool {
        self.option(key) == Some("true")
    }
}

fn parse(xml: &str) -> Result<El, String> {
    let mut reader = Reader::from_str(xml);
    let mut stack: Vec<El> = vec![El::default()];
    loop {
        let event = reader.read_event().map_err(|e| e.to_string())?;
        match event {
            Event::Start(ref tag) | Event::Empty(ref tag) => {
                let mut el = El { name: tag.name().as_ref().to_owned(), ..El::default() };
                for a in tag.attributes() {
                    let a = a.map_err(|e| e.to_string())?;
                    let value = a.normalized_value(XmlVersion::Implicit1_0).map_err(|e| e.to_string())?;
                    el.attrs.push((a.key.as_ref().to_owned(), value.into_owned()));
                }
                if matches!(event, Event::Start(_)) {
                    stack.push(el);
                } else if let Some(parent) = stack.last_mut() {
                    parent.children.push(el);
                }
            }
            Event::End(_) => {
                let el = stack.pop().ok_or("unbalanced element")?;
                stack.last_mut().ok_or("unbalanced element")?.children.push(el);
            }
            Event::Eof => break,
            _ => {}
        }
    }
    let mut document = stack.pop().filter(|_| stack.is_empty()).ok_or("unclosed element")?;
    document.children.pop().ok_or_else(|| "no root element".to_owned())
}

// ------------------------------------------------------------------- mapping

const PYTHON: &str = "PythonConfigurationType";
const DJANGO_SERVER: &str = "Python.DjangoServer";
const DJANGO_TESTS: &str = "DjangoTestsConfigurationType";
const PYTHON_TESTS: &str = "tests";
const NPM: &str = "js.build_tools.npm";
const JEST: &str = "JavaScriptTestRunnerJest";
const VITEST: &str = "JavaScriptTestRunnerVitest";
const NODE: &str = "NodeJSConfigurationType";
const SHELL: &str = "ShConfigurationType";
const COMPOUND: &str = "CompoundRunConfigurationType";
const APPLICATION: &str = "Application";
const JAR_APPLICATION: &str = "JarApplication";
const SPRING_BOOT: &str = "SpringBootApplicationConfigurationType";
const GO_APPLICATION: &str = "GoApplicationRunConfiguration";
const GO_TEST: &str = "GoTestRunConfiguration";

type Res<T> = Result<T, SkipReason>;

/// What a `$NAME$` that isn't a known path macro does.
#[derive(Clone, Copy, PartialEq)]
enum Unknown {
    /// Skips the configuration: a path variable defined in the IDE, with no value here.
    Skip,
    /// Stays as written: script text, where `$` belongs to the shell.
    Keep,
}

struct Cx<'a> {
    root: &'a Path,
    home: Option<String>,
    /// Modules `.idea/modules.xml` lists. `$MODULE_DIR$` is the module's content root: the project
    /// directory in a single-module project, unknown here with several.
    modules: usize,
    /// The configuration being converted used `$USER_HOME$`: its values belong to this machine.
    machine_values: Cell<bool>,
}

/// A JSON string as the pytest configuration stores its `_new_*` fields (`"\"tests\""`).
fn json_string(raw: &str) -> String {
    serde_json::from_str::<String>(raw).unwrap_or_else(|_| raw.to_owned())
}

/// A command line the run configuration forms parse back into `args` (`formatArgs` in the UI):
/// single quotes only where needed.
fn format_args(args: &[String]) -> String {
    let quote = |a: &String| {
        if a.is_empty() {
            "''".to_owned()
        } else if a.chars().any(|c| c.is_whitespace() || "'\"\\$`".contains(c)) {
            format!("'{}'", a.replace('\'', "'\\''"))
        } else {
            a.clone()
        }
    };
    args.iter().map(quote).collect::<Vec<_>>().join(" ")
}

/// Regex-escaped for Jest / Vitest `-t`.
fn regex_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if r"\^$.|?*+()[]{}".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

impl Cx<'_> {
    /// Replaces the path macros in `s`; another `$NAME$` skips the configuration.
    fn expand(&self, s: &str) -> Res<String> {
        self.expand_with(s, Unknown::Skip)
    }

    /// Replaces the path macros in `s`, which IDEA writes in every option of a configuration
    /// (script text included); `unknown` says what another `$NAME$` does.
    fn expand_with(&self, s: &str, unknown: Unknown) -> Res<String> {
        let mut out = String::with_capacity(s.len());
        let mut rest = s;
        while let Some(start) = rest.find('$') {
            let after = &rest[start + 1..];
            let len =
                after.find('$').filter(|&n| n > 0 && after[..n].chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
            let Some(len) = len else {
                out.push_str(&rest[..=start]);
                rest = after;
                continue;
            };
            out.push_str(&rest[..start]);
            let name = &after[..len];
            let value = match name {
                "PROJECT_DIR" | "ContentRoot" | "ProjectFileDir" => self.root.to_string_lossy().into_owned(),
                // Which module's directory is unknown here when there are several.
                "MODULE_DIR" | "MODULE_WORKING_DIR" if self.modules > 1 => {
                    return Err(SkipReason::SeveralModules { variable: format!("${name}$") });
                }
                "MODULE_DIR" | "MODULE_WORKING_DIR" => self.root.to_string_lossy().into_owned(),
                "USER_HOME" => {
                    self.machine_values.set(true);
                    self.home.clone().ok_or(SkipReason::PathVariable { variable: format!("${name}$") })?
                }
                _ => match unknown {
                    Unknown::Skip => return Err(SkipReason::PathVariable { variable: format!("${name}$") }),
                    Unknown::Keep => format!("${name}$"),
                },
            };
            out.push_str(&value);
            rest = &after[len + 1..];
        }
        out.push_str(rest);
        Ok(out)
    }

    fn text(&self, value: Option<&str>) -> Res<Option<String>> {
        match value.map(str::trim) {
            Some(v) if !v.is_empty() => self.expand(v).map(Some),
            _ => Ok(None),
        }
    }

    /// A filesystem path: expand IDEA's macros before converting a file URL.
    fn path(&self, value: Option<&str>) -> Res<Option<String>> {
        Ok(self.text(value)?.map(|v| file_url_path(&v)))
    }

    /// Words of a parameters field, split like IDEA's `ParametersListUtil.parse`.
    fn words(&self, value: Option<&str>) -> Res<Vec<String>> {
        self.words_quoted(value, Quotes::Double)
    }

    fn words_quoted(&self, value: Option<&str>, quotes: Quotes) -> Res<Vec<String>> {
        Ok(self.text(value)?.map(|v| parse_params(&v, quotes)).unwrap_or_default())
    }

    /// Words of a command line, paths inside the project relative to `dir`.
    fn args(&self, value: Option<&str>, dir: &Path) -> Res<Vec<String>> {
        self.args_quoted(value, Quotes::Double, dir)
    }

    fn args_quoted(&self, value: Option<&str>, quotes: Quotes, dir: &Path) -> Res<Vec<String>> {
        Ok(self
            .words_quoted(value, quotes)?
            .into_iter()
            .map(|a| path_from(self.root, file_url_path(&a), dir))
            .collect())
    }

    /// The working directory (absolute) and the configuration's `cwd`.
    fn cwd(&self, value: Option<&str>) -> Res<(PathBuf, Option<PathBuf>)> {
        Ok(match self.path(value)? {
            Some(dir) => working_dir(self.root, &dir),
            None => (self.root.to_path_buf(), None),
        })
    }

    fn entry(&self, c: &El) -> Entry {
        let name = c.attr("name").unwrap_or_default().trim().to_owned();
        self.machine_values.set(false);
        let result = if name.is_empty() { Err(SkipReason::Invalid) } else { self.convert(&name, c) };
        let result = result.map(|mut found| {
            // Values of this machine (its home) stay out of the shared run.toml.
            found.config.extras.local = self.machine_values.get();
            if let Some(folder) = c.attr("folderName").filter(|f| !f.trim().is_empty()) {
                found.config.extras.folder = Some(folder.trim().to_owned());
            }
            // IDEA's "Allow multiple instances".
            found.config.allow_parallel = c.attr("singleton") == Some("false");
            if c.child("method").is_some_and(|m| !m.children.is_empty()) {
                found.ignored.push("before launch".into());
            }
            found.ignored.sort();
            found
        });
        Entry { name, result }
    }

    fn convert(&self, name: &str, c: &El) -> Res<Found> {
        let ty = c.attr("type").unwrap_or_default();
        let factory = c.attr("factoryName").unwrap_or_default();
        let mut ignored = Vec::new();
        let mut members = Vec::new();
        let config = match ty {
            PYTHON => self.python(name, c, &mut ignored)?,
            DJANGO_SERVER => self.django_server(name, c, &mut ignored)?,
            DJANGO_TESTS => self.django_tests(name, c, &mut ignored)?,
            PYTHON_TESTS if matches!(factory, "py.test" | "pytest") => self.pytest(name, c, &mut ignored)?,
            NPM => self.npm(name, c, &mut ignored)?,
            JEST | VITEST => self.js_tests(name, c, ty == VITEST, &mut ignored)?,
            NODE => self.node(name, c, &mut ignored)?,
            SHELL => self.shell(name, c)?,
            APPLICATION => self.java_app(name, c, false, &mut ignored)?,
            JAR_APPLICATION => self.jar_app(name, c, &mut ignored)?,
            SPRING_BOOT => self.java_app(name, c, true, &mut ignored)?,
            GO_APPLICATION => self.go_config(name, c, false, &mut ignored)?,
            GO_TEST => self.go_config(name, c, true, &mut ignored)?,
            COMPOUND => {
                members = c.children_named("toRun").filter_map(|t| t.attr("name")).map(str::to_owned).collect();
                config(name, "compound", String::new(), Vec::new(), None)
            }
            PYTHON_TESTS => return Err(SkipReason::UnsupportedType { type_: format!("{ty} ({factory})") }),
            other => return Err(SkipReason::UnsupportedType { type_: other.to_owned() }),
        };
        Ok(Found { config, members, ignored })
    }

    /// A Go Application (`GoApplicationRunConfiguration`) or Go Test configuration. Both share
    /// the kind (package / file / directory), the target node, `go_parameters` (go tool
    /// arguments) and envs; a test adds a `pattern` and program arguments go after `-args`.
    fn go_config(&self, name: &str, c: &El, test: bool, _ignored: &mut Vec<String>) -> Res<RunConfig> {
        let (dir, cwd) = self.cwd(c.value("working_directory"))?;
        let scope = match c.value("kind").unwrap_or("PACKAGE") {
            "FILE" => "file",
            "DIRECTORY" => "directory",
            _ => "package",
        };
        let path_target = |value: Option<&str>| -> Res<Option<String>> {
            Ok(self.path(value)?.map(|p| path_from(self.root, p, &dir)).filter(|p| !p.is_empty()))
        };
        let target = match scope {
            "file" => path_target(c.value("filePath"))?
                .or(self.text(c.value("package"))?)
                .filter(|t| !t.is_empty())
                .unwrap_or_else(|| ".".to_owned()),
            "directory" => path_target(c.value("directory"))?.unwrap_or_else(|| ".".to_owned()),
            _ => self.text(c.value("package"))?.filter(|t| !t.is_empty()).unwrap_or_else(|| ".".to_owned()),
        };
        let raw_tool = self.text(c.value("go_parameters"))?.unwrap_or_default();
        let tool_args = parse_params(&raw_tool, Quotes::Double);
        let raw_program = self.text(c.value("parameters"))?.unwrap_or_default();
        let program_args = parse_params(&raw_program, Quotes::Double);
        let pattern = self.text(c.value("pattern"))?.unwrap_or_default();
        let output_dir =
            self.path(c.value("output_directory"))?.map(|p| path_from(self.root, p, self.root)).unwrap_or_default();
        // The form's module is the working directory relative to the project root.
        let module = cwd.as_ref().map(|d| d.to_string_lossy().replace('\\', "/")).unwrap_or_default();
        let run_after_build = c.option("run") != Some("false");
        let targets: Vec<String> = if scope == "file" {
            target.split('|').map(|t| t.trim().to_owned()).filter(|t| !t.is_empty()).collect()
        } else {
            vec![target.clone()]
        };
        let mut args = vec![if test { "test".to_owned() } else { "build".to_owned() }];
        args.extend(tool_args.clone());
        if test {
            if !pattern.is_empty() {
                args.extend(["-run".to_owned(), pattern.clone()]);
            }
            args.extend(targets);
            if !program_args.is_empty() {
                args.push("-args".to_owned());
                args.extend(program_args.clone());
            }
        } else {
            args.extend(targets);
        }
        let mut rc = config(name, "go", "go".into(), args, Some("delve"));
        rc.cwd = cwd.map(Into::into);
        rc.is_test = test;
        let mut params = BTreeMap::from([
            ("goKind".to_owned(), if test { "test" } else { "build" }.to_owned()),
            ("scope".to_owned(), scope.to_owned()),
            ("target".to_owned(), target),
            ("toolArgs".to_owned(), raw_tool),
            ("programArgs".to_owned(), raw_program),
            ("module".to_owned(), module),
        ]);
        if test {
            if !pattern.is_empty() {
                params.insert("pattern".to_owned(), pattern);
            }
        } else {
            params.insert("outputDir".to_owned(), output_dir);
            params.insert("runAfterBuild".to_owned(), run_after_build.to_string());
        }
        if !program_args.is_empty() {
            params.insert("programArgv".to_owned(), serde_json::to_string(&program_args).unwrap_or_default());
        }
        params.retain(|_, value| !value.is_empty());
        rc.extras.params = params;
        self.envs(c, &mut rc);
        Ok(rc)
    }

    // ------------------------------------------------------------- Python

    /// The interpreter (`SDK_HOME` when the configuration doesn't use the module's), its
    /// options, and the working directory.
    fn interpreter(&self, c: &El, ignored: &mut Vec<String>) -> Res<(String, Vec<String>, PathBuf, Option<PathBuf>)> {
        let (dir, cwd) = self.cwd(c.option("WORKING_DIRECTORY"))?;
        let sdk = if c.flag("IS_MODULE_SDK") { None } else { self.path(c.option("SDK_HOME"))? };
        let (exe, mut args) = match sdk {
            Some(sdk) => (path_from(self.root, sdk, &dir), Vec::new()),
            None => project_python(self.root, &dir),
        };
        args.extend(self.words(c.option("INTERPRETER_OPTIONS"))?);
        // A flag (`AbstractPythonRunConfiguration.java:320-321`): `false` leaves nothing out.
        if c.option("RUN_TOOL") == Some("true") {
            ignored.push("RUN_TOOL".into());
        }
        Ok((exe, args, dir, cwd))
    }

    /// `envs`, `PARENT_ENVS`, `ENV_FILES` and the EnvFile plugin's files.
    fn python_env(&self, c: &El, rc: &mut RunConfig, ignored: &mut Vec<String>) -> Res<()> {
        self.envs(c, rc);
        rc.extras.include_system_env = c.option("PARENT_ENVS") != Some("false");
        // PyCharm 2024+: "Paths to .env files", joined with `File.pathSeparator`.
        for file in split_env_files(c.option("ENV_FILES").unwrap_or_default(), PATH_SEPARATOR) {
            if let Some(file) = self.path(Some(file))? {
                rc.extras.env_files.push(path_from(self.root, file, self.root));
            }
        }
        self.envfile_plugin(c, rc, ignored)
    }

    /// Environment variables, as written: IDEA doesn't put path macros there
    /// (`RunConfigurationPathMacroFilter`), and the Python and Shell types pass `$NAME$` through as is.
    fn envs(&self, c: &El, rc: &mut RunConfig) {
        for env in c.child("envs").into_iter().flat_map(|e| e.children_named("env")) {
            if let Some(key) = env.attr("name").filter(|k| !k.is_empty()) {
                rc.env.insert(key.to_owned(), env.attr("value").unwrap_or_default().to_owned());
            }
        }
    }

    /// The EnvFile plugin (`net.ashald.envfile`): its enabled `.env` entries.
    fn envfile_plugin(&self, c: &El, rc: &mut RunConfig, ignored: &mut Vec<String>) -> Res<()> {
        let Some(ext) = c.children_named("extension").find(|e| e.attr("name") == Some("net.ashald.envfile")) else {
            return Ok(());
        };
        if !ext.flag("IS_ENABLED") {
            return Ok(());
        }
        for entry in ext.child("ENTRIES").into_iter().flat_map(|e| e.children_named("ENTRY")) {
            let path = entry.attr("PATH").unwrap_or_default();
            if entry.attr("IS_ENABLED") == Some("false") || path.is_empty() {
                continue;
            }
            if entry.attr("PARSER").is_some_and(|p| p != "env") || entry.attr("IS_EXECUTABLE") == Some("true") {
                ignored.push(format!("EnvFile {path}"));
                continue;
            }
            if let Some(file) = self.path(Some(path))? {
                rc.extras.env_files.push(path_from(self.root, file, self.root));
            }
        }
        Ok(())
    }

    fn python(&self, name: &str, c: &El, ignored: &mut Vec<String>) -> Res<RunConfig> {
        let (exe, mut args, dir, cwd) = self.interpreter(c, ignored)?;
        let Some(script) = self.text(c.option("SCRIPT_NAME"))? else {
            return Err(SkipReason::NothingToRun);
        };
        if c.flag("MODULE_MODE") {
            args.extend(["-m".to_owned(), script]);
        } else {
            args.push(path_from(self.root, file_url_path(&script), &dir));
        }
        args.extend(self.args(c.option("PARAMETERS"), &dir)?);
        let mut rc = config(name, "python", exe, args, Some("debugpy"));
        rc.cwd = cwd.map(Into::into);
        rc.extras.emulate_terminal = c.flag("EMULATE_TERMINAL");
        if c.flag("REDIRECT_INPUT") {
            ignored.push("REDIRECT_INPUT".into());
        }
        self.python_env(c, &mut rc, ignored)?;
        Ok(rc)
    }

    /// `manage.py` relative to the working directory: there, at the root, or one level down.
    fn manage_py(&self, dir: &Path) -> Res<String> {
        let mut candidates = vec![dir.join("manage.py"), self.root.join("manage.py")];
        if let Ok(read) = std::fs::read_dir(self.root) {
            let mut nested: Vec<PathBuf> =
                read.flatten().map(|e| e.path().join("manage.py")).filter(|p| p.is_file()).collect();
            if nested.len() == 1 {
                candidates.append(&mut nested);
            }
        }
        let found =
            candidates.into_iter().find(|p| p.is_file()).ok_or(SkipReason::MissingFile { file: "manage.py".into() })?;
        Ok(relative_to(&normalize(&found), dir).unwrap_or_else(|| found.to_string_lossy().into_owned()))
    }

    fn django_server(&self, name: &str, c: &El, ignored: &mut Vec<String>) -> Res<RunConfig> {
        let (exe, mut args, dir, cwd) = self.interpreter(c, ignored)?;
        args.push(self.manage_py(&dir)?);
        let custom = if c.flag("useCustomRunCommand") { self.text(c.option("customRunCommand"))? } else { None };
        args.push(custom.unwrap_or_else(|| "runserver".into()));
        let port = self.text(c.option("port"))?;
        match (self.text(c.option("host"))?, port) {
            (Some(host), port) => args.push(format!("{host}:{}", port.as_deref().unwrap_or("8000"))),
            (None, Some(port)) => args.push(port),
            (None, None) => {}
        }
        if c.flag("runNoReload") {
            args.push("--noreload".into());
        }
        args.extend(self.words(c.option("additionalOptions"))?);
        for key in ["browserUrl", "launchJavascriptDebuger", "runTestServer"] {
            if c.option(key).is_some_and(|v| !v.is_empty() && v != "false") {
                ignored.push(key.into());
            }
        }
        let mut rc = config(name, "python", exe, args, Some("debugpy"));
        rc.cwd = cwd.map(Into::into);
        self.python_env(c, &mut rc, ignored)?;
        Ok(rc)
    }

    fn django_tests(&self, name: &str, c: &El, ignored: &mut Vec<String>) -> Res<RunConfig> {
        let (exe, mut args, dir, cwd) = self.interpreter(c, ignored)?;
        let manage = self.manage_py(&dir)?;
        // The Django tests form runs `manage.py` from the working directory; another place stays a Python run.
        let kind = if manage == "manage.py" { "django-test" } else { "python" };
        args.extend([manage, "test".to_owned()]);
        args.extend(self.words(c.option("TARGET"))?);
        if c.flag("CUSTOM_SETTINGS")
            && let Some(settings) = self.path(c.option("SETTINGS_FILE"))?
        {
            args.extend(["--settings".to_owned(), settings_module(&settings, self.root, &dir)]);
        }
        if c.flag("USE_OPTIONS") {
            args.extend(self.words(c.option("OPTIONS"))?);
        }
        let mut rc = config(name, kind, exe, args, Some("debugpy"));
        rc.cwd = cwd.map(Into::into);
        // A test configuration either way: the test tree reads `manage.py test` output in a Python run too.
        rc.is_test = true;
        self.python_env(c, &mut rc, ignored)?;
        Ok(rc)
    }

    fn pytest(&self, name: &str, c: &El, ignored: &mut Vec<String>) -> Res<RunConfig> {
        let (exe, mut args, dir, cwd) = self.interpreter(c, ignored)?;
        args.extend(["-m".to_owned(), "pytest".to_owned()]);
        let field = |key: &str| c.option(key).map(json_string).filter(|v| !v.trim().is_empty());
        // As `PyTestConfiguration` (intellij-community `PyTest.kt:151-153`, `:181-183`): parameters only
        // follow a Python target (`name[params]`), keywords go to `-k` unless the target is custom.
        let target_type = field("_new_targetType");
        if let Some(target) = field("_new_target") {
            let target = self.expand(&target)?;
            match target_type.as_deref() {
                Some("PYTHON") => {
                    let params = field("_new_parameters").map(|p| format!("[{p}]")).unwrap_or_default();
                    match self.python_target(&target, &dir) {
                        Some(node_id) => args.push(format!("{node_id}{params}")),
                        // Not a module of the project (an installed package): pytest finds it by name.
                        None => {
                            args.extend(["--pyargs".to_owned(), target]);
                            if !params.is_empty() {
                                ignored.push("_new_parameters".into());
                            }
                        }
                    }
                }
                Some("CUSTOM") => {}
                _ => args.push(path_from(self.root, file_url_path(&target), &dir)),
            }
        }
        if target_type.as_deref() != Some("CUSTOM")
            && let Some(keywords) =
                field("_new_keywords").map(|k| strip_quotes(&k).to_owned()).filter(|k| !k.is_empty())
        {
            args.extend(["-k".to_owned(), keywords]);
        }
        // Single quotes group words here too (`PyTestsShared.kt:671`).
        args.extend(self.args_quoted(field("_new_additionalArguments").as_deref(), Quotes::Single, &dir)?);
        let mut rc = config(name, "pytest", exe, args, Some("debugpy"));
        rc.cwd = cwd.map(Into::into);
        rc.is_test = true;
        self.python_env(c, &mut rc, ignored)?;
        Ok(rc)
    }

    /// A pytest Python target (`tests.test_money.TestRound.test_eur`) as the node id PyCharm
    /// passes (`tests/test_money.py::TestRound::test_eur`, intellij-community `PyTestsShared.kt:366-400`):
    /// the longest prefix that is a module on disk (`a/b.py` or `a/b/__init__.py`, from the working
    /// directory, then the project root), then the rest as `::` symbols. Relative to `dir`.
    fn python_target(&self, dotted: &str, dir: &Path) -> Option<String> {
        let parts: Vec<&str> = dotted.split('.').collect();
        if parts.iter().any(|p| p.is_empty()) {
            return None;
        }
        for base in [dir, self.root] {
            for n in (1..=parts.len()).rev() {
                let module = parts[..n].join("/");
                let (file, node) = if base.join(format!("{module}.py")).is_file() {
                    (base.join(format!("{module}.py")), format!("{module}.py"))
                } else if base.join(&module).join("__init__.py").is_file() {
                    (base.join(&module), module.clone())
                } else {
                    continue;
                };
                let path = if base == dir { node } else { path_from(self.root, file.to_string_lossy().into(), dir) };
                return Some(
                    std::iter::once(path)
                        .chain(parts[n..].iter().map(|s| (*s).to_owned()))
                        .collect::<Vec<_>>()
                        .join("::"),
                );
            }
        }
        None
    }

    // ------------------------------------------------------------- JavaScript

    /// The configuration's own Node interpreter; `None` for the project's (`project`).
    fn node_interpreter(&self, c: &El) -> Res<Option<String>> {
        match c.value("node-interpreter").or_else(|| c.attr("node-interpreter")).map(str::trim) {
            None | Some("" | "project") => Ok(None),
            interpreter => self.path(interpreter),
        }
    }

    /// Kinds without an interpreter field keep the project's and list the setting as ignored.
    fn node_interpreter_ignored(&self, c: &El, ignored: &mut Vec<String>) -> Res<()> {
        if self.node_interpreter(c)?.is_some() {
            ignored.push("node-interpreter".into());
        }
        Ok(())
    }

    fn npm(&self, name: &str, c: &El, ignored: &mut Vec<String>) -> Res<RunConfig> {
        let package_json = self.path(c.value("package-json"))?;
        let dir = match &package_json {
            Some(p) => normalize(&self.root.join(p)).parent().map(Path::to_path_buf).unwrap_or(self.root.to_path_buf()),
            None => self.root.to_path_buf(),
        };
        let manager = match self.path(c.value("package-manager"))? {
            Some(pm) if ["npm", "pnpm", "yarn", "bun"].contains(&command_name(&pm)) => command_name(&pm).to_owned(),
            _ => {
                let pkg = std::fs::read_to_string(dir.join("package.json"))
                    .ok()
                    .and_then(|t| serde_json::from_str(&t).ok())
                    .unwrap_or_default();
                crate::detect::package_manager(&dir, &pkg).to_owned()
            }
        };
        let command = self.text(c.value("command"))?.unwrap_or_else(|| "run".into());
        let scripts: Vec<&str> = c
            .child("scripts")
            .into_iter()
            .flat_map(|s| s.children_named("script"))
            .filter_map(|s| s.attr("value"))
            .collect();
        let mut args = vec![command.clone()];
        let mut test = command == "test";
        if command == "run" {
            let Some(script) = scripts.first() else { return Err(SkipReason::NothingToRun) };
            test = crate::detect::is_test_script(script);
            args.push((*script).to_owned());
            if scripts.len() > 1 {
                ignored.push("scripts".into());
            }
        }
        let arguments = self.words(c.value("arguments"))?;
        args.extend(arguments.iter().cloned());
        let interpreter = self.node_interpreter(c)?;
        let package_dir = working_dir(self.root, &dir.to_string_lossy()).1;
        let mut rc = config(name, "npm", manager.clone(), args, Some("js-debug"));
        if let Some(interpreter) = interpreter {
            // The npm form's fields, so the interpreter shows there (and the rest still match).
            let script = if command == "run" { scripts.first().map(|s| (*s).to_owned()) } else { None };
            let mut params = BTreeMap::from([
                ("packageManager".to_owned(), manager),
                ("command".to_owned(), command),
                ("script".to_owned(), script.unwrap_or_default()),
                ("arguments".to_owned(), format_args(&arguments)),
                (
                    "packageDir".to_owned(),
                    package_dir.as_ref().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default(),
                ),
                ("nodeInterpreter".to_owned(), interpreter),
            ]);
            params.retain(|_, v| !v.is_empty());
            rc.extras.params = params;
        }
        rc.cwd = package_dir.map(Into::into);
        rc.is_test = test;
        self.envs(c, &mut rc);
        Ok(rc)
    }

    fn js_tests(&self, name: &str, c: &El, vitest: bool, ignored: &mut Vec<String>) -> Res<RunConfig> {
        let (dir, cwd) = self.cwd(c.value("working-dir"))?;
        let mut args: Vec<String> = if vitest { vec!["vitest".into(), "run".into()] } else { vec!["jest".into()] };
        if !vitest && let Some(config_file) = self.path(c.value("config-file"))? {
            args.extend(["--config".to_owned(), path_from(self.root, config_file, &dir)]);
        }
        args.extend(self.args(c.value(if vitest { "vitest-options" } else { "jest-options" }), &dir)?);
        match c.value("scope-kind").unwrap_or("ALL") {
            "DIRECTORY" => args.extend(self.path(c.value("test-directory"))?.map(|d| path_from(self.root, d, &dir))),
            "TEST_FILE" | "SUITE" | "TEST" => {
                args.extend(self.path(c.value("test-file"))?.map(|f| path_from(self.root, f, &dir)));
                let names: Vec<&str> = c
                    .child("test-names")
                    .into_iter()
                    .flat_map(|n| n.children_named("test-name"))
                    .filter_map(|n| n.attr("value"))
                    .collect();
                if !names.is_empty() {
                    let pattern = names.iter().map(|n| regex_escape(n)).collect::<Vec<_>>().join(" ");
                    let anchored = if c.value("scope-kind") == Some("TEST") {
                        format!("^{pattern}$")
                    } else {
                        format!("^{pattern}")
                    };
                    args.extend(["-t".to_owned(), anchored]);
                }
            }
            _ => {}
        }
        self.node_interpreter_ignored(c, ignored)?;
        let mut rc = config(name, "node", "npx".into(), args, Some("js-debug"));
        rc.cwd = cwd.map(Into::into);
        rc.is_test = true;
        self.envs(c, &mut rc);
        Ok(rc)
    }

    fn node(&self, name: &str, c: &El, ignored: &mut Vec<String>) -> Res<RunConfig> {
        let (dir, cwd) = self.cwd(c.attr("working-dir"))?;
        let Some(file) = self.path(c.attr("path-to-js-file"))? else {
            return Err(SkipReason::NothingToRun);
        };
        let mut args = self.words(c.attr("node-parameters"))?;
        args.push(path_from(self.root, file, &dir));
        args.extend(self.args(c.attr("application-parameters"), &dir)?);
        self.node_interpreter_ignored(c, ignored)?;
        let mut rc = config(name, "node", "node".into(), args, Some("js-debug"));
        rc.cwd = cwd.map(Into::into);
        self.envs(c, &mut rc);
        rc.extras.include_system_env = c.attr("pass-parent-envs") != Some("false");
        Ok(rc)
    }

    // ------------------------------------------------------------- Java

    fn jar_app(&self, name: &str, c: &El, ignored: &mut Vec<String>) -> Res<RunConfig> {
        let Some(jar) = self.path(c.option("JAR_PATH"))? else { return Err(SkipReason::NothingToRun) };
        let (dir, cwd) = self.cwd(c.option("WORKING_DIRECTORY"))?;
        let jar = path_from(self.root, jar, &dir);
        let vm = self.words(c.option("VM_PARAMETERS"))?;
        let program = self.words(c.option("PROGRAM_PARAMETERS"))?;
        let mut params = BTreeMap::from([
            ("jarPath".to_owned(), jar.clone()),
            ("vmOptions".to_owned(), format_args(&vm)),
            ("programArgs".to_owned(), format_args(&program)),
        ]);
        let mut command = "java".to_owned();
        if c.flag("ALTERNATIVE_JRE_PATH_ENABLED")
            && let Some(jre) = self.path(c.option("ALTERNATIVE_JRE_PATH"))?
        {
            // IDEA also stores SDK names here; those don't identify a JRE on this machine.
            if jre.contains('/') || jre.contains('\\') {
                let jre = jre.replace('\\', "/");
                command = if jre.ends_with("/bin/java") || jre.to_ascii_lowercase().ends_with("/bin/java.exe") {
                    jre.clone()
                } else {
                    format!("{}/bin/{}", jre.trim_end_matches('/'), if cfg!(windows) { "java.exe" } else { "java" })
                };
                params.insert("jre".to_owned(), jre);
            } else {
                ignored.push(format!("JRE {jre}"));
            }
        }
        let mut args = vm;
        args.extend(["-jar".to_owned(), jar]);
        args.extend(program);
        let mut rc = config(name, "jar-application", command, args, Some("java-debug"));
        rc.cwd = cwd.map(Into::into);
        rc.extras.params = params;
        rc.extras.include_system_env = c.option("PASS_PARENT_ENVS") != Some("false");
        self.envs(c, &mut rc);
        Ok(rc)
    }

    /// IDEA's Application and Spring Boot types, as the `application` / `spring-boot` forms run
    /// them: `java <vm options> -cp ${classpath} <main> [--spring.profiles.active=…] <arguments>`
    /// with the module's runtime classpath.
    fn java_app(&self, name: &str, c: &El, spring: bool, ignored: &mut Vec<String>) -> Res<RunConfig> {
        let main = if spring { "SPRING_BOOT_MAIN_CLASS" } else { "MAIN_CLASS_NAME" };
        let Some(main) = self.text(c.option(main))? else { return Err(SkipReason::NothingToRun) };
        let (_, cwd) = self.cwd(c.option("WORKING_DIRECTORY"))?;
        let mut args = self.words(c.option("VM_PARAMETERS"))?;
        args.extend(["-cp".to_owned(), "${classpath}".to_owned(), main]);
        if spring && let Some(profiles) = self.text(c.option("ACTIVE_PROFILES"))? {
            args.push(format!("--spring.profiles.active={profiles}"));
        }
        args.extend(self.words(c.option("PROGRAM_PARAMETERS"))?);
        let mut rc =
            config(name, if spring { "spring-boot" } else { "application" }, "java".into(), args, Some("java-debug"));
        rc.cwd = cwd.map(Into::into);
        self.envs(c, &mut rc);
        if let Some(module) = c.child("module").and_then(|m| m.attr("name")).filter(|m| !m.is_empty()) {
            match module_dir(self.root, module) {
                Some(dir) => rc.extras.module = Some(dir),
                None => ignored.push(format!("module {module}")),
            }
        }
        // Options the forms have no field for.
        if c.flag("ALTERNATIVE_JRE_PATH_ENABLED") {
            ignored.push("JRE".into());
        }
        if c.flag("INCLUDE_PROVIDED_SCOPE") {
            ignored.push("provided scope".into());
        }
        if c.child("classpathModifications").is_some_and(|m| !m.children.is_empty()) {
            ignored.push("classpath modifications".into());
        }
        if spring {
            for (option, label) in [("HIDE_BANNER", "hide banner"), ("DEBUG_MODE", "debug output")] {
                if c.flag(option) {
                    ignored.push(label.into());
                }
            }
            if c.child("additionalParameters").is_some_and(|p| !p.children.is_empty()) {
                ignored.push("override configuration properties".into());
            }
        }
        Ok(rc)
    }

    // ------------------------------------------------------------- Shell

    /// A script file (with its interpreter) or script text, kept as the Shell Script form's fields.
    fn shell(&self, name: &str, c: &El) -> Res<RunConfig> {
        let (dir, cwd) = self.cwd(c.option("SCRIPT_WORKING_DIRECTORY"))?;
        let mut params = BTreeMap::new();
        // Both default to true when missing (`ShRunConfiguration.java:148-149`).
        let rc = if c.option("EXECUTE_SCRIPT_FILE") != Some("false") {
            let Some(path) = self.path(c.option("SCRIPT_PATH"))? else { return Err(SkipReason::NothingToRun) };
            let path = path_from(self.root, path, &dir);
            let options = self.text(c.option("SCRIPT_OPTIONS"))?.unwrap_or_default();
            let interpreter =
                self.path(c.option("INTERPRETER_PATH"))?.map(|i| path_from(self.root, i, &dir)).unwrap_or_default();
            let interpreter_options = self.text(c.option("INTERPRETER_OPTIONS"))?.unwrap_or_default();
            // Run directly, the script is the program: `./run.sh`, so it isn't looked up on the PATH.
            let path = if interpreter.is_empty() { dot_slash(path) } else { path };
            let (command, args) = if interpreter.is_empty() {
                (path.clone(), parse_params(&options, Quotes::Double))
            } else {
                let mut args = parse_params(&interpreter_options, Quotes::Double);
                args.push(path.clone());
                args.extend(parse_params(&options, Quotes::Double));
                (interpreter.clone(), args)
            };
            params.extend([
                ("mode".to_owned(), "file".to_owned()),
                ("path".to_owned(), path),
                ("options".to_owned(), options),
                ("interpreter".to_owned(), interpreter),
                ("interpreterOptions".to_owned(), interpreter_options),
            ]);
            config(name, "shell", command, args, None)
        } else {
            // IDEA writes `$PROJECT_DIR$` / `$USER_HOME$` into the text too; any other `$` is the shell's.
            let script = self.expand_with(c.option("SCRIPT_TEXT").unwrap_or_default().trim(), Unknown::Keep)?;
            if script.is_empty() {
                return Err(SkipReason::NothingToRun);
            }
            params.extend([("mode".to_owned(), "text".to_owned()), ("script".to_owned(), script.clone())]);
            config(name, "shell", script, Vec::new(), None)
        };
        let mut rc = rc;
        params.retain(|_, v| !v.is_empty());
        rc.extras.params = params;
        rc.cwd = cwd.map(Into::into);
        rc.extras.emulate_terminal = c.option("EXECUTE_IN_TERMINAL") != Some("false");
        self.envs(c, &mut rc);
        Ok(rc)
    }
}

/// Which quotes group words in a parameters field.
#[derive(Clone, Copy)]
enum Quotes {
    Double,
    Single,
}

/// IDEA's `ParametersListUtil.parse`: words split at whitespace, grouped by quotes (dropped);
/// a backslash escapes only a quote, so Windows paths (`C:\p\out`) keep theirs.
fn parse_params(line: &str, quotes: Quotes) -> Vec<String> {
    let is_quote = |c: char| c == '"' || (matches!(quotes, Quotes::Single) && c == '\'');
    let mut out = Vec::new();
    let mut token = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    let mut non_empty = false;
    let mut chars = line.trim().chars().peekable();
    while let Some(c) = chars.next() {
        if quote.map_or(is_quote(c), |q| q == c) {
            if !escaped {
                quote = if quote.is_some() { None } else { Some(c) };
                non_empty = true;
                continue;
            }
            escaped = false;
        } else if c.is_whitespace() && quote.is_none() {
            if !token.is_empty() || non_empty {
                out.push(std::mem::take(&mut token));
                non_empty = false;
            }
            continue;
        } else if c == '\\'
            && let Some(&next) = chars.peek()
            && quote.map_or(is_quote(next), |q| q == next)
        {
            escaped = true;
            continue;
        }
        token.push(c);
    }
    if !token.is_empty() || non_empty {
        out.push(token);
    }
    out
}

/// A relative path as a program: `run.sh` → `./run.sh` (`../x` and rooted paths stay; `/opt/x`
/// has no drive on Windows but isn't relative either).
fn dot_slash(path: String) -> String {
    if Path::new(&path).has_root() || path.starts_with("./") || path.starts_with("../") {
        path
    } else {
        format!("./{path}")
    }
}

/// How IDEA joins a configuration's `.env` files (`File.pathSeparator`).
const PATH_SEPARATOR: char = if cfg!(windows) { ';' } else { ':' };

/// The `ENV_FILES` paths, joined with `separator` (intellij-community
/// `AbstractPythonRunConfiguration.java:303-304`, `:337`).
fn split_env_files(value: &str, separator: char) -> impl Iterator<Item = &str> {
    let mut rest = value;
    std::iter::from_fn(move || {
        if rest.is_empty() {
            return None;
        }
        let end = rest.match_indices(separator).find_map(|(end, _)| {
            let field = rest[..end].trim_start();
            if separator == ':' {
                // A URL's scheme and optional drive letter aren't list separators.
                let scheme = field.eq_ignore_ascii_case("file");
                let drive = field.strip_prefix("file:").is_some_and(|body| {
                    let body = body.trim_start_matches('/');
                    let body = body
                        .split_once('/')
                        .filter(|(host, _)| host.eq_ignore_ascii_case("localhost"))
                        .map_or(body, |(_, path)| path);
                    body.len() == 1 && body.as_bytes()[0].is_ascii_alphabetic()
                });
                if scheme || drive {
                    return None;
                }
            }
            Some(end)
        });
        let field = match end {
            Some(end) => {
                let field = &rest[..end];
                rest = &rest[end + separator.len_utf8()..];
                field
            }
            None => std::mem::take(&mut rest),
        };
        Some(field)
    })
    .filter(|f| !f.trim().is_empty())
}

/// The path a `file:` URL names, and `value` unchanged when it is not one.
///
/// IDEA writes path options as URLs (`file://$PROJECT_DIR$`), which expand to
/// `file://C:/project` on Windows: the drive letter lands where a URL's authority
/// belongs. Parsing that as a path yields `C:project`, a drive-relative path that
/// then resolves against the project directory instead of replacing it.
fn file_url_path(value: &str) -> String {
    let Some(rest) = value.strip_prefix("file:") else {
        return value.to_owned();
    };
    let rest = match rest.strip_prefix("//").and_then(|r| r.split_once('/')) {
        Some((host, path)) if host.eq_ignore_ascii_case("localhost") => path,
        _ => rest,
    };
    let body = rest.trim_start_matches('/');
    let drive = matches!(body.as_bytes(), [d, b':', ..] if d.is_ascii_alphabetic());
    if drive {
        body.to_owned()
    } else if rest.starts_with("//") && !rest.starts_with("///") {
        // A real authority (`file://server/share`): a UNC path.
        format!("//{body}")
    } else {
        format!("/{body}")
    }
}

/// Keywords without the quotes around them (`"not slow"` → `not slow`).
fn strip_quotes(s: &str) -> &str {
    let s = s.trim();
    for q in ['"', '\''] {
        if let Some(inner) = s.strip_prefix(q).and_then(|r| r.strip_suffix(q)) {
            return inner;
        }
    }
    s
}

/// Modules in `.idea/modules.xml` (0 without the file).
fn module_count(root: &Path) -> usize {
    let Some(doc) = std::fs::read_to_string(root.join(".idea/modules.xml")).ok().and_then(|t| parse(&t).ok()) else {
        return 0;
    };
    let components = std::iter::once(&doc).chain(doc.children.iter());
    components
        .filter(|c| c.name == "component" && c.attr("name") == Some("ProjectModuleManager"))
        .flat_map(|c| c.children_named("modules"))
        .map(|m| m.children_named("module").count())
        .sum()
}

/// The folder (relative, `""` for the project's own) of IDEA module `name`: a Maven module is
/// named after its `artifactId` (usually its folder), a Gradle one `<project>.<path>.<source set>`.
fn module_dir(root: &Path, name: &str) -> Option<String> {
    let folder = |dir: &Path| dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let exact = |dir: &Path| folder(dir) == name || pom_artifact(dir).is_some_and(|a| a == name);
    if let Some(dir) = find_module(root, &exact) {
        return Some(dir);
    }
    let gradle = name.strip_suffix(".main").or_else(|| name.strip_suffix(".test")).unwrap_or(name);
    let last = gradle.rsplit('.').next().filter(|last| *last != name)?;
    find_module(root, &|dir: &Path| folder(dir) == last)
}

/// The shallowest build folder under `root` (itself included) that `names` accepts.
fn find_module(root: &Path, names: &dyn Fn(&Path) -> bool) -> Option<String> {
    const BUILDS: [&str; 3] = ["pom.xml", "build.gradle", "build.gradle.kts"];
    let mut level = vec![root.to_path_buf()];
    for _ in 0..5 {
        if let Some(found) = level.iter().find(|d| BUILDS.iter().any(|b| d.join(b).is_file()) && names(d)) {
            let rel = found.strip_prefix(root).ok()?;
            return Some(rel.to_string_lossy().replace('\\', "/"));
        }
        let mut next: Vec<PathBuf> = level
            .iter()
            .filter_map(|d| std::fs::read_dir(d).ok())
            .flat_map(|entries| entries.flatten().map(|e| e.path()))
            .filter(|p| p.is_dir())
            .filter(|p| {
                let n = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                !n.starts_with('.') && !["node_modules", "target", "build", "out", "src"].contains(&n.as_str())
            })
            .collect();
        next.sort();
        level = next;
    }
    None
}

/// The `artifactId` of the module's own `pom.xml` (not its parent's).
fn pom_artifact(dir: &Path) -> Option<String> {
    let pom = std::fs::read_to_string(dir.join("pom.xml")).ok()?;
    let own = match (pom.find("<parent>"), pom.find("</parent>")) {
        (Some(start), Some(end)) if start < end => format!("{}{}", &pom[..start], &pom[end..]),
        _ => pom,
    };
    let start = own.find("<artifactId>")? + "<artifactId>".len();
    let end = start + own[start..].find("</artifactId>")?;
    Some(own[start..end].trim().to_owned())
}

/// `--settings` from PyCharm's "Settings" field: a file (`mysite/settings/dev.py`, relative to
/// the project) becomes its module relative to the working directory; a module stays as it is.
fn settings_module(value: &str, root: &Path, dir: &Path) -> String {
    let Some(stem) = value.strip_suffix(".py") else { return value.to_owned() };
    let file = normalize(&root.join(stem));
    let rel = file.strip_prefix(dir).map(Path::to_path_buf).unwrap_or_else(|_| PathBuf::from(stem));
    rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join(".")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_elements_attributes_and_escapes() {
        let doc = parse(
            "<?xml version=\"1.0\"?>\n<project><component name=\"RunManager\"><configuration name=\"a &amp; b\">\
             <option name=\"SCRIPT_TEXT\" value=\"echo 1&#10;echo 2\" /></configuration></component></project>",
        )
        .unwrap();
        assert_eq!(doc.name, "project");
        let c = &doc.children[0].children[0];
        assert_eq!(c.attr("name"), Some("a & b"));
        assert_eq!(c.option("SCRIPT_TEXT"), Some("echo 1\necho 2"));
        assert!(parse("<a><b></a>").is_err());
    }

    #[test]
    fn file_urls_become_paths_whatever_the_drive_letter_looks_like() {
        // IDEA on Windows: the drive letter sits where the authority belongs.
        assert_eq!(file_url_path("file://C:/p"), "C:/p");
        assert_eq!(file_url_path(r"file://C:\p"), r"C:\p");
        assert_eq!(file_url_path("file:///C:/p"), "C:/p");
        assert_eq!(file_url_path("file:///p/a"), "/p/a");
        assert_eq!(file_url_path("file://server/share"), "//server/share");
        // Not a URL: left alone, including a bare Windows path.
        assert_eq!(file_url_path(r"C:\p"), r"C:\p");
        assert_eq!(file_url_path("/p/a"), "/p/a");
        assert_eq!(file_url_path(""), "");
    }

    #[test]
    fn file_urls_preserve_paths_and_treat_localhost_as_local() {
        for (url, expected) in [
            ("file:///p/100%20", "/p/100%20"),
            ("file:///p/a%E4", "/p/a%E4"),
            ("file:///p/a b/中.py", "/p/a b/中.py"),
            ("file://C:/a b/é", "C:/a b/é"),
            ("file:///C:/a%20b", "C:/a%20b"),
            ("file://localhost/p/a%20b", "/p/a%20b"),
            ("file://localhost/C:/a%20b", "C:/a%20b"),
            ("file://LOCALHOST/p", "/p"),
            ("file://server/share/a%20b", "//server/share/a%20b"),
            ("file:///p/%2520", "/p/%2520"),
            ("/p/a%20b", "/p/a%20b"),
            ("relative%20path", "relative%20path"),
            ("https://localhost/a%20b", "https://localhost/a%20b"),
        ] {
            assert_eq!(file_url_path(url), expected, "{url}");
        }
    }

    /// The property the bug broke: `working_dir` joins its `cwd` onto the project
    /// directory, so a URL that reads as a relative path resolves inside it instead
    /// of replacing it.
    #[test]
    fn file_urls_name_absolute_paths() {
        let absolute = if cfg!(windows) {
            vec!["file://C:/p", "file:///C:/p", r"file://C:\p", "file://server/share"]
        } else {
            vec!["file:///p/a", "file://server/share"]
        };
        for url in absolute {
            let path = file_url_path(url);
            assert!(Path::new(&path).is_absolute(), "{url} became {path:?}, which is not absolute");
        }
    }

    #[test]
    fn env_files_split_on_the_path_separator() {
        assert_eq!(
            split_env_files("$PROJECT_DIR$/.env:$PROJECT_DIR$/.env.local", ':').collect::<Vec<_>>(),
            ["$PROJECT_DIR$/.env", "$PROJECT_DIR$/.env.local"]
        );
        assert_eq!(
            split_env_files(r"C:\p\.env;C:\p\.env.local", ';').collect::<Vec<_>>(),
            [r"C:\p\.env", r"C:\p\.env.local"]
        );
        assert_eq!(
            split_env_files("file://$PROJECT_DIR$/.env:file://localhost/p/a%20b:.env.local", ':').collect::<Vec<_>>(),
            ["file://$PROJECT_DIR$/.env", "file://localhost/p/a%20b", ".env.local"]
        );
        assert_eq!(
            split_env_files("file://C:/p/.env:file:///D:/p/.env:file://localhost/E:/p/.env%3Adev", ':')
                .collect::<Vec<_>>(),
            ["file://C:/p/.env", "file:///D:/p/.env", "file://localhost/E:/p/.env%3Adev"]
        );
        assert_eq!(
            split_env_files("file://C:/p/.env;file://localhost/C:/p/.env.local", ';').collect::<Vec<_>>(),
            ["file://C:/p/.env", "file://localhost/C:/p/.env.local"]
        );
        assert_eq!(split_env_files("", ':').count(), 0);
        assert_eq!(PATH_SEPARATOR, if cfg!(windows) { ';' } else { ':' });
    }

    #[test]
    fn parameters_split_like_idea() {
        let p = |s: &str| parse_params(s, Quotes::Double);
        assert_eq!(p(r"--out C:\p\out \\srv\share"), [r"--out", r"C:\p\out", r"\\srv\share"]);
        assert_eq!(p(r#" a "b c" "" d\"e "f\"g" "#), ["a", "b c", "", r#"d"e"#, r#"f"g"#]);
        assert_eq!(p("'a b'"), ["'a", "b'"]);
        assert_eq!(parse_params("-k 'a b' \"c d\"", Quotes::Single), ["-k", "a b", "c d"]);
        assert!(p("   ").is_empty());
    }

    #[test]
    fn macros_and_settings_modules() {
        let cx =
            Cx { root: Path::new("/p"), home: Some("/home/me".into()), modules: 1, machine_values: Cell::new(false) };
        assert_eq!(cx.expand("$PROJECT_DIR$/src $5 a$b").unwrap(), "/p/src $5 a$b");
        assert_eq!(cx.expand_with("cd $PROJECT_DIR$ && $PATH$", Unknown::Keep).unwrap(), "cd /p && $PATH$");
        assert!(!cx.machine_values.get());
        assert_eq!(dot_slash("run.sh".into()), "./run.sh");
        assert_eq!(dot_slash("../run.sh".into()), "../run.sh");
        assert_eq!(dot_slash("/opt/run.sh".into()), "/opt/run.sh");
        assert_eq!(cx.expand("$USER_HOME$/.venvs").unwrap(), "/home/me/.venvs");
        assert!(cx.machine_values.get());
        assert_eq!(
            cx.expand("$MAVEN_REPOSITORY$/x"),
            Err(SkipReason::PathVariable { variable: "$MAVEN_REPOSITORY$".into() })
        );
        assert_eq!(
            settings_module("src/mysite/settings/dev.py", Path::new("/p"), Path::new("/p/src")),
            "mysite.settings.dev"
        );
        assert_eq!(settings_module("mysite.settings.dev", Path::new("/p"), Path::new("/p")), "mysite.settings.dev");
        assert_eq!(json_string("\"tests\""), "tests");
        let several = Cx { modules: 2, ..cx };
        assert_eq!(
            several.expand("$MODULE_DIR$/x"),
            Err(SkipReason::SeveralModules { variable: "$MODULE_DIR$".into() })
        );
        assert_eq!(several.expand("$PROJECT_DIR$/x").unwrap(), "/p/x");
        assert_eq!(strip_quotes("\"not slow\""), "not slow");
        assert_eq!(strip_quotes("'a or b'"), "a or b");
        assert_eq!(strip_quotes("plain"), "plain");
        assert_eq!(regex_escape("adds 1+1 (sum)"), r"adds 1\+1 \(sum\)");
    }
}
