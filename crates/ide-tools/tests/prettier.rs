//! `cargo test -p ide-tools --test prettier -- --ignored --nocapture`
//! Installs into a temporary managed-tools directory; no repository dependency is added.
use ide_core::CancellationToken;
use ide_language::FormatterConfig;
use ide_tools::{Tools, formatter};
use std::path::Path;

fn format(
    tools: &Tools,
    path: &Path,
    parser: &str,
    text: &str,
    range: Option<(u32, u32)>,
) -> ide_core::IdeResult<String> {
    let config = FormatterConfig {
        tool: "prettier".into(),
        parser: parser.into(),
        range: matches!(parser, "typescript" | "json" | "graphql"),
    };
    let mut cmd = tools.formatter_command("prettier", path, None)?;
    cmd.current_dir(path.parent().unwrap());
    cmd.args(formatter::arguments("prettier", &config, path, 4, true, range));
    formatter::run("prettier", cmd, text, &CancellationToken::new())
}

#[test]
#[ignore = "requires Node.js/npm and network; installs real Prettier into a temporary managed directory"]
fn real_prettier_config_ignore_languages_ranges_and_errors() {
    if std::env::var_os("OPENIDEA_TEST_OFFLINE").is_some() {
        eprintln!("SKIP real Prettier: OPENIDEA_TEST_OFFLINE is set; npm network access is disabled");
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let tools = Tools::new(&temp.path().join("app-data"));
    let info = tools.info("prettier", &[]).unwrap();
    if !info.can_install {
        eprintln!("SKIP real Prettier: {}", info.unavailable_reason.unwrap_or_default());
        return;
    }
    tools.install("prettier", &[], &Default::default(), &|_| {}).expect(
        "Prettier managed install failed; offline environments may set OPENIDEA_TEST_OFFLINE=1 (reported as SKIP)",
    );
    let project = temp.path().join("project with spaces");
    std::fs::create_dir_all(project.join("docs/nested")).unwrap();
    let md = project.join("docs/nested/readme.md");
    let input = "# Title\ntext\n\n| a | b |\n|---|---|\n|1|2|\n\n- a\n - b\n";
    let output = format(&tools, &md, "markdown", input, None).unwrap();
    assert!(output.starts_with("# Title\n\ntext\n"), "{output}");
    assert!(output.contains("| 1   | 2   |"), "{output}");
    assert!(!md.exists(), "formatting must never write the file");
    std::fs::write(project.join(".prettierrc"), r#"{"proseWrap":"always","printWidth":24,"tabWidth":2}"#).unwrap();
    let prose =
        "This is a long paragraph with several words that should wrap according to the project configuration.\n";
    assert!(format(&tools, &md, "markdown", prose, None).unwrap().lines().count() > 2);
    std::fs::write(project.join(".prettierignore"), "docs/nested/readme.md\n").unwrap();
    assert_eq!(format(&tools, &md, "markdown", input, None).unwrap(), input);
    std::fs::remove_file(project.join(".prettierignore")).unwrap();
    std::fs::remove_file(project.join(".prettierrc")).unwrap();
    assert_eq!(
        format(&tools, &project.join("a.css"), "css", "a{color:red}", None).unwrap(),
        "a {\n    color: red;\n}\n"
    );
    std::fs::write(project.join("package.json"), r#"{"prettier":{"tabWidth":3,"proseWrap":"never"}}"#).unwrap();
    assert_eq!(
        format(&tools, &project.join("a.css"), "css", "a{color:red}", None).unwrap(),
        "a {\n   color: red;\n}\n"
    );
    assert_eq!(format(&tools, &project.join("a.yaml"), "yaml", "a: [1,2]\n", None).unwrap(), "a: [1, 2]\n");
    let js = "const a={x:1};\nconst b={y:2};\n";
    let formatted = format(&tools, &project.join("a.ts"), "typescript", js, Some((0, 14))).unwrap();
    assert!(formatted.starts_with("const a = { x: 1 };"), "{formatted}");
    assert!(formatted.contains("const b={y:2};"), "{formatted}");
    assert!(format(&tools, &project.join("bad.css"), "css", "a {", None).is_err());
    // Nearest project version must win over the managed install, including npm's object-style bin.
    let package = project.join("node_modules/prettier");
    std::fs::create_dir_all(&package).unwrap();
    std::fs::write(package.join("package.json"), r#"{"bin":{"prettier":"cli.cjs"}}"#).unwrap();
    std::fs::write(
        package.join("cli.cjs"),
        "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('project version\\n')); ",
    )
    .unwrap();
    assert_eq!(format(&tools, &md, "markdown", input, None).unwrap(), "project version\n");
    std::fs::write(package.join("cli.cjs"), "setInterval(() => {}, 1000)").unwrap();
    let start = std::time::Instant::now();
    assert!(format(&tools, &md, "markdown", input, None).unwrap_err().message.contains("timed out"));
    assert!(start.elapsed() < std::time::Duration::from_secs(20));
    eprintln!(
        "PASS: real managed Prettier, config/ignore discovery, editor defaults, YAML/CSS/Markdown, ranges, errors, project precedence, timeout; no disk writes"
    );
}
