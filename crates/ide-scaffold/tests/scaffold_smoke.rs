//! Creates real projects with each generator and builds them, with the toolchains
//! installed on this machine (`--ignored`; most generators need the network).
//! `cargo test -p ide-scaffold --test scaffold_smoke -- --ignored --exact <generator>`
//! runs one; an upstream CLI changing its options shows up here first.

use ide_core::CancellationToken;
use ide_scaffold::{CreateRequest, ScaffoldEvent, create};
use std::path::Path;
use std::process::Command;

fn smoke(generator: &str, values: &[(&str, &str)], build: &[&str]) {
    let tmp = tempfile::tempdir().unwrap();
    let req = CreateRequest {
        generator: generator.into(),
        location: tmp.path().to_path_buf().into(),
        name: "smoke-app".into(),
        git: true,
        values: values.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
    };
    let dir = create(&req, &CancellationToken::new(), &|e| match e {
        ScaffoldEvent::Step { text } => eprintln!("== {text}"),
        ScaffoldEvent::Line { text } => eprintln!("   {text}"),
    })
    .unwrap_or_else(|e| panic!("{generator}: {}", e.message));
    assert!(dir.join(".git").is_dir(), "{generator}: no repository");
    if build.is_empty() {
        return;
    }
    run(&dir, build);
}

fn run(dir: &Path, argv: &[&str]) {
    let program = ide_core::process::find_executable(argv[0], &std::env::var_os("PATH").unwrap_or_default())
        .unwrap_or_else(|| dir.join(argv[0]));
    let status = Command::new(program).args(&argv[1..]).current_dir(dir).status().unwrap();
    assert!(status.success(), "`{}` failed in {}", argv.join(" "), dir.display());
}

macro_rules! smoke {
    ($($name:ident: $generator:literal, [$(($k:literal, $v:literal)),* $(,)?], [$($arg:literal),* $(,)?];)*) => {
        $(
            #[test]
            #[ignore]
            fn $name() {
                smoke($generator, &[$(($k, $v)),*], &[$($arg),*]);
            }
        )*
    };
}

smoke! {
    empty: "empty", [], [];
    java: "java", [], ["mvn", "-q", "compile"];
    java_gradle: "java", [("build", "gradle")], ["./gradlew", "-q", "compileJava"];
    kotlin: "kotlin", [], ["./gradlew", "-q", "compileKotlin"];
    kotlin_maven: "kotlin", [("build", "maven")], ["mvn", "-q", "compile"];
    ktor: "ktor", [], ["./gradlew", "-q", "compileKotlin"];
    spring_boot: "spring-boot", [("type", "maven-project"), ("language", "java"), ("dependencies", "web")], ["./mvnw", "-q", "compile"];
    quarkus: "quarkus", [("dependencies", "io.quarkus:quarkus-rest")], ["./mvnw", "-q", "compile"];
    micronaut: "micronaut", [("type", "DEFAULT"), ("lang", "JAVA"), ("build", "GRADLE"), ("test", "JUNIT")], ["./gradlew", "-q", "compileJava"];
    scala: "scala", [], ["sbt", "compile"];
    python: "python", [], ["uv", "run", "python", "-c", "pass"];
    django: "django", [], ["uv", "run", "python", "manage.py", "check"];
    fastapi: "fastapi", [], ["uv", "run", "python", "-c", "import main"];
    flask: "flask", [], ["uv", "run", "python", "-c", "import app"];
    node: "node", [], ["node", "src/index.ts"];
    vite: "vite", [], ["npm", "run", "build"];
    nextjs: "nextjs", [], ["npm", "run", "build"];
    nuxt: "nuxt", [], ["npm", "run", "build"];
    angular: "angular", [], ["npm", "run", "build"];
    sveltekit: "sveltekit", [], ["npm", "run", "build"];
    astro: "astro", [], ["npm", "run", "build"];
    nestjs: "nestjs", [], ["npm", "run", "build"];
    express: "express", [], ["node", "--check", "index.js"];
    html: "html", [], [];
    go: "go", [], ["go", "build", "./..."];
    rust: "rust", [], ["cargo", "build", "-q"];
    cpp: "cpp", [], ["cmake", "-S", ".", "-B", "build"];
    zig: "zig", [], ["zig", "build"];
    dotnet: "dotnet", [], ["dotnet", "build"];
    php: "php", [], ["php", "public/index.php"];
    laravel: "laravel", [], ["php", "artisan", "--version"];
    symfony: "symfony", [], ["php", "bin/console", "about"];
    ruby: "ruby", [], ["ruby", "main.rb"];
    rails: "rails", [], ["bin/rails", "about"];
    dart: "dart", [], ["dart", "analyze"];
    flutter: "flutter", [], ["flutter", "analyze"];
    swift: "swift", [], ["swift", "build"];
    elixir: "elixir", [], ["mix", "compile"];
    phoenix: "phoenix", [("database", "none")], [];
    haskell: "haskell", [], ["cabal", "build"];
}

/// Every generator has a smoke test.
#[test]
fn every_generator_has_a_smoke_test() {
    let source = include_str!("scaffold_smoke.rs");
    for g in ide_scaffold::catalog() {
        assert!(source.contains(&format!(": \"{}\", [", g.id)), "no smoke test for `{}`", g.id);
    }
}
