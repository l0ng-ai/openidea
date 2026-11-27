use openidea_plugin::{host, mock::MockHost, *};

fn exec_cfg(id: &str, test: bool, debugger: Option<Debugger>, output_mode: OutputMode) -> PluginExecutionConfiguration {
    PluginExecutionConfiguration {
        launch: PluginLaunchConfiguration {
            config: PluginRunConfiguration {
                id: id.into(),
                name: id.into(),
                program: "runner".into(),
                args: vec!["run".into()],
                test,
                ..Default::default()
            },
            env: vec![],
            debugger,
        },
        output_mode,
    }
}

#[test]
fn output_mode_precedence_and_disallowed_combinations() {
    let mock = MockHost::install();
    mock.set_execution_configurations(vec![
        exec_cfg("pty-default", false, Some(Debugger::Launch { language: "python".into() }), OutputMode::Pty),
        exec_cfg("pipes-default", false, None, OutputMode::Pipes),
        exec_cfg("test-pipes", true, None, OutputMode::Pipes),
    ]);

    assert!(matches!(
        host::start_run_with_options("pty-default", &[], &RunStartOptions::default()),
        Err(Error::Denied(_))
    ));

    let mock = mock.with_capabilities(&["process:runner"]);

    // Plugin default applies when invocation passes None.
    let id1 = host::start_run_with_options("pty-default", &["a".into()], &RunStartOptions::default()).unwrap();
    let id2 = host::start_run_with_options("pipes-default", &[], &RunStartOptions::default()).unwrap();

    // Per-invocation override wins over plugin default.
    let id3 = host::start_run_with_options(
        "pty-default",
        &[],
        &RunStartOptions { debug: false, output_mode: Some(OutputMode::Pipes) },
    )
    .unwrap();
    let id4 = host::start_run_with_options(
        "pipes-default",
        &[],
        &RunStartOptions { debug: false, output_mode: Some(OutputMode::Pty) },
    )
    .unwrap();

    // User-saved override wins over both invocation and plugin default.
    mock.set_user_run_output_override("pty-default", Some(OutputMode::Pipes));
    let id5 = host::start_run_with_options(
        "pty-default",
        &[],
        &RunStartOptions { debug: false, output_mode: Some(OutputMode::Pty) },
    )
    .unwrap();
    mock.set_user_run_output_override("pipes-default", Some(OutputMode::Pty));
    let id6 = host::start_run_with_options(
        "pipes-default",
        &[],
        &RunStartOptions { debug: false, output_mode: Some(OutputMode::Pipes) },
    )
    .unwrap();

    assert_eq!(
        mock.configuration_run_options().into_iter().map(|(id, _, _, _, mode)| (id, mode)).collect::<Vec<_>>(),
        vec![
            (id1, OutputMode::Pty),
            (id2, OutputMode::Pipes),
            (id3, OutputMode::Pipes),
            (id4, OutputMode::Pty),
            (id5, OutputMode::Pipes),
            (id6, OutputMode::Pty),
        ]
    );

    // Debug with None forces pipes; explicit Pty with debug is rejected.
    mock.set_user_run_output_override("pty-default", None);
    let debug_id =
        host::start_run_with_options("pty-default", &[], &RunStartOptions { debug: true, output_mode: None }).unwrap();
    assert_eq!(mock.configuration_run_options().last().unwrap().0, debug_id);
    assert_eq!(mock.configuration_run_options().last().unwrap().4, OutputMode::Pipes);
    assert!(matches!(
        host::start_run_with_options(
            "pty-default",
            &[],
            &RunStartOptions { debug: true, output_mode: Some(OutputMode::Pty) }
        ),
        Err(Error::Invalid(_))
    ));

    // Disallowed combinations: test, stdin redirection, remote target.
    assert!(matches!(
        host::start_run_with_options(
            "test-pipes",
            &[],
            &RunStartOptions { debug: false, output_mode: Some(OutputMode::Pty) }
        ),
        Err(Error::Invalid(_))
    ));
    mock.set_run_configuration_stdin_file("pipes-default", true);
    mock.set_user_run_output_override("pipes-default", None);
    assert!(matches!(
        host::start_run_with_options(
            "pipes-default",
            &[],
            &RunStartOptions { debug: false, output_mode: Some(OutputMode::Pty) }
        ),
        Err(Error::Invalid(_))
    ));
    mock.set_run_configuration_stdin_file("pipes-default", false);
    mock.set_run_configuration_remote_target("pipes-default", true);
    assert!(matches!(
        host::start_run_with_options(
            "pipes-default",
            &[],
            &RunStartOptions { debug: false, output_mode: Some(OutputMode::Pty) }
        ),
        Err(Error::Invalid(_))
    ));
}
