use ide_core::NullSink;
use ide_host::{Host, HostConfig, ops};
use ide_workspace::settings::SettingsScope;
use std::path::Path;
use std::sync::Arc;

fn host(base: &Path) -> Host {
    Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    })
}

fn write(root: &Path, rel: &str, text: &str) {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn module(root: &Path, name: &str, properties: &str) {
    write(
        root,
        &format!("{name}/pom.xml"),
        &format!(
            "<project><parent><groupId>demo</groupId><artifactId>parent</artifactId><version>1</version></parent>\
             <artifactId>{name}</artifactId><properties>{properties}</properties></project>"
        ),
    );
}

fn reactor(root: &Path, modules: &[(&str, &str)]) {
    let listed: String = modules.iter().map(|(name, _)| format!("<module>{name}</module>")).collect();
    write(
        root,
        "pom.xml",
        &format!(
            "<project><groupId>demo</groupId><artifactId>parent</artifactId><version>1</version>\
             <packaging>pom</packaging><modules>{listed}</modules></project>"
        ),
    );
    for (name, encoding) in modules {
        let properties = if encoding.is_empty() {
            String::new()
        } else {
            format!("<project.build.sourceEncoding>{encoding}</project.build.sourceEncoding>")
        };
        module(root, name, &properties);
    }
}

/// Encoding of a new ASCII source at `rel`, as the editor opens it.
fn opened(project: &ide_host::Project, rel: &str) -> String {
    write(&project.root, rel, "class A {}\n");
    project.documents.open(&project.root.join(rel)).unwrap().encoding
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ascii_sources_of_a_maven_module_open_in_the_source_encoding_of_its_pom() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let root = base.join("project");
    reactor(
        &root,
        &[
            ("legacy", "ISO-8859-15"),
            ("windows", "Cp1252"),
            ("java-name", "ISO8859_15"),
            ("modern", "UTF8"),
            ("unknown", "X-NO-SUCH-CHARSET"),
            ("wide", "UTF-16"),
            ("plain", ""),
        ],
    );
    let host = host(&base);
    host.trust.decide(&root, true, false).unwrap();
    let project = host.open_project("main", &root).unwrap();

    assert_eq!(opened(&project, "legacy/src/main/java/A.java"), "iso-8859-15");
    assert_eq!(opened(&project, "windows/src/main/java/A.java"), "windows-1252");
    assert_eq!(opened(&project, "java-name/src/main/java/A.java"), "iso-8859-15");
    // Nothing configured, or nothing the editor can apply to ASCII text: detection, as before.
    for unchanged in ["modern", "unknown", "wide", "plain"] {
        assert_eq!(opened(&project, &format!("{unchanged}/src/main/java/A.java")), "utf-8", "{unchanged}");
    }
    assert_eq!(opened(&project, "README.java"), "utf-8", "outside every module with an encoding");
    assert_eq!(opened(&project, "legacy/Notes.java"), "utf-8", "beside the POM, not a source");

    // The POM wins over the project encoding, and a settings change keeps what the POM said.
    ops::project::set_settings(&host, "main", SettingsScope::Project, "editor.encodings.project", "\"gbk\"").unwrap();
    assert_eq!(opened(&project, "legacy/src/main/java/B.java"), "iso-8859-15");
    assert_eq!(opened(&project, "modern/src/main/java/B.java"), "utf-8", "UTF-8 in the POM is a choice too");
    assert_eq!(opened(&project, "plain/src/main/java/B.java"), "gbk");

    // `.editorconfig` wins over the POM.
    write(&root, "legacy/.editorconfig", "[*.java]\ncharset = utf-8\n");
    assert_eq!(opened(&project, "legacy/src/main/java/C.java"), "utf-8");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pom_edit_reaches_new_documents_when_the_build_model_reloads() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let root = base.join("project");
    reactor(&root, &[("app", "")]);
    let host = host(&base);
    host.trust.decide(&root, true, false).unwrap();
    let project = host.open_project("main", &root).unwrap();
    assert_eq!(opened(&project, "app/src/main/java/A.java"), "utf-8");

    module(&root, "app", "<project.build.sourceEncoding>ISO-8859-15</project.build.sourceEncoding>");
    let model = ops::build::build_model(&host, "main").await.unwrap();
    let app = model.maven.unwrap().projects.into_iter().find(|p| p.dir == "app").unwrap();
    assert_eq!(app.source_encoding.as_deref(), Some("ISO-8859-15"));
    assert_eq!(opened(&project, "app/src/main/java/B.java"), "iso-8859-15");

    module(&root, "app", "");
    ops::build::build_model(&host, "main").await.unwrap();
    assert_eq!(opened(&project, "app/src/main/java/C.java"), "utf-8");
}
