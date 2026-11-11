//! Metadata fingerprints for successful Maven launch builds.
use super::*;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::time::SystemTime;

/// `(byte length, mtime, blake3 hex)`; the hash is recorded for files inside the project only.
type Stamp = (u64, SystemTime, Option<String>);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaunchFingerprint {
    version: u32,
    parameters: String,
    /// Per input: a [`Stamp`] for regular files, `None` for
    /// directories and inputs that cannot be resolved. The content hash catches external
    /// edits that preserve both length and mtime (timestamp-preserving tools, coarse
    /// timestamp granularity), which `(length, mtime)` alone would miss. Only files inside
    /// the project are hashed; toolchain inputs such as the JDK's `lib/modules` keep the stamp.
    files: BTreeMap<PathBuf, Option<Stamp>>,
}

/// `blake3` hex of a file's bytes, streamed in chunks so memory stays bounded. An
/// unreadable file records a sentinel so one permission problem does not drop the whole
/// fingerprint (that would just force a normal rebuild).
fn content_hash(path: &Path) -> IdeResult<String> {
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok("missing".into()),
        Err(e) => return Err(e.into()),
    };
    let mut hasher = blake3::Hasher::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hasher.finalize().to_hex().to_string())
}

fn scan(
    root: &Path,
    path: &Path,
    files: &mut BTreeMap<PathBuf, Option<Stamp>>,
    ancestors: &mut HashSet<PathBuf>,
    cancel: &CancellationToken,
) -> IdeResult<()> {
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    let meta = match fs::metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            files.insert(path.to_path_buf(), None);
            return Ok(());
        }
        Err(e) => return Err(e.into()),
    };
    if meta.is_dir() {
        let canonical = dunce::canonicalize(path)?;
        if !ancestors.insert(canonical.clone()) {
            return Err(IdeError::internal("cyclic launch input directory"));
        }
        // Directory mtimes change on irrelevant JDT writes. File paths detect additions/deletions.
        files.insert(path.to_path_buf(), None);
        for entry in fs::read_dir(path)? {
            scan(root, &entry?.path(), files, ancestors, cancel)?;
        }
        ancestors.remove(&canonical);
    } else if meta.is_file() {
        let hash = if path.starts_with(root) { Some(content_hash(path)?) } else { None };
        files.insert(path.to_path_buf(), Some((meta.len(), meta.modified()?, hash)));
    } else {
        return Err(IdeError::internal("unsupported launch input file"));
    }
    Ok(())
}

/// One planned step as fingerprinted: resolved program, args, cwd and env.
type StepFingerprint = (PathBuf, Vec<String>, PathBuf, BTreeMap<String, String>);

/// Environment, planned steps and input paths shared by every Maven build
/// fingerprint: the filtered process environment plus the wrapper, settings
/// and JDK files the planned invocation reads.
struct Collected {
    inputs: Vec<PathBuf>,
    environment: BTreeMap<String, String>,
    steps: Vec<StepFingerprint>,
    inherited_hash: u64,
}

fn collect(
    root: &Path,
    projects: &[&maven::MavenProject],
    plan: &BuildPlan,
    local_repo: Option<PathBuf>,
) -> IdeResult<Option<Collected>> {
    let Some(mut inputs) = maven::launch_inputs(root, projects, local_repo) else { return Ok(None) };
    let mut environment: BTreeMap<String, String> = std::env::vars()
        .map(|(key, value)| (key.to_ascii_uppercase(), value))
        .filter(|(key, _)| {
            key.starts_with("MAVEN_")
                || key.starts_with("JAVA_")
                || key.starts_with("JDK_")
                || matches!(
                    key.as_str(),
                    "PATH" | "HOME" | "LANG" | "LC_ALL" | "_JAVA_OPTIONS" | "M2_HOME" | "MAVEN_HOME"
                )
        })
        .collect();
    // Explicit step values override the inherited environment just as they do in Command.
    for step in &plan.steps {
        environment.extend(step.env.iter().map(|(key, value)| (key.to_ascii_uppercase(), value.clone())));
        for dir in step.cwd.ancestors() {
            inputs.extend([dir.join(".mvn"), dir.join("mvnw"), dir.join("mvnw.cmd")]);
            if dir == root {
                break;
            }
        }
        let program = process::program_path(&step.program, &step.env);
        inputs.push(program.clone());
        // Maven installed via a symlink still reads conf from its distribution.
        if let Ok(program) = dunce::canonicalize(program)
            && let Some(home) = program.parent().and_then(Path::parent)
        {
            for conf in ["conf", "libexec/conf"] {
                inputs.extend([home.join(conf).join("settings.xml"), home.join(conf).join("toolchains.xml")]);
            }
        }
        if !environment.contains_key("JAVA_HOME") {
            let java = process::program_path(if cfg!(windows) { "java.exe" } else { "java" }, &step.env);
            inputs.push(java.clone());
            if let Ok(java) = dunce::canonicalize(java)
                && let Some(home) = java.parent().and_then(Path::parent)
            {
                inputs.push(home.join("release"));
            }
        }
        for (i, arg) in step.args.iter().enumerate() {
            if matches!(arg.as_str(), "-s" | "--settings" | "-gs" | "--global-settings" | "-t" | "--toolchains")
                && let Some(file) = step.args.get(i + 1)
            {
                inputs.push(step.cwd.join(file));
            }
            for prefix in ["--settings=", "--global-settings=", "--toolchains="] {
                if let Some(file) = arg.strip_prefix(prefix) {
                    inputs.push(step.cwd.join(file));
                }
            }
        }
    }
    if let Some(home) = dirs::home_dir() {
        inputs.extend([home.join(".m2/settings.xml"), home.join(".m2/toolchains.xml")]);
    }
    for key in ["MAVEN_HOME", "M2_HOME"] {
        if let Some(home) = environment.get(key) {
            inputs.extend([Path::new(home).join("conf/settings.xml"), Path::new(home).join("conf/toolchains.xml")]);
        }
    }
    if let Some(home) = environment.get("JAVA_HOME") {
        inputs.extend([
            Path::new(home).join("release"),
            Path::new(home).join("lib/modules"),
            Path::new(home).join("lib/tools.jar"),
            Path::new(home).join(if cfg!(windows) { "bin/java.exe" } else { "bin/java" }),
        ]);
    }
    let steps = plan
        .steps
        .iter()
        .map(|s| (process::program_path(&s.program, &s.env), s.args.clone(), s.cwd.clone(), s.env.clone()))
        .collect();
    // Profiles and plugins can read arbitrary environment variables. Keep a signature
    // of the inherited environment without persisting unrelated credentials.
    let inherited: BTreeMap<_, _> = std::env::vars_os().collect();
    let mut inherited_hash = std::hash::DefaultHasher::new();
    inherited.hash(&mut inherited_hash);
    Ok(Some(Collected { inputs, environment, steps, inherited_hash: inherited_hash.finish() }))
}

/// Scans every input, storing project inputs relative to the project.
fn scan_all(
    root: &Path,
    inputs: Vec<PathBuf>,
    cancel: &CancellationToken,
) -> IdeResult<BTreeMap<PathBuf, Option<Stamp>>> {
    let mut files = BTreeMap::new();
    for path in inputs {
        scan(root, &path, &mut files, &mut HashSet::new(), cancel)?;
    }
    // Store project inputs relative to the project, including each file's relative path.
    Ok(files.into_iter().map(|(p, stamp)| (p.strip_prefix(root).unwrap_or(&p).to_path_buf(), stamp)).collect())
}

/// `None` means an input cannot be resolved safely: build normally without reuse.
/// All filesystem work belongs on the caller's blocking thread.
pub fn launch_fingerprint(
    root: &Path,
    model: &BuildModel,
    module: &Path,
    test: bool,
    local_repo: Option<PathBuf>,
    cancel: &CancellationToken,
) -> IdeResult<Option<LaunchFingerprint>> {
    let Some(m) = &model.maven else { return Ok(None) };
    let projects = maven_launch_projects(root, m, module, test);
    if projects.is_empty() {
        return Ok(None);
    }
    let plan = launch_plan(root, model, module, test, BuildKind::Build)?;
    let Some(collected) = collect(root, &projects, &plan, local_repo)? else { return Ok(None) };
    let Collected { inputs, environment, steps, inherited_hash } = collected;
    let parameters = serde_json::to_string(&(root, module, test, steps, environment, inherited_hash, projects))
        .map_err(|e| IdeError::internal(e.to_string()))?;
    Ok(Some(LaunchFingerprint { version: 2, parameters, files: scan_all(root, inputs, cancel)? }))
}

/// Inputs fingerprint of a menu build (`Build Project` / `Build Module`): the
/// built modules' sources, resources and POM chain plus the exact planned
/// steps, so an unchanged project skips Maven entirely (#2476). Only `Build`
/// callers reuse it, never `Rebuild` or `Artifacts`; `None` disables reuse.
/// All filesystem work belongs on the caller's blocking thread.
pub fn menu_fingerprint(
    root: &Path,
    model: &BuildModel,
    file: Option<&Path>,
    cancel: &CancellationToken,
) -> IdeResult<Option<LaunchFingerprint>> {
    let plan = plan(root, model, BuildKind::Build, file, None)?;
    if plan.system != BuildSystem::Maven {
        return Ok(None);
    }
    let Some(m) = &model.maven else { return Ok(None) };
    let projects: Vec<&maven::MavenProject> = match file {
        Some(file) => {
            // The innermost linked project owning the file, as in single-file compilation.
            let rel = rel_str(root, file);
            let module = m
                .projects
                .iter()
                .filter(|p| rel == p.dir || rel.starts_with(&format!("{}/", p.dir)) || p.dir.is_empty())
                .max_by_key(|p| p.dir.len());
            match module {
                Some(project) if project.packaging != "pom" => {
                    maven_launch_projects(root, m, &subdir(root, &project.dir), true)
                }
                _ => return Ok(None),
            }
        }
        // A project build walks every linked project.
        None => m.projects.iter().collect(),
    };
    if projects.is_empty() {
        return Ok(None);
    }
    let Some(collected) = collect(root, &projects, &plan, None)? else { return Ok(None) };
    let Collected { inputs, environment, steps, inherited_hash } = collected;
    let scope = file.map(|f| rel_str(root, f));
    let parameters = serde_json::to_string(&("menu-build", scope, steps, environment, inherited_hash))
        .map_err(|e| IdeError::internal(e.to_string()))?;
    Ok(Some(LaunchFingerprint { version: 2, parameters, files: scan_all(root, inputs, cancel)? }))
}

impl LaunchFingerprint {
    /// Folders (relative to the project) of the Maven projects whose POM is an input.
    pub(super) fn project_dirs(&self) -> impl Iterator<Item = &Path> {
        self.files
            .keys()
            .filter(|p| p.is_relative() && p.file_name().is_some_and(|n| n == "pom.xml"))
            .map(|pom| pom.parent().unwrap_or(Path::new("")))
    }

    /// Relative paths whose content changed while `(length, mtime)` stayed the same
    /// compared to `previous` (timestamp-preserving external edits, coarse-granularity
    /// filesystems). Timestamp-incremental builders (Maven, the Kotlin plugin) would
    /// skip these sources as "unchanged", so the rebuild the fingerprint triggers
    /// compiles nothing and the stale outputs get re-recorded as fresh. Callers
    /// re-stamp the returned paths before building. Inputs without a content hash
    /// (directories, files outside the project) are never reported.
    pub fn mtime_preserved_edits(&self, current: &Self) -> Vec<PathBuf> {
        let mut edits = Vec::new();
        for (path, current_stamp) in &current.files {
            let Some(current_stamp) = current_stamp else { continue };
            let Some(previous_stamp) = self.files.get(path).and_then(|stamp| stamp.as_ref()) else { continue };
            let (len, mtime, Some(current_hash)) = current_stamp else { continue };
            let (prev_len, prev_mtime, Some(prev_hash)) = previous_stamp else { continue };
            if current_hash != prev_hash && len == prev_len && mtime == prev_mtime {
                edits.push(path.clone());
            }
        }
        edits.sort();
        edits
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, rel: &str, value: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, value).unwrap();
    }

    fn fixture(root: &Path) -> BuildModel {
        write(
            root,
            "pom.xml",
            r#"<project><groupId>demo</groupId><artifactId>parent</artifactId><version>1</version>
            <packaging>pom</packaging><modules><module>lib</module><module>app</module></modules></project>"#,
        );
        write(
            root,
            "lib/pom.xml",
            r#"<project><parent><groupId>demo</groupId><artifactId>parent</artifactId><version>1</version></parent>
            <artifactId>lib</artifactId><build><sourceDirectory>code</sourceDirectory><resources><resource><directory>conf</directory></resource></resources></build></project>"#,
        );
        write(
            root,
            "app/pom.xml",
            r#"<project><parent><groupId>demo</groupId><artifactId>parent</artifactId><version>1</version></parent>
            <artifactId>app</artifactId><dependencies><dependency><groupId>demo</groupId><artifactId>lib</artifactId><version>1</version></dependency></dependencies></project>"#,
        );
        write(root, "lib/src/main/kotlin/Channel.kt", "value");
        write(root, "app/src/main/resources/app.properties", "key=value");
        write(root, "lib/conf/custom.properties", "custom=value");
        write(root, "lib/code/Custom.java", "class Custom {}");
        BuildModel { maven: Some(maven::load(root)), ..Default::default() }
    }

    fn fingerprint(root: &Path, model: &BuildModel) -> Option<LaunchFingerprint> {
        launch_fingerprint(root, model, &root.join("app"), false, None, &CancellationToken::new()).unwrap()
    }

    #[test]
    fn unchanged_inputs_match_but_source_resource_pom_add_delete_and_mtime_invalidate() {
        for rel in [
            "lib/src/main/kotlin/Channel.kt",
            "app/src/main/resources/app.properties",
            "lib/conf/custom.properties",
            "lib/code/Custom.java",
            "app/pom.xml",
            "lib/pom.xml",
            "pom.xml",
            ".mvn/maven.config",
            "lib/src/main/groovy/New.groovy",
            "app/src/test/scala/Test.scala",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            let model = fixture(root);
            let before = fingerprint(root, &model);
            assert!(before.is_some());
            assert_eq!(before, fingerprint(root, &model), "unchanged {rel}");
            let serialized = serde_json::to_vec(&before).unwrap();
            assert_eq!(before, serde_json::from_slice(&serialized).unwrap());
            let value = if rel.ends_with("pom.xml") {
                format!("{}<!-- changed -->", fs::read_to_string(root.join(rel)).unwrap())
            } else {
                "changed input".to_owned()
            };
            write(root, rel, &value);
            let changed = fingerprint(root, &model);
            assert_ne!(before, changed, "changed/added {rel}");
            let file = fs::OpenOptions::new().write(true).open(root.join(rel)).unwrap();
            file.set_modified(SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(42)).unwrap();
            let touched = fingerprint(root, &model);
            assert_ne!(changed, touched, "mtime-only {rel}");
            fs::remove_file(root.join(rel)).unwrap();
            assert_ne!(touched, fingerprint(root, &model), "deleted {rel}");
        }
    }

    /// An external tool that keeps the byte length and the mtime (timestamp-preserving
    /// writes, coarse-granularity filesystems) still changes the content: the fingerprint
    /// must differ via the content hash, not via `(length, mtime)`.
    #[test]
    fn external_edit_preserving_length_and_mtime_still_invalidates() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let model = fixture(root);
        let source = root.join("lib/src/main/kotlin/Channel.kt");
        let before = fingerprint(root, &model);
        assert!(before.is_some());
        let mtime = fs::metadata(&source).unwrap().modified().unwrap();
        // Same 5-byte length, different content.
        write(root, "lib/src/main/kotlin/Channel.kt", "valve");
        fs::File::options().write(true).open(&source).unwrap().set_modified(mtime).unwrap();
        let after = fingerprint(root, &model);
        assert_ne!(before, after, "a same-length, same-mtime content change must invalidate the fingerprint");
    }

    #[test]
    fn mtime_preserved_edits_only_reports_lying_timestamps() {
        fn stamp(len: u64, hash: &str) -> Option<Stamp> {
            Some((len, SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(42), Some(hash.into())))
        }
        fn prints(
            previous: BTreeMap<PathBuf, Option<Stamp>>,
            current: BTreeMap<PathBuf, Option<Stamp>>,
        ) -> Vec<PathBuf> {
            let previous = LaunchFingerprint { version: 2, parameters: String::new(), files: previous };
            let current = LaunchFingerprint { version: 2, parameters: String::new(), files: current };
            previous.mtime_preserved_edits(&current)
        }
        // Same length and mtime, different content: the builder would skip it.
        assert_eq!(
            prints([("a.java".into(), stamp(5, "old"))].into(), [("a.java".into(), stamp(5, "new"))].into()),
            vec![PathBuf::from("a.java")]
        );
        // A normal edit bumps the mtime: the builder already sees it.
        let mut touched = stamp(5, "new").unwrap();
        touched.1 += std::time::Duration::from_secs(1);
        assert!(
            prints([("a.java".into(), stamp(5, "old"))].into(), [("a.java".into(), Some(touched))].into()).is_empty()
        );
        // Added, deleted, and hash-less inputs (directories, files outside the
        // project) carry no comparable content: never reported.
        assert!(
            prints(
                [("gone.java".into(), stamp(5, "old")), ("dir".into(), None)].into(),
                [("new.java".into(), stamp(5, "new")), ("dir".into(), None)].into()
            )
            .is_empty()
        );
    }

    #[test]
    fn lying_source_is_found_against_a_real_fingerprint() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let model = fixture(root);
        let source = root.join("lib/src/main/kotlin/Channel.kt");
        let before = fingerprint(root, &model).unwrap();
        let mtime = fs::metadata(&source).unwrap().modified().unwrap();
        // Same 5-byte length, different content, preserved mtime.
        write(root, "lib/src/main/kotlin/Channel.kt", "valve");
        fs::File::options().write(true).open(&source).unwrap().set_modified(mtime).unwrap();
        let after = fingerprint(root, &model).unwrap();
        assert_eq!(before.mtime_preserved_edits(&after), [PathBuf::from("lib/src/main/kotlin/Channel.kt")]);
        // A normal edit (mtime advances) needs no repair.
        write(root, "lib/src/main/kotlin/Channel.kt", "valve!");
        let normal = fingerprint(root, &model).unwrap();
        assert!(before.mtime_preserved_edits(&normal).is_empty());
    }

    #[test]
    fn profile_options_jdk_goal_and_wrapper_invalidate_without_using_class_outputs() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut model = fixture(root);
        let before = fingerprint(root, &model);
        write(root, "lib/target/classes/Channel.class", "JDT stub");
        write(root, "app/target/classes/Main.class", "JDT stub");
        assert_eq!(before, fingerprint(root, &model));
        let mut previous = before.clone();
        for option in ["-Pdev", "-Pprod", "-DskipTests", "-o"] {
            model.maven.as_mut().unwrap().projects[0].options = vec![option.into()];
            let current = fingerprint(root, &model);
            assert_ne!(previous, current, "{option}");
            previous = current;
        }
        model.maven.as_mut().unwrap().projects[0].options.clear();
        model.maven.as_mut().unwrap().projects[0]
            .env
            .insert("JAVA_HOME".into(), root.join("jdk").to_string_lossy().into_owned());
        let jdk = fingerprint(root, &model);
        assert_ne!(before, jdk);
        write(root, "jdk/release", "JAVA_VERSION=21");
        assert_ne!(jdk, fingerprint(root, &model));
        model.maven.as_mut().unwrap().projects[0].env.clear();
        let test = launch_fingerprint(root, &model, &root.join("app"), true, None, &CancellationToken::new())
            .unwrap()
            .unwrap();
        assert_ne!(before, Some(test));
        write(root, "mvnw", "wrapper changed");
        assert_ne!(before, fingerprint(root, &model));
    }

    #[test]
    fn unresolved_roots_and_cancel_never_claim_up_to_date() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let model = fixture(root);
        write(
            root,
            "lib/pom.xml",
            "<project><artifactId>lib</artifactId><build><sourceDirectory>${unknown}/src</sourceDirectory></build></project>",
        );
        assert!(
            launch_fingerprint(root, &model, &root.join("app"), false, None, &CancellationToken::new())
                .unwrap()
                .is_none()
        );
        let model = fixture(root);
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(launch_fingerprint(root, &model, &root.join("app"), false, None, &cancel).is_err());
    }
    #[test]
    fn external_parent_and_selected_settings_files_invalidate() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("project");
        let repo = dir.path().join("repository");
        write(
            &repo,
            "demo/parent/1/parent-1.pom",
            "<project><groupId>demo</groupId><artifactId>parent</artifactId><version>1</version></project>",
        );
        write(
            &root,
            "pom.xml",
            "<project><parent><groupId>demo</groupId><artifactId>parent</artifactId><version>1</version><relativePath/></parent><artifactId>app</artifactId></project>",
        );
        let mut model = crate::load(&root, &root.join("cache"), Some(repo.clone()));
        let settings = dir.path().join("custom-settings.xml");
        fs::write(&settings, "<settings/>").unwrap();
        model.maven.as_mut().unwrap().projects[0].options = vec!["-s".into(), settings.to_string_lossy().into_owned()];
        let get =
            || launch_fingerprint(&root, &model, &root, false, Some(repo.clone()), &CancellationToken::new()).unwrap();
        let before = get();
        assert!(before.is_some());
        write(
            &repo,
            "demo/parent/1/parent-1.pom",
            "<project><groupId>demo</groupId><artifactId>parent</artifactId><version>1</version><!-- changed --></project>",
        );
        let parent = get();
        assert_ne!(before, parent);
        fs::write(settings, "<settings><activeProfiles><activeProfile>dev</activeProfile></activeProfiles></settings>")
            .unwrap();
        assert_ne!(parent, get());
    }
}
