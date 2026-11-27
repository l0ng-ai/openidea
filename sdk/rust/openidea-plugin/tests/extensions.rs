use openidea_plugin::{Error, EventKind, host, mock::MockHost};
use serde::Deserialize;

#[derive(Debug, Deserialize, PartialEq)]
struct Completion {
    label: String,
    weight: Option<i64>,
}

#[test]
fn a_plugin_reads_what_dependents_contributed_to_its_point() {
    let mock = MockHost::install();
    assert!(matches!(host::extension_contributions("acme.base.completions"), Err(Error::NotFound(_))));

    mock.set_extension_contributions(
        "acme.base.completions",
        vec![("acme.more", r#"{"label":"ew.x","weight":3}"#), ("acme.other", r#"{"label":"y"}"#)],
    );
    let all = host::extension_contributions("acme.base.completions").unwrap();
    assert_eq!(all.iter().map(|c| c.plugin.as_str()).collect::<Vec<_>>(), ["acme.more", "acme.other"]);
    assert_eq!(all[0].parse::<Completion>().unwrap(), Completion { label: "ew.x".into(), weight: Some(3) });
    assert_eq!(all[1].parse::<Completion>().unwrap(), Completion { label: "y".into(), weight: None });
}

#[test]
fn a_contribution_that_does_not_fit_the_type_is_an_invalid_error_naming_the_plugin() {
    let mock = MockHost::install();
    mock.set_extension_contributions("acme.base.completions", vec![("acme.more", r#"{"weight":1}"#)]);
    let all = host::extension_contributions("acme.base.completions").unwrap();
    let Err(Error::Invalid(message)) = all[0].parse::<Completion>() else { panic!("expected invalid") };
    assert!(message.contains("acme.more"), "{message}");
}

#[test]
fn the_change_event_has_the_name_the_ide_knows() {
    assert_eq!(EventKind::ExtensionsChanged.name(), "extensions-changed");
}
