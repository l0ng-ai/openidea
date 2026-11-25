mod common;

use ide_build::compile::BuildEvent;
use ide_core::RequestId;
use ide_host::{Host, ops};
use ide_run::BuildPolicy;
use ide_workspace::{SettingsStore, settings::SettingsScope};
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};

fn write(root: &Path, rel: &str, text: &str) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

/// A Maven launch compiles with the IDE's Java build (javac, outputs in the project cache)
/// and runs from its outputs. Needs `mvn` and a JDK (`JAVA_HOME`), else it is skipped.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn maven_launch_compiles_with_the_ides_java_build() {
    let has_jdk = std::env::var_os("JAVA_HOME").is_some_and(|h| Path::new(&h).join("bin").is_dir());
    if !has_jdk || ide_core::process::find_executable("mvn", &ide_core::tool_path::search_path()).is_none() {
        eprintln!("skipped: needs JAVA_HOME and mvn");
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let root = base.join("project");
    write(
        &root,
        "pom.xml",
        r#"<project><modelVersion>4.0.0</modelVersion><groupId>t</groupId><artifactId>root</artifactId><version>1</version><packaging>pom</packaging>
<modules><module>lib</module><module>app</module></modules>
<properties><maven.compiler.release>11</maven.compiler.release><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties></project>"#,
    );
    write(
        &root,
        "lib/pom.xml",
        r#"<project><modelVersion>4.0.0</modelVersion><parent><groupId>t</groupId><artifactId>root</artifactId><version>1</version></parent><artifactId>lib</artifactId></project>"#,
    );
    write(
        &root,
        "app/pom.xml",
        r#"<project><modelVersion>4.0.0</modelVersion><parent><groupId>t</groupId><artifactId>root</artifactId><version>1</version></parent><artifactId>app</artifactId>
<dependencies><dependency><groupId>t</groupId><artifactId>lib</artifactId><version>1</version></dependency></dependencies></project>"#,
    );
    write(
        &root,
        "lib/src/main/java/l/L.java",
        "package l;\npublic class L { public static String name() { return \"lib\"; } }\n",
    );
    write(
        &root,
        "app/src/main/java/a/A.java",
        "package a;\npublic class A { public static void main(String[] args) { System.out.println(l.L.name()); } }\n",
    );
    // No language server: the build tool compiles the launch.
    let global = SettingsStore::load(&base.join("config"), None);
    for server in ["jdtls", "java-analyzer", "kmp-lsp"] {
        global
            .set(SettingsScope::Global, &format!("languageServers.{server}.enabled"), serde_json::json!(false))
            .unwrap();
    }
    let host = Host::new(common::host_config(&base));
    host.trust.decide(&root, true, false).unwrap();
    host.open_project("main", &root).unwrap();

    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let channel = ops::Channel::new(move |event: BuildEvent| sink.lock().unwrap().push(event));
    let info = ops::java::java_resolve_launch(
        &host,
        "main",
        root.join("app"),
        false,
        false,
        BuildPolicy::Make,
        RequestId::next(),
        channel,
    )
    .await
    .unwrap();
    let steps: Vec<String> = events
        .lock()
        .unwrap()
        .iter()
        .filter_map(|e| match e {
            BuildEvent::Step { command, .. } => Some(command.clone()),
            _ => None,
        })
        .collect();
    assert!(steps.iter().any(|s| s.starts_with("javac lib")), "{steps:?}");
    assert!(steps.iter().any(|s| s.starts_with("javac app")), "{steps:?}");
    assert!(!steps.iter().any(|s| s.contains("-am")), "{steps:?}");
    let first = Path::new(&info.class_paths[0]);
    assert!(first.ends_with("out/t.app/classes"), "{:?}", info.class_paths);
    assert!(first.join("a/A.class").is_file());
    assert!(info.class_paths.iter().any(|p| Path::new(p).ends_with("out/t.lib/classes")), "{:?}", info.class_paths);
    assert!(!root.join("app/target/classes").exists());

    // Build › Build Project compiles with it too, and reports javac's errors.
    write(&root, "lib/src/main/java/l/L.java", "package l;\npublic class L { }\n");
    let built = ops::build::build_run(
        &host,
        "main",
        ide_build::compile::BuildKind::Build,
        None,
        None,
        RequestId::next(),
        Vec::new(),
        ops::Channel::new(|_: BuildEvent| {}),
    )
    .await
    .unwrap();
    assert_eq!(built.system, ide_build::compile::BuildSystem::Javac);
    assert!(!built.success);
    assert_eq!(built.errors, 1, "{:?}", built.messages);
    assert!(built.messages[0].path.as_deref().is_some_and(|p| p.ends_with("a/A.java")), "{:?}", built.messages);
    assert!(!root.join("lib/target/classes").exists());
    host.shutdown().await;
}

/// With Settings › Gradle › Build and run using: IDE, a Gradle launch and Build Project compile
/// with the IDE's Java build too. Needs a JDK (`JAVA_HOME`) and Gradle (`OPENIDEA_TEST_GRADLE`).
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gradle_launch_compiles_with_the_ides_java_build() {
    let has_jdk = std::env::var_os("JAVA_HOME").is_some_and(|h| Path::new(&h).join("bin").is_dir());
    let Some(gradle) = std::env::var_os("OPENIDEA_TEST_GRADLE").filter(|_| has_jdk) else {
        eprintln!("skipped: needs JAVA_HOME and OPENIDEA_TEST_GRADLE");
        return;
    };
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let root = base.join("project");
    write(&root, "settings.gradle", "rootProject.name = 'root'\ninclude 'lib', 'app'\n");
    write(&root, "build.gradle", "subprojects {\n  apply plugin: 'java'\n  group = 't'\n}\n");
    write(&root, "lib/build.gradle", "");
    write(&root, "app/build.gradle", "dependencies { implementation project(':lib') }\n");
    write(&root, "gradlew", &format!("#!/bin/sh\nexec '{}' \"$@\"\n", Path::new(&gradle).display()));
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(root.join("gradlew"), fs::Permissions::from_mode(0o755)).unwrap();
    write(
        &root,
        "lib/src/main/java/l/L.java",
        "package l;\npublic class L { public static String name() { return \"lib\"; } }\n",
    );
    write(
        &root,
        "app/src/main/java/a/A.java",
        "package a;\npublic class A { public static void main(String[] args) { System.out.println(l.L.name()); } }\n",
    );
    let global = SettingsStore::load(&base.join("config"), None);
    for server in ["jdtls", "java-analyzer", "kmp-lsp"] {
        global
            .set(SettingsScope::Global, &format!("languageServers.{server}.enabled"), serde_json::json!(false))
            .unwrap();
    }
    global.set(SettingsScope::Global, "languages.java.gradle.runUsing", serde_json::json!("ide")).unwrap();
    let host = Host::new(common::host_config(&base));
    host.trust.decide(&root, true, false).unwrap();
    host.open_project("main", &root).unwrap();

    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let channel = ops::Channel::new(move |event: BuildEvent| sink.lock().unwrap().push(event));
    let info = ops::java::java_resolve_launch(
        &host,
        "main",
        root.join("app"),
        false,
        false,
        BuildPolicy::Make,
        RequestId::next(),
        channel,
    )
    .await
    .unwrap();
    let steps: Vec<String> = events
        .lock()
        .unwrap()
        .iter()
        .filter_map(|e| match e {
            BuildEvent::Step { command, .. } => Some(command.clone()),
            _ => None,
        })
        .collect();
    assert!(steps.iter().any(|s| s.contains("openideaBuildModel")), "{steps:?}");
    assert!(steps.iter().any(|s| s.starts_with("javac lib")), "{steps:?}");
    assert!(steps.iter().any(|s| s.starts_with("javac app")), "{steps:?}");
    let first = Path::new(&info.class_paths[0]);
    assert!(first.ends_with("out/t.app/classes"), "{:?}", info.class_paths);
    assert!(first.join("a/A.class").is_file());
    assert!(info.class_paths.iter().any(|p| Path::new(p).ends_with("out/t.lib/classes")), "{:?}", info.class_paths);
    assert!(!root.join("app/build/classes").exists());

    write(&root, "lib/src/main/java/l/L.java", "package l;\npublic class L { }\n");
    let built = ops::build::build_run(
        &host,
        "main",
        ide_build::compile::BuildKind::Build,
        None,
        None,
        RequestId::next(),
        Vec::new(),
        ops::Channel::new(|_: BuildEvent| {}),
    )
    .await
    .unwrap();
    assert_eq!(built.system, ide_build::compile::BuildSystem::Javac);
    assert_eq!(built.errors, 1, "{:?}", built.messages);
    assert!(built.messages[0].path.as_deref().is_some_and(|p| p.ends_with("a/A.java")), "{:?}", built.messages);
    host.shutdown().await;
}
