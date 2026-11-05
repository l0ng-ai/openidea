//! Test fixture: MCP tools (`where_am_i` reports where it runs, `fail`
//! fails) and a command launching an "agent" in a terminal with the MCP
//! endpoint in its environment.

use openidea_plugin::mcp::McpTools;
use openidea_plugin::{Error, Invocation, Plugin, TerminalOptions, host, register_plugin};

#[derive(Default)]
pub struct McpProbe {
    calls: u32,
}

impl Plugin for McpProbe {
    /// `launch` passes the token in `OPENIDEA_MCP_TOKEN`, or the variable `arg` names.
    fn run_command(&mut self, id: &str, ctx: &Invocation, arg: Option<&str>) -> Result<Option<String>, Error> {
        match id {
            "launch" => {
                let endpoint = ctx.project().ok_or("no project is open")?.mcp_endpoint()?;
                let agent = TerminalOptions::new("Agent", "agent")
                    .args(["--mcp-url", endpoint.url.as_str()])
                    .env(arg.unwrap_or("OPENIDEA_MCP_TOKEN"), &endpoint.token)
                    .cwd("src");
                host::open_terminal_with(&agent)?;
                Ok(Some(endpoint.stdio_command.join(" ")))
            }
            _ => Err(Error::NotFound(format!("command {id}"))),
        }
    }
}

impl McpTools for McpProbe {
    fn call_tool(&mut self, name: &str, arguments: &str, ctx: &Invocation) -> Result<String, Error> {
        self.calls += 1;
        match name {
            "where_am_i" => {
                let root = ctx.project().ok_or("no project")?.root()?;
                let editor = match ctx.editor() {
                    Some(e) => {
                        let at = e.selections().ok().and_then(|s| s.first().copied());
                        let at = at.map_or_else(String::new, |r| format!(":{}:{}", r.start.line, r.start.character));
                        format!("{}{at}", e.path())
                    }
                    None => "-".into(),
                };
                Ok(format!("project={root} editor={editor} calls={} args={arguments}", self.calls))
            }
            "fail" => Err(Error::Failed("asked to fail".into())),
            _ => Err(Error::NotFound(format!("tool {name}"))),
        }
    }
}

register_plugin!(McpProbe, mcp);

#[cfg(test)]
mod tests {
    use super::*;
    use openidea_plugin::mock::MockHost;

    #[test]
    fn tools_and_the_launcher() {
        let host = MockHost::install().with_capabilities(&["mcp", "project.read", "editor.read", "process:agent"]);
        host.open_editor("/project/src/a.rs", "rust", "fn main() {}", &[(0, 3, 0, 7)]);
        let mut probe = McpProbe::default();
        let out = probe.call_tool("where_am_i", "{\"note\":1}", &host.invocation()).unwrap();
        assert_eq!(out, "project=/project editor=/project/src/a.rs:0:3 calls=1 args={\"note\":1}");
        assert_eq!(probe.call_tool("fail", "{}", &host.invocation()), Err(Error::Failed("asked to fail".into())));

        let stdio = probe.run_command("launch", &host.invocation(), None).unwrap().unwrap();
        assert_eq!(stdio, "openidea --mcp-stdio --project /project");
        let terminal = &host.terminals()[0];
        assert_eq!(terminal.env, [("OPENIDEA_MCP_TOKEN".to_owned(), "mock-token".to_owned())]);
        assert_eq!(terminal.cwd.as_deref(), Some("src"));
    }
}
