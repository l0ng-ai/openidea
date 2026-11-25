use super::*;
use std::fs;
use std::sync::Mutex as StdMutex;

const JAR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../java/java-build/openidea-java-build.jar");

fn write(root: &Path, rel: &str, text: &str) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

/// A JDK (`JAVA_HOME`) and Maven on the search path, else `None` (the test is skipped).
fn tools() -> Option<(PathBuf, PathBuf)> {
    let home = std::env::var_os("JAVA_HOME").map(PathBuf::from).filter(|h| h.join("bin").is_dir())?;
    let mvn = ide_core::process::find_executable("mvn", &ide_core::tool_path::search_path())?;
    Some((home, mvn))
}

/// `lib` ← `app`; `app` filters its resources and has tests.
fn reactor(root: &Path) {
    write(
        root,
        "pom.xml",
        r#"<project><modelVersion>4.0.0</modelVersion><groupId>t</groupId><artifactId>root</artifactId><version>1</version><packaging>pom</packaging>
<modules><module>lib</module><module>app</module></modules>
<properties><maven.compiler.release>11</maven.compiler.release><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties>
<build><pluginManagement><plugins><plugin><artifactId>maven-compiler-plugin</artifactId><version>3.13.0</version>
<configuration><parameters>true</parameters></configuration></plugin></plugins></pluginManagement></build></project>"#,
    );
    write(
        root,
        "lib/pom.xml",
        r#"<project><modelVersion>4.0.0</modelVersion><parent><groupId>t</groupId><artifactId>root</artifactId><version>1</version></parent><artifactId>lib</artifactId></project>"#,
    );
    write(
        root,
        "app/pom.xml",
        r#"<project><modelVersion>4.0.0</modelVersion><parent><groupId>t</groupId><artifactId>root</artifactId><version>1</version></parent><artifactId>app</artifactId>
<dependencies><dependency><groupId>t</groupId><artifactId>lib</artifactId><version>1</version></dependency></dependencies>
<build><resources><resource><directory>src/main/resources</directory><filtering>true</filtering></resource></resources></build></project>"#,
    );
    write(
        root,
        "lib/src/main/java/l/L.java",
        "package l;\npublic class L { public static String name() { return \"lib\"; } }\n",
    );
    write(
        root,
        "app/src/main/java/a/A.java",
        "package a;\npublic class A { public static void main(String[] args) { System.out.println(l.L.name()); } }\n",
    );
    write(root, "app/src/main/resources/app.properties", "version=${project.version}\n");
    write(root, "app/src/test/java/a/ATest.java", "package a;\npublic class ATest { String s = l.L.name(); }\n");
}

struct Recorder(StdMutex<Vec<BuildEvent>>);

impl Recorder {
    fn steps(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                BuildEvent::Step { command, .. } => Some(command.clone()),
                _ => None,
            })
            .collect()
    }

    fn clear(&self) {
        self.0.lock().unwrap().clear();
    }
}

#[test]
fn builds_maven_modules_with_javac_and_only_what_changed() {
    let Some((home, mvn)) = tools() else {
        eprintln!("skipped: needs JAVA_HOME and mvn");
        return;
    };
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap();
    reactor(&root);
    let cache = root.join(".cache");
    let mut model = crate::load(&root, &cache, None);
    for p in &mut model.maven.as_mut().unwrap().projects {
        p.command = mvn.to_string_lossy().into_owned();
        p.env.insert("JAVA_HOME".into(), home.to_string_lossy().into_owned());
    }
    let service = JavaBuildService::default();
    let jdk = |_: Option<u32>| None;
    let build = JavaBuild {
        root: &root,
        model: &model,
        cache: &cache,
        jar: Path::new(JAR),
        jar_version: "test",
        local_repo: None,
        service: &service,
        jdk: &jdk,
    };
    let events = Recorder(StdMutex::new(Vec::new()));
    let on_event = |e: BuildEvent| events.0.lock().unwrap().push(e);
    let app = root.join("app");
    let cancel = CancellationToken::new();
    let launch = |test: bool| match build.build_launch(&app, test, BuildKind::Build, &cancel, &on_event).unwrap() {
        Built::Done(outputs) => outputs,
        Built::Unsupported(reason) => panic!("unsupported: {reason}"),
    };

    // First build: Maven prepares the model, javac compiles lib then app into the IDE's outputs.
    let first = launch(false);
    assert_eq!(first.failure, None, "{:?}", first.messages);
    let out = model::output_root(&cache, "");
    assert_eq!(first.class_paths[0], out.join("t.app/classes"));
    assert!(first.class_paths.contains(&out.join("t.lib/classes")), "{:?}", first.class_paths);
    assert!(out.join("t.app/classes/a/A.class").is_file());
    assert!(out.join("t.lib/classes/l/L.class").is_file());
    assert!(!root.join("app/target/classes/a/A.class").exists());
    assert_eq!(fs::read_to_string(out.join("t.app/classes/app.properties")).unwrap(), "version=1\n");
    let steps = events.steps();
    assert!(steps[0].contains("process-resources"), "{steps:?}");
    assert!(steps[1].starts_with("javac lib (main") && steps[2].starts_with("javac app (main"), "{steps:?}");

    // Nothing changed: no Maven, no javac.
    events.clear();
    assert_eq!(launch(false).failure, None);
    assert!(events.steps().is_empty(), "{:?}", events.steps());

    // An upstream change compiles it and what depends on it, without Maven.
    events.clear();
    write(
        &root,
        "lib/src/main/java/l/L.java",
        "package l;\npublic class L { public static String name() { return \"lib 2\"; } }\n",
    );
    assert_eq!(launch(false).failure, None);
    let steps = events.steps();
    assert_eq!(steps.len(), 2, "{steps:?}");
    assert!(steps[0].starts_with("javac lib") && steps[1].starts_with("javac app"), "{steps:?}");

    // A resource change is processed by Maven (it filters), and compiles nothing.
    events.clear();
    write(&root, "app/src/main/resources/app.properties", "version=${project.version}\nmore=1\n");
    assert_eq!(launch(false).failure, None);
    let steps = events.steps();
    assert_eq!(steps.len(), 1, "{steps:?}");
    assert!(steps[0].contains("resources:resources") && steps[0].contains("-pl app"), "{steps:?}");
    assert_eq!(fs::read_to_string(out.join("t.app/classes/app.properties")).unwrap(), "version=1\nmore=1\n");

    // A deleted source leaves no class behind.
    write(&root, "app/src/main/java/a/Gone.java", "package a;\nclass Gone {}\n");
    assert_eq!(launch(false).failure, None);
    assert!(out.join("t.app/classes/a/Gone.class").is_file());
    fs::remove_file(root.join("app/src/main/java/a/Gone.java")).unwrap();
    assert_eq!(launch(false).failure, None);
    assert!(!out.join("t.app/classes/a/Gone.class").exists());

    // Compile errors fail the build with positioned messages.
    write(&root, "app/src/main/java/a/A.java", "package a;\npublic class A { int x = \"s\"; }\n");
    let failed = launch(false);
    let failure = failed.failure.expect("fails");
    assert!(failure.contains("incompatible types"), "{failure}");
    let error = failed.messages.iter().find(|m| m.severity == Severity::Error).unwrap();
    assert_eq!(error.path.as_deref(), Some(root.join("app/src/main/java/a/A.java").as_path()));
    assert_eq!(error.range.unwrap().start, Pos::new(1, 25));
    // It compiles again next time, even unchanged.
    events.clear();
    assert!(launch(false).failure.is_some());
    assert_eq!(events.steps().len(), 1);

    // A test launch compiles the module's tests after its main classes.
    write(
        &root,
        "app/src/main/java/a/A.java",
        "package a;\npublic class A { public static void main(String[] args) { System.out.println(l.L.name()); } }\n",
    );
    let tests = launch(true);
    assert_eq!(tests.failure, None, "{:?}", tests.messages);
    assert_eq!(tests.class_paths[..2], [out.join("t.app/test-classes"), out.join("t.app/classes")]);
    assert!(out.join("t.app/test-classes/a/ATest.class").is_file());
}

#[test]
fn ant_patterns_match_like_maven() {
    assert!(ant_match("**/*.java", "a/b/C.java"));
    assert!(ant_match("**/*.java", "C.java"));
    assert!(ant_match("com/acme/**", "com/acme/x/Y.java"));
    assert!(!ant_match("com/acme/**", "com/other/Y.java"));
    assert!(ant_match("**/generated/", "x/generated/Y.java"));
    assert!(ant_match("**/*Test?.java", "a/FooTest1.java"));
    assert!(!ant_match("*.java", "a/B.java"));
}

#[test]
fn javac_options_follow_the_compiler_configuration() {
    let set = SourceSet {
        output: PathBuf::from("/o"),
        compiler: Some(CompilerConfig {
            release: Some("17".into()),
            source: Some("1.8".into()),
            encoding: Some("UTF-8".into()),
            parameters: Some(true),
            debuglevel: Some("lines,vars".into()),
            proc: Some("none".into()),
            processor_path: Some(vec![PathBuf::from("/p.jar")]),
            annotation_processors: Some(vec!["a.P".into()]),
            compiler_args: vec!["-Xlint:unchecked".into()],
            compiler_arguments: [("Akey=v".to_owned(), None)].into(),
            show_warnings: Some(false),
            ..Default::default()
        }),
        ..Default::default()
    };
    let args = javac_options(&set, &[PathBuf::from("/lib.jar")], Path::new("/gen"), Some(21));
    let joined = args.join(" ");
    let separator = if cfg!(windows) { ";" } else { ":" };
    assert!(joined.starts_with(&format!("-d /o -classpath /o{separator}/lib.jar -sourcepath  -s /gen")), "{joined}");
    for expected in [
        "-processorpath /p.jar",
        "-processor a.P",
        "-proc:none",
        "-g:lines,vars",
        "-parameters",
        "-nowarn",
        "-encoding UTF-8",
        "--release 17",
        "-Akey=v",
    ] {
        assert!(joined.contains(expected), "{expected} in {joined}");
    }
    assert!(joined.ends_with("-Xlint:unchecked"), "{joined}");
    // JDK 8 has no --release: source and target instead.
    let old = javac_options(&set, &[], Path::new("/gen"), Some(8)).join(" ");
    assert!(old.contains("-source 1.8") && !old.contains("--release"), "{old}");
}
