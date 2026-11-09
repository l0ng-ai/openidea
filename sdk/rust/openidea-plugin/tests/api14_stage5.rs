use openidea_plugin::{Error, PluginDataSource, host, mock::MockHost};
#[test]
fn database_wrappers_are_owned_project_scoped_and_write_only() {
    let mock = MockHost::install().with_capabilities(&[]);
    let p = mock.invocation().project().unwrap();
    let source =
        PluginDataSource { id: "local".into(), name: "Local".into(), driver: "postgres".into(), ..Default::default() };
    assert!(matches!(p.upsert_data_source(&source), Err(Error::Denied(c)) if c == "database.sources"));
    assert!(p.data_sources().is_err());
    assert!(p.remove_data_source("foreign").is_err());
    assert!(p.set_data_source_credential("local", "password").is_err());
    assert!(p.connect_data_source("local").is_err());
    let mock = mock.with_capabilities(&["database.sources"]);
    p.upsert_data_source(&source).unwrap();
    p.set_data_source_credential("local", "password").unwrap();
    p.connect_data_source("local").unwrap();
    assert_eq!(p.data_sources().unwrap(), ["local"]);
    assert!(matches!(p.remove_data_source("foreign"), Err(Error::NotFound(_))));
    mock.set_project_root(Some("/other"));
    assert!(mock.invocation().project().unwrap().data_sources().unwrap().is_empty());
    mock.set_restricted(true);
    assert!(p.data_sources().is_err());
    mock.set_restricted(false);
    p.remove_data_source("local").unwrap();
    assert!(p.data_sources().unwrap().is_empty());
}
#[test]
fn stdio_discovery_returns_only_argv_and_none_while_off() {
    let mock = MockHost::install();
    assert!(host::mcp_stdio_command().is_none());
    let command = vec!["openidea".into(), "--mcp-stdio".into(), "--project".into(), "/project".into()];
    mock.set_mcp_stdio_command(Some(command.clone()));
    assert_eq!(host::mcp_stdio_command(), Some(command));
}
