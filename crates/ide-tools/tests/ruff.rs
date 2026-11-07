//! `cargo test -p ide-tools --test ruff -- --ignored --nocapture`

use ide_core::CancellationToken;
use ide_language::FormatterConfig;
use ide_tools::{Tools, formatter};
use std::path::Path;

fn format(
    tools: &Tools,
    path: &Path,
    text: &str,
    range: Option<formatter::FormatRange>,
    config_file: Option<&Path>,
) -> ide_core::IdeResult<String> {
    let config = FormatterConfig { tool: "ruff".into(), parser: "python".into(), range: true };
    let mut cmd = tools.formatter_command("ruff", path, None)?;
    cmd.current_dir(path.parent().unwrap());
    cmd.args(formatter::arguments("ruff", &config, path, 4, true, range, config_file));
    formatter::run("ruff", cmd, text, &CancellationToken::new())
}

#[test]
#[ignore = "requires ruff on PATH"]
fn real_ruff_reads_project_config_formats_stdin_and_supports_ranges() {
    let temp = tempfile::tempdir().unwrap();
    let tools = Tools::new(&temp.path().join("app-data"));
    if tools.info("ruff", &[]).unwrap().status == ide_tools::ToolStatus::Missing {
        eprintln!("SKIP real Ruff: not on PATH");
        return;
    }
    let project = temp.path().join("project with spaces");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::write(project.join("pyproject.toml"), "[tool.ruff.format]\nquote-style = \"single\"\n").unwrap();
    let path = project.join("example.py");
    let input = "def greet(name):\n    return {\"message\": name}\n";
    let output = format(&tools, &path, input, None, None).unwrap();
    assert_eq!(output, "def greet(name):\n    return {'message': name}\n");
    assert!(!path.exists(), "formatting must never write the file");

    let range = formatter::FormatRange {
        start_offset: 0,
        end_offset: 0,
        start_line: 2,
        start_col: 1,
        end_line: 2,
        end_col: 100,
    };
    let mixed = "def untouched( a,b ):\n    return {\"message\": name}\n";
    let output = format(&tools, &path, mixed, Some(range), None).unwrap();
    assert!(output.starts_with("def untouched( a,b ):"), "{output}");
    assert!(output.contains("return {'message': name}"), "{output}");

    let shared = temp.path().join("shared config");
    std::fs::create_dir_all(&shared).unwrap();
    let shared_config = shared.join("ruff.toml");
    std::fs::write(&shared_config, "[format]\nquote-style = \"double\"\n").unwrap();
    std::fs::remove_file(project.join("pyproject.toml")).unwrap();
    let output = format(&tools, &path, input, None, Some(&shared_config)).unwrap();
    assert_eq!(output, "def greet(name):\n    return {\"message\": name}\n");

    let invalid = "def broken(:\n    pass\n";
    let error = format(&tools, &path, invalid, None, Some(&shared_config)).unwrap_err();
    assert!(error.message.contains("Failed to parse"), "{}", error.message);
    eprintln!(
        "PASS: real Ruff config discovery, custom config file, stdin formatting, quote style, range, invalid syntax diagnostics, no disk writes"
    );
}
