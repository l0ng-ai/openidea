use openidea_plugin::{host, register_plugin, *};
#[derive(Default)]
struct Execution;
impl Plugin for Execution {
    fn run_command(&mut self, id: &str, _ctx: &Invocation, arg: Option<&str>) -> Result<Option<String>, Error> {
        match id {
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
            "events" => host::storage::get("events"),
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
register_plugin!(Execution, run_configurations, test_results);
