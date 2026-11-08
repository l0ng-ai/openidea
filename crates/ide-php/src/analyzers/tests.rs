use super::*;

const SOURCE: &str = "<?php\n\nnamespace App;\n\nfinal class Greeter\n{\n    public function greet(string $name): string\n    {\n        $émoji = '😀';\n        return $this->format($name) . $émoji . $missing;\n    }\n}\n";

fn root() -> PathBuf {
    if cfg!(windows) { PathBuf::from("C:\\work\\app") } else { PathBuf::from("/work/app") }
}

fn file() -> PathBuf {
    root().join("src").join("Greeter.php")
}

/// `vendor/bin/phpstan analyse --error-format=json src/Greeter.php` (PHPStan 1.12).
fn phpstan_report() -> String {
    let path = file().to_string_lossy().replace('\\', "\\\\");
    let other = root().join("src").join("Other.php").to_string_lossy().replace('\\', "\\\\");
    format!(
        r#"{{"totals":{{"errors":0,"file_errors":3}},"files":{{"{path}":{{"errors":2,"messages":[{{"message":"Undefined variable: $missing","line":10,"ignorable":true,"identifier":"variable.undefined"}},{{"message":"Call to an undefined method App\\Greeter::format().","line":10,"ignorable":true,"tip":"Learn more at <fg=cyan>https://phpstan.org/user-guide/discovering-symbols</>","identifier":"method.notFound"}}]}},"{other}":{{"errors":1,"messages":[{{"message":"Elsewhere.","line":3,"ignorable":true}}]}}}},"errors":[]}}"#
    )
}

/// `vendor/bin/psalm --output-format=json src/Greeter.php` (Psalm 5).
fn psalm_report() -> String {
    let path = file().to_string_lossy().replace('\\', "\\\\");
    format!(
        r#"[{{"link":"https://psalm.dev/024","severity":"error","line_from":10,"line_to":10,"type":"UndefinedVariable","message":"Cannot find referenced variable $missing","file_name":"src/Greeter.php","file_path":"{path}","snippet":"        return $this->format($name) . $émoji . $missing;","selected_text":"$missing","from":181,"to":189,"snippet_from":131,"snippet_to":190,"column_from":49,"column_to":57,"error_level":-1,"shortcode":24,"taint_trace":null,"other_references":null}},{{"link":"https://psalm.dev/022","severity":"info","line_from":9,"line_to":9,"type":"MixedAssignment","message":"Unable to determine the type that $émoji is being assigned to","file_name":"src/Greeter.php","file_path":"{path}","snippet":"","selected_text":"","from":0,"to":0,"snippet_from":0,"snippet_to":0,"column_from":9,"column_to":16,"error_level":1,"shortcode":32,"taint_trace":null,"other_references":null}},{{"severity":"error","line_from":1,"line_to":1,"type":"X","message":"Elsewhere","file_name":"src/Other.php","file_path":"/elsewhere/Other.php","column_from":1,"column_to":2}}]"#
    )
}

fn pos(line: u32, col: u32) -> Pos {
    Pos { line, col }
}

#[test]
fn phpstan_report_becomes_whole_line_diagnostics_of_the_file() {
    let found = Analyzer::PhpStan.parse(&phpstan_report(), &file(), &root(), SOURCE).unwrap();
    assert_eq!(found.len(), 2, "{found:#?}");
    // `return …` starts after 8 spaces; the line is 56 UTF-16 units long.
    let line = SOURCE.lines().nth(9).unwrap();
    let end = line.encode_utf16().count() as u32;
    for d in &found {
        assert_eq!(d.range, Range { start: pos(9, 8), end: pos(9, end) });
        assert_eq!(d.severity, Severity::Error);
        assert_eq!(d.source.as_deref(), Some("phpstan"));
        assert_eq!(d.server.as_deref(), Some("phpstan"));
    }
    assert_eq!(found[0].message, "Undefined variable: $missing");
    assert_eq!(found[0].code.as_deref(), Some("variable.undefined"));
    assert_eq!(
        found[1].message,
        "Call to an undefined method App\\Greeter::format().\nLearn more at https://phpstan.org/user-guide/discovering-symbols"
    );
}

#[test]
fn phpstan_trait_context_and_relative_paths_match() {
    let report = r#"{"totals":{"errors":0,"file_errors":2},"files":{"src/Greeter.php (in context of class App\\Uses)":{"errors":1,"messages":[{"message":"In a trait.","line":5,"ignorable":true}]}},"errors":[]}"#;
    let found = Analyzer::PhpStan.parse(report, &file(), &root(), SOURCE).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].range.start, pos(4, 0));
    assert_eq!(found[0].code, None);
}

#[test]
fn phpstan_without_problems_and_with_notices_before_the_report() {
    let clean = r#"{"totals":{"errors":0,"file_errors":0},"files":[],"errors":[]}"#;
    assert_eq!(Analyzer::PhpStan.parse(clean, &file(), &root(), SOURCE).unwrap(), Vec::new());
    let noisy = format!("PHP Deprecated:  something in /x.php on line 3\n{}\n", phpstan_report());
    assert_eq!(Analyzer::PhpStan.parse(&noisy, &file(), &root(), SOURCE).unwrap().len(), 2);
    let missing_line = r#"{"files":{"src/Greeter.php":{"messages":[{"message":"File-level.","line":null}]}}}"#;
    let found = Analyzer::PhpStan.parse(missing_line, &file(), &root(), SOURCE).unwrap();
    assert_eq!(found[0].range, Range { start: pos(0, 0), end: pos(0, 5) });
}

#[test]
fn output_without_a_report_is_an_error() {
    let err = Analyzer::PhpStan.parse("Fatal error: Allowed memory size exhausted", &file(), &root(), SOURCE);
    assert_eq!(err.unwrap_err(), "phpstan printed no JSON report");
    assert!(Analyzer::Psalm.parse("", &file(), &root(), SOURCE).is_err());
}

#[test]
fn psalm_report_keeps_columns_in_utf16() {
    let found = Analyzer::Psalm.parse(&psalm_report(), &file(), &root(), SOURCE).unwrap();
    assert_eq!(found.len(), 2, "{found:#?}");
    // Sorted by position: the info on line 9 first.
    assert_eq!(found[0].range, Range { start: pos(8, 8), end: pos(8, 14) });
    assert_eq!(found[0].severity, Severity::Warning);
    assert_eq!(found[0].code.as_deref(), Some("MixedAssignment"));
    // Byte column 49 (1-based) is after `$émoji` (é is 2 bytes in UTF-8, 1 unit in UTF-16).
    let line = SOURCE.lines().nth(9).unwrap();
    let start = line[..line.find("$missing").unwrap()].encode_utf16().count() as u32;
    assert_eq!(found[1].range, Range { start: pos(9, start), end: pos(9, start + 8) });
    assert_eq!(found[1].message, "Cannot find referenced variable $missing");
    assert_eq!(found[1].severity, Severity::Error);
    assert_eq!(found[1].source.as_deref(), Some("psalm"));
    assert_eq!(found[1].code.as_deref(), Some("UndefinedVariable"));
}

#[test]
fn psalm_clean_report_and_clamped_columns() {
    assert_eq!(Analyzer::Psalm.parse("[]\n", &file(), &root(), SOURCE).unwrap(), Vec::new());
    let report = r#"[{"severity":"error","line_from":3,"line_to":40,"type":"T","message":"m","file_path":"src/Greeter.php","column_from":2,"column_to":999}]"#;
    let found = Analyzer::Psalm.parse(report, &file(), &root(), SOURCE).unwrap();
    assert_eq!(found[0].range, Range { start: pos(2, 1), end: pos(39, 0) });
}

#[test]
fn detection_needs_the_script_and_for_psalm_a_config() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    assert!(detect(root).is_empty());
    std::fs::create_dir_all(root.join("vendor/bin")).unwrap();
    std::fs::write(root.join("vendor/bin/phpstan"), "#!/usr/bin/env php\n").unwrap();
    std::fs::write(root.join("vendor/bin/psalm"), "#!/usr/bin/env php\n").unwrap();
    assert_eq!(detect(root), vec![Analyzer::PhpStan]);
    std::fs::write(root.join("psalm.xml.dist"), "<psalm/>").unwrap();
    assert_eq!(detect(root), vec![Analyzer::PhpStan, Analyzer::Psalm]);
    let args = Analyzer::PhpStan.args(Path::new("src/A.php"));
    assert_eq!(args.first().map(|a| a.to_string_lossy().into_owned()).as_deref(), Some("analyse"));
    assert!(args.iter().any(|a| a == "--error-format=json"));
    assert_eq!(args.last().unwrap(), "src/A.php");
    assert!(Analyzer::Psalm.args(Path::new("a.php")).iter().any(|a| a == "--output-format=json"));
}

fn engine(line: u32, message: &str) -> Diagnostic {
    diagnostic(
        Range { start: pos(line, 4), end: pos(line, 9) },
        Severity::Error,
        message.to_owned(),
        Some("PhpUndefinedVariable".into()),
        "php",
    )
}

#[test]
fn duplicates_of_the_engines_diagnostics_are_removed() {
    let mut found = Analyzer::PhpStan.parse(&phpstan_report(), &file(), &root(), SOURCE).unwrap();
    let own = [engine(9, "Undefined variable '$missing'"), engine(3, "Undefined method 'format'")];
    remove_duplicates(&mut found, &own);
    // The method problem is on another line than the engine's, so it stays.
    assert_eq!(found.len(), 1);
    assert!(found[0].message.starts_with("Call to an undefined method"));
    remove_duplicates(&mut found, &[engine(9, "Undefined method 'format'")]);
    assert!(found.is_empty());

    let mut found = Analyzer::Psalm.parse(&psalm_report(), &file(), &root(), SOURCE).unwrap();
    remove_duplicates(&mut found, &[engine(9, "Undefined variable '$missing'"), engine(8, "Unused variable '$other'")]);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].code.as_deref(), Some("MixedAssignment"));
}

#[test]
fn unrelated_problems_on_the_same_line_stay() {
    let mut found = Analyzer::PhpStan.parse(&phpstan_report(), &file(), &root(), SOURCE).unwrap();
    // Common words ("undefined", "variable", "method") don't make a duplicate.
    remove_duplicates(&mut found, &[engine(9, "Undefined variable '$name'"), engine(9, "Unused import 'Foo'")]);
    assert_eq!(found.len(), 2);
    remove_duplicates(&mut found, &[]);
    assert_eq!(found.len(), 2);
}

#[test]
fn syntax_errors_and_short_variable_names() {
    let mut found = vec![
        diagnostic(
            Range { start: pos(2, 0), end: pos(2, 3) },
            Severity::Error,
            "Syntax error, unexpected '}' on line 3".into(),
            None,
            "phpstan",
        ),
        diagnostic(
            Range { start: pos(4, 0), end: pos(4, 3) },
            Severity::Error,
            "Undefined variable: $a".into(),
            None,
            "phpstan",
        ),
        diagnostic(
            Range { start: pos(5, 0), end: pos(5, 3) },
            Severity::Error,
            "Call to a member function x() on null.".into(),
            None,
            "phpstan",
        ),
    ];
    remove_duplicates(
        &mut found,
        &[
            engine(2, "Syntax error: unexpected token"),
            engine(4, "Undefined variable '$a'"),
            engine(5, "Undefined variable '$a'"),
        ],
    );
    assert_eq!(found.len(), 1);
    assert!(found[0].message.starts_with("Call to a member"));
}

#[test]
fn console_tags_are_stripped_but_generics_kept() {
    assert_eq!(strip_console_tags("<fg=cyan>a</> array<int> <options=bold>b</>"), "a array<int> b");
    assert_eq!(strip_console_tags("x < y"), "x < y");
}
