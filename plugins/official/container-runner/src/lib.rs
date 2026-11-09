//! A fake executable makes the argv/cwd and terminal lifecycle easy to inspect.
use openidea_plugin::{Error, Event, Invocation, Plugin, PluginRunTarget, StatusItem, host, register_plugin};
const PROGRAM: &str = "openidea-example-wrapper";
#[derive(Default)]
pub struct ContainerRunner;
impl Plugin for ContainerRunner {
    fn run_command(&mut self, _id: &str, ctx: &Invocation, _arg: Option<&str>) -> Result<Option<String>, Error> {
        let project = ctx.project().ok_or("Open a project first")?;
        host::register_run_target(
            &project,
            &PluginRunTarget {
                id: "example".into(),
                name: "Example wrapper".into(),
                program: PROGRAM.into(),
                args: vec!["exec".into()],
                workdir_args: vec!["--cwd".into(), "{cwd}".into()],
                container_root: None,
                commands: vec![],
            },
        )?;
        let id =
            host::open_terminal_session("example", "Wrapper example", &host::Command::new(PROGRAM).arg("terminal"))?;
        host::set_window_status_item(
            "wrapper",
            &StatusItem { text: "Wrapper running".into(), tooltip: Some(id.clone()), command: Some("start".into()) },
        )?;
        host::output_append("wrapper", &format!("Started terminal {id}\n"))?;
        host::output_reveal("wrapper")?;
        Ok(Some(id))
    }
    fn handle_events(&mut self, events: &[Event], _ctx: &Invocation) {
        for event in events {
            if let Some(exit) = event.terminal_exited() {
                let _ = host::output_append("wrapper", &format!("Terminal {} exited: {:?}\n", exit.id, exit.status));
                let _ = host::set_window_status_item(
                    "wrapper",
                    &StatusItem { text: "Wrapper exited".into(), tooltip: None, command: Some("start".into()) },
                );
            }
        }
    }
}
register_plugin!(ContainerRunner);
#[cfg(test)]
mod tests {
    use super::*;
    use openidea_plugin::mock::MockHost;
    #[test]
    fn terminal_completion_updates_status_and_output() {
        let mock = MockHost::install().with_capabilities(&["project.read", "process:openidea-example-wrapper"]);
        let mut plugin = ContainerRunner;
        plugin.run_command("start", &mock.invocation(), None).unwrap();
        assert_eq!(mock.run_targets().len(), 1);
        let event = mock.finish_terminal("example").unwrap();
        plugin.handle_events(&[event], &mock.invocation());
        assert_eq!(mock.status_items()["wrapper"].text, "Wrapper exited");
        assert!(mock.output()["wrapper"].contains("Some(0)"));
    }
}
