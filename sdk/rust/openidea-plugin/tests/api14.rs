use openidea_plugin::{Error, HttpRequest, StatusItem, host, mock::MockHost};

#[test]
fn ipc_is_granted_bounded_and_closed_on_drop() {
    let mock = MockHost::install().with_capabilities(&[]);
    assert!(matches!(host::ipc_connect("/tmp/test-1"), Err(Error::Denied(_))));
    let _mock = mock.with_capabilities(&["ipc:/tmp/test-*"]);
    let connection = host::ipc_connect("/tmp/test-1").unwrap();
    connection.write(b"echo").unwrap();
    assert_eq!(connection.read(4, 100).unwrap(), b"echo");
    let others: Vec<_> = (0..7).map(|_| host::ipc_connect("/tmp/test-2").unwrap()).collect();
    assert!(matches!(host::ipc_connect("/tmp/test-3"), Err(Error::Invalid(_))));
    connection.close().unwrap();
    assert!(connection.read(4, 0).is_err());
    host::ipc_connect("/tmp/test-3").unwrap();
    drop(others);
}

#[test]
fn http_requires_its_own_grant_and_secrets_are_declaration_scoped() {
    let mock = MockHost::install().with_capabilities(&["net:*.example.com", "secrets"]);
    assert!(
        matches!(host::fetch(&HttpRequest::get("http://api.example.com/")), Err(Error::Denied(c)) if c == "net.http:api.example.com")
    );
    assert!(matches!(host::secret_set("token", "value"), Err(Error::NotFound(_))));
    mock.declare_secret("token");
    host::secret_set("token", "value").unwrap();
    assert!(host::secret_is_set("token"));
    host::secret_delete("token").unwrap();
    assert!(!host::secret_is_set("token"));
}

#[test]
fn scoped_status_commands_output_and_loopbacks_are_available_in_the_sdk() {
    let mock = MockHost::install();
    let item = |text: &str| StatusItem { text: text.into(), tooltip: None, command: None };
    host::set_status_item("state", &item("global"));
    host::set_window_status_item("state", &item("window")).unwrap();
    host::set_status_item("state", &item("updated"));
    assert_eq!(mock.status_items()["state"].text, "window");
    host::remove_window_status_item("state").unwrap();
    assert_eq!(mock.status_items()["state"].text, "updated");
    mock.on_command("other.command", |arg| Ok(arg.map(str::to_owned)));
    assert_eq!(host::execute_command("other.command", Some("result")).unwrap(), Some("result".into()));
    assert!(matches!(host::execute_command("missing", None), Err(Error::NotFound(_))));
    mock.on_command("recursive", |_| host::execute_command("recursive", None));
    assert!(matches!(host::execute_command("recursive", None), Err(Error::Invalid(_))));
    host::output_append("build", &"😀".repeat(300_000)).unwrap();
    assert_eq!(mock.output()["build"].len(), 1 << 20);
    host::output_clear("build").unwrap();
    assert!(mock.output()["build"].is_empty());
    host::output_reveal("build").unwrap();
    let listener = host::begin_loopback("callback").unwrap();
    assert!(listener.redirect_uri().starts_with("http://127.0.0.1:"));
    let other = host::begin_loopback("second").unwrap();
    assert!(matches!(host::begin_loopback("third"), Err(Error::Invalid(_))));
    mock.queue_loopback_query(Some("code=a%2Bb&state=test"));
    assert_eq!(listener.wait(100).unwrap().as_deref(), Some("code=a%2Bb&state=test"));
    assert!(listener.wait(100).is_err());
    drop(other);
    host::begin_loopback("third").unwrap();
}
