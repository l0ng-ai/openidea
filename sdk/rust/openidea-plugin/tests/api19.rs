use openidea_plugin::{Error, mock::MockHost};

#[test]
fn language_server_requests_need_the_server_grant_and_pass_its_answer_through() {
    let mock = MockHost::install().with_capabilities(&[]);
    let p = mock.invocation().project().unwrap();
    assert!(
        matches!(p.language_server_request("phoxite", "phoxite/laravel/modelView", Some("{}")), Err(Error::Denied(c)) if c == "lsp:phoxite")
    );
    assert!(p.language_server_notify("phoxite", "phoxite/laravel/touched", None).is_err());

    let mock = mock.with_capabilities(&["lsp:phoxite"]);
    // A different server stays denied: one grant per server name.
    assert!(
        matches!(p.language_server_request("gopls", "gopls/listimports", None), Err(Error::Denied(c)) if c == "lsp:gopls")
    );

    mock.on_language_server(|server, method, params| {
        assert_eq!(server, "phoxite");
        match (method, params) {
            ("phoxite/laravel/modelView", Some(r#"{"model":"User"}"#)) => Ok(r#"{"view":"users.index"}"#.into()),
            ("phoxite/laravel/touched", None) => Ok("{}".into()),
            other => panic!("unexpected call {other:?}"),
        }
    });
    assert_eq!(
        p.language_server_request("phoxite", "phoxite/laravel/modelView", Some(r#"{"model":"User"}"#)).unwrap(),
        r#"{"view":"users.index"}"#
    );
    assert!(p.language_server_notify("phoxite", "phoxite/laravel/touched", None).is_ok());
    assert_eq!(
        mock.language_server_calls(),
        [
            ("phoxite".into(), "phoxite/laravel/modelView".into(), Some(r#"{"model":"User"}"#.into())),
            ("phoxite".into(), "phoxite/laravel/touched".into(), None),
        ]
    );

    // Without a handler the request is the host's not-found.
    let bare = MockHost::install().with_capabilities(&["lsp:phoxite"]);
    assert!(matches!(
        bare.invocation().project().unwrap().language_server_request("phoxite", "phoxite/index", None),
        Err(Error::NotFound(_))
    ));
}

#[test]
fn the_standard_methods_are_refused_before_anything_reaches_the_server() {
    let mock = MockHost::install().with_capabilities(&["lsp:phoxite"]);
    let p = mock.invocation().project().unwrap();
    let refused = [
        "initialize",
        "initialized",
        "shutdown",
        "exit",
        "$/cancelRequest",
        "textDocument/completion",
        "workspace/executeCommand",
        "window/showMessageRequest",
        "notebookDocument/didOpen",
        "callHierarchy/incomingCalls",
        "typeHierarchy/supertypes",
        "completionItem/resolve",
        "codeAction/resolve",
        "codeLens/resolve",
        "documentLink/resolve",
        "inlayHint/resolve",
        "workspaceSymbol/resolve",
        "client/registerCapability",
        "telemetry/event",
        "",
    ];
    mock.on_language_server(|_, _, _| panic!("a refused method must not reach the server"));
    for method in refused {
        let Err(Error::Invalid(message)) = p.language_server_request("phoxite", method, Some("{}")) else {
            panic!("{method:?} must be refused");
        };
        assert!(message.contains("own methods"), "{method:?}: {message}");
    }
    // `textDocumentX/foo` only looks close to a standard namespace: it is the
    // server's own and passes.
    mock.on_language_server(|_, _, _| Ok("{}".into()));
    assert_eq!(p.language_server_request("phoxite", "textDocumentX/foo", None).unwrap(), "{}");

    // Params must be JSON.
    let Err(Error::Invalid(message)) = p.language_server_request("phoxite", "phoxite/index", Some("{not json")) else {
        panic!("non-JSON params must be refused");
    };
    assert!(message.contains("JSON"), "{message}");
    assert!(mock.language_server_calls().iter().all(|(_, method, _)| method != "phoxite/index"));
}
