//! A Java project without a build tool, built from its Project Structure: `javac` compiles
//! the source roots to the module's output folder against the project libraries and the
//! Web facet's `WEB-INF/lib`, and the resources are copied next to the classes; tests the
//! same way into the test output, which also sees the production classes.
use super::*;
use ide_core::settings::{
    ArtifactConfig, ArtifactKind, DependencyScope, ModuleStructureSettings, ProjectStructureSettings,
};
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

/// Whether Rebuild may delete the output folder `dir`: never the project folder or one above
/// it, nor a folder that holds or lies inside a source, test or resource root.
fn deletable_output(dir: &Path, root: &Path, roots: &StructureRoots) -> bool {
    let dir = normalize(dir);
    let overlaps = |r: &PathBuf| {
        let r = normalize(r);
        r.starts_with(&dir) || dir.starts_with(&r)
    };
    !normalize(root).starts_with(&dir)
        && !roots.sources.iter().chain(&roots.tests).chain(&roots.resources).chain(&roots.test_resources).any(overlaps)
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
        let lib = web_root(root, facet).join("WEB-INF").join("lib");
        if lib.is_dir() {
            add(format!("{}{}*", lib.to_string_lossy(), std::path::MAIN_SEPARATOR));
        }
    }
    out
}

/// The web resource folder of a Web facet: its own, else the folder holding `WEB-INF/web.xml`.
fn web_root(root: &Path, facet: &ide_core::settings::FacetConfig) -> PathBuf {
    let dir = facet.web_root.trim();
    let dir = if dir.is_empty() {
        facet.descriptor.trim().replace('\\', "/").strip_suffix("/WEB-INF/web.xml").unwrap_or("").to_owned()
    } else {
        dir.to_owned()
    };
    root.join(dir)
}

/// The class archives and folders of a library path (`lib/*.jar` lists the folder's jars).
fn library_files(root: &Path, value: &str) -> Vec<PathBuf> {
    let entry = class_entry(root, value);
    match entry.strip_suffix('*') {
        Some(dir) => {
            let mut jars: Vec<PathBuf> = fs::read_dir(dir)
                .map(|d| d.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "jar")).collect())
                .unwrap_or_default();
            jars.sort();
            jars
        }
        None => vec![PathBuf::from(entry)],
    }
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
        let dirs: Vec<PathBuf> =
            [&main_out, &test_out].into_iter().filter(|d| deletable_output(d, root, roots)).cloned().collect();
        if !dirs.is_empty() {
            steps.push(BuildStep::action(Action::Clean(dirs), root));
        }
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
    // Artifacts hold production classes only.
    if !test_sources.is_empty() && kind != BuildKind::Artifacts {
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
    if kind == BuildKind::Artifacts {
        if ps.artifacts.is_empty() {
            return Err(IdeError::invalid("No artifacts are configured: add one in Project Structure › Artifacts"));
        }
        for artifact in &ps.artifacts {
            steps.extend(artifact_steps(root, ps, artifact, &main_out, None, cache));
        }
    }
    Ok(Some(BuildPlan { system: BuildSystem::Javac, title: module_name(root), steps }))
}

/// Where an artifact goes: its output folder, else `out/artifacts/<name>`.
pub fn artifact_output(root: &Path, artifact: &ArtifactConfig) -> PathBuf {
    resolve_dir(root, &artifact.output_directory)
        .unwrap_or_else(|| root.join("out").join("artifacts").join(file_name(&artifact.name)))
}

/// An artifact name as a file name (`shop:war exploded` → `shop_war_exploded`).
fn file_name(name: &str) -> String {
    name.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '.' { c } else { '_' }).collect()
}

/// The archive a `jar` / `war` artifact writes (`<output>/<name>.war`), or its folder (exploded).
pub fn artifact_file(root: &Path, artifact: &ArtifactConfig) -> PathBuf {
    let out = artifact_output(root, artifact);
    let base = artifact.name.split(':').next().filter(|n| !n.trim().is_empty()).unwrap_or(&artifact.name);
    match artifact.kind {
        ArtifactKind::Jar => out.join(format!("{}.jar", file_name(base))),
        ArtifactKind::War => out.join(format!("{}.war", file_name(base))),
        ArtifactKind::WarExploded => out,
    }
}

/// The steps laying out one artifact from the module output `classes`; `war`: write a
/// WAR there instead of the artifact's own output (an application server's deployment).
fn artifact_steps(
    root: &Path,
    ps: &ProjectStructureSettings,
    artifact: &ArtifactConfig,
    classes: &Path,
    war: Option<&Path>,
    cache: &Path,
) -> Vec<BuildStep> {
    let libraries: Vec<PathBuf> = ps
        .libraries
        .iter()
        .filter(|l| artifact.include_libraries.contains(&l.name))
        .flat_map(|l| l.classes.iter().flat_map(|c| library_files(root, c)))
        .collect();
    let facet = ps
        .facets
        .iter()
        .filter(|f| f.kind == "web")
        .find(|f| f.module == artifact.module || f.module.is_empty() && artifact.module == ".")
        .or_else(|| ps.facets.iter().find(|f| f.kind == "web"));
    let staging = cache.join("artifacts").join(file_name(&artifact.name));
    // What the last build laid out in a folder the user chose, so the next one replaces only that.
    let record = cache.join("artifacts").join(format!("{}.files", file_name(&artifact.name)));
    let mut steps = Vec::new();
    match (artifact.kind, war) {
        (ArtifactKind::Jar, None) => {
            let out = artifact_output(root, artifact);
            let mut manifest = String::from("Manifest-Version: 1.0\r\n");
            if !artifact.main_class.trim().is_empty() {
                manifest.push_str(&format!("Main-Class: {}\r\n", artifact.main_class.trim()));
            }
            let names: Vec<String> =
                libraries.iter().filter_map(|l| l.file_name()).map(|n| n.to_string_lossy().into_owned()).collect();
            if !names.is_empty() {
                manifest.push_str(&format!("Class-Path: {}\r\n", names.join(" ")));
            }
            steps.push(BuildStep::action(
                Action::Layout {
                    into: staging.clone(),
                    entries: vec![(classes.to_path_buf(), PathBuf::new())],
                    record: None,
                },
                root,
            ));
            // The jar's Class-Path names the libraries next to it.
            steps.push(BuildStep::action(
                Action::Layout {
                    into: out.clone(),
                    entries: libraries.iter().map(|l| (l.clone(), file_of(l))).collect(),
                    record: Some(record),
                },
                root,
            ));
            steps.push(BuildStep::action(
                Action::Archive { from: staging, to: artifact_file(root, artifact), manifest: Some(manifest) },
                root,
            ));
        }
        (kind, war) => {
            let exploded = match (kind, war) {
                (ArtifactKind::WarExploded, None) => artifact_output(root, artifact),
                _ => staging.clone(),
            };
            let mut entries = Vec::new();
            if let Some(facet) = facet {
                entries.push((web_root(root, facet), PathBuf::new()));
            }
            entries.push((classes.to_path_buf(), PathBuf::from("WEB-INF/classes")));
            for lib in &libraries {
                entries.push((lib.clone(), Path::new("WEB-INF/lib").join(file_of(lib))));
            }
            // The exploded output may be a folder the user chose; the staging folder is the IDE's own.
            let record = (exploded != staging).then_some(record);
            steps.push(BuildStep::action(Action::Layout { into: exploded.clone(), entries, record }, root));
            let archive = war
                .map(Path::to_path_buf)
                .or_else(|| (kind != ArtifactKind::WarExploded).then(|| artifact_file(root, artifact)));
            if let Some(to) = archive {
                steps.push(BuildStep::action(Action::Archive { from: exploded, to, manifest: None }, root));
            }
        }
    }
    steps
}

fn file_of(path: &Path) -> PathBuf {
    path.file_name().map(PathBuf::from).unwrap_or_default()
}

/// The WAR artifacts of a project without a build tool: an application server deploys them.
pub fn structure_web_artifacts(ps: &ProjectStructureSettings) -> Vec<&ArtifactConfig> {
    ps.artifacts.iter().filter(|a| matches!(a.kind, ArtifactKind::War | ArtifactKind::WarExploded)).collect()
}

/// A build of `artifact` into the WAR `war` (Tomcat's deployment), compiling first.
#[allow(clippy::too_many_arguments)]
pub fn structure_war_plan(
    root: &Path,
    ps: &ProjectStructureSettings,
    roots: &StructureRoots,
    jdk: Option<&StructureJdk>,
    language_level: &str,
    artifact: &ArtifactConfig,
    war: &Path,
    cache: &Path,
) -> IdeResult<BuildPlan> {
    let mut plan = structure_plan(root, ps, roots, jdk, language_level, BuildKind::Build, cache)?
        .unwrap_or_else(|| BuildPlan { system: BuildSystem::Javac, title: module_name(root), steps: Vec::new() });
    let (main_out, _) = structure_outputs(root, ps);
    // Tests are not part of a deployment.
    plan.steps.retain(|s| !s.args.iter().any(|a| a.ends_with("test.args")));
    plan.steps
        .retain(|s| !matches!(&s.action, Some((Action::CopyResources { to, .. }, _)) if !to.starts_with(&main_out)));
    plan.steps.extend(artifact_steps(root, ps, artifact, &main_out, Some(war), cache));
    plan.title = artifact.name.clone();
    Ok(plan)
}

/// Work a build does in the IDE itself rather than through a tool.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Action {
    /// Deletes these output folders (Rebuild).
    Clean(Vec<PathBuf>),
    /// Copies the files of these folders that are not Java sources into `to`, keeping their
    /// relative paths; files that are already up to date are left alone.
    CopyResources { from: Vec<PathBuf>, to: PathBuf },
    /// Lays out an artifact in `into`: each folder's content or file goes to its relative
    /// place (`""` = the top). What is no longer laid out is removed: without `record`, `into`
    /// is the IDE's own folder and is laid out afresh; with it, `into` is a folder the user chose
    /// and only the files the previous layout recorded there are removed, never anything else.
    Layout { into: PathBuf, entries: Vec<(PathBuf, PathBuf)>, record: Option<PathBuf> },
    /// Zips the folder `from` into the archive `to`, with this manifest first.
    Archive { from: PathBuf, to: PathBuf, manifest: Option<String> },
}

impl Action {
    pub(crate) fn display(&self, root: &Path) -> String {
        let rel = |p: &Path| p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/");
        match self {
            Action::Clean(dirs) => format!("Clean {}", dirs.iter().map(|d| rel(d)).collect::<Vec<_>>().join(", ")),
            Action::CopyResources { to, .. } => format!("Copy resources to {}", rel(to)),
            Action::Layout { into, .. } => format!("Lay out {}", rel(into)),
            Action::Archive { to, .. } => format!("Pack {}", rel(to)),
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
            Action::Layout { into, entries, record } => {
                if entries.iter().any(|(from, _)| from.starts_with(into)) {
                    return Err(IdeError::invalid(format!(
                        "The artifact output folder {} holds files the artifact is made of",
                        into.display()
                    )));
                }
                if record.is_none() && into.exists() {
                    fs::remove_dir_all(into)
                        .map_err(|e| IdeError::internal(format!("cannot delete {} ({e})", into.display())))?;
                }
                let mut written = Vec::new();
                for (from, to) in entries {
                    let target = into.join(to);
                    // The folders of the output it goes into (and a folder entry's own) are
                    // never links; a file in a link's place replaces the link.
                    let mut at = into.to_path_buf();
                    let folders = to.components().count().saturating_sub(usize::from(!from.is_dir()));
                    for c in to.components().take(folders) {
                        at.push(c);
                        refuse_link(&at)?;
                    }
                    if from.is_dir() {
                        copy_tree(from, &target, &mut written, cancel)?;
                    } else if from.is_file() {
                        copy_file(from, &target)?;
                        written.push(target);
                    }
                }
                if let Some(record) = record {
                    replace_recorded(into, record, &written)?;
                }
                Ok(format!("{} file(s) laid out", written.len()))
            }
            Action::Archive { from, to, manifest } => {
                archive(from, to, manifest.as_deref(), cancel)?;
                Ok(format!("Wrote {}", to.display()))
            }
        }
    }
}

fn copy_file(from: &Path, to: &Path) -> IdeResult<()> {
    // A link in the artifact's place is replaced, not written through.
    if fs::symlink_metadata(to).is_ok_and(|m| m.file_type().is_symlink()) {
        fs::remove_file(to).map_err(|e| IdeError::internal(format!("cannot replace {} ({e})", to.display())))?;
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| IdeError::internal(format!("cannot create {} ({e})", parent.display())))?;
    }
    fs::copy(from, to).map_err(|e| IdeError::internal(format!("cannot copy {} ({e})", from.display())))?;
    Ok(())
}

fn refuse_link(folder: &Path) -> IdeResult<()> {
    if fs::symlink_metadata(folder).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(IdeError::invalid(format!(
            "{} links to another folder; the artifact is not laid out through it",
            folder.display()
        )));
    }
    Ok(())
}

fn copy_tree(from: &Path, to: &Path, written: &mut Vec<PathBuf>, cancel: &CancellationToken) -> IdeResult<()> {
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    let Ok(entries) = fs::read_dir(from) else { return Ok(()) };
    for e in entries.flatten() {
        let Ok(t) = e.file_type() else { continue };
        let target = to.join(e.file_name());
        if t.is_dir() {
            refuse_link(&target)?;
            copy_tree(&e.path(), &target, written, cancel)?;
        } else if t.is_file() {
            copy_file(&e.path(), &target)?;
            written.push(target);
        }
    }
    Ok(())
}

/// Removes the files the previous layout recorded in `into` that this one didn't write
/// (and the folders that leaves empty), then records `written` for the next layout.
fn replace_recorded(into: &Path, record: &Path, written: &[PathBuf]) -> IdeResult<()> {
    let now: std::collections::HashSet<PathBuf> =
        written.iter().filter_map(|p| p.strip_prefix(into).ok().map(Path::to_path_buf)).collect();
    let before = fs::read_to_string(record).unwrap_or_default();
    let mut lines = before.lines();
    // The record names its folder first: one made for another output folder removes nothing.
    let same = lines.next().is_some_and(|dir| Path::new(dir) == into);
    for rel in lines.filter(|_| same).map(PathBuf::from) {
        // Only plain relative paths inside `into`: a damaged record must not reach elsewhere.
        if rel.as_os_str().is_empty()
            || now.contains(&rel)
            || rel.components().any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            continue;
        }
        let file = into.join(&rel);
        // Never through a link: a folder of the output that now links elsewhere (or a file that
        // is a link) leads out of what the layout wrote.
        let mut at = into.to_path_buf();
        let linked = rel.components().any(|c| {
            at.push(c);
            fs::symlink_metadata(&at).is_ok_and(|m| m.file_type().is_symlink())
        });
        if !linked && file.is_file() {
            let _ = fs::remove_file(&file);
            let mut dir = file.parent();
            while let Some(d) = dir.filter(|d| *d != into && d.starts_with(into)) {
                if fs::remove_dir(d).is_err() {
                    break;
                }
                dir = d.parent();
            }
        }
    }
    let mut list: Vec<String> = now.iter().map(|p| p.to_string_lossy().into_owned()).collect();
    list.sort();
    list.insert(0, into.to_string_lossy().into_owned());
    if let Some(parent) = record.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| IdeError::internal(format!("cannot create {} ({e})", parent.display())))?;
    }
    fs::write(record, list.join("\n"))
        .map_err(|e| IdeError::internal(format!("cannot write {} ({e})", record.display())))
}

fn archive(from: &Path, to: &Path, manifest: Option<&str>, cancel: &CancellationToken) -> IdeResult<()> {
    use std::io::Write;
    let err = |e: &dyn std::fmt::Display| IdeError::internal(format!("cannot write {} ({e})", to.display()));
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|e| err(&e))?;
    }
    let mut zip = zip::ZipWriter::new(fs::File::create(to).map_err(|e| err(&e))?);
    let options = zip::write::SimpleFileOptions::default();
    if let Some(manifest) = manifest {
        zip.add_directory("META-INF/", options).map_err(|e| err(&e))?;
        zip.start_file("META-INF/MANIFEST.MF", options).map_err(|e| err(&e))?;
        zip.write_all(manifest.as_bytes()).map_err(|e| err(&e))?;
    }
    let mut stack = vec![from.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let path = e.path();
            let name = path.strip_prefix(from).unwrap_or(&path).to_string_lossy().replace('\\', "/");
            if manifest.is_some() && name.eq_ignore_ascii_case("META-INF/MANIFEST.MF") {
                continue;
            }
            match e.file_type() {
                Ok(t) if t.is_dir() => {
                    if !(manifest.is_some() && name == "META-INF") {
                        zip.add_directory(format!("{name}/"), options).map_err(|e| err(&e))?;
                    }
                    stack.push(path);
                }
                Ok(t) if t.is_file() => {
                    zip.start_file(name, options).map_err(|e| err(&e))?;
                    let mut file = fs::File::open(&path).map_err(|e| err(&e))?;
                    std::io::copy(&mut file, &mut zip).map_err(|e| err(&e))?;
                }
                _ => {}
            }
        }
    }
    zip.finish().map_err(|e| err(&e))?;
    Ok(())
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
        assert!(Path::new(entries[0]).ends_with("lib/*"));
        assert!(Path::new(entries[1]).ends_with("WEB-INF/lib/*"));
        assert!(javac.args.windows(2).any(|w| w == ["--release", "17"]));
        let args = fs::read_to_string(tmp.path().join("cache/javac/production.args")).unwrap();
        assert!(args.contains("A.java") && !args.contains("ATest.java"));
        assert_eq!(shown[2], "Copy resources to out/production/shop");
        let test = &plan.steps[3];
        let test_cp = cp(test);
        assert_eq!(Path::new(test_cp.split(sep).next().unwrap()), root.join("out/production/shop"));
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
        assert!(
            javac.args.windows(2).any(|w| w[0] == "-d" && Path::new(&w[1]).ends_with("build/classes/production/p"))
        );
    }

    #[test]
    fn rebuild_never_cleans_an_output_folder_over_the_project_or_its_sources() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("p");
        write(&root.join("src/A.java"), "class A {}");
        let roots = StructureRoots { sources: vec![root.join("src")], ..Default::default() };
        for (main, test) in [(".", "bin"), ("src", "src/../test-out"), ("src/classes", ".."), ("", "")] {
            let mut ps = ProjectStructureSettings::default();
            ps.modules.insert(
                ".".into(),
                ModuleStructureSettings {
                    compiler_output: main.into(),
                    test_compiler_output: test.into(),
                    ..Default::default()
                },
            );
            let plan = structure_plan(&root, &ps, &roots, None, "17", BuildKind::Rebuild, &tmp.path().join("c"))
                .unwrap()
                .unwrap();
            let clean: Vec<String> =
                plan.steps.iter().map(BuildStep::display).filter(|s| s.starts_with("Clean")).collect();
            let expected: &[&str] = match main {
                "." => &["Clean bin"],
                "src" => &["Clean src/../test-out"],
                "src/classes" => &[],
                _ => &["Clean out/production/p, out/test/p"],
            };
            assert_eq!(clean, expected, "{main} / {test}");
        }
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

    fn entries(archive: &Path) -> Vec<String> {
        let mut zip = zip::ZipArchive::new(fs::File::open(archive).unwrap()).unwrap();
        (0..zip.len()).map(|i| zip.by_index(i).unwrap().name().unwrap().into_owned()).collect()
    }

    fn run_plan(plan: &BuildPlan) {
        let cancel = CancellationToken::new();
        for step in &plan.steps {
            if let Some((action, _)) = &step.action {
                action.run(&cancel).unwrap();
            }
        }
    }

    #[test]
    fn lays_out_war_jar_and_exploded_artifacts() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("shop");
        write(&root.join("WebRoot/index.jsp"), "hi");
        write(&root.join("WebRoot/WEB-INF/web.xml"), "<web-app/>");
        write(&root.join("WebRoot/WEB-INF/lib/inside.jar"), "");
        write(&root.join("lib/extra.jar"), "");
        let classes = root.join("out/production/shop");
        write(&classes.join("com/a/A.class"), "");
        let artifact = |name: &str, kind| ArtifactConfig {
            name: name.into(),
            kind,
            module: ".".into(),
            include_libraries: vec!["extra".into()],
            main_class: "com.a.A".into(),
            ..Default::default()
        };
        let ps = ProjectStructureSettings {
            libraries: vec![ProjectLibrary {
                name: "extra".into(),
                classes: vec!["lib/*.jar".into()],
                ..Default::default()
            }],
            facets: vec![FacetConfig {
                kind: "web".into(),
                module: ".".into(),
                descriptor: "WebRoot/WEB-INF/web.xml".into(),
                web_root: String::new(),
            }],
            artifacts: vec![
                artifact("shop:war", ArtifactKind::War),
                artifact("shop:war exploded", ArtifactKind::WarExploded),
                artifact("shop:jar", ArtifactKind::Jar),
            ],
            ..Default::default()
        };
        let cache = tmp.path().join("cache");
        for a in &ps.artifacts {
            let plan = BuildPlan {
                system: BuildSystem::Javac,
                title: String::new(),
                steps: artifact_steps(&root, &ps, a, &classes, None, &cache),
            };
            run_plan(&plan);
        }
        let war = entries(&root.join("out/artifacts/shop_war/shop.war"));
        for name in [
            "index.jsp",
            "WEB-INF/web.xml",
            "WEB-INF/lib/inside.jar",
            "WEB-INF/lib/extra.jar",
            "WEB-INF/classes/com/a/A.class",
        ] {
            assert!(war.iter().any(|e| e == name), "{name} in {war:?}");
        }
        let exploded = root.join("out/artifacts/shop_war_exploded");
        assert!(exploded.join("WEB-INF/classes/com/a/A.class").is_file());
        assert!(exploded.join("WEB-INF/lib/extra.jar").is_file());
        let jar_dir = root.join("out/artifacts/shop_jar");
        let jar = entries(&jar_dir.join("shop.jar"));
        assert_eq!(jar[..2], ["META-INF/".to_owned(), "META-INF/MANIFEST.MF".to_owned()]);
        assert!(jar.iter().any(|e| e == "com/a/A.class"));
        assert!(jar_dir.join("extra.jar").is_file());
        let mut zip = zip::ZipArchive::new(fs::File::open(jar_dir.join("shop.jar")).unwrap()).unwrap();
        let mut manifest = String::new();
        std::io::Read::read_to_string(&mut zip.by_name("META-INF/MANIFEST.MF").unwrap(), &mut manifest).unwrap();
        assert!(manifest.contains("Main-Class: com.a.A") && manifest.contains("Class-Path: extra.jar"));
    }

    #[test]
    fn never_lays_out_over_its_own_sources() {
        let tmp = tempfile::tempdir().unwrap();
        let web = tmp.path().join("WebRoot");
        write(&web.join("a.jsp"), "");
        let action = Action::Layout {
            into: tmp.path().to_path_buf(),
            entries: vec![(web.clone(), PathBuf::new())],
            record: None,
        };
        assert!(action.run(&CancellationToken::new()).is_err());
        assert!(web.join("a.jsp").is_file());
    }

    #[test]
    fn a_chosen_output_folder_keeps_what_the_artifact_did_not_put_there() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("project");
        write(&project.join("src/A.java"), "class A {}");
        write(&project.join(".git/HEAD"), "ref: refs/heads/main");
        let libs = tmp.path().join("libs");
        write(&libs.join("a.jar"), "a");
        write(&libs.join("b.jar"), "b");
        let record = tmp.path().join("cache/artifacts/app.files");
        let layout = |names: &[&str]| Action::Layout {
            into: project.clone(),
            entries: names.iter().map(|n| (libs.join(n), PathBuf::from(n))).collect(),
            record: Some(record.clone()),
        };
        layout(&["a.jar", "b.jar"]).run(&CancellationToken::new()).unwrap();
        assert!(project.join("a.jar").is_file() && project.join("b.jar").is_file());
        // A library dropped from the artifact goes; the project's own files stay.
        layout(&["a.jar"]).run(&CancellationToken::new()).unwrap();
        assert!(project.join("a.jar").is_file() && !project.join("b.jar").exists());
        assert!(project.join("src/A.java").is_file() && project.join(".git/HEAD").is_file());
        // A damaged record never reaches outside the folder.
        write(&record, &format!("{}\n../outside.txt", project.display()));
        write(&tmp.path().join("outside.txt"), "x");
        layout(&["a.jar"]).run(&CancellationToken::new()).unwrap();
        assert!(tmp.path().join("outside.txt").is_file());
        // Nor through a folder of the output that now links elsewhere.
        #[cfg(unix)]
        {
            write(&project.join("assets/x.txt"), "laid out");
            write(&record, &format!("{}\nassets/x.txt", project.display()));
            fs::remove_dir_all(project.join("assets")).unwrap();
            std::os::unix::fs::symlink(project.join("src"), project.join("assets")).unwrap();
            write(&project.join("src/x.txt"), "source");
            layout(&["a.jar"]).run(&CancellationToken::new()).unwrap();
            assert!(project.join("src/x.txt").is_file());
        }
        // An entry's own folder that links elsewhere stops the layout instead of copying through it.
        #[cfg(unix)]
        {
            fs::remove_file(project.join("assets")).unwrap();
            std::os::unix::fs::symlink(project.join("src"), project.join("classes")).unwrap();
            write(&tmp.path().join("out/A.class"), "compiled");
            let into_link = Action::Layout {
                into: project.clone(),
                entries: vec![(tmp.path().join("out"), PathBuf::from("classes"))],
                record: Some(record.clone()),
            };
            assert!(into_link.run(&CancellationToken::new()).is_err());
            assert!(!project.join("src/A.class").exists());
            fs::remove_file(project.join("classes")).unwrap();
        }
        // Nor does one made for another output folder.
        write(&project.join("c.jar"), "mine");
        write(&record, "/elsewhere\nc.jar");
        layout(&["a.jar"]).run(&CancellationToken::new()).unwrap();
        assert!(project.join("c.jar").is_file());
    }
}
