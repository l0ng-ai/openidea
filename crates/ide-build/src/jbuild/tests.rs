use super::*;
use crate::BuildModel;
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

const ROOT_POM: &str = r#"<project><modelVersion>4.0.0</modelVersion><groupId>t</groupId><artifactId>root</artifactId><version>1</version><packaging>pom</packaging>
<modules><module>lib</module><module>app</module></modules>
<properties><maven.compiler.release>11</maven.compiler.release><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties>
<build><pluginManagement><plugins><plugin><artifactId>maven-compiler-plugin</artifactId><version>3.13.0</version>
<configuration><parameters>true</parameters></configuration></plugin></plugins></pluginManagement></build></project>"#;
const LIB_POM: &str = r#"<project><modelVersion>4.0.0</modelVersion><parent><groupId>t</groupId><artifactId>root</artifactId><version>1</version></parent><artifactId>lib</artifactId></project>"#;
const APP_POM: &str = r#"<project><modelVersion>4.0.0</modelVersion><parent><groupId>t</groupId><artifactId>root</artifactId><version>1</version></parent><artifactId>app</artifactId>
<dependencies><dependency><groupId>t</groupId><artifactId>lib</artifactId><version>1</version></dependency></dependencies>
<build><resources><resource><directory>src/main/resources</directory><filtering>true</filtering></resource></resources></build></project>"#;

/// A `lib` ← `app` reactor built by the IDE's Java build with a real Maven and JDK.
struct Fixture {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    cache: PathBuf,
    model: BuildModel,
    /// Where the build keeps its state under the cache (`Reactor::key`).
    key: &'static str,
    service: JavaBuildService,
    events: StdMutex<Vec<BuildEvent>>,
}

impl Fixture {
    fn new(files: &[(&str, &str)]) -> Option<Self> {
        let Some((home, mvn)) = tools() else {
            eprintln!("skipped: needs JAVA_HOME and mvn");
            return None;
        };
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        for (rel, text) in
            [("pom.xml", ROOT_POM), ("lib/pom.xml", LIB_POM), ("app/pom.xml", APP_POM)].iter().chain(files)
        {
            write(&root, rel, text);
        }
        let cache = root.join(".cache");
        let mut model = crate::load(&root, &cache, None);
        for p in &mut model.maven.as_mut().unwrap().projects {
            p.command = mvn.to_string_lossy().into_owned();
            p.env.insert("JAVA_HOME".into(), home.to_string_lossy().into_owned());
        }
        Some(Fixture {
            _tmp: tmp,
            root,
            cache,
            model,
            key: "",
            service: JavaBuildService::default(),
            events: StdMutex::default(),
        })
    }

    /// The same `lib` ← `app` build with Gradle (`OPENIDEA_TEST_GRADLE`, else `gradle` on the
    /// search path).
    fn gradle(files: &[(&str, &str)]) -> Option<Self> {
        let home = std::env::var_os("JAVA_HOME").map(PathBuf::from).filter(|h| h.join("bin").is_dir());
        let gradle = std::env::var_os("OPENIDEA_TEST_GRADLE")
            .map(PathBuf::from)
            .or_else(|| ide_core::process::find_executable("gradle", &ide_core::tool_path::search_path()));
        let (Some(home), Some(gradle)) = (home, gradle) else {
            eprintln!("skipped: needs JAVA_HOME and gradle (OPENIDEA_TEST_GRADLE)");
            return None;
        };
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        let build = [
            // A persistent Gradle daemon can keep the fixture's output pipes open on Windows.
            ("gradle.properties", "org.gradle.daemon=false\n"),
            ("settings.gradle", "rootProject.name = 'root'\ninclude 'lib', 'app'\n"),
            (
                "build.gradle",
                "subprojects {\n  apply plugin: 'java'\n  group = 't'\n  tasks.withType(JavaCompile).configureEach { options.release = 11; options.encoding = 'UTF-8' }\n}\n",
            ),
            ("lib/build.gradle", ""),
            (
                "app/build.gradle",
                "dependencies { implementation project(':lib') }\nprocessResources { filesMatching('*.properties') { expand(version: '1') } }\n",
            ),
        ];
        for (rel, text) in build.iter().chain(files) {
            write(&root, rel, text);
        }
        let cache = root.join(".cache");
        let mut model = crate::load(&root, &cache, None);
        assert_eq!(model.gradle.len(), 1, "{model:?}");
        let g = &mut model.gradle[0];
        g.command = gradle.to_string_lossy().into_owned();
        g.env.insert("JAVA_HOME".into(), home.to_string_lossy().into_owned());
        Some(Fixture {
            _tmp: tmp,
            root,
            cache,
            model,
            key: "_gradle",
            service: JavaBuildService::default(),
            events: StdMutex::default(),
        })
    }

    fn write(&self, rel: &str, text: &str) {
        write(&self.root, rel, text);
    }

    fn out(&self, rel: &str) -> PathBuf {
        model::output_root(&self.cache, self.key).join(rel)
    }

    /// Builds the launch of `app` (its tests when `test`).
    fn launch(&self, test: bool) -> LaunchOutputs {
        self.build(Target::Launch { module: &self.root.join("app"), test })
    }

    fn build(&self, target: Target) -> LaunchOutputs {
        let jdk = |_: Option<u32>| None;
        let build = JavaBuild {
            root: &self.root,
            model: &self.model,
            cache: &self.cache,
            jar: Path::new(JAR),
            jar_version: "test",
            local_repo: None,
            service: &self.service,
            jdk: &jdk,
        };
        let on_event = |e: BuildEvent| self.events.lock().unwrap().push(e);
        match build.build(target, BuildKind::Build, &CancellationToken::new(), &on_event) {
            Ok(Built::Done(outputs)) => outputs,
            Ok(Built::Unsupported(reason)) => panic!("unsupported: {reason}"),
            Err(e) => panic!("{e:?}"),
        }
    }

    /// The steps of the launch builds since the last call.
    fn steps(&self) -> Vec<String> {
        self.events
            .lock()
            .unwrap()
            .drain(..)
            .filter_map(|e| match e {
                BuildEvent::Step { command, .. } => Some(command),
                _ => None,
            })
            .collect()
    }

    /// Builds and returns the steps it took, which must succeed.
    fn steps_of_launch(&self) -> Vec<String> {
        self.steps();
        let built = self.launch(false);
        assert_eq!(built.failure, None, "{:?}", built.messages);
        self.steps()
    }
}

#[test]
fn builds_maven_modules_with_javac_and_only_what_changed() {
    let Some(f) = Fixture::new(&[
        (
            "lib/src/main/java/l/L.java",
            "package l;\npublic class L { public static String name() { return \"lib\"; } }\n",
        ),
        (
            "app/src/main/java/a/A.java",
            "package a;\npublic class A { public static void main(String[] args) { System.out.println(l.L.name()); } }\n",
        ),
        ("app/src/main/resources/app.properties", "version=${project.version}\n"),
        ("app/src/test/java/a/ATest.java", "package a;\npublic class ATest { String s = l.L.name(); }\n"),
    ]) else {
        return;
    };

    // First build: Maven prepares the model, javac compiles lib then app into the IDE's outputs.
    let first = f.launch(false);
    assert_eq!(first.failure, None, "{:?}", first.messages);
    assert_eq!(first.class_paths[0], f.out("t.app/classes"));
    assert!(first.class_paths.contains(&f.out("t.lib/classes")), "{:?}", first.class_paths);
    assert!(f.out("t.app/classes/a/A.class").is_file());
    assert!(f.out("t.lib/classes/l/L.class").is_file());
    assert!(!f.root.join("app/target/classes/a/A.class").exists());
    assert_eq!(fs::read_to_string(f.out("t.app/classes/app.properties")).unwrap(), "version=1\n");
    let steps = f.steps();
    assert!(steps[0].contains("process-resources"), "{steps:?}");
    assert_eq!(steps[1..], ["javac lib (main, 1 file)", "javac app (main, 1 file)"]);

    // Nothing changed: no Maven, no javac.
    assert_eq!(f.steps_of_launch(), Vec::<String>::new());

    // A change inside a method compiles that class only, without Maven.
    f.write(
        "lib/src/main/java/l/L.java",
        "package l;\npublic class L { public static String name() { return \"lib 2\"; } }\n",
    );
    assert_eq!(f.steps_of_launch(), ["javac lib (main, 1 file)"]);

    // A resource change is processed by Maven (it filters), and compiles nothing.
    f.write("app/src/main/resources/app.properties", "version=${project.version}\nmore=1\n");
    let steps = f.steps_of_launch();
    assert_eq!(steps.len(), 1, "{steps:?}");
    assert!(steps[0].contains("resources:resources") && steps[0].contains("-pl app"), "{steps:?}");
    assert_eq!(fs::read_to_string(f.out("t.app/classes/app.properties")).unwrap(), "version=1\nmore=1\n");

    // A deleted source leaves no class behind.
    f.write("app/src/main/java/a/Gone.java", "package a;\nclass Gone {}\n");
    assert_eq!(f.steps_of_launch(), ["javac app (main, 1 of 2 files)"]);
    assert!(f.out("t.app/classes/a/Gone.class").is_file());
    fs::remove_file(f.root.join("app/src/main/java/a/Gone.java")).unwrap();
    assert_eq!(f.steps_of_launch(), Vec::<String>::new());
    assert!(!f.out("t.app/classes/a/Gone.class").exists());

    // Compile errors fail the build with positioned messages.
    f.write("app/src/main/java/a/A.java", "package a;\npublic class A { int x = \"s\"; }\n");
    let failed = f.launch(false);
    let failure = failed.failure.expect("fails");
    assert!(failure.contains("incompatible types"), "{failure}");
    let error = failed.messages.iter().find(|m| m.severity == Severity::Error).unwrap();
    assert_eq!(error.path.as_deref(), Some(f.root.join("app/src/main/java/a/A.java").as_path()));
    assert_eq!(error.range.unwrap().start, Pos::new(1, 25));
    // It compiles again next time, even unchanged.
    f.steps();
    assert!(f.launch(false).failure.is_some());
    assert_eq!(f.steps(), ["javac app (main, 1 file)"]);

    // A test launch compiles the module's tests after its main classes.
    f.write(
        "app/src/main/java/a/A.java",
        "package a;\npublic class A { public static void main(String[] args) { System.out.println(l.L.name()); } }\n",
    );
    let tests = f.launch(true);
    assert_eq!(tests.failure, None, "{:?}", tests.messages);
    assert_eq!(tests.class_paths[..2], [f.out("t.app/test-classes"), f.out("t.app/classes")]);
    assert!(f.out("t.app/test-classes/a/ATest.class").is_file());

    // Recompile compiles the file even unchanged.
    f.steps();
    let file = f.root.join("app/src/main/java/a/A.java");
    assert_eq!(f.build(Target::File(&file)).failure, None);
    assert_eq!(f.steps(), ["javac app (main, 1 file)"]);
    // Build Project builds every module's main and test classes.
    f.write("lib/src/test/java/l/LTest.java", "package l;\nclass LTest { String s = L.name(); }\n");
    assert_eq!(f.build(Target::Project).failure, None);
    assert_eq!(f.steps(), ["javac lib (tests, 1 file)"]);
    assert!(f.out("t.lib/test-classes/l/LTest.class").is_file());
}

#[test]
fn recompiles_the_classes_an_api_change_reaches() {
    let Some(f) = Fixture::new(&[
        ("lib/src/main/java/l/Base.java", "package l;\npublic class Base { public int m() { return 1; } }\n"),
        ("lib/src/main/java/l/Sub.java", "package l;\npublic class Sub extends Base {}\n"),
        ("lib/src/main/java/l/User.java", "package l;\nclass User { int u(Sub s) { return s.m(); } }\n"),
        ("lib/src/main/java/l/Const.java", "package l;\npublic class Const { public static final int X = 1; }\n"),
        ("lib/src/main/java/l/ConstUser.java", "package l;\nclass ConstUser { int c() { return Const.X; } }\n"),
        ("lib/src/main/java/l/Other.java", "package l;\npublic class Other { public int o() { return 1; } }\n"),
        ("app/src/main/java/a/A.java", "package a;\nclass A { int a() { return new l.Other().o(); } }\n"),
        ("app/src/main/java/a/B.java", "package a;\nclass B { int b() { return l.Const.X; } }\n"),
    ]) else {
        return;
    };
    assert_eq!(f.steps_of_launch()[1..], ["javac lib (main, 6 files)", "javac app (main, 2 files)"]);

    // A body change: that class only, and nothing downstream.
    f.write("lib/src/main/java/l/Other.java", "package l;\npublic class Other { public int o() { return 2; } }\n");
    assert_eq!(f.steps_of_launch(), ["javac lib (main, 1 of 6 files)"]);

    // An API change reaches the classes that use the class or a subclass of it.
    f.write(
        "lib/src/main/java/l/Base.java",
        "package l;\npublic class Base { public int m() { return 1; } public int n() { return 2; } }\n",
    );
    assert_eq!(f.steps_of_launch(), ["javac lib (main, 1 of 6 files)", "javac lib (main, 2 of 6 files)"]);

    // Across modules: only the classes that use it.
    f.write(
        "lib/src/main/java/l/Other.java",
        "package l;\npublic class Other { public int o() { return 2; } public void p() {} }\n",
    );
    assert_eq!(f.steps_of_launch(), ["javac lib (main, 1 of 6 files)", "javac app (main, 1 of 2 files)"]);

    // A compile-time constant is copied into its uses: everything compiled against it compiles again.
    f.write("lib/src/main/java/l/Const.java", "package l;\npublic class Const { public static final int X = 2; }\n");
    assert_eq!(
        f.steps_of_launch(),
        ["javac lib (main, 1 of 6 files)", "javac lib (main, 5 of 6 files)", "javac app (main, 2 files)"]
    );

    // A removed method fails the classes that still call it.
    f.write("lib/src/main/java/l/Base.java", "package l;\npublic class Base { public int n() { return 2; } }\n");
    let failed = f.launch(false);
    assert!(failed.failure.expect("fails").contains("User.java"));
}

#[test]
fn an_api_change_from_a_failed_build_still_reaches_other_modules() {
    let Some(f) = Fixture::new(&[
        ("lib/src/main/java/l/L.java", "package l;\npublic class L { public static int m() { return 1; } }\n"),
        ("lib/src/main/java/l/U.java", "package l;\nclass U { int u() { return L.m(); } }\n"),
        ("app/src/main/java/a/A.java", "package a;\nclass A { int a() { return l.L.m(); } }\n"),
    ]) else {
        return;
    };
    assert_eq!(f.launch(false).failure, None);

    // L compiles, then U, which still calls the removed method, fails lib before app compiles.
    f.write("lib/src/main/java/l/L.java", "package l;\npublic class L { public static int n() { return 1; } }\n");
    assert!(f.launch(false).failure.expect("lib fails").contains("U.java"));

    // Once lib compiles, app learns that L changed, and A fails too instead of keeping a class
    // that calls a method L no longer has.
    f.write("lib/src/main/java/l/U.java", "package l;\nclass U { int u() { return L.n(); } }\n");
    let failed = f.launch(false);
    assert!(failed.failure.expect("app fails").contains("A.java"), "{:?}", failed.messages);

    // So does a changed constant: C compiles, then the whole set, where U fails.
    f.write("app/src/main/java/a/A.java", "package a;\nclass A { int a() { return l.L.n() + l.C.X; } }\n");
    let c = |x: u32, y: &str| format!("package l;\npublic class C {{ public static final int X = {x};{y} }}\n");
    f.write("lib/src/main/java/l/C.java", &c(1, " public static int y() { return 0; }"));
    f.write("lib/src/main/java/l/U.java", "package l;\nclass U { int u() { return L.n() + C.y(); } }\n");
    assert_eq!(f.launch(false).failure, None);
    f.write("lib/src/main/java/l/C.java", &c(2, ""));
    assert!(f.launch(false).failure.expect("lib fails").contains("U.java"));
    f.write("lib/src/main/java/l/U.java", "package l;\nclass U { int u() { return L.n(); } }\n");
    f.steps();
    assert_eq!(f.launch(false).failure, None);
    let steps = f.steps();
    assert!(steps.contains(&"javac app (main, 1 file)".to_owned()), "{steps:?}");
}

#[test]
fn reads_what_a_class_file_declares() {
    let Some((home, _)) = tools() else { return };
    let tmp = tempfile::tempdir().unwrap();
    let compile = |text: &str| {
        write(tmp.path(), "p/C.java", text);
        let status = std::process::Command::new(home.join("bin/javac"))
            .args(["-d", "out", "p/C.java"])
            .current_dir(tmp.path())
            .status()
            .unwrap();
        assert!(status.success());
        classfile::parse(&fs::read(tmp.path().join("out/p/C.class")).unwrap()).unwrap()
    };
    let a = compile(
        "package p;\nimport java.util.List;\npublic class C extends Thread implements Runnable {\n  public static final String K = \"k\";\n  @Deprecated public List<javax.swing.JButton> f;\n  public x.Y g() { return null; }\n  private int hidden() { return 1; }\n}\nclass Z {}\n"
            .replace("x.Y", "Object")
            .as_str(),
    );
    assert_eq!(a.name, "p/C");
    assert_eq!(a.super_name.as_deref(), Some("java/lang/Thread"));
    assert_eq!(a.interfaces, ["java/lang/Runnable"]);
    assert!(a.refs.contains("javax/swing/JButton"), "{:?}", a.refs);
    assert!(!a.refs.iter().any(|r| r.starts_with("java/")), "{:?}", a.refs);
    // Private members and method bodies aren't API; constants have their own fingerprint.
    let b = compile(
        "package p;\nimport java.util.List;\npublic class C extends Thread implements Runnable {\n  public static final String K = \"k\";\n  @Deprecated public List<javax.swing.JButton> f;\n  public Object g() { return \"x\"; }\n  private long hidden2() { return 1; }\n}\nclass Z {}\n",
    );
    assert_eq!((a.api, a.constants), (b.api, b.constants));
    let c = compile(
        "package p;\nimport java.util.List;\npublic class C extends Thread implements Runnable {\n  public static final String K = \"changed\";\n  @Deprecated public List<javax.swing.JButton> f;\n  public Object g() { return \"x\"; }\n}\nclass Z {}\n",
    );
    assert_eq!(a.api, c.api);
    assert_ne!(a.constants, c.constants);
    let d = compile(
        "package p;\nimport java.util.List;\npublic class C extends Thread implements Runnable {\n  public static final String K = \"k\";\n  @Deprecated public List<javax.swing.JLabel> f;\n  public Object g() { return \"x\"; }\n}\nclass Z {}\n",
    );
    assert_ne!(a.api, d.api);
}

#[test]
fn follows_api_changes_through_the_log() {
    let mut state = SetState { generation: 1, ..Default::default() };
    state.log(2, ["a/A".to_owned()].into(), false);
    state.log(3, ["a/B".to_owned()].into(), false);
    assert_eq!(state.changes_since(3), Some(BTreeSet::new()));
    assert_eq!(state.changes_since(2), Some(["a/B".to_owned()].into()));
    assert_eq!(state.changes_since(1), Some(["a/A".to_owned(), "a/B".to_owned()].into()));
    // Unknown generations, and a log entry where everything changed, mean everything.
    assert_eq!(state.changes_since(0), None);
    state.log(4, BTreeSet::new(), true);
    assert_eq!(state.changes_since(3), None);
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

#[test]
fn builds_gradle_projects_with_javac_and_only_what_changed() {
    let Some(f) = Fixture::gradle(&[
        (
            "lib/src/main/java/l/L.java",
            "package l;\npublic class L { public static String name() { return \"lib\"; } }\n",
        ),
        (
            "app/src/main/java/a/A.java",
            "package a;\npublic class A { public static void main(String[] args) { System.out.println(l.L.name()); } }\n",
        ),
        ("app/src/main/resources/app.properties", "version=${version}\n"),
        ("app/src/test/java/a/ATest.java", "package a;\npublic class ATest { String s = l.L.name(); }\n"),
    ]) else {
        return;
    };
    let steps = f.steps_of_launch();
    assert_eq!(steps.len(), 3, "{steps:?}");
    assert!(steps[0].contains("openideaBuildModel"), "{steps:?}");
    assert!(steps[1].starts_with("javac lib (main"), "{steps:?}");
    assert!(steps[2].starts_with("javac app (main"), "{steps:?}");
    assert!(f.out("t.lib/classes/l/L.class").is_file());
    assert!(f.out("t.app/classes/a/A.class").is_file());
    assert_eq!(fs::read_to_string(f.out("t.app/classes/app.properties")).unwrap(), "version=1\n");
    // Gradle's own outputs stay untouched.
    assert!(!f.root.join("app/build/classes").exists());

    let built = f.launch(false);
    assert!(built.class_paths.iter().any(|p| p.ends_with("t.lib/classes")), "{:?}", built.class_paths);
    assert!(!built.class_paths.iter().any(|p| p.extension().is_some_and(|e| e == "jar")), "{:?}", built.class_paths);
    assert_eq!(f.steps(), Vec::<String>::new(), "nothing changed");

    f.write(
        "app/src/main/java/a/A.java",
        "package a;\npublic class A { public static void main(String[] args) { System.out.println(l.L.name() + 1); } }\n",
    );
    let steps = f.steps_of_launch();
    assert_eq!(steps.len(), 1, "{steps:?}");
    assert!(steps[0].starts_with("javac app (main"), "{steps:?}");

    f.write("app/src/main/resources/app.properties", "version=${version}\nname=app\n");
    let steps = f.steps_of_launch();
    assert_eq!(steps.len(), 1, "{steps:?}");
    assert!(steps[0].contains(":app:processResources"), "{steps:?}");
    assert_eq!(fs::read_to_string(f.out("t.app/classes/app.properties")).unwrap(), "version=1\nname=app\n");

    // Tests compile against the main classes.
    f.steps();
    let built = f.launch(true);
    assert_eq!(built.failure, None, "{:?}", built.messages);
    assert!(f.out("t.app/test-classes/a/ATest.class").is_file());

    // A changed build script prepares again.
    f.write("lib/build.gradle", "// changed\n");
    let steps = f.steps_of_launch();
    assert!(steps[0].contains("openideaBuildModel"), "{steps:?}");

    // An error is a javac diagnostic on the source.
    f.write("lib/src/main/java/l/L.java", "package l;\npublic class L { public static String name() { return 1; } }\n");
    let built = f.launch(false);
    assert!(built.failure.is_some());
    let error = built.messages.iter().find(|m| m.severity == Severity::Error).expect("an error");
    assert_eq!(error.path.as_deref(), Some(f.root.join("lib/src/main/java/l/L.java").as_path()));
}

#[test]
fn leaves_gradle_projects_with_other_compilers_to_gradle() {
    let Some(f) = Fixture::gradle(&[
        ("app/build.gradle", "apply plugin: 'groovy'\ndependencies { implementation project(':lib') }\n"),
        ("app/src/main/java/a/A.java", "package a;\npublic class A {}\n"),
    ]) else {
        return;
    };
    let jdk = |_: Option<u32>| None;
    let build = JavaBuild {
        root: &f.root,
        model: &f.model,
        cache: &f.cache,
        jar: Path::new(JAR),
        jar_version: "test",
        local_repo: None,
        service: &f.service,
        jdk: &jdk,
    };
    let target = Target::Launch { module: &f.root.join("app"), test: false };
    match build.build(target, BuildKind::Build, &CancellationToken::new(), &|_| {}) {
        Ok(Built::Unsupported(reason)) => assert!(reason.contains("GroovyCompile"), "{reason}"),
        Ok(Built::Done(outputs)) => panic!("built: {outputs:?}"),
        Err(e) => panic!("{e:?}"),
    }
}
