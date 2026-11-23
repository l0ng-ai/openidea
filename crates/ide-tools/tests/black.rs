//! `cargo test -p ide-tools --test black -- --ignored --nocapture`

use ide_core::CancellationToken;
use ide_language::FormatterConfig;
use ide_tools::{Tools, formatter};
use std::path::Path;

fn format(
    tools: &Tools,
    path: &Path,
    text: &str,
    range: Option<formatter::FormatRange>,
) -> ide_core::IdeResult<String> {
    let config = FormatterConfig { tool: "ruff".into(), parser: "python".into(), range: true };
    let mut cmd = tools.formatter_command("black", path, None)?;
    cmd.current_dir(path.parent().unwrap());
    cmd.args(formatter::arguments("black", &config, path, 4, true, range, None));
    formatter::run("black", cmd, text, &CancellationToken::new())
}

#[test]
#[ignore = "requires black on PATH"]
fn real_black_reads_project_config_formats_stdin_ranges_and_exclusions() {
    let temp = tempfile::tempdir().unwrap();
    let tools = Tools::new(&temp.path().join("app-data"));
    if tools.info("black", &[]).unwrap().status == ide_tools::ToolStatus::Missing {
        eprintln!("SKIP real Black: not on PATH");
        return;
    }
    let project = temp.path().join("project with spaces");
    std::fs::create_dir_all(project.join("gen")).unwrap();
    std::fs::write(project.join("pyproject.toml"), "[tool.black]\nline-length = 20\nforce-exclude = \"gen/\"\n")
        .unwrap();
    let path = project.join("example.py");
    let output = format(&tools, &path, "x = {'a': 1, 'b': 2, 'c': 3}\n", None).unwrap();
    assert_eq!(output, "x = {\n    \"a\": 1,\n    \"b\": 2,\n    \"c\": 3,\n}\n");
    assert!(!path.exists(), "formatting must never write the file");

    let range = formatter::FormatRange {
        start_offset: 0,
        end_offset: 0,
        start_line: 2,
        start_col: 1,
        end_line: 2,
        end_col: 100,
    };
    let output = format(&tools, &path, "a  =  1\nb  =  2\n", Some(range)).unwrap();
    assert_eq!(output, "a  =  1\nb = 2\n");

    // An excluded file comes back empty; the host keeps the document as it is.
    let output = format(&tools, &project.join("gen/m.py"), "x = {  'a':1 }\n", None).unwrap();
    assert_eq!(output, "");
}
