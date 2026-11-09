use openidea_plugin::{host, mock::MockHost, *};
#[test]
fn keyed_terminals_require_program_grants_and_reuse_only_live_operations() {
    let mock = MockHost::install();
    let cmd = host::Command::new("runner");
    assert!(matches!(host::open_terminal_session("key", "Terminal", &cmd), Err(Error::Denied(_))));
    let mock = mock.with_capabilities(&["process:runner"]);
    let first = host::open_terminal_session("key", "Terminal", &cmd).unwrap();
    assert_eq!(host::open_terminal_session("key", "Again", &cmd).unwrap(), first);
    host::write_terminal("key", "hello\n").unwrap();
    assert_eq!(mock.terminal_writes(), [("key".into(), "hello\n".into())]);
    let event = mock.finish_terminal("key").unwrap();
    assert_eq!(event.terminal_exited().unwrap().id, first);
    assert_ne!(host::open_terminal_session("key", "Next", &cmd).unwrap(), first);
    let _ = mock.finish_terminal("key");
    assert!(matches!(host::write_terminal("key", "late"), Err(Error::NotFound(_))));
    assert!(host::open_terminal_session("key", "Next", &cmd.env("VALUE", "first").env("VALUE", "collision")).is_err());
}
#[test]
fn owned_configurations_require_grants_and_reject_debug_without_a_debugger() {
    let mock = MockHost::install();
    mock.set_run_configurations(vec![PluginRunConfiguration {
        id: "tests".into(),
        program: "runner".into(),
        ..Default::default()
    }]);
    assert!(matches!(host::start_run("tests", &[], false), Err(Error::Denied(_))));
    let _mock = mock.with_capabilities(&["process:runner"]);
    assert!(host::start_run("tests", &["extra".into()], false).unwrap().starts_with("mock-run-"));
    assert!(matches!(host::start_run("tests", &[], true), Err(Error::Invalid(_))));
    assert!(matches!(host::start_run("foreign", &[], false), Err(Error::NotFound(_))));
}

#[test]
fn run_targets_require_a_program_grant_and_are_project_scoped() {
    let mock = MockHost::install();
    let project = mock.invocation().project().unwrap();
    let target = PluginRunTarget {
        id: "ddev".into(),
        name: "DDEV".into(),
        program: "ddev".into(),
        args: vec!["exec".into()],
        ..Default::default()
    };
    assert!(matches!(host::register_run_target(&project, &target), Err(Error::Denied(_))));
    let mock = mock.with_capabilities(&["process:ddev"]);
    host::register_run_target(&project, &target).unwrap();
    assert_eq!(mock.run_targets().len(), 1);
    host::register_run_target(&project, &target).unwrap();
    assert_eq!(mock.run_targets().len(), 1);
    host::unregister_run_target(&project, "missing");
    assert_eq!(mock.run_targets().len(), 1);
    host::unregister_run_target(&project, "ddev");
    assert!(mock.run_targets().is_empty());
}

#[test]
fn parsers_can_keep_the_default_unsupported_test_selection() {
    struct Parser;
    impl TestResults for Parser {
        fn parse(&mut self, _: &str, _: &str) -> Vec<PluginTestEvent> {
            vec![]
        }
    }
    assert_eq!(Parser.select_tests("tests", &[vec!["Suite".into(), "Test".into()]]), None);
}
