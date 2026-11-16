//! A Java project without a build tool, built from its Project Structure: `javac` compiles
//! the source roots to the module's output folder against the project libraries and the
//! Web facet's `WEB-INF/lib`, and the resources are copied next to the classes; tests the
//! same way into the test output, which also sees the production classes.
use super::*;
use ide_core::settings::{DependencyScope, ModuleStructureSettings, ProjectStructureSettings};
use std::fs;

/// The roots of the project as the IDE resolved them (absolute folders).
#[derive(Clone, Debug, Default)]
pub struct StructureRoots {
    pub sources: Vec<PathBuf>,
    pub tests: Vec<PathBuf>,
    pub resources: Vec<PathBuf>,
    pub test_resources: Vec<PathBuf>,
    pub excluded: Vec<PathBuf>,
}

/// The JDK compiling the project.
#[derive(Clone, Debug)]
pub struct StructureJdk {
    pub home: PathBuf,
    pub major: u32,
}

/// Where the project's classes go: `<compiler output>/production/<module>` and
/// `<compiler output>/test/<module>` (`out` by default), unless the module names its own.
pub fn structure_outputs(root: &Path, ps: &ProjectStructureSettings) -> (PathBuf, PathBuf) {
    let module = root_module(root, ps);
    let name = module_name(root);
    let base = resolve_dir(root, &ps.compiler_output).unwrap_or_else(|| root.join("out"));
    let main = module
        .and_then(|m| resolve_dir(root, &m.compiler_output))
        .unwrap_or_else(|| base.join("production").join(&name));
    let test = module
        .and_then(|m| resolve_dir(root, &m.test_compiler_output))
        .unwrap_or_else(|| base.join("test").join(&name));
    (main, test)
}

fn module_name(root: &Path) -> String {
    root.file_name().map_or_else(|| "project".to_owned(), |n| n.to_string_lossy().into_owned())
}

fn root_module<'a>(root: &Path, ps: &'a ProjectStructureSettings) -> Option<&'a ModuleStructureSettings> {
    ps.modules.get(".").or_else(|| ps.module_settings(root, root))
}

fn resolve_dir(root: &Path, value: &str) -> Option<PathBuf> {
    let value = value.trim();
    (!value.is_empty()).then(|| root.join(value))
}

/// `.java` files below `dir`, not inside an excluded folder or another root of `skip`.
fn java_files(dir: &Path, excluded: &[PathBuf], out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let path = e.path();
        match e.file_type() {
            Ok(t) if t.is_dir() => {
                if !excluded.iter().any(|x| path.starts_with(x)) {
                    java_files(&path, excluded, out);
                }
            }
            Ok(t) if t.is_file() && path.extension().is_some_and(|x| x == "java") => out.push(path),
            _ => {}
        }
    }
}

/// Folders and archives of the libraries a module compiles against, for `scope`.
fn library_entries(root: &Path, ps: &ProjectStructureSettings, test: bool) -> Vec<String> {
    let wanted = |scope: DependencyScope| match scope {
        DependencyScope::Compile | DependencyScope::Provided => true,
        DependencyScope::Test => test,
        DependencyScope::Runtime => false,
    };
    let mut out: Vec<String> = Vec::new();
    let mut add = |entry: String| {
        if !out.contains(&entry) {
            out.push(entry);
        }
    };
    let module_deps = root_module(root, ps).map(|m| m.dependencies.as_slice()).unwrap_or_default();
    for lib in &ps.libraries {
        // A library a module dependency names takes that dependency's scope.
        let scope =
            module_deps.iter().find(|d| d.kind == "library" && d.target == lib.name).map_or(lib.scope, |d| d.scope);
        if wanted(scope) {
            for class in &lib.classes {
                add(class_entry(root, class));
            }
        }
    }
    for dep in module_deps.iter().filter(|d| d.kind == "library" && wanted(d.scope)) {
        if !ps.libraries.iter().any(|l| l.name == dep.target) && !dep.target.trim().is_empty() {
            add(class_entry(root, &dep.target));
        }
    }
    for facet in ps.facets.iter().filter(|f| f.kind == "web") {
        let web_root = if facet.web_root.trim().is_empty() {
            facet.descriptor.trim().strip_suffix("/WEB-INF/web.xml").unwrap_or("").to_owned()
        } else {
            facet.web_root.trim().to_owned()
        };
        let lib = root.join(&web_root).join("WEB-INF").join("lib");
        if lib.is_dir() {
            add(format!("{}{}*", lib.to_string_lossy(), std::path::MAIN_SEPARATOR));
        }
    }
    out
}

/// A classpath entry for a library path: a folder of jars (`lib/*`) stays a wildcard javac expands.
fn class_entry(root: &Path, value: &str) -> String {
    let path = root.join(value.trim());
    let text = path.to_string_lossy().into_owned();
    if text.ends_with("/*.jar") || text.ends_with("\\*.jar") {
        return text[..text.len() - 4].to_owned();
    }
    text
}

fn classpath(entries: &[String]) -> String {
    entries.join(if cfg!(windows) { ";" } else { ":" })
}

/// `--release N` from JDK 9 on; older compilers only know `-source` / `-target`.
fn release_args(level: Option<u32>, jdk: Option<&StructureJdk>) -> Vec<String> {
    let Some(level) = level else { return Vec::new() };
    if jdk.is_none_or(|j| j.major >= 9) {
        vec!["--release".into(), level.to_string()]
    } else {
        vec!["-source".into(), format!("1.{level}"), "-target".into(), format!("1.{level}")]
    }
}

/// `"17"`, `"1.8"`, `"JDK_17"` → the release number.
pub fn language_release(level: &str) -> Option<u32> {
    let digits = level.trim().trim_start_matches("JDK_").trim_start_matches("jdk").replace('_', ".");
    let digits = digits.strip_prefix("1.").unwrap_or(&digits);
    digits.split(['.', ' ']).next()?.parse().ok().filter(|n| *n > 0)
}

/// The Build / Rebuild plan of a project without a build tool, or `None` when it has no
/// Java sources under its source roots. `language_level`: the project's, unless the module
/// overrides it. Writes the javac argument files below `cache`.
pub fn structure_plan(
    root: &Path,
    ps: &ProjectStructureSettings,
    roots: &StructureRoots,
    jdk: Option<&StructureJdk>,
    language_level: &str,
    kind: BuildKind,
    cache: &Path,
) -> IdeResult<Option<BuildPlan>> {
    let mut main_sources = Vec::new();
    for dir in &roots.sources {
        java_files(dir, &roots.excluded, &mut main_sources);
    }
    let mut test_sources = Vec::new();
    for dir in &roots.tests {
        java_files(dir, &roots.excluded, &mut test_sources);
    }
    if main_sources.is_empty() && test_sources.is_empty() {
        return Ok(None);
    }
    let (main_out, test_out) = structure_outputs(root, ps);
    let module = root_module(root, ps);
    let level = module
        .map(|m| m.language_level.as_str())
        .filter(|l| !l.trim().is_empty())
        .or(Some(language_level))
        .and_then(language_release);
    let env: BTreeMap<String, String> = jdk
        .map(|j| BTreeMap::from([("JAVA_HOME".to_owned(), j.home.to_string_lossy().into_owned())]))
        .unwrap_or_default();
    let javac = find_javac(&env);
    let args_dir = cache.join("javac");
    fs::create_dir_all(&args_dir)
        .map_err(|e| IdeError::internal(format!("cannot create {} ({e})", args_dir.display())))?;

    let mut steps = Vec::new();
    if kind == BuildKind::Rebuild {
        steps.push(BuildStep::action(Action::Clean(vec![main_out.clone(), test_out.clone()]), root));
    }
    let main_cp = library_entries(root, ps, false);
    let compile = |name: &str, sources: &[PathBuf], out: &Path, cp: &[String]| -> IdeResult<BuildStep> {
        let args_file = args_dir.join(format!("{name}.args"));
        // One quoted path per line: the sources outgrow a command line quickly.
        let text: String = sources
            .iter()
            .map(|p| format!("\"{}\"\n", p.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"")))
            .collect();
        fs::write(&args_file, text)
            .map_err(|e| IdeError::internal(format!("cannot write {} ({e})", args_file.display())))?;
        let mut step = BuildStep::new(&javac, &[], root, Format::Gradle);
        step.args.extend(["-encoding".into(), "UTF-8".into(), "-g".into()]);
        step.args.extend(["-d".into(), out.to_string_lossy().into_owned()]);
        if !cp.is_empty() {
            step.args.extend(["-cp".into(), classpath(cp)]);
        }
        step.args.extend(release_args(level, jdk));
        step.args.push(format!("@{}", args_file.to_string_lossy()));
        step.env = env.clone();
        step.mkdirs = vec![out.to_path_buf()];
        Ok(step)
    };
    if !main_sources.is_empty() {
        steps.push(compile("production", &main_sources, &main_out, &main_cp)?);
    }
    steps.push(BuildStep::action(
        Action::CopyResources {
            from: roots.sources.iter().chain(&roots.resources).cloned().collect(),
            to: main_out.clone(),
        },
        root,
    ));
    if !test_sources.is_empty() {
        let mut test_cp = vec![main_out.to_string_lossy().into_owned()];
        test_cp.extend(library_entries(root, ps, true));
        steps.push(compile("test", &test_sources, &test_out, &test_cp)?);
        steps.push(BuildStep::action(
            Action::CopyResources {
                from: roots.tests.iter().chain(&roots.test_resources).cloned().collect(),
                to: test_out.clone(),
            },
            root,
        ));
    }
    Ok(Some(BuildPlan { system: BuildSystem::Javac, title: module_name(root), steps }))
}

/// Work a build does in the IDE itself rather than through a tool.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Action {
    /// Deletes these output folders (Rebuild).
    Clean(Vec<PathBuf>),
    /// Copies the files of these folders that are not Java sources into `to`, keeping their
    /// relative paths; files that are already up to date are left alone.
    CopyResources { from: Vec<PathBuf>, to: PathBuf },
}

impl Action {
    pub(crate) fn display(&self, root: &Path) -> String {
        let rel = |p: &Path| p.strip_prefix(root).unwrap_or(p).to_string_lossy().into_owned();
        match self {
            Action::Clean(dirs) => format!("Clean {}", dirs.iter().map(|d| rel(d)).collect::<Vec<_>>().join(", ")),
            Action::CopyResources { to, .. } => format!("Copy resources to {}", rel(to)),
        }
    }

    /// Runs the action; the text is a summary for the console.
    pub(crate) fn run(&self, cancel: &CancellationToken) -> IdeResult<String> {
        match self {
            Action::Clean(dirs) => {
                for dir in dirs.iter().filter(|d| d.exists()) {
                    fs::remove_dir_all(dir)
                        .map_err(|e| IdeError::internal(format!("cannot delete {} ({e})", dir.display())))?;
                }
                Ok(String::new())
            }
            Action::CopyResources { from, to } => {
                let mut copied = 0;
                for dir in from {
                    copied += copy_resources(dir, dir, to, cancel)?;
                }
                Ok(format!("{copied} resource file(s) copied"))
            }
        }
    }
}

fn copy_resources(base: &Path, dir: &Path, to: &Path, cancel: &CancellationToken) -> IdeResult<usize> {
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    let Ok(entries) = fs::read_dir(dir) else { return Ok(0) };
    let mut copied = 0;
    for e in entries.flatten() {
        let path = e.path();
        let Ok(t) = e.file_type() else { continue };
        if t.is_dir() {
            // The output folder can sit inside a source root (`src` holding `classes`).
            if path != to && !path.starts_with(to) {
                copied += copy_resources(base, &path, to, cancel)?;
            }
            continue;
        }
        if !t.is_file() || path.extension().is_some_and(|x| x == "java") {
            continue;
        }
        let target = to.join(path.strip_prefix(base).unwrap_or(&path));
        let newer =
            match (fs::metadata(&path).and_then(|m| m.modified()), fs::metadata(&target).and_then(|m| m.modified())) {
                (Ok(source), Ok(existing)) => source > existing,
                _ => true,
            };
        if newer {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| IdeError::internal(format!("cannot create {} ({e})", parent.display())))?;
            }
            fs::copy(&path, &target)
                .map_err(|e| IdeError::internal(format!("cannot copy {} ({e})", path.display())))?;
            copied += 1;
        }
    }
    Ok(copied)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::settings::{FacetConfig, ModuleDependency, ProjectLibrary};

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn reads_language_levels() {
        assert_eq!(language_release("17"), Some(17));
        assert_eq!(language_release("1.8"), Some(8));
        assert_eq!(language_release("JDK_11"), Some(11));
        assert_eq!(language_release(""), None);
    }

    #[test]
    fn plans_javac_over_source_roots_with_libraries_and_web_lib() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("shop");
        write(&root.join("src/com/a/A.java"), "package com.a; class A {}");
        write(&root.join("src/com/a/app.properties"), "x=1");
        write(&root.join("test/com/a/ATest.java"), "package com.a; class ATest {}");
        write(&root.join("WebRoot/WEB-INF/web.xml"), "<web-app/>");
        write(&root.join("WebRoot/WEB-INF/lib/x.jar"), "");
        let ps = ProjectStructureSettings {
            libraries: vec![
                ProjectLibrary { name: "tools".into(), classes: vec!["lib/*.jar".into()], ..Default::default() },
                ProjectLibrary {
                    name: "junit".into(),
                    classes: vec!["junit.jar".into()],
                    scope: DependencyScope::Test,
                    ..Default::default()
                },
            ],
            facets: vec![FacetConfig {
                kind: "web".into(),
                module: ".".into(),
                descriptor: "WebRoot/WEB-INF/web.xml".into(),
                web_root: String::new(),
            }],
            ..Default::default()
        };
        let roots =
            StructureRoots { sources: vec![root.join("src")], tests: vec![root.join("test")], ..Default::default() };
        let jdk = StructureJdk { home: PathBuf::from("/jdk"), major: 21 };
        let plan = structure_plan(&root, &ps, &roots, Some(&jdk), "17", BuildKind::Rebuild, &tmp.path().join("cache"))
            .unwrap()
            .unwrap();
        assert_eq!(plan.system, BuildSystem::Javac);
        let shown: Vec<String> = plan.steps.iter().map(BuildStep::display).collect();
        assert_eq!(shown[0], "Clean out/production/shop, out/test/shop");
        let javac = &plan.steps[1];
        let cp = |s: &BuildStep| s.args[s.args.iter().position(|a| a == "-cp").unwrap() + 1].clone();
        let sep = if cfg!(windows) { ";" } else { ":" };
        let main_cp = cp(javac);
        let entries: Vec<&str> = main_cp.split(sep).collect();
        assert_eq!(entries.len(), 2, "{main_cp}");
        assert!(entries[0].ends_with("lib/*"));
        assert!(entries[1].ends_with("WEB-INF/lib/*"));
        assert!(javac.args.windows(2).any(|w| w == ["--release", "17"]));
        let args = fs::read_to_string(tmp.path().join("cache/javac/production.args")).unwrap();
        assert!(args.contains("A.java") && !args.contains("ATest.java"));
        assert_eq!(shown[2], "Copy resources to out/production/shop");
        let test = &plan.steps[3];
        let test_cp = cp(test);
        assert!(test_cp.starts_with(&root.join("out/production/shop").to_string_lossy().into_owned()));
        assert!(test_cp.contains("junit.jar"));
    }

    #[test]
    fn a_module_dependency_gives_its_library_a_scope_and_jdk_8_gets_source_and_target() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("p");
        write(&root.join("src/A.java"), "class A {}");
        let mut ps = ProjectStructureSettings {
            libraries: vec![ProjectLibrary {
                name: "junit".into(),
                classes: vec!["junit.jar".into()],
                ..Default::default()
            }],
            compiler_output: "build/classes".into(),
            ..Default::default()
        };
        ps.modules.insert(
            ".".into(),
            ModuleStructureSettings {
                language_level: "1.8".into(),
                dependencies: vec![ModuleDependency {
                    kind: "library".into(),
                    target: "junit".into(),
                    scope: DependencyScope::Test,
                    exported: false,
                }],
                ..Default::default()
            },
        );
        let roots = StructureRoots { sources: vec![root.join("src")], ..Default::default() };
        let jdk = StructureJdk { home: PathBuf::from("/jdk8"), major: 8 };
        let plan = structure_plan(&root, &ps, &roots, Some(&jdk), "21", BuildKind::Build, &tmp.path().join("c"))
            .unwrap()
            .unwrap();
        let javac = &plan.steps[0];
        assert!(!javac.args.iter().any(|a| a == "-cp"), "{:?}", javac.args);
        assert!(javac.args.windows(4).any(|w| w == ["-source", "1.8", "-target", "1.8"]));
        assert!(javac.args.windows(2).any(|w| w[0] == "-d" && w[1].ends_with("build/classes/production/p")));
    }

    #[test]
    fn no_plan_without_java_sources() {
        let tmp = tempfile::tempdir().unwrap();
        let roots = StructureRoots { sources: vec![tmp.path().join("src")], ..Default::default() };
        let plan =
            structure_plan(tmp.path(), &Default::default(), &roots, None, "", BuildKind::Build, &tmp.path().join("c"));
        assert!(plan.unwrap().is_none());
    }

    #[test]
    fn copies_resources_but_not_sources_and_skips_up_to_date_files() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        write(&src.join("a/A.java"), "class A {}");
        write(&src.join("a/x.xml"), "<x/>");
        let out = tmp.path().join("out");
        let action = Action::CopyResources { from: vec![src], to: out.clone() };
        let cancel = CancellationToken::new();
        assert_eq!(action.run(&cancel).unwrap(), "1 resource file(s) copied");
        assert!(out.join("a/x.xml").is_file() && !out.join("a/A.java").exists());
        assert_eq!(action.run(&cancel).unwrap(), "0 resource file(s) copied");
        Action::Clean(vec![out.clone()]).run(&cancel).unwrap();
        assert!(!out.exists());
    }
}
