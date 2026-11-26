use openidea_plugin::{host, register_plugin, *};

#[derive(Default)]
struct ExecutionOutput;

impl Plugin for ExecutionOutput {
    fn run_command(&mut self, id: &str, _: &Invocation, arg: Option<&str>) -> Result<Option<String>, Error> {
        match id {
            "start" => {
                let raw = arg.unwrap_or("pty-default|default|run");
                let mut parts = raw.split('|');
                let config = parts.next().unwrap_or("pty-default");
                let mode = match parts.next().unwrap_or("default") {
                    "pty" => Some(OutputMode::Pty),
                    "pipes" => Some(OutputMode::Pipes),
                    _ => None,
                };
                let debug = parts.next() == Some("debug");
                host::start_run_with_options(
                    config,
                    &["extra".into()],
                    &RunStartOptions { debug, output_mode: mode },
                )
                .map(Some)
            }
            "start-legacy" => host::start_run(arg.unwrap_or("pty-default"), &["legacy".into()], false).map(Some),
            "events" => host::storage::get("events"),
            _ => Err(Error::NotFound(id.into())),
        }
    }

    fn handle_events(&mut self, events: &[Event], _: &Invocation) {
        let mut received: Vec<serde_json::Value> = host::storage::get("events")
            .unwrap()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        for event in events {
            if let Event::Other { kind, data } = event {
                received.push(serde_json::json!({"kind": kind, "data": data}));
            }
        }
        host::storage::set("events", &serde_json::to_string(&received).unwrap()).unwrap();
    }
}

impl ExecutionConfigurations for ExecutionOutput {
    fn execution_configurations(&mut self, _: &str) -> Vec<PluginExecutionConfiguration> {
        vec![
            PluginExecutionConfiguration {
                launch: PluginLaunchConfiguration {
                    config: PluginRunConfiguration {
                        id: "pty-default".into(),
                        name: "PTY Default".into(),
                        program: "execution-tool".into(),
                        args: vec!["pty".into()],
                        ..Default::default()
                    },
                    env: Vec::new(),
                    debugger: Some(Debugger::Launch { language: "python".into() }),
                },
                output_mode: OutputMode::Pty,
            },
            PluginExecutionConfiguration {
                launch: PluginLaunchConfiguration {
                    config: PluginRunConfiguration {
                        id: "pipes-default".into(),
                        name: "Pipes Default".into(),
                        program: "execution-tool".into(),
                        args: vec!["pipes".into()],
                        ..Default::default()
                    },
                    env: Vec::new(),
                    debugger: None,
                },
                output_mode: OutputMode::Pipes,
            },
            PluginExecutionConfiguration {
                launch: PluginLaunchConfiguration {
                    config: PluginRunConfiguration {
                        id: "test-pipes".into(),
                        name: "Test Pipes".into(),
                        program: "execution-tool".into(),
                        args: vec!["test".into()],
                        test: true,
                        ..Default::default()
                    },
                    env: Vec::new(),
                    debugger: None,
                },
                output_mode: OutputMode::Pipes,
            },
        ]
    }
}

register_plugin!(ExecutionOutput, execution_configurations);
