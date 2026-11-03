//! Metadata fingerprints for successful Maven launch builds.
use super::*;
use std::fs;
use std::hash::{Hash, Hasher};
use std::time::SystemTime;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaunchFingerprint {
    version: u32,
    parameters: String,
    files: BTreeMap<PathBuf, Option<(u64, SystemTime)>>,
}

fn scan(
    path: &Path,
    files: &mut BTreeMap<PathBuf, Option<(u64, SystemTime)>>,
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
            scan(&entry?.path(), files, ancestors, cancel)?;
        }
        ancestors.remove(&canonical);
    } else if meta.is_file() {
        files.insert(path.to_path_buf(), Some((meta.len(), meta.modified()?)));
    } else {
        return Err(IdeError::internal("unsupported launch input file"));
    }
    Ok(())
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
    let Some(mut inputs) = maven::launch_inputs(root, &projects, local_repo) else { return Ok(None) };
    let plan = launch_plan(root, model, module, test)?;
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
    let steps: Vec<_> =
        plan.steps.iter().map(|s| (process::program_path(&s.program, &s.env), &s.args, &s.cwd, &s.env)).collect();
    // Profiles and plugins can read arbitrary environment variables. Keep a signature
    // of the inherited environment without persisting unrelated credentials.
    let inherited: BTreeMap<_, _> = std::env::vars_os().collect();
    let mut inherited_hash = std::hash::DefaultHasher::new();
    inherited.hash(&mut inherited_hash);
    let parameters =
        serde_json::to_string(&(root, module, test, steps, environment, inherited_hash.finish(), projects))
            .map_err(|e| IdeError::internal(e.to_string()))?;
    let mut files = BTreeMap::new();
    for path in inputs {
        scan(&path, &mut files, &mut HashSet::new(), cancel)?;
    }
    // Store project inputs relative to the project, including each file's relative path.
    let files = files.into_iter().map(|(p, stamp)| (p.strip_prefix(root).unwrap_or(&p).to_path_buf(), stamp)).collect();
    Ok(Some(LaunchFingerprint { version: 1, parameters, files }))
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
