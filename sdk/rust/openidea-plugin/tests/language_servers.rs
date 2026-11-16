use openidea_plugin::{Error, mock::MockHost};

#[test]
fn requests_reach_a_running_servers_own_methods_behind_the_grant() {
    let mock = MockHost::install().with_capabilities(&[]);
    mock.set_language_server_response("phoxite", "phoxite/laravel/routes", r#"[{"uri":"/users"}]"#);
    let p = mock.invocation().project().unwrap();
    let routes = |p: &openidea_plugin::host::Project| {
        p.language_server_request("phoxite", "phoxite/laravel/routes", Some(r#"{"method":"GET"}"#))
    };
    assert!(matches!(routes(&p), Err(Error::Denied(c)) if c == "lsp:phoxite"));
    assert!(matches!(p.language_server_notify("phoxite", "phoxite/changed", None), Err(Error::Denied(_))));

    let mock = mock.with_capabilities(&["lsp:phoxite"]);
    assert_eq!(routes(&p).unwrap(), r#"[{"uri":"/users"}]"#);
    p.language_server_notify("phoxite", "phoxite/changed", None).unwrap();
    let sent = mock.language_server_requests();
    assert_eq!(sent.len(), 1);
    assert_eq!((sent[0].server.as_str(), sent[0].method.as_str()), ("phoxite", "phoxite/laravel/routes"));
    assert_eq!(sent[0].params.as_deref(), Some(r#"{"method":"GET"}"#));
    assert_eq!(mock.language_server_notifications()[0].method, "phoxite/changed");

    // LSP's own methods never pass, and a grant covers one server.
    for method in ["textDocument/hover", "workspace/executeCommand", "$/cancelRequest", "shutdown"] {
        assert!(matches!(p.language_server_request("phoxite", method, None), Err(Error::Invalid(_))), "{method}");
    }
    assert!(
        matches!(p.language_server_request("intelephense", "x/y", None), Err(Error::Denied(c)) if c == "lsp:intelephense")
    );

    // A server that is not running is not-found; one that runs fails an unknown method itself.
    let mock = mock.with_capabilities(&["lsp:phoxite", "lsp:phpactor"]);
    assert!(matches!(p.language_server_request("phpactor", "phpactor/status", None), Err(Error::NotFound(_))));
    assert!(matches!(p.language_server_request("phoxite", "phoxite/unknown", None), Err(Error::Failed(_))));

    mock.set_restricted(true);
    assert!(matches!(routes(&p), Err(Error::Denied(m)) if m == "project is not trusted"));
}
