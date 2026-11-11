//! Single-file Java compilation with `javac` for the Compile File action (#2476).
//!
//! A module build (`-pl … -am`) still walks every upstream module, and packaging
//! walks the whole reactor; compiling one file only needs that file's module
//! outputs plus its dependency classpath, which is much faster to assemble.
use super::*;
use std::fs;
use std::process::Command as ProcCommand;

/// Output file of the `dependency:build-classpath` probe, relative to each module.
const CP_FILE: &str = "target/ide-compile-cp.txt";

/// A `.java` source and the module build that compiles it.
pub struct SingleFileTarget {
    /// Absolute module directory.
    pub module: PathBuf,
    /// The source is under `src/test`: compile to test classes with the test classpath.
    pub test: bool,
    /// Absolute `target/classes` (or `target/test-classes`).
    pub out_dir: PathBuf,
    /// Reactor root building the module (owns the Maven command and options).
    pub top: maven::MavenProject,
    /// `-pl` value of the module relative to the reactor root; empty when the
    /// module is the root itself.
    pub pl: String,
    /// `maven.compiler.release` (or equivalent) of the module's project.
    pub java_version: Option<u32>,
}

/// Locates the linked Maven module owning a `.java` source file.
pub fn single_file_target(root: &Path, model: &BuildModel, file: &Path) -> IdeResult<SingleFileTarget> {
    if file.extension().is_none_or(|ext| ext != "java") {
        return Err(IdeError::invalid("only Java sources can be compiled as a single file"));
    }
    if !file.is_file() {
        return Err(IdeError::not_found("no Java source found for single-file compilation"));
    }
    let Some(m) = &model.maven else {
        return Err(IdeError::not_found("no linked Maven project found for module"));
    };
    // The innermost project whose directory contains the file owns it; the
    // aggregator root (`""`) is a prefix of everything, so take the longest match.
    let rel = rel_str(root, file);
    let project = m
        .projects
        .iter()
        .filter(|p| rel == p.dir || rel.starts_with(&format!("{}/", p.dir)) || p.dir.is_empty())
        .max_by_key(|p| p.dir.len())
        .ok_or_else(|| IdeError::not_found("no linked Maven project found for module"))?;
    if project.packaging == "pom" {
        // An aggregator owns no sources itself: a file that only matches it
        // belongs to no linked module.
        return Err(IdeError::not_found("no linked Maven project found for module"));
    }
    let module = subdir(root, &project.dir);
    let top = maven_reactor(m, &project.dir)
        .ok_or_else(|| IdeError::not_found("no linked Maven project found for module"))?;
    let top_dir = subdir(root, &top.dir);
    let pl = module.strip_prefix(&top_dir).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();
    // Test sources see the test classpath and compile into test classes.
    let parts: Vec<&str> = rel.split('/').collect();
    let test = parts.windows(2).any(|w| w == ["src", "test"]);
    let out_dir = module.join("target").join(if test { "test-classes" } else { "classes" });
    Ok(SingleFileTarget { module, test, out_dir, top: top.clone(), pl, java_version: project.java_version })
}

/// `javac` for the module: its `JAVA_HOME`, else `PATH`.
pub fn find_javac(env: &BTreeMap<String, String>) -> String {
    let home = env.get("JAVA_HOME").map(Path::new);
    let exe = if cfg!(windows) { "javac.exe" } else { "javac" };
    if let Some(javac) = home.map(|h| h.join("bin").join(exe)).filter(|p| p.is_file()) {
        return javac.to_string_lossy().into_owned();
    }
    exe.to_owned()
}

/// Dependency classpath of the module: existing reactor class directories plus
/// `mvn dependency:build-classpath` (which resolves without compiling anything,
/// so `-am` stays cheap). Entries are platform-separated (`;` on Windows).
pub fn single_file_classpath(root: &Path, model: &BuildModel, target: &SingleFileTarget) -> IdeResult<String> {
    let mut entries: Vec<String> = Vec::new();
    if let Some(m) = &model.maven {
        // Upstream reactor modules first: their freshly built classes shadow
        // installed snapshots of the same artifacts.
        for project in maven_launch_projects(root, m, &target.module, target.test) {
            let dir = subdir(root, &project.dir);
            if dir == target.module {
                continue;
            }
            for classes in ["target/classes", "target/test-classes"] {
                let path = dir.join(classes);
                if path.is_dir() {
                    entries.push(path.to_string_lossy().into_owned());
                }
            }
        }
    }
    let probe = CP_FILE;
    let mut args = vec!["-B", "-Dstyle.color=never", maven::LOCAL_REPO_TRACKING_ARG];
    args.extend(target.top.options.iter().map(String::as_str));
    if !target.pl.is_empty() {
        args.extend(["-pl", target.pl.as_str(), "-am"]);
    }
    let output_arg = format!("-Dmdep.outputFile={probe}");
    args.extend(["dependency:build-classpath", output_arg.as_str(), "-Dmdep.includeScope=test", "-q"]);
    let top_dir = subdir(root, &target.top.dir);
    let status = ProcCommand::new(&target.top.command)
        .args(&args)
        .envs(&target.top.env)
        .current_dir(&top_dir)
        .output()
        .map_err(|e| IdeError::internal(format!("cannot resolve the compile classpath: {e}")))?;
    if !status.status.success() {
        let stderr = String::from_utf8_lossy(&status.stderr);
        let tail: Vec<&str> = stderr.lines().filter(|l| !l.trim().is_empty()).collect();
        let tail = tail.iter().rev().take(5).rev().cloned().collect::<Vec<_>>().join("\n");
        return Err(IdeError::internal(format!("cannot resolve the compile classpath:\n{tail}")));
    }
    // With `-am` every visited module writes its own file; only this module's counts.
    let cp_file = target.module.join(probe);
    let content = fs::read_to_string(&cp_file).map_err(|e| {
        IdeError::internal(format!("cannot resolve the compile classpath: {} ({e})", cp_file.display()))
    })?;
    let separator = if cfg!(windows) { ';' } else { ':' };
    entries.extend(content.split([separator, '\n', '\r']).map(str::trim).filter(|e| !e.is_empty()).map(str::to_owned));
    entries.dedup();
    Ok(entries.join(&separator.to_string()))
}

/// The `javac` step compiling `file` into `target`'s output directory.
pub fn javac_step(target: &SingleFileTarget, file: &Path, classpath: &str, javac: &str) -> IdeResult<BuildStep> {
    fs::create_dir_all(&target.out_dir)
        .map_err(|e| IdeError::internal(format!("cannot create {} ({e})", target.out_dir.display())))?;
    let mut step = BuildStep::new(javac, &[], &target.module, Format::Gradle);
    // Raw `javac` prints `path:line: error: …`, the same form Gradle forwards.
    step.args.push("-encoding".into());
    step.args.push("UTF-8".into());
    step.args.push("-d".into());
    step.args.push(target.out_dir.to_string_lossy().into_owned());
    step.args.push("-cp".into());
    step.args.push(classpath.to_owned());
    if let Some(version) = target.java_version {
        step.args.push("--release".into());
        step.args.push(version.to_string());
    }
    step.args.push(file.to_string_lossy().into_owned());
    step.env = target.top.env.clone();
    Ok(step)
}

/// Resolves the classpath and plans the `javac` invocation for one Java source.
pub fn compile_file_plan(root: &Path, model: &BuildModel, file: &Path) -> IdeResult<BuildPlan> {
    let target = single_file_target(root, model, file)?;
    let classpath = single_file_classpath(root, model, &target)?;
    let javac = find_javac(&target.top.env);
    let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(BuildPlan {
        system: BuildSystem::Maven,
        title: format!("Compile {name}"),
        steps: vec![javac_step(&target, file, &classpath, &javac)?],
    })
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
            <artifactId>lib</artifactId></project>"#,
        );
        write(
            root,
            "app/pom.xml",
            r#"<project><parent><groupId>demo</groupId><artifactId>parent</artifactId><version>1</version></parent>
            <artifactId>app</artifactId><dependencies><dependency><groupId>demo</groupId><artifactId>lib</artifactId><version>1</version></dependency></dependencies></project>"#,
        );
        write(root, "app/src/main/java/demo/Main.java", "class Main {}");
        write(root, "app/src/test/java/demo/MainTest.java", "class MainTest {}");
        write(root, "lib/target/classes/Lib.class", "built");
        crate::load(root, &root.join("cache"), None)
    }

    #[test]
    fn target_finds_the_owning_module_and_the_test_scope() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let model = fixture(root);
        let main = single_file_target(root, &model, &root.join("app/src/main/java/demo/Main.java")).unwrap();
        assert_eq!(main.module, root.join("app"));
        assert!(!main.test);
        assert_eq!(main.out_dir, root.join("app/target/classes"));
        let test = single_file_target(root, &model, &root.join("app/src/test/java/demo/MainTest.java")).unwrap();
        assert!(test.test);
        assert_eq!(test.out_dir, root.join("app/target/test-classes"));
    }

    #[test]
    fn target_rejects_non_java_missing_and_unlinked_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let model = fixture(root);
        write(root, "app/pom.xml", "<project/>");
        assert!(single_file_target(root, &model, &root.join("app/pom.xml")).is_err());
        assert!(single_file_target(root, &model, &root.join("app/src/main/java/demo/Missing.java")).is_err());
        write(root, "other/Main.java", "class Main {}");
        assert!(single_file_target(root, &model, &root.join("other/Main.java")).is_err());
    }

    #[test]
    fn javac_prefers_the_module_jdk_and_scopes_test_sources() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let model = fixture(root);
        let file = root.join("app/src/test/java/demo/MainTest.java");
        let target = single_file_target(root, &model, &file).unwrap();
        let jdk = root.join("jdk");
        fs::create_dir_all(jdk.join("bin")).unwrap();
        let exe = if cfg!(windows) { "javac.exe" } else { "javac" };
        fs::write(jdk.join("bin").join(exe), "fake").unwrap();
        let mut target = target;
        target.top.env.insert("JAVA_HOME".into(), jdk.to_string_lossy().into_owned());
        let step = javac_step(&target, &file, "/repo/a.jar", &find_javac(&target.top.env)).unwrap();
        assert!(step.program.ends_with(exe));
        assert!(target.out_dir.is_dir());
        let args = step.args.join(" ");
        assert!(args.contains("-encoding UTF-8"), "{args}");
        assert!(args.contains("-d ") && args.contains("test-classes"), "{args}");
        assert!(args.contains("-cp /repo/a.jar"), "{args}");
        assert!(args.contains("MainTest.java"), "{args}");
        // No `JAVA_HOME`: plain `javac` from `PATH`.
        assert_eq!(find_javac(&BTreeMap::new()), exe);
    }

    /// The classpath probe runs the project's Maven command with `-pl … -am`
    /// `dependency:build-classpath`; the fake `mvnw` below only records its
    /// arguments and writes a canned classpath file for the `-pl` module.
    #[cfg(unix)]
    #[test]
    fn classpath_probe_writes_one_file_per_module_and_reads_the_compiled_one() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fixture(root);
        let script = root.join("mvnw");
        fs::write(
            &script,
            "#!/bin/sh\npl='.'\nwhile [ $# -gt 0 ]; do\nif [ \"$1\" = \"-pl\" ]; then pl=\"$2\"; shift 2; else shift; fi\ndone\nmkdir -p \"$pl/target\"\nprintf '/repo/a.jar:/repo/b.jar' > \"$pl/target/ide-compile-cp.txt\"\n",
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        let model = crate::load(root, &root.join("cache"), None);
        let file = root.join("app/src/main/java/demo/Main.java");
        let target = single_file_target(root, &model, &file).unwrap();
        assert!(target.top.command.ends_with("mvnw"));
        assert_eq!(target.pl, "app");
        let cp = single_file_classpath(root, &model, &target).unwrap();
        let separator = ':';
        // Reactor class directories first, so fresh outputs shadow installed snapshots.
        let lib = root.join("lib/target/classes").to_string_lossy().into_owned();
        assert!(cp.starts_with(&lib), "{cp}");
        assert!(cp.contains("/repo/a.jar"), "{cp}");
        assert!(cp.contains("/repo/b.jar"), "{cp}");
        assert!(cp.split(separator).count() >= 3, "{cp}");
    }
}
