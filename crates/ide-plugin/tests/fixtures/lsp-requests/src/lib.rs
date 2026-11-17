use openidea_plugin::{Error, Invocation, Plugin, register_plugin};

#[derive(Default)]
struct LspRequests;

impl Plugin for LspRequests {
    fn run_command(&mut self, id: &str, inv: &Invocation, arg: Option<&str>) -> Result<Option<String>, Error> {
        let project = inv.project().ok_or("no project")?;
        match id {
            "request" => project.language_server_request("mock", "mock/routes", arg).map(Some),
            "notify" => project.language_server_notify("mock", "mock/changed", arg).map(|()| None),
            "standard" => project.language_server_request("mock", "textDocument/hover", arg).map(Some),
            // Shows the server what arrived: the arguments of the command it handed to the client.
            "ran" => project.language_server_notify("mock", "mock/ran", arg).map(|()| None),
            "ungranted" => project.language_server_request("other", "other/status", arg).map(Some),
            _ => Err(Error::NotFound(id.into())),
        }
    }
}

register_plugin!(LspRequests);
