use openidea_plugin::{Error, Event, Invocation, Plugin, StatusItem, host, register_plugin};
#[derive(Default)]
struct Api14;
impl Plugin for Api14 {
    fn run_command(&mut self, id: &str, _ctx: &Invocation, arg: Option<&str>) -> Result<Option<String>, Error> {
        let arg = arg.unwrap_or_default();
        match id {
            "ipc" => {
                let stream = host::ipc_connect(arg)?;
                stream.write(b"echo")?;
                let bytes = stream.read(4, 2000)?;
                stream.close()?;
                Ok(Some(String::from_utf8_lossy(&bytes).into()))
            }
            "fetch" => {
                let response = host::fetch(&openidea_plugin::HttpRequest::get(arg))?;
                Ok(Some(String::from_utf8_lossy(&response.body).into()))
            }
            "global-status" | "window-status" => {
                let item = StatusItem { text: arg.into(), tooltip: None, command: Some("events".into()) };
                if id == "global-status" {
                    host::set_status_item("state", &item);
                } else {
                    host::set_window_status_item("state", &item)?;
                }
                Ok(None)
            }
            "remove-window-status" => {
                host::remove_window_status_item("state")?;
                Ok(None)
            }
            "execute" => host::execute_command(arg, Some("argument")),
            "oauth" => {
                let redirect = host::begin_loopback("oauth/callback")?;
                host::output_append("oauth", &redirect.redirect_uri())?;
                redirect.wait(2000)
            }
            "secret" => {
                host::secret_set("token", arg)?;
                Ok(None)
            }
            "delete-secret" => {
                host::secret_delete("token")?;
                Ok(None)
            }
            "undeclared-secret" => {
                host::secret_set("undeclared", arg)?;
                Ok(None)
            }
            "output" => {
                host::output_append("test", arg)?;
                host::output_reveal("test")?;
                Ok(None)
            }
            "process-run" => Ok(Some(host::run_process("api14-tool", &[], None)?.stdout)),
            "process-run-command" => Ok(Some(host::run_command(&host::Command::new("api14-tool"), None, None)?.stdout)),
            "process-start" => {
                let child = host::start(&host::Command::new("api14-tool"), None)?;
                Ok(Some(child.wait(2000)?.stdout))
            }
            "terminal" => {
                host::open_terminal("API test", "api14-tool", &[])?;
                Ok(None)
            }
            "log" => {
                host::open_log_tab(
                    "api-test",
                    "API test",
                    &openidea_plugin::details::ProcessLog {
                        program: "api14-tool".into(),
                        args: Vec::new(),
                        toggles: Vec::new(),
                    },
                )?;
                Ok(None)
            }
            "events" => host::storage::get("events"),
            _ => Err(Error::NotFound(id.into())),
        }
    }
    fn handle_events(&mut self, events: &[Event], ctx: &Invocation) {
        let mut received: Vec<serde_json::Value> =
            host::storage::get("events").unwrap().map(|s| serde_json::from_str(&s).unwrap()).unwrap_or_default();
        for event in events {
            if let Event::Other { kind, data } = event {
                let editor = ctx.editor().map(|e| {
                    (
                        e.path(),
                        e.selections()
                            .unwrap()
                            .into_iter()
                            .map(|r| [r.start.line, r.start.character, r.end.line, r.end.character])
                            .collect::<Vec<_>>(),
                    )
                });
                received.push(serde_json::json!({ "kind": kind, "data": data, "editor": editor }));
            }
        }
        host::storage::set("events", &serde_json::to_string(&received).unwrap()).unwrap();
    }
}
register_plugin!(Api14);
