//! Settings › PHP › Inspections (the inspection profile in effect) and batch
//! Inspect Code over files that aren't open.

use std::collections::BTreeMap;

use ide_core::inspection_settings::InspectionOverride;

use super::*;

fn profile(json: &str) -> BTreeMap<String, InspectionOverride> {
    serde_json::from_str(json).unwrap()
}

/// The codes of the published diagnostics of `rel`.
fn published_codes(p: &Project, rel: &str) -> Vec<String> {
    p.published(rel).unwrap_or_default().into_iter().filter_map(|d| d.code).collect()
}

#[test]
fn profile_overrides_configure_the_builtin_inspections() {
    let config = InspectionConfig::from_profile(&profile(
        r#"{
            "lsp:php:PhpUndefinedClass": {"enabled": false},
            "lsp:php:PhpParams": {"options": {"strict": true}, "severity": "weakWarning"},
            "lsp:php:PhpIncompatibleReturnType": {"options": {"strict": false}},
            "lsp:php:PhpUnusedAlias": {"severity": "error"},
            "lsp:intelephense:P1009": {"enabled": false},
            "lsp:php": {"severity": "warning"}
        }"#,
    ));
    assert!(!config.all_disabled);
    assert_eq!(config.disabled.iter().collect::<Vec<_>>(), ["PhpUndefinedClass"]);
    assert_eq!(config.strict.iter().collect::<Vec<_>>(), ["PhpParams"]);
    assert_eq!(config.mode("PhpParams"), TypeCheckMode::Strict);
    assert_eq!(config.mode("PhpIncompatibleReturnType"), TypeCheckMode::Lenient);
    let ids = Inspections::configured(&config).ids();
    assert!(!ids.contains(&"PhpUndefinedClass"));
    assert_eq!(ids.len(), Inspections::builtin().len() - 1, "only the disabled one is left out");

    // Turning the whole producer off leaves only the syntax errors.
    let off = InspectionConfig::from_profile(&profile(r#"{"lsp:php": {"enabled": false}}"#));
    assert!(off.all_disabled && Inspections::configured(&off).is_empty());

    // No overrides: the built-in set in lenient mode.
    let default = InspectionConfig::from_profile(&BTreeMap::new());
    assert_eq!(default, InspectionConfig::default());
    assert_eq!(Inspections::configured(&default).ids(), Inspections::builtin().ids());
}

#[test]
fn every_call_and_type_check_takes_its_own_mode() {
    let asked = Mutex::new(Vec::new());
    let set = Inspections::builtin_modes(&|id| {
        asked.lock().push(id);
        TypeCheckMode::Lenient
    });
    let asked = asked.into_inner();
    assert_eq!(
        asked,
        [
            "PhpMethodParametersCountMismatch",
            "PhpUnknownNamedArgument",
            "PhpParams",
            "PhpIncompatibleReturnType",
            "PhpFieldAssignmentTypeMismatch",
        ]
    );
    // The mode is asked under the inspection's own id.
    let ids = set.ids();
    let position = |id: &str| ids.iter().position(|i| *i == id).unwrap();
    assert_eq!(asked.iter().map(|id| position(id)).collect::<Vec<_>>(), [8, 9, 10, 11, 12]);
}

#[test]
fn settings_switch_inspections_off_and_to_strict() {
    let mut p = Project::new();
    let rel = "src/a.php";
    // An extra argument to a user function: strict mode only.
    let doc = p
        .open(rel, "<?php\nfunction f(int $a): void { echo $a; }\nf(1, 2);\nfunction g(): void { echo $undefined; }\n");

    // The default configuration is the one the engine started with: nothing
    // to do (the test set stays).
    p.engine.configure_inspections(InspectionConfig::default());
    assert_eq!(p.engine.inspections().ids(), test_set().ids());

    let strict = InspectionConfig::from_profile(&profile(
        r#"{"lsp:php:PhpMethodParametersCountMismatch": {"options": {"strict": true}}}"#,
    ));
    p.engine.configure_inspections(strict.clone());
    assert!(p.engine.wait_inspections(WAIT));
    assert_eq!(published_codes(&p, rel), ["PhpMethodParametersCountMismatch", "PhpUndefinedVariable"]);
    let inspected = p.engine.inspected(doc).unwrap();
    let count = inspected.problems.iter().find(|p| p.inspection.ends_with("Mismatch"));
    assert_eq!(count.map(|p| p.range.start.line), Some(2));

    // The same configuration again changes nothing: no new run.
    p.events.lock().clear();
    p.engine.configure_inspections(strict);
    assert!(p.engine.wait_inspections(WAIT));
    assert_eq!(p.published(rel), None);

    // Back to lenient, with the undefined variables off.
    p.engine.configure_inspections(InspectionConfig::from_profile(&profile(
        r#"{"lsp:php:PhpUndefinedVariable": {"enabled": false}}"#,
    )));
    assert!(p.engine.wait_inspections(WAIT));
    assert_eq!(published_codes(&p, rel), Vec::<String>::new());
    assert!(!p.engine.inspections().ids().contains(&"PhpUndefinedVariable"));
}

#[test]
fn inspect_file_checks_files_that_are_not_open() {
    let p = Project::with_files(&[("src/Foo.php", "<?php\nnamespace App;\n\nclass Foo {}\n")]);
    p.engine.set_inspections(Inspections::builtin());
    let path = p.root.join("src").join("b.php");
    let text = "<?php\nnew \\App\\Foo();\nnew \\App\\Missing();\n$x = ;\n";
    let found = p.engine.inspect_file(&path, text, &CancellationToken::new()).expect("inspected");
    let mut codes: Vec<String> = found.iter().map(|d| d.code.clone().unwrap_or_else(|| "syntax".into())).collect();
    codes.dedup();
    assert_eq!(codes, ["syntax", "PhpUndefinedClass"], "{found:?}");
    let undefined = found.iter().find(|d| d.code.as_deref() == Some("PhpUndefinedClass")).unwrap();
    assert_eq!(undefined.range.start, Pos::new(2, 4));
    assert_eq!(undefined.source.as_deref(), Some("php"));

    // Nothing is published for a batch run.
    assert!(p.engine.wait_inspections(WAIT));
    assert_eq!(p.published("src/b.php"), None);

    // Cancelled: nothing.
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(p.engine.inspect_file(&path, text, &cancel).is_none());
}

#[test]
fn inspect_file_uses_the_buffer_of_an_open_document() {
    let mut p = Project::new();
    p.open("src/a.php", "<?php\ntodo();\n");
    let path = p.root.join("src").join("a.php");
    let found = p.engine.inspect_file(&path, "<?php\n// saved text without problems\n", &CancellationToken::new());
    let codes: Vec<Option<String>> = found.unwrap().into_iter().map(|d| d.code).collect();
    assert_eq!(codes, [Some("PhpTodoCall".to_owned())]);
}

/// Settings › PHP › Inspections lists the engine's inspections from
/// `src/platform/phpInspections.ts`: every built-in one, in order, the call
/// and type checks with the Strict option.
#[test]
fn the_settings_page_lists_every_inspection() {
    let ts = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/platform/phpInspections.ts"),
    )
    .unwrap();
    let listed: Vec<&str> =
        ts.lines().filter_map(|line| line.trim().strip_prefix("code: \"")?.strip_suffix("\",")).collect();
    assert_eq!(listed, Inspections::builtin().ids());
    assert!(ts.contains(&format!("PHP_STRICT_OPTION = \"{STRICT_OPTION}\"")));
    assert!(ts.contains("`lsp:${PHP_PRODUCER}:${code}`") && PROFILE_ID == "lsp:php");
}
