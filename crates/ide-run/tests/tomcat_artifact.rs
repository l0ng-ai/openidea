//! Opt-in build-tool integration checks: cargo test -p ide-run --test tomcat_artifact -- --ignored
use std::{fs, path::Path, process::Command};

fn write(root: &Path, path: &str, text: &str) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn build_and_deploy(root: &Path, id: &str, expected: &Path) {
    let cache = root.join("工作 cache");
    let model = ide_build::load(root, &cache, None);
    let mut plan = ide_build::web::build(root, &model, id, &cache).unwrap();
    plan.resolve_project(root, &std::env::vars().collect(), &ide_core::CancellationToken::new()).unwrap();
    let output = Command::new(&plan.command)
        .args(&plan.args)
        .envs(&plan.env)
        .current_dir(root.join(&plan.cwd))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let manifest = fs::read_to_string(cache.join("artifact-path.txt")).unwrap();
    assert_eq!(Path::new(manifest.trim()).canonicalize().unwrap(), expected.canonicalize().unwrap());
    let mut config: ide_run::RunConfig = serde_json::from_value(serde_json::json!({
        "id": "tomcat:test", "name": "Tomcat", "kind": "tomcat", "command": "catalina",
        "args": [], "env": {}, "detected": false, "isTest": false
    }))
    .unwrap();
    config.cwd = Some("timesheet".into());
    config.extras.params.insert("artifact".into(), id.into());
    let deployed = ide_run::tomcat::deployment(root, &cache, &config, false).unwrap();
    assert_eq!(fs::read_to_string(deployed.join("index.html")).unwrap(), "issue 515 timesheet");
    let siblings: Vec<_> = fs::read_dir(expected.parent().unwrap())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains(".war."))
        .collect();
    assert!(siblings.is_empty(), "Unexpected WAR siblings: {siblings:?}");
}

#[test]
#[ignore = "requires Maven and downloads Maven plugins"]
fn maven_packaged_artifacts_deploy_from_root_and_nested_reactors() {
    for (reactor, module, custom) in
        [("", "", false), ("", "timesheet", false), ("parent", "apps/timesheet", true), ("timesheet", "", true)]
    {
        let tmp = tempfile::Builder::new().prefix("tomcat maven ").tempdir().unwrap();
        let root = tmp.path();
        let reactor_dir = root.join(reactor);
        let module_dir = reactor_dir.join(module);
        let plugins = "<pluginManagement><plugins><plugin><artifactId>maven-war-plugin</artifactId><version>3.4.0</version><configuration><failOnMissingWebXml>false</failOnMissingWebXml></configuration></plugin></plugins></pluginManagement>";
        let parent = if module.is_empty() && custom {
            write(&reactor_dir, ".mvn/maven.config", "-Drevision=2\n");
            "<groupId>test</groupId><version>${revision}</version><properties><revision>1</revision></properties>"
                .to_owned()
        } else if module.is_empty() {
            "<groupId>test</groupId><version>1</version>".to_owned()
        } else {
            write(
                &reactor_dir,
                "pom.xml",
                &format!(
                    "<project><modelVersion>4.0.0</modelVersion><groupId>test</groupId><artifactId>parent</artifactId><version>1</version><packaging>pom</packaging><modules><module>core</module><module>{module}</module></modules><build>{plugins}</build></project>"
                ),
            );
            write(
                &reactor_dir,
                "core/pom.xml",
                "<project><modelVersion>4.0.0</modelVersion><parent><groupId>test</groupId><artifactId>parent</artifactId><version>1</version></parent><artifactId>core</artifactId></project>",
            );
            let relative = "../".repeat(module.split('/').count());
            format!(
                "<parent><groupId>test</groupId><artifactId>parent</artifactId><version>1</version><relativePath>{relative}pom.xml</relativePath></parent>"
            )
        };
        let dependency = if module.is_empty() {
            ""
        } else {
            "<dependencies><dependency><groupId>test</groupId><artifactId>core</artifactId><version>1</version></dependency></dependencies>"
        };
        let output = if custom {
            "<directory>${project.basedir}/custom output</directory><finalName>custom-timesheet</finalName>"
        } else {
            "<finalName>timesheet</finalName>"
        };
        write(
            &module_dir,
            "pom.xml",
            &format!(
                "<project><modelVersion>4.0.0</modelVersion>{parent}<artifactId>timesheet</artifactId><packaging>war</packaging>{dependency}<build>{plugins}{output}</build></project>"
            ),
        );
        write(&module_dir, "src/main/webapp/index.html", "issue 515 timesheet");
        if custom && !module.is_empty() {
            for dir in [&reactor_dir, &reactor_dir.join("core"), &module_dir] {
                let pom = dir.join("pom.xml");
                let text =
                    fs::read_to_string(&pom).unwrap().replace("<version>1</version>", "<version>${revision}</version>");
                fs::write(pom, text).unwrap();
            }
            let pom = reactor_dir.join("pom.xml");
            fs::write(
                &pom,
                fs::read_to_string(&pom).unwrap().replace(
                    "<packaging>pom</packaging>",
                    "<packaging>pom</packaging><properties><revision>1</revision></properties>",
                ),
            )
            .unwrap();
            write(&reactor_dir, ".mvn/maven.config", "-Drevision=2\n");
            write(&module_dir, ".mvn/maven.config", "-Drevision=3\n");
        }
        let pom = module_dir.join("pom.xml").strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
        let expected =
            module_dir.join(if custom { "custom output/custom-timesheet.war" } else { "target/timesheet.war" });
        build_and_deploy(root, &format!("maven:{pom}"), &expected);
    }
}

#[test]
#[ignore = "requires Gradle"]
fn gradle_packaged_artifacts_deploy_with_custom_archive_names() {
    for module in ["", "apps/timesheet"] {
        let tmp = tempfile::Builder::new().prefix("tomcat gradle ").tempdir().unwrap();
        let root = tmp.path();
        let settings = if module.is_empty() {
            "rootProject.name = 'timesheet'\n"
        } else {
            "rootProject.name = 'timesheet'\ninclude 'apps:timesheet'\n"
        };
        write(root, "settings.gradle", settings);
        write(
            &root.join(module),
            "build.gradle",
            "plugins { id 'war' }\ntasks.named('war') { archiveFileName = 'custom-timesheet.war'; destinationDirectory = layout.projectDirectory.dir('custom output') }\n",
        );
        write(&root.join(module), "src/main/webapp/index.html", "issue 515 timesheet");
        let project = if module.is_empty() { ":" } else { ":apps:timesheet" };
        build_and_deploy(
            root,
            &format!("gradle:{project}"),
            &root.join(module).join("custom output/custom-timesheet.war"),
        );
    }
}
