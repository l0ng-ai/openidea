//! Which coverage tool runs a configuration, and how its command line changes.

use crate::{CoveragePrepared, CoverageReportSpec, InstallCommand};
use ide_run::RunConfig;
use ide_run::wrap::{self, program_name};
use std::path::Path;

const GRADLE_INIT: &str = r#"// Written by OpenIDEA for Run with Coverage.
allprojects {
    plugins.withId('java') {
        apply plugin: 'jacoco'
        tasks.withType(Test).configureEach { t -> t.finalizedBy(tasks.named('jacocoTestReport')) }
        tasks.named('jacocoTestReport') { r -> r.reports { xml.required.set(true) } }
    }
}
"#;

fn s(v: &str) -> String {
    v.to_owned()
}

fn path(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn unsupported(reason: impl Into<String>) -> CoveragePrepared {
    CoveragePrepared::Unsupported { reason: reason.into() }
}

fn missing(tool: &str, message: impl Into<String>, install: Option<(Vec<String>, &Path)>) -> CoveragePrepared {
    CoveragePrepared::MissingTool {
        tool: tool.to_owned(),
        message: message.into(),
        install: install.and_then(|(argv, cwd)| {
            let (command, args) = argv.split_first()?;
            Some(InstallCommand { command: command.clone(), args: args.to_vec(), cwd: Some(cwd.to_path_buf().into()) })
        }),
    }
}

fn ready(
    runner: &str,
    config: &RunConfig,
    command: String,
    args: Vec<String>,
    report: CoverageReportSpec,
) -> CoveragePrepared {
    CoveragePrepared::Ready {
        runner: runner.to_owned(),
        launch: Box::new(RunConfig { command, args, ..config.clone() }),
        report,
    }
}

/// How to run `config` with coverage. `out` is an empty directory for the run's
/// data; it must exist (the Gradle init script is written there). Probes tools,
/// so call it from a blocking thread.
pub fn prepare(root: &Path, config: &RunConfig, out: &Path) -> CoveragePrepared {
    let dir = wrap::run_dir(root, config);
    let program = program_name(&config.command);
    let first = config.args.first().map(String::as_str).unwrap_or_default();
    match program.as_str() {
        "cargo" => cargo(config, &dir, out),
        "go" if first == "test" => go(config, &dir, out),
        "go" => unsupported("Go coverage is collected by `go test`; run a test configuration with coverage."),
        "mvn" | "mvnw" => maven(config, &dir),
        "gradle" | "gradlew" => gradle(config, &dir, out),
        "npm" | "pnpm" | "yarn" | "bun" => npm(root, config, &dir, out),
        "node" | "npx" | "tsx" | "ts-node" => c8(root, config, &dir, out),
        "ruby" | "bundle" | "rake" | "rspec" | "rails" => ruby(root, config, &dir, out),
        "deno" => unsupported("Coverage of Deno tasks is not supported yet."),
        "java" => unsupported(
            "Coverage of Java applications needs the JaCoCo agent; run a Maven or Gradle test configuration with coverage.",
        ),
        _ => match wrap::python_command(config) {
            Some(py) => python(config, &dir, out, py),
            None => unsupported(format!("No coverage runner is known for '{}'.", config.name)),
        },
    }
}

fn cargo(config: &RunConfig, dir: &Path, out: &Path) -> CoveragePrepared {
    // `cargo +nightly test …`: the toolchain stays in front.
    let toolchain: Vec<String> = config.args.iter().take_while(|a| a.starts_with('+')).cloned().collect();
    let rest = &config.args[toolchain.len()..];
    let Some(sub) = rest.first().filter(|s| matches!(s.as_str(), "test" | "run" | "nextest")) else {
        return unsupported("Coverage runs `cargo test`, `cargo run` or `cargo nextest` configurations.");
    };
    let probe: Vec<String> = std::iter::once(config.command.clone())
        .chain(toolchain.iter().cloned())
        .chain([s("llvm-cov"), s("--version")])
        .collect();
    if !wrap::probe(&probe, dir, config) {
        return missing(
            "cargo-llvm-cov",
            "Rust coverage needs cargo-llvm-cov (and the llvm-tools-preview rustup component).",
            Some((vec![s("cargo"), s("install"), s("cargo-llvm-cov")], dir)),
        );
    }
    let lcov = out.join("lcov.info");
    let mut args = toolchain;
    args.extend([s("llvm-cov"), sub.clone(), s("--lcov"), s("--output-path"), path(&lcov)]);
    args.extend(rest[1..].iter().cloned());
    let report =
        CoverageReportSpec::Lcov { runner: s("cargo-llvm-cov"), path: lcov.into(), base: dir.to_path_buf().into() };
    ready("cargo-llvm-cov", config, config.command.clone(), args, report)
}

fn go(config: &RunConfig, dir: &Path, out: &Path) -> CoveragePrepared {
    let profile = out.join("cover.out");
    let mut args = vec![s("test"), format!("-coverprofile={}", path(&profile))];
    args.extend(config.args[1..].iter().cloned());
    let (module, module_dir) = wrap::go_module(dir).unwrap_or_else(|| (String::new(), dir.to_path_buf()));
    let report = CoverageReportSpec::GoProfile { path: profile.into(), module, module_dir: module_dir.into() };
    ready("go test -cover", config, config.command.clone(), args, report)
}

fn runs_tests(args: &[String]) -> bool {
    args.iter().any(|a| {
        let task = a.rsplit(':').next().unwrap_or(a);
        matches!(task, "test" | "verify" | "check" | "integrationTest") || a.starts_with("-Dtest=") || a == "--tests"
    })
}

fn maven(config: &RunConfig, dir: &Path) -> CoveragePrepared {
    if !runs_tests(&config.args) {
        return unsupported("Coverage runs Maven configurations that run tests (`test`, `verify`).");
    }
    let mut args = vec![s("org.jacoco:jacoco-maven-plugin:prepare-agent")];
    args.extend(config.args.iter().cloned());
    // Report even when tests fail, and from this run's data only.
    args.extend([
        s("org.jacoco:jacoco-maven-plugin:report"),
        s("-Djacoco.append=false"),
        s("-Dmaven.test.failure.ignore=true"),
    ]);
    ready("JaCoCo", config, config.command.clone(), args, CoverageReportSpec::Jacoco { dir: dir.to_path_buf().into() })
}

fn gradle(config: &RunConfig, dir: &Path, out: &Path) -> CoveragePrepared {
    if !runs_tests(&config.args) {
        return unsupported("Coverage runs Gradle configurations that run tests (`test`, `check`).");
    }
    let script = out.join("openidea-jacoco.init.gradle");
    if let Err(e) = std::fs::write(&script, GRADLE_INIT) {
        return unsupported(format!("Cannot write the Gradle init script: {e}"));
    }
    let mut args = vec![s("--init-script"), path(&script)];
    args.extend(config.args.iter().cloned());
    ready("JaCoCo", config, config.command.clone(), args, CoverageReportSpec::Jacoco { dir: dir.to_path_buf().into() })
}

/// `npm install -D x` / `pnpm add -D x`.
fn add_dev(pm: &str, package: &str) -> Vec<String> {
    let verb = if pm == "npm" { "install" } else { "add" };
    vec![s(pm), s(verb), s("-D"), s(package)]
}

const SHELL_META: &[char] = &['&', '|', ';', '<', '>', '$', '`', '"', '\'', '(', ')'];

fn npm(root: &Path, config: &RunConfig, dir: &Path, out: &Path) -> CoveragePrepared {
    let pm = program_name(&config.command);
    let Some((name, script)) = wrap::npm_script(config, dir) else {
        return unsupported("Coverage runs package.json scripts that use vitest or jest.");
    };
    let tokens: Vec<&str> = script.split_whitespace().collect();
    let runner_at = tokens.iter().position(|t| matches!(*t, "vitest" | "jest"));
    let Some(runner_at) = runner_at else {
        return unsupported(format!("The '{name}' script does not run vitest or jest: {script}"));
    };
    let runner = tokens[runner_at];
    let lcov = out.join("lcov.info");
    let coverage_args: Vec<String> = if runner == "vitest" {
        if !wrap::node_package("@vitest/coverage-v8", dir, root)
            && !wrap::node_package("@vitest/coverage-istanbul", dir, root)
        {
            // The provider must match the installed vitest exactly.
            let provider = match wrap::node_package_version("vitest", dir, root) {
                Some(v) => format!("@vitest/coverage-v8@{v}"),
                None => s("@vitest/coverage-v8"),
            };
            return missing(
                "@vitest/coverage-v8",
                "Vitest coverage needs a coverage provider package.",
                Some((add_dev(&pm, &provider), dir)),
            );
        }
        vec![
            s("--coverage.enabled=true"),
            s("--coverage.reporter=lcov"),
            format!("--coverage.reportsDirectory={}", path(out)),
        ]
    } else {
        vec![s("--coverage"), s("--coverageReporters=lcov"), format!("--coverageDirectory={}", path(out))]
    };
    let report =
        CoverageReportSpec::Lcov { runner: runner.to_owned(), path: lcov.into(), base: dir.to_path_buf().into() };
    // A plain `vitest run …` script runs the runner directly, so its arguments need no `--` games.
    let simple =
        !script.contains(SHELL_META) && tokens[..runner_at].iter().all(|t| matches!(*t, "npx" | "pnpm" | "exec"));
    if simple && let Some(bin) = wrap::node_bin(runner, dir, root) {
        let mut args: Vec<String> = tokens[runner_at + 1..].iter().map(|t| s(t)).collect();
        args.extend(wrap::passthrough_args(config));
        args.extend(coverage_args);
        return ready(runner, config, path(&bin), args, report);
    }
    let mut args = config.args.clone();
    if !args.iter().any(|a| a == "--") {
        args.push(s("--"));
    }
    args.extend(coverage_args);
    ready(runner, config, config.command.clone(), args, report)
}

fn c8(root: &Path, config: &RunConfig, dir: &Path, out: &Path) -> CoveragePrepared {
    let Some(c8) = wrap::find_tool("c8", config, dir, root) else {
        return missing(
            "c8",
            "Coverage of Node.js programs needs c8.",
            Some((vec![s("npm"), s("install"), s("-g"), s("c8")], dir)),
        );
    };
    let mut args = vec![
        s("--reporter=lcov"),
        format!("--reports-dir={}", path(out)),
        format!("--temp-directory={}", path(&out.join("tmp"))),
        config.command.clone(),
    ];
    args.extend(config.args.iter().cloned());
    let report = CoverageReportSpec::Lcov {
        runner: s("c8"),
        path: out.join("lcov.info").into(),
        base: dir.to_path_buf().into(),
    };
    ready("c8", config, path(&c8), args, report)
}

/// Loaded first (`ide_run::ruby_preload`) when the project never starts SimpleCov itself.
const SIMPLECOV_PRELOAD: &str = r#"# Written by OpenIDEA for Run with Coverage.
require "simplecov"
SimpleCov.coverage_dir(ENV.fetch("OPENIDEA_COVERAGE_DIR"))
SimpleCov.start do
  add_filter %r{^/(test|spec|features)/}
  enable_coverage :branch
end
"#;

/// Files where a project conventionally starts SimpleCov.
const SIMPLECOV_STARTERS: &[&str] =
    &[".simplecov", "spec/spec_helper.rb", "spec/rails_helper.rb", "test/test_helper.rb", "test/minitest_helper.rb"];

fn ruby(root: &Path, config: &RunConfig, dir: &Path, out: &Path) -> CoveragePrepared {
    let bundled = [dir, root].iter().any(|d| d.join("Gemfile").is_file());
    let mentions = |file: &str| {
        [dir, root].iter().any(|d| std::fs::read_to_string(d.join(file)).is_ok_and(|t| t.contains("simplecov")))
    };
    if bundled && !mentions("Gemfile.lock") && !mentions("Gemfile") {
        return missing(
            "simplecov",
            "Ruby coverage needs the simplecov gem in the project's Gemfile.",
            Some((vec![s("bundle"), s("add"), s("simplecov"), s("--group"), s("test")], dir)),
        );
    }
    let starts = |d: &Path| {
        SIMPLECOV_STARTERS.iter().any(|f| {
            std::fs::read_to_string(d.join(f))
                .is_ok_and(|t| t.contains("SimpleCov.start") || f.starts_with(".simplecov"))
        })
    };
    let mut config = config.clone();
    let resultset = if [dir, root].iter().any(|d| starts(d)) {
        // The project's own configuration decides where the report goes (default `coverage/`).
        // Drop the previous run's data: SimpleCov merges into it.
        let results = dir.join("coverage");
        let _ = std::fs::remove_file(results.join(".resultset.json"));
        results.join(".resultset.json")
    } else {
        let preload = out.join("openidea_simplecov.rb");
        if let Err(e) = std::fs::write(&preload, SIMPLECOV_PRELOAD) {
            return unsupported(format!("Cannot write the SimpleCov preload: {e}"));
        }
        config.env.insert(s("OPENIDEA_COVERAGE_DIR"), path(out));
        // `out` lives under the IDE's data directory, which may have spaces (RUBYOPT cannot take them).
        ide_run::ruby_preload::add(&mut config.env, out, "openidea_simplecov", true);
        out.join(".resultset.json")
    };
    let report = CoverageReportSpec::SimpleCov { path: resultset.into(), base: dir.to_path_buf().into() };
    ready("SimpleCov", &config, config.command.clone(), config.args.clone(), report)
}

fn python(config: &RunConfig, dir: &Path, out: &Path, py: wrap::PythonCommand) -> CoveragePrepared {
    if py.target.is_empty() {
        return unsupported("Coverage needs a Python script or module to run.");
    }
    let mut config = config.clone();
    let data = out.join(".coverage");
    config.env.insert(s("COVERAGE_FILE"), path(&data));
    let with =
        |extra: &[&str]| -> Vec<String> { py.interpreter.iter().cloned().chain(extra.iter().map(|e| s(e))).collect() };
    if !wrap::probe(&with(&["-m", "coverage", "--version"]), dir, &config) {
        let install = match py.manager.as_deref() {
            Some("uv") => vec![s("uv"), s("add"), s("--dev"), s("coverage")],
            Some("poetry") => vec![s("poetry"), s("add"), s("--group"), s("dev"), s("coverage")],
            Some("pdm") => vec![s("pdm"), s("add"), s("-d"), s("coverage")],
            _ => with(&["-m", "pip", "install", "coverage"]),
        };
        return missing(
            "coverage",
            "Python coverage needs coverage.py in the project's interpreter.",
            Some((install, dir)),
        );
    }
    let lcov = out.join("lcov.info");
    let mut argv = with(&["-m", "coverage", "run", "--branch"]);
    argv.extend(py.target.iter().cloned());
    let report = CoverageReportSpec::Exported {
        runner: s("coverage.py"),
        argv: with(&["-m", "coverage", "lcov", "-o", &path(&lcov)]),
        cwd: dir.to_path_buf().into(),
        env: config.env.clone(),
        lcov: lcov.into(),
    };
    let (command, args) = argv.split_first().map(|(c, a)| (c.clone(), a.to_vec())).unwrap_or_default();
    ready("coverage.py", &config, command, args, report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn cfg(kind: &str, command: &str, args: &[&str]) -> RunConfig {
        RunConfig {
            id: "t".into(),
            name: "t".into(),
            kind: kind.into(),
            command: command.into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            cwd: None,
            env: BTreeMap::new(),
            detected: true,
            is_test: true,
            debug_adapter: None,
            allow_parallel: false,
            extras: Default::default(),
        }
    }

    fn launch(p: &CoveragePrepared) -> (&RunConfig, &CoverageReportSpec) {
        match p {
            CoveragePrepared::Ready { launch, report, .. } => (launch, report),
            other => panic!("not ready: {other:?}"),
        }
    }

    #[test]
    fn go_test_gets_a_cover_profile() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("go.mod"), "module example.com/m\n").unwrap();
        let out = dir.path().join("out");
        let p = prepare(dir.path(), &cfg("go", "go", &["test", "./...", "-run", "X"]), &out);
        let (l, report) = launch(&p);
        assert_eq!(l.args[0], "test");
        assert!(l.args[1].starts_with("-coverprofile=") && l.args[1].ends_with("cover.out"));
        assert_eq!(&l.args[2..], ["./...", "-run", "X"]);
        assert!(matches!(report, CoverageReportSpec::GoProfile { module, .. } if module == "example.com/m"));
        assert!(matches!(
            prepare(dir.path(), &cfg("go", "go", &["run", "."]), &out),
            CoveragePrepared::Unsupported { .. }
        ));
    }

    #[test]
    fn maven_and_gradle_use_jacoco() {
        let dir = tempfile::tempdir().unwrap();
        let p = prepare(dir.path(), &cfg("maven", "./mvnw", &["test", "-Dtest=CalcTest"]), dir.path());
        let (l, _) = launch(&p);
        assert_eq!(l.args[0], "org.jacoco:jacoco-maven-plugin:prepare-agent");
        assert!(l.args.contains(&"org.jacoco:jacoco-maven-plugin:report".to_owned()));
        assert!(matches!(
            prepare(dir.path(), &cfg("maven", "mvn", &["package"]), dir.path()),
            CoveragePrepared::Unsupported { .. }
        ));

        let p = prepare(dir.path(), &cfg("gradle", "./gradlew", &[":app:test", "--tests", "*Calc"]), dir.path());
        let (l, report) = launch(&p);
        assert_eq!(l.args[0], "--init-script");
        assert!(std::fs::read_to_string(&l.args[1]).unwrap().contains("jacoco"));
        assert!(matches!(report, CoverageReportSpec::Jacoco { .. }));
    }

    #[test]
    fn vitest_scripts_run_the_runner_with_coverage() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("package.json"), r#"{"scripts":{"test":"vitest run","t2":"tsc && jest"}}"#).unwrap();
        let config = cfg("npm", "pnpm", &["run", "test", "--", "a.test.ts"]);
        // No provider package: install hint.
        match prepare(root, &config, root) {
            CoveragePrepared::MissingTool { install: Some(i), .. } => {
                assert_eq!(i.args, ["add", "-D", "@vitest/coverage-v8"])
            }
            other => panic!("{other:?}"),
        }
        // ... pinned to the installed vitest.
        let vitest = root.join("node_modules/vitest");
        std::fs::create_dir_all(&vitest).unwrap();
        std::fs::write(vitest.join("package.json"), r#"{"version":"2.1.9"}"#).unwrap();
        match prepare(root, &config, root) {
            CoveragePrepared::MissingTool { install: Some(i), .. } => {
                assert_eq!(i.args, ["add", "-D", "@vitest/coverage-v8@2.1.9"])
            }
            other => panic!("{other:?}"),
        }
        let pkg = root.join("node_modules/@vitest/coverage-v8");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("package.json"), "{}").unwrap();
        let bin = root.join("node_modules/.bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join(if cfg!(windows) { "vitest.cmd" } else { "vitest" }), "").unwrap();
        let p = prepare(root, &config, root);
        let (l, _) = launch(&p);
        assert!(l.command.contains("node_modules"));
        assert_eq!(&l.args[..2], ["run", "a.test.ts"]);
        assert!(l.args.contains(&"--coverage.reporter=lcov".to_owned()));

        // A compound script: arguments go after `--`.
        let p = prepare(root, &cfg("npm", "npm", &["run", "t2"]), root);
        let (l, _) = launch(&p);
        assert_eq!(l.command, "npm");
        assert_eq!(&l.args[..3], ["run", "t2", "--"]);
        assert!(l.args.contains(&"--coverage".to_owned()));
    }

    #[test]
    fn cargo_without_llvm_cov_suggests_installing_it() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = cfg("cargo", "cargo", &["test"]);
        // A search path without cargo: the probe fails.
        config.env.insert("PATH".into(), dir.path().to_string_lossy().into_owned());
        config.command = dir.path().join("cargo").to_string_lossy().into_owned();
        match prepare(dir.path(), &config, dir.path()) {
            CoveragePrepared::MissingTool { tool, install: Some(i), .. } => {
                assert_eq!(tool, "cargo-llvm-cov");
                assert_eq!(i.args, ["install", "cargo-llvm-cov"]);
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            prepare(dir.path(), &cfg("cargo", "cargo", &["build"]), dir.path()),
            CoveragePrepared::Unsupported { .. }
        ));
    }

    #[test]
    fn ruby_runs_get_simplecov() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // The IDE's data directory has spaces on macOS (`Application Support`).
        let out = root.join("out dir");
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(root.join("Gemfile"), "source 'https://rubygems.org'\n").unwrap();
        let config = cfg("rspec", "bundle", &["exec", "rspec"]);
        // Bundler project without the gem: install hint.
        match prepare(root, &config, &out) {
            CoveragePrepared::MissingTool { tool, install: Some(i), .. } => {
                assert_eq!(tool, "simplecov");
                assert_eq!(i.args, ["add", "simplecov", "--group", "test"]);
            }
            other => panic!("{other:?}"),
        }
        // Gem present, never started: preloaded through RUBYOPT, report in `out`.
        std::fs::write(root.join("Gemfile"), "gem 'simplecov'\n").unwrap();
        let p = prepare(root, &config, &out);
        let (l, report) = launch(&p);
        assert_eq!(
            (l.command.as_str(), l.args.as_slice()),
            ("bundle", ["exec".to_owned(), "rspec".to_owned()].as_slice())
        );
        assert!(l.env["RUBYOPT"].contains("-ropenidea_simplecov"));
        assert!(std::env::split_paths(&l.env["RUBYLIB"]).any(|d| d == out));
        assert_eq!(l.env["OPENIDEA_COVERAGE_DIR"], out.to_string_lossy());
        assert!(out.join("openidea_simplecov.rb").is_file());
        assert!(
            matches!(report, CoverageReportSpec::SimpleCov { path, .. } if (path.as_ref() as &Path).starts_with(&out))
        );
        // Started by the project: untouched environment, stale data dropped, report in `coverage/`.
        std::fs::create_dir_all(root.join("test")).unwrap();
        std::fs::create_dir_all(root.join("coverage")).unwrap();
        std::fs::write(root.join("coverage/.resultset.json"), "{}").unwrap();
        std::fs::write(root.join("test/test_helper.rb"), "require 'simplecov'\nSimpleCov.start\n").unwrap();
        let p = prepare(root, &cfg("ruby", "ruby", &["-Ilib", "test/a_test.rb"]), &out);
        let (l, report) = launch(&p);
        assert!(!l.env.contains_key("RUBYOPT"));
        assert_eq!(l.args, ["-Ilib", "test/a_test.rb"]);
        assert!(!root.join("coverage/.resultset.json").exists());
        assert!(
            matches!(report, CoverageReportSpec::SimpleCov { path, .. } if (path.as_ref() as &Path).ends_with("coverage/.resultset.json"))
        );
    }

    #[test]
    fn unknown_commands_are_unsupported() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            prepare(dir.path(), &cfg("make", "make", &["all"]), dir.path()),
            CoveragePrepared::Unsupported { .. }
        ));
    }
}
