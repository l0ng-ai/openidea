use ide_run::{RunConfig, detect};
use std::fs;
use std::path::Path;
use tempfile::TempDir;

fn project(files: &[(&str, &str)]) -> TempDir {
    let dir = tempfile::tempdir().unwrap();
    for (path, content) in files {
        let p = dir.path().join(path);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, content).unwrap();
    }
    dir
}

fn find<'a>(configs: &'a [RunConfig], id: &str) -> &'a RunConfig {
    configs
        .iter()
        .find(|c| c.id == id)
        .unwrap_or_else(|| panic!("missing {id}; have {:?}", configs.iter().map(|c| &c.id).collect::<Vec<_>>()))
}

fn ids(configs: &[RunConfig]) -> Vec<&str> {
    configs.iter().map(|c| c.id.as_str()).collect()
}

fn cmdline(c: &RunConfig) -> String {
    std::iter::once(c.command.as_str()).chain(c.args.iter().map(String::as_str)).collect::<Vec<_>>().join(" ")
}

#[test]
fn empty_project_detects_nothing() {
    let dir = tempfile::tempdir().unwrap();
    assert!(detect(dir.path()).is_empty());
    assert!(detect(Path::new("/definitely/not/here")).is_empty());
}

#[test]
fn npm_scripts_with_lockfile_package_manager() {
    let dir = project(&[
        ("package.json", r#"{"scripts":{"dev":"vite","test":"vitest","build":"vite build","test:e2e":"playwright"}}"#),
        ("pnpm-lock.yaml", ""),
    ]);
    let c = detect(dir.path());
    assert_eq!(ids(&c), ["npm:build", "npm:dev", "npm:test", "npm:test:e2e"]);
    let dev = find(&c, "npm:dev");
    assert_eq!(cmdline(dev), "pnpm run dev");
    assert!(dev.detected && !dev.is_test);
    assert_eq!(dev.kind, "npm");
    assert!(find(&c, "npm:test").is_test);
    assert!(find(&c, "npm:test:e2e").is_test);
}

#[test]
fn package_manager_selection() {
    for (lock, pm) in [("yarn.lock", "yarn"), ("bun.lockb", "bun"), ("bun.lock", "bun"), ("package-lock.json", "npm")] {
        let dir = project(&[("package.json", r#"{"scripts":{"start":"node ."}}"#), (lock, "")]);
        assert_eq!(find(&detect(dir.path()), "npm:start").command, pm, "{lock}");
    }
    let dir = project(&[("package.json", r#"{"packageManager":"yarn@4.1.0","scripts":{"start":"x"}}"#)]);
    assert_eq!(find(&detect(dir.path()), "npm:start").command, "yarn");
}

#[test]
fn npm_workspace_packages() {
    let dir = project(&[
        ("package.json", r#"{"workspaces":["packages/*"],"scripts":{"lint":"eslint"}}"#),
        ("packages/web/package.json", r#"{"name":"@acme/web","scripts":{"dev":"vite"}}"#),
        ("packages/api/package.json", r#"{"scripts":{"test":"jest"}}"#),
        ("packages/notapkg/readme.md", ""),
    ]);
    let c = detect(dir.path());
    let web = find(&c, "npm:@acme/web:dev");
    assert_eq!(web.cwd.as_deref(), Some(Path::new("packages/web")));
    assert_eq!(cmdline(web), "npm run dev");
    let api = find(&c, "npm:packages/api:test");
    assert!(api.is_test);

    let dir = project(&[
        ("package.json", "{}"),
        ("pnpm-lock.yaml", ""),
        ("pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n  - \"libs/core\"\n"),
        ("apps/site/package.json", r#"{"name":"site","scripts":{"build":"astro build"}}"#),
        ("libs/core/package.json", r#"{"name":"core","scripts":{"test":"vitest"}}"#),
    ]);
    let c = detect(dir.path());
    assert_eq!(cmdline(find(&c, "npm:site:build")), "pnpm run build");
    assert!(find(&c, "npm:core:test").is_test);
}

#[test]
fn cargo_single_package() {
    let dir =
        project(&[("Cargo.toml", "[package]\nname = \"app\"\nversion = \"0.1.0\"\n"), ("src/main.rs", "fn main() {}")]);
    let c = detect(dir.path());
    assert_eq!(ids(&c), ["cargo:run:app", "cargo:test", "cargo:build"]);
    let run = find(&c, "cargo:run:app");
    assert_eq!(cmdline(run), "cargo run");
    assert_eq!(run.debug_adapter.as_deref(), Some("codelldb"));
    assert!(find(&c, "cargo:test").is_test);
    assert_eq!(cmdline(find(&c, "cargo:test")), "cargo test");
}

#[test]
fn cargo_multiple_bins() {
    let dir = project(&[
        (
            "Cargo.toml",
            "[package]\nname = \"tool\"\nversion = \"0.1.0\"\n\n[[bin]]\nname = \"special\"\npath = \"tools/special.rs\"\n",
        ),
        ("src/main.rs", ""),
        ("src/bin/extra.rs", ""),
        ("src/bin/multi/main.rs", ""),
    ]);
    let c = detect(dir.path());
    assert_eq!(cmdline(find(&c, "cargo:run:tool")), "cargo run --bin tool");
    assert_eq!(cmdline(find(&c, "cargo:run:special")), "cargo run --bin special");
    assert_eq!(cmdline(find(&c, "cargo:run:extra")), "cargo run --bin extra");
    assert_eq!(cmdline(find(&c, "cargo:run:multi")), "cargo run --bin multi");
}

#[test]
fn cargo_workspace() {
    let dir = project(&[
        ("Cargo.toml", "[workspace]\nmembers = [\"crates/*\", \"cli\"]\nexclude = [\"crates/skip\"]\n"),
        ("crates/core/Cargo.toml", "[package]\nname = \"core\"\n"),
        ("crates/core/src/lib.rs", ""),
        ("crates/skip/Cargo.toml", "[package]\nname = \"skip\"\n"),
        ("crates/skip/src/main.rs", ""),
        ("cli/Cargo.toml", "[package]\nname = \"openidea-cli\"\n"),
        ("cli/src/main.rs", ""),
    ]);
    let c = detect(dir.path());
    assert_eq!(ids(&c), ["cargo:run:openidea-cli", "cargo:test", "cargo:build"]);
    assert_eq!(cmdline(&c[0]), "cargo run -p openidea-cli --bin openidea-cli");
    assert_eq!(cmdline(find(&c, "cargo:test")), "cargo test --workspace");
}

#[test]
fn gradle_projects() {
    let dir = project(&[
        ("build.gradle.kts", "plugins {\n    application\n    id(\"org.springframework.boot\") version \"3.2.0\"\n}\n"),
        ("gradlew", "#!/bin/sh"),
    ]);
    let c = detect(dir.path());
    assert_eq!(ids(&c), ["gradle:build", "gradle:test", "gradle:run", "gradle:bootRun"]);
    if cfg!(unix) {
        assert_eq!(cmdline(find(&c, "gradle:bootRun")), "./gradlew bootRun");
    }
    assert!(find(&c, "gradle:test").is_test);

    let dir = project(&[("build.gradle", "plugins { id 'java' }\n")]);
    let c = detect(dir.path());
    assert_eq!(ids(&c), ["gradle:build", "gradle:test"]);
    assert_eq!(c[0].command, "gradle");

    let dir = project(&[("build.gradle", "apply plugin: 'application'\n")]);
    assert!(detect(dir.path()).iter().any(|c| c.id == "gradle:run"));

    // Multi-module: Spring Boot applied in a subproject.
    let dir = project(&[
        ("settings.gradle", "include 'app'"),
        ("build.gradle", ""),
        ("app/build.gradle", "plugins { id 'org.springframework.boot' version '3.2.0' }"),
    ]);
    assert!(detect(dir.path()).iter().any(|c| c.id == "gradle:bootRun"));
}

#[test]
fn maven_projects() {
    let pom = "<project><build><plugins><plugin><groupId>org.springframework.boot</groupId>\
               <artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>";
    let dir = project(&[("pom.xml", pom), ("mvnw", "#!/bin/sh")]);
    let c = detect(dir.path());
    assert_eq!(ids(&c), ["maven:package", "maven:test", "maven:spring-boot:run"]);
    if cfg!(unix) {
        assert_eq!(cmdline(find(&c, "maven:test")), "./mvnw test");
    }
    assert!(find(&c, "maven:test").is_test);

    let dir = project(&[("pom.xml", "<project/>")]);
    let c = detect(dir.path());
    assert_eq!(ids(&c), ["maven:package", "maven:test"]);
    assert_eq!(c[0].command, "mvn");
}

const BOOT_POM: &str = "<project><artifactId>app</artifactId><build><plugins><plugin>\
                        <artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>";
const PARENT_POM: &str = "<project><packaging>pom</packaging><modules><module>app</module></modules>\
                          <build><pluginManagement><plugins><plugin>\
                          <artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></pluginManagement>\
                          </build></project>";
const BOOT_MAIN: &str = "package org.dromara;\n\nimport org.springframework.boot.SpringApplication;\n\
                         import org.springframework.boot.autoconfigure.SpringBootApplication;\n\n\
                         /** Entry. */\n@SpringBootApplication\npublic class DromaraApplication {\n\
                         \x20   public static void main(String[] args) {\n\
                         \x20       SpringApplication.run(DromaraApplication.class, args);\n    }\n}\n";

/// A folder holding a Maven back end and an npm front end, each its own repository
/// (RuoYi-Vue-Plus + plus-ui): the Maven build is detected where it is.
#[test]
fn builds_nested_in_a_folder_of_repositories() {
    let dir = project(&[
        ("RuoYi-Vue-Plus/pom.xml", PARENT_POM),
        ("RuoYi-Vue-Plus/ruoyi-admin/pom.xml", BOOT_POM),
        ("RuoYi-Vue-Plus/ruoyi-admin/src/main/java/org/dromara/DromaraApplication.java", BOOT_MAIN),
        ("RuoYi-Vue-Plus/ruoyi-admin/src/main/java/org/dromara/web/Controller.java", "package org.dromara.web;"),
        ("RuoYi-Vue-Plus/ruoyi-common/pom.xml", "<project><packaging>pom</packaging></project>"),
        ("RuoYi-Vue-Plus/ruoyi-common/ruoyi-common-core/pom.xml", "<project/>"),
        ("RuoYi-Vue-Plus/ruoyi-common/ruoyi-common-core/src/main/java/A.java", "class A {}"),
        ("plus-ui/package.json", r#"{"scripts":{"dev":"vite"}}"#),
    ]);
    let c = detect(dir.path());
    let app = find(&c, "application:RuoYi-Vue-Plus/ruoyi-admin:org.dromara.DromaraApplication");
    assert_eq!(app.name, "DromaraApplication");
    assert_eq!(app.kind, "spring-boot");
    assert_eq!(cmdline(app), "java -cp ${classpath} org.dromara.DromaraApplication");
    assert_eq!(app.cwd.as_deref(), Some(Path::new("RuoYi-Vue-Plus/ruoyi-admin")));
    assert_eq!(app.debug_adapter.as_deref(), Some("java-debug"));
    let package = find(&c, "maven:package:RuoYi-Vue-Plus");
    assert_eq!(package.name, "RuoYi-Vue-Plus: mvn package");
    assert_eq!(cmdline(package), "mvn package");
    assert_eq!(package.cwd.as_deref(), Some(Path::new("RuoYi-Vue-Plus")));
    assert!(find(&c, "maven:test:RuoYi-Vue-Plus").is_test);
    assert!(ids(&c).contains(&"maven:spring-boot:run:RuoYi-Vue-Plus"));
    assert!(ids(&c).contains(&"npm:plus-ui:dev"));
    // Modules of the nested build are not builds of their own; only one application.
    assert!(!ids(&c).iter().any(|id| id.contains("ruoyi-common")));
    assert_eq!(c.iter().filter(|c| c.kind == "spring-boot").count(), 1);
}

/// RuoYi-AI opened from the folder above it (`ites-agent/ruoyi-ai`), or two folders above:
/// its application class builds the `SpringApplication` itself.
#[test]
fn spring_boot_application_of_a_repository_nested_one_or_two_levels_down() {
    const MAIN: &str = "package org.ruoyi;\n\nimport org.springframework.boot.SpringApplication;\n\
                        import org.springframework.boot.autoconfigure.SpringBootApplication;\n\n\
                        /**\n * 启动程序\n *\n * @author Lion Li\n */\n@SpringBootApplication\n\
                        public class RuoYiAIApplication {\n\n    public static void main(String[] args) {\n\
                        \x20       SpringApplication application = new SpringApplication(RuoYiAIApplication.class);\n\
                        \x20       application.run(args);\n\
                        \x20       System.out.println(\"(♥◠‿◠)ﾉﾞ     RuoYi-AI启动成功   ლ(´ڡ`ლ)\");\n    }\n}\n";
    for prefix in ["", "ites-agent/"] {
        let file = |p: &str| format!("{prefix}ruoyi-ai/{p}");
        let files = [
            (file("pom.xml"), PARENT_POM),
            (file("ruoyi-admin/pom.xml"), BOOT_POM),
            (file("ruoyi-admin/src/main/java/org/ruoyi/RuoYiAIApplication.java"), MAIN),
            (file("ruoyi-admin/src/main/java/org/ruoyi/RuoYiAIServletInitializer.java"), "package org.ruoyi;"),
            (file("ruoyi-common/pom.xml"), "<project><packaging>pom</packaging></project>"),
            (file("ruoyi-modules/ruoyi-chat/pom.xml"), "<project/>"),
            (file("docs/README.md"), "docs"),
        ];
        let files: Vec<(&str, &str)> = files.iter().map(|(p, t)| (p.as_str(), *t)).collect();
        let dir = project(&files);
        let c = detect(dir.path());
        let module = format!("{prefix}ruoyi-ai/ruoyi-admin");
        let app = find(&c, &format!("application:{module}:org.ruoyi.RuoYiAIApplication"));
        assert_eq!((app.name.as_str(), app.kind.as_str()), ("RuoYiAIApplication", "spring-boot"), "{prefix}");
        assert_eq!(app.cwd.as_deref(), Some(Path::new(&module)));
        assert!(ids(&c).contains(&format!("maven:spring-boot:run:{prefix}ruoyi-ai").as_str()), "{prefix}");
    }
}

#[test]
fn nested_builds_of_every_kind_and_depth() {
    let dir = project(&[
        ("services/api/settings.gradle.kts", "include(\"app\")"),
        ("services/api/gradlew", "#!/bin/sh"),
        ("services/api/app/build.gradle.kts", "plugins { id(\"org.springframework.boot\") version \"3.3.0\" }\n"),
        (
            "services/api/app/src/main/kotlin/com/acme/Api.kt",
            "package com.acme\n\n@SpringBootApplication\nclass Api\n\nfun main(args: Array<String>) {\n    runApplication<Api>(*args)\n}\n",
        ),
        ("billing/pom.xml", BOOT_POM),
        ("billing/mvnw", "#!/bin/sh"),
        (
            "billing/src/main/java/Billing.java",
            "@SpringBootApplication\nclass Billing { public static void main(String[] a) {} }",
        ),
        // Deeper than a build is looked for.
        ("a/b/c/d/pom.xml", "<project/>"),
        // Build output and sources are not searched.
        ("web/node_modules/x/pom.xml", "<project/>"),
        ("tool/src/pom.xml", "<project/>"),
    ]);
    let c = detect(dir.path());
    let boot = find(&c, "gradle:bootRun:services/api");
    assert_eq!(boot.name, "services/api: gradle bootRun");
    assert_eq!(boot.cwd.as_deref(), Some(Path::new("services/api")));
    if cfg!(unix) {
        assert_eq!(cmdline(boot), "./gradlew bootRun");
        assert_eq!(cmdline(find(&c, "maven:package:billing")), "./mvnw package");
    }
    assert!(find(&c, "gradle:test:services/api").is_test);
    let api = find(&c, "application:services/api/app:com.acme.ApiKt");
    assert_eq!(api.cwd.as_deref(), Some(Path::new("services/api/app")));
    let billing = find(&c, "application:billing:Billing");
    assert_eq!(billing.cwd.as_deref(), Some(Path::new("billing")));
    let builds: Vec<&str> =
        ids(&c).into_iter().filter(|id| id.starts_with("maven:package") || id.starts_with("gradle:build")).collect();
    assert_eq!(builds, ["gradle:build:services/api", "maven:package:billing"]);
}

#[test]
fn a_root_build_disables_the_nested_scan() {
    let dir = project(&[
        ("pom.xml", BOOT_POM),
        (
            "src/main/java/demo/App.java",
            "package demo;\n@SpringBootApplication public class App {\n  public static void main(String[] args) {}\n}\n",
        ),
        ("tools/gen/pom.xml", "<project/>"),
    ]);
    let c = detect(dir.path());
    assert!(ids(&c).contains(&"maven:package"));
    assert!(!ids(&c).iter().any(|id| id.contains("tools")));
    let app = find(&c, "application:demo.App");
    assert_eq!(app.cwd, None);
}

#[test]
fn spring_boot_applications_need_the_plugin_and_a_main() {
    let main =
        "package demo;\n@SpringBootApplication\npublic class App {\n  public static void main(String[] args) {}\n}\n";
    // A library using Spring Boot without the plugin, a configuration class without `main`,
    // the annotation in a comment, a parent POM.
    let dir = project(&[
        ("lib/pom.xml", "<project><dependencies>spring-boot-starter</dependencies></project>"),
        ("lib/src/main/java/demo/App.java", main),
        ("svc/pom.xml", BOOT_POM),
        ("svc/src/main/java/demo/Config.java", "package demo;\n@SpringBootApplication\npublic class Config {}\n"),
        (
            "svc/src/main/java/demo/Old.java",
            "package demo;\n// @SpringBootApplication\nclass Old { public static void main(String[] a) {} }\n",
        ),
        ("gr/build.gradle", "dependencies { implementation 'org.springframework.boot:spring-boot-starter' }\n"),
        ("gr/src/main/java/demo/App.java", main),
    ]);
    let c = detect(dir.path());
    assert!(!c.iter().any(|c| c.kind == "spring-boot"), "{:?}", ids(&c));
}

#[test]
fn go_projects() {
    let dir = project(&[
        ("go.mod", "module example.com/x\n"),
        ("main.go", "// comment\npackage main\n\nfunc main() {}\n"),
        ("main_test.go", "package main\n"),
        ("cmd/server/main.go", "package main\n"),
        ("cmd/lib/lib.go", "package lib\n"),
    ]);
    let c = detect(dir.path());
    assert_eq!(ids(&c), ["go:run", "go:run:server", "go:test"]);
    assert_eq!(cmdline(find(&c, "go:run:server")), "go run ./cmd/server");
    assert_eq!(cmdline(find(&c, "go:test")), "go test ./...");
    assert!(find(&c, "go:test").is_test);
    assert_eq!(find(&c, "go:run").debug_adapter.as_deref(), Some("delve"));

    let dir = project(&[("go.mod", "module x\n"), ("lib.go", "package x\n")]);
    assert_eq!(ids(&detect(dir.path())), ["go:test"]);
}

#[test]
fn python_projects() {
    let dir = project(&[
        ("pyproject.toml", "[tool.pytest.ini_options]\naddopts = \"-q\"\n"),
        ("uv.lock", ""),
        ("src/mypkg/__init__.py", ""),
        ("src/mypkg/__main__.py", ""),
        ("manage.py", ""),
    ]);
    let c = detect(dir.path());
    assert_eq!(ids(&c), ["django:runserver", "python:module:mypkg", "pytest"]);
    let pytest = find(&c, "pytest");
    assert_eq!(cmdline(pytest), "uv run pytest");
    assert!(pytest.is_test);
    assert_eq!(pytest.debug_adapter.as_deref(), Some("debugpy"));
    assert_eq!(cmdline(find(&c, "python:module:mypkg")), "uv run python -m mypkg");
    assert_eq!(cmdline(find(&c, "django:runserver")), "uv run python manage.py runserver");

    let dir = project(&[("pytest.ini", "[pytest]\n"), ("poetry.lock", "")]);
    assert_eq!(cmdline(find(&detect(dir.path()), "pytest")), "poetry run pytest");

    let dir = project(&[("setup.cfg", "[tool:pytest]\ntestpaths = tests\n")]);
    assert_eq!(cmdline(find(&detect(dir.path()), "pytest")), "pytest");

    let dir = project(&[("requirements.txt", "requests\n"), ("app/__main__.py", "")]);
    let c = detect(dir.path());
    assert_eq!(ids(&c), ["python:module:app"]);
}

#[cfg(unix)]
#[test]
fn python_virtualenv() {
    let dir = project(&[("tox.ini", ""), (".venv/bin/python", ""), (".venv/bin/pytest", ""), ("manage.py", "")]);
    let c = detect(dir.path());
    assert_eq!(cmdline(find(&c, "pytest")), ".venv/bin/pytest");
    assert_eq!(cmdline(find(&c, "django:runserver")), ".venv/bin/python manage.py runserver");
}

#[cfg(unix)]
#[test]
fn bare_virtualenv_marks_a_python_project() {
    // No packaging files: the venv alone says which interpreter / pytest to use.
    let dir = project(&[(".venv/bin/python", ""), (".venv/bin/pytest", ""), ("worker/test_w.py", "")]);
    assert_eq!(cmdline(find(&detect(dir.path()), "pytest")), ".venv/bin/pytest");
    let dir = project(&[(".venv/bin/python", "")]);
    assert!(detect(dir.path()).is_empty());
}

#[test]
fn makefile_targets() {
    let makefile = "\
CC := gcc
VERSION = 1.0:beta
.PHONY: all test clean
export PATH := $(PATH)

all: build test
build: main.o
\tgcc -o app main.o
%.o: %.c
\t$(CC) -c $<
test::
\t./run-tests
clean lint: ; rm -rf out
$(OUT)/x: y
out/file: z
define TEMPLATE
inner: x
endef
# comment: no
";
    let dir = project(&[("Makefile", makefile)]);
    let c = detect(dir.path());
    assert_eq!(ids(&c), ["make:all", "make:build", "make:test", "make:clean", "make:lint"]);
    assert_eq!(cmdline(find(&c, "make:build")), "make build");
    assert!(find(&c, "make:test").is_test);
}

#[test]
fn deno_tasks() {
    let dir = project(&[(
        "deno.jsonc",
        "{\n  // tasks\n  \"tasks\": {\n    \"dev\": \"deno run -A main.ts\", /* inline */\n    \"test\": \"deno test\",\n  },\n  \"url\": \"https://x.dev//y\"\n}\n",
    )]);
    let c = detect(dir.path());
    assert_eq!(ids(&c), ["deno:dev", "deno:test"]);
    assert_eq!(cmdline(&c[0]), "deno task dev");
    assert!(c[1].is_test);
}

#[test]
fn godot_projects_run_their_main_scene() {
    let dir = project(&[("project.godot", "config_version=5\n"), ("demo/project.godot", "config_version=5\n")]);
    let c = detect(dir.path());
    let root = find(&c, "godot:project");
    assert_eq!((root.name.as_str(), root.kind.as_str()), ("Godot Project", "godot"));
    assert_eq!(cmdline(root), "godot --path .");
    assert_eq!(root.cwd, None);
    assert_eq!(root.debug_adapter.as_deref(), Some("godot"));
    let demo = find(&c, "godot:project:demo");
    assert_eq!(demo.name, "Godot Project (demo)");
    assert_eq!(demo.cwd, Some(std::path::PathBuf::from("demo").into()));
    assert!(detect(project(&[("main.gd", "extends Node\n")]).path()).is_empty());
}

#[test]
fn just_recipes() {
    let justfile = "\
set shell := [\"bash\", \"-c\"]
alias b := build
version := \"1.0\"
export RUST_LOG := \"info\"

# Build it
build target='debug':
    cargo build
@test *args: build
    cargo test {{args}}
_hidden:
    echo
[private]
secret:
    echo
serve port=\"8080\": (build \"release\")
    ./serve
";
    let dir = project(&[("justfile", justfile)]);
    let c = detect(dir.path());
    assert_eq!(ids(&c), ["just:build", "just:test", "just:serve"]);
    assert_eq!(cmdline(&c[1]), "just test");
    assert!(c[1].is_test);
}

#[test]
fn ordering_is_stable_across_ecosystems() {
    let dir = project(&[
        ("Makefile", "all:\n"),
        ("package.json", r#"{"scripts":{"dev":"x"}}"#),
        ("Cargo.toml", "[package]\nname = \"a\"\n"),
        ("src/main.rs", ""),
        ("go.mod", "module a\n"),
    ]);
    let first = ids(&detect(dir.path())).into_iter().map(str::to_owned).collect::<Vec<_>>();
    assert_eq!(first, ["npm:dev", "cargo:run:a", "cargo:test", "cargo:build", "go:test", "make:all"]);
    for _ in 0..3 {
        assert_eq!(detect(dir.path()).iter().map(|c| c.id.clone()).collect::<Vec<_>>(), first);
    }
    assert!(detect(dir.path()).iter().all(|c| c.detected));
}

#[test]
fn nested_packages_in_polyglot_repo() {
    let dir = project(&[
        ("Makefile", "all:\n\techo\n"),
        ("web/package.json", r#"{"scripts":{"dev":"vite","test":"vitest"}}"#),
        ("web/pnpm-lock.yaml", ""),
        ("api/go.mod", "module x\n"),
        ("api/main.go", "package main\nfunc main() {}\n"),
        ("node_modules/x/package.json", r#"{"scripts":{"no":"x"}}"#),
    ]);
    let c = detect(dir.path());
    let dev = find(&c, "npm:web:dev");
    assert_eq!(cmdline(dev), "pnpm run dev");
    assert_eq!(dev.cwd.as_deref(), Some(Path::new("web")));
    assert_eq!(dev.name, "web: pnpm run dev");
    assert!(find(&c, "npm:web:test").is_test);
    let run = find(&c, "go:run:api");
    assert_eq!(run.cwd.as_deref(), Some(Path::new("api")));
    assert_eq!(run.name, "api: go run .");
    let test = find(&c, "go:test:api");
    assert!(test.is_test);
    assert_eq!(cmdline(test), "go test ./...");
    assert!(!ids(&c).iter().any(|id| id.contains("no")));
}

#[test]
fn root_package_disables_nested_scan() {
    let dir = project(&[
        ("package.json", r#"{"scripts":{"build":"tsc"}}"#),
        ("tools/package.json", r#"{"scripts":{"gen":"x"}}"#),
        ("go.mod", "module x\n"),
        ("svc/go.mod", "module y\n"),
    ]);
    let c = detect(dir.path());
    assert!(!ids(&c).contains(&"npm:tools:gen"));
    assert!(ids(&c).contains(&"go:test"));
    assert!(!ids(&c).contains(&"go:test:svc"));
}
