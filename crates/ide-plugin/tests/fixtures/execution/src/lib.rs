use openidea_plugin::{host, register_plugin, *};
#[derive(Default)]
struct Execution;
impl Plugin for Execution {
    fn run_command(&mut self, id: &str, ctx: &Invocation, arg: Option<&str>) -> Result<Option<String>, Error> {
        match id {
            "target" => {
                let project = ctx.project().ok_or_else(|| Error::Invalid("no project".into()))?;
                host::register_run_target(
                    &project,
                    &PluginRunTarget {
                        id: arg.unwrap_or("wrapper").into(),
                        name: "Execution target".into(),
                        program: "execution-tool".into(),
                        args: vec!["wrapped".into()],
                        workdir_args: vec!["--cwd={cwd}".into()],
                        container_root: Some("/container".into()),
                        commands: vec![("composer".into(), vec!["composer".into()])],
                    },
                )?;
                Ok(None)
            }
            "target-overrides" => {
                let project = ctx.project().ok_or_else(|| Error::Invalid("no project".into()))?;
                let workdir_args = match arg {
                    Some("empty") => Some(vec![]),
                    Some("own") => Some(vec!["--working-dir={cwd}".into()]),
                    Some("invalid") => Some(vec!["bad\0arg".into()]),
                    _ => None,
                };
                host::register_run_target_with_overrides(
                    &project,
                    &PluginRunTargetWithOverrides {
                        id: "wrapper".into(),
                        name: "Execution target".into(),
                        program: "execution-tool".into(),
                        args: vec!["wrapped".into()],
                        workdir_args: vec!["--cwd={cwd}".into()],
                        container_root: Some("/container".into()),
                        commands: vec![PluginCommandOverride {
                            name: "composer".into(),
                            args: vec!["composer".into()],
                            workdir_args,
                        }],
                    },
                )?;
                Ok(None)
            }
            "untarget" => {
                host::unregister_run_target(&ctx.project().unwrap(), arg.unwrap_or("wrapper"));
                Ok(None)
            }
            "run" | "debug" => {
                host::start_run(arg.unwrap_or("detected"), &["appended".into()], id == "debug").map(Some)
            }
            "terminal" => host::open_terminal_session(
                "session",
                "Execution",
                &host::Command::new("execution-tool").args(["interactive"]),
            )
            .map(Some),
            "write" => {
                host::write_terminal("session", arg.unwrap_or("input\n"))?;
                Ok(None)
            }
            "content" => {
                host::open_content_tab(&ContentTab {
                    key: "config".into(),
                    title: "Config".into(),
                    content: "hello".into(),
                    actions: vec![ContentAction {
                        id: "save".into(),
                        label: "Save".into(),
                        save: true,
                        ..Default::default()
                    }],
                    ..Default::default()
                })?;
                Ok(None)
            }
            "diff" => {
                host::open_diff(
                    &ContentDiff {
                        left: "before\n".into(),
                        right: "after\n".into(),
                        title: Some("Review".into()),
                        ..Default::default()
                    },
                    Some("src/review.rs"),
                )?;
                Ok(None)
            }
            "events" => host::storage::get("events"),
            "validation" => host::storage::get("validation"),
            _ => Err(Error::NotFound(id.into())),
        }
    }
    fn handle_events(&mut self, events: &[Event], _: &Invocation) {
        let mut received: Vec<serde_json::Value> =
            host::storage::get("events").unwrap().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        for event in events {
            if let Event::Other { kind, data } = event {
                received.push(serde_json::json!({"kind": kind, "data": data}));
                if kind == "content-tab-action" {
                    let a: ContentTabAction = serde_json::from_str(data).unwrap();
                    host::reply_content_tab(
                        &a.request_id,
                        &ContentTabReply { saved: Some(true), status: Some("Saved".into()), ..Default::default() },
                    )
                    .unwrap();
                }
            }
        }
        host::storage::set("events", &serde_json::to_string(&received).unwrap()).unwrap();
    }
}
impl RunConfigurations for Execution {
    fn configurations(&mut self, _: &str) -> Vec<PluginRunConfiguration> {
        vec![PluginRunConfiguration {
            id: "dynamic".into(),
            name: "Dynamic tests".into(),
            program: "execution-tool".into(),
            args: vec!["test".into()],
            test: true,
            framework: Some("plugin".into()),
            ..Default::default()
        }]
    }
}
impl TestResults for Execution {
    fn select_tests(&mut self, config: &str, tests: &[Vec<String>]) -> Option<Vec<String>> {
        match tests.first()?.first()?.as_str() {
            "none" => return None,
            "trap" => panic!("selection failed"),
            "timeout" => loop {
                std::hint::spin_loop();
            },
            _ => {}
        }
        Some(std::iter::once(config.to_owned()).chain(tests.iter().map(|p| p.join("::"))).collect())
    }
    fn parse(&mut self, _: &str, chunk: &str) -> Vec<PluginTestEvent> {
        if chunk == "trap" {
            panic!("parser failed");
        }
        vec![
            PluginTestEvent::SuiteStarted(TestStart {
                id: "suite".into(),
                parent: None,
                name: "Suite".into(),
                location: None,
            }),
            PluginTestEvent::TestStarted(TestStart {
                id: "test".into(),
                parent: Some("suite".into()),
                name: "Test".into(),
                location: None,
            }),
            PluginTestEvent::Passed(TestPassed { id: "test".into(), duration_ms: Some(7) }),
        ]
    }
}
impl RunTargetValidation for Execution {
    fn validate(&mut self, project: &str, target: &str, launch: &RunTargetLaunch) -> Result<(), String> {
        host::storage::set(
            "validation",
            &format!("{project}|{target}|{:?}|{}|{}", launch.operation, launch.program, launch.cwd),
        )
        .unwrap();
        match target {
            "refuse" => Err("Project runtime is stopped".into()),
            "long-refusal" => Err("x".repeat(10000)),
            "trap" => panic!("validator failed"),
            "timeout" => {
                let _task = host::begin_task("Validation", true);
                loop {
                    std::hint::spin_loop();
                }
            }
            _ => Ok(()),
        }
    }
}
register_plugin!(Execution, run_configurations, test_results, run_target_validation);
