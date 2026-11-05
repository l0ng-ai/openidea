//! `PluginEngine::check_component` (what installing and `openidea-plugin check`
//! run) refuses a component the IDE could not start: every import has to link
//! against the host, function by function, and the plugin world's exports have
//! to be there, not only the interface names and their API version.

use ide_plugin::PluginEngine;

fn check(wat: &str) -> Result<Option<semver::Version>, String> {
    let engine = PluginEngine::new().unwrap();
    let component = engine.compile_bytes(&wat::parse_str(wat).unwrap()).unwrap();
    engine.check_component(&component)
}

#[test]
fn components_the_host_cannot_link_are_refused() {
    let cases = [
        // dengliu.gitlink 0.1.0: functions added to `ui` on an unreleased branch, still at @1.0.0.
        (
            "a function the host's interface lacks",
            r#"(component (import "openidea:plugin/ui@1.0.0" (instance
                (export "copy-to-clipboard" (func (param "text" string))))))"#,
            "copy-to-clipboard",
        ),
        (
            "a function with another signature",
            r#"(component (import "openidea:plugin/ui@1.0.0" (instance
                (export "show-notification" (func (param "title" string))))))"#,
            "show-notification",
        ),
        (
            "an interface the host lacks",
            r#"(component (import "openidea:plugin/clipboard@1.0.0" (instance
                (export "copy" (func (param "text" string))))))"#,
            "openidea:plugin/clipboard@1.0.0",
        ),
        ("no plugin exports", r#"(component (import "openidea:plugin/ui@1.0.0" (instance)))"#, "lifecycle"),
    ];
    for (case, wat, names) in cases {
        let err = check(wat).expect_err(case);
        assert!(err.contains(names), "{case}: {err}");
        assert!(err.contains("update OpenIDEA") && err.contains("rebuild"), "{case}: {err}");
    }
}
