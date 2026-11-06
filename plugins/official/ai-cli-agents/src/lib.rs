//! AI CLI Agents: starts Claude Code and Codex in the IDE's terminal connected
//! to OpenIDEA's MCP server, configures them to reach it from any terminal, and
//! serves the IDE tools they call (`tools`).

mod agents;
mod tools;

use agents::Agent;
use openidea_plugin::mcp::McpTools;
use openidea_plugin::{Error, Invocation, NotificationLevel, Plugin, Project, host, register_plugin};

#[derive(Default)]
pub struct AiCliAgents;

impl Plugin for AiCliAgents {
    fn run_command(&mut self, id: &str, ctx: &Invocation, _arg: Option<&str>) -> Result<Option<String>, Error> {
        let project = ctx.project().ok_or("open a project first")?;
        let result = match id {
            "launch-claude" => launch(&project, Agent::Claude),
            "launch-codex" => launch(&project, Agent::Codex),
            "configure-claude-user" => configure_claude(&project, "user"),
            "configure-claude-project" => configure_claude(&project, "project"),
            "configure-codex" => configure_codex(&project),
            "copy-config" => copy_config(&project),
            _ => return Err(Error::NotFound(format!("command {id}"))),
        };
        match result {
            // Explained in a notification of our own.
            Err(Error::Denied(cap)) => {
                denied(&cap);
                Ok(None)
            }
            other => other.map(|()| None),
        }
    }
}

impl McpTools for AiCliAgents {
    fn call_tool(&mut self, name: &str, arguments: &str, ctx: &Invocation) -> Result<String, Error> {
        tools::call(name, arguments, ctx)
    }
}

register_plugin!(AiCliAgents, mcp);

fn denied(cap: &str) {
    let body = match cap.strip_prefix("process:") {
        Some(program) => format!(
            "Allow \"{cap}\" for AI CLI Agents in Settings › Plugins, then try again. \
             OpenIDEA runs the {program} found on PATH at that moment."
        ),
        None => format!("Allow \"{cap}\" for AI CLI Agents in Settings › Plugins, then try again."),
    };
    host::notify(NotificationLevel::Warning, "AI CLI Agents needs a permission", &body);
}

/// Opens the agent in a terminal tab in the project root, with the IDE's MCP
/// server for this session and its token in the environment only.
fn launch(project: &Project, agent: Agent) -> Result<(), Error> {
    let endpoint = project.mcp_endpoint()?;
    let extra = agents::split_args(&host::setting_string(agent.args_setting()).unwrap_or_default());
    let options = match agent {
        Agent::Claude => agents::claude(&endpoint, &extra),
        Agent::Codex => {
            // Codex refuses a URL for a server configured with a command (Auto-Configure
            // adds the stdio bridge as `openidea`): use that one as it is.
            let configured =
                project.run_process("codex", &["mcp".into(), "get".into(), agents::SERVER.into()], None)?;
            let stdio = configured.status == Some(0) && agents::codex_has_stdio_server(&configured.stdout);
            agents::codex(&endpoint, &extra, !stdio)
        }
    };
    host::open_terminal_with(&options)
}

/// Runs the agent's CLI; a failure carries what it printed.
fn run(project: &Project, agent: Agent, args: &[String]) -> Result<String, Error> {
    let out = project.run_process(agent.program(), args, None)?;
    if out.status == Some(0) {
        Ok(out.stdout.trim().to_owned())
    } else {
        let said = if out.stderr.trim().is_empty() { out.stdout.trim() } else { out.stderr.trim() };
        Err(Error::Failed(format!("{} {}: {said}", agent.program(), args.first().map_or("", |s| s.as_str()))))
    }
}

/// `claude mcp add-json` of the stdio bridge in `scope`, replacing an `openidea` server there.
fn configure_claude(project: &Project, scope: &str) -> Result<(), Error> {
    let endpoint = project.mcp_endpoint()?;
    // Absent is fine: there is nothing to replace.
    let _ = run(project, Agent::Claude, &agents::claude_remove(scope));
    run(project, Agent::Claude, &agents::claude_add(&endpoint, scope))?;
    let body = match scope {
        "project" => "Added the \"openidea\" MCP server to .mcp.json in the project root. Claude Code asks once to approve it; it reaches OpenIDEA while the IDE runs.".to_owned(),
        _ => "Added the \"openidea\" MCP server to your Claude Code configuration. Claude Code started in any project open in OpenIDEA reaches it while the IDE runs.".to_owned(),
    };
    host::notify(NotificationLevel::Info, "Claude Code configured", &body);
    Ok(())
}

/// `codex mcp add` of the stdio bridge, replacing an `openidea` server.
fn configure_codex(project: &Project) -> Result<(), Error> {
    let endpoint = project.mcp_endpoint()?;
    let _ = run(project, Agent::Codex, &agents::codex_remove());
    run(project, Agent::Codex, &agents::codex_add(&endpoint))?;
    host::notify(
        NotificationLevel::Info,
        "Codex configured",
        "Added the \"openidea\" MCP server to Codex's configuration. Codex started in any project open in OpenIDEA reaches it while the IDE runs.",
    );
    Ok(())
}

/// Copies an `mcpServers` configuration with the stdio bridge (no token); shows
/// it instead without the clipboard permission.
fn copy_config(project: &Project) -> Result<(), Error> {
    let config = agents::client_config(&project.mcp_endpoint()?);
    match host::copy_to_clipboard(&config) {
        Ok(()) => {
            host::notify(
                NotificationLevel::Info,
                "MCP config copied",
                "Paste it into your MCP client's configuration. It starts OpenIDEA's executable, which relays to the running IDE.",
            );
            Ok(())
        }
        Err(Error::Denied(_)) => {
            host::notify(NotificationLevel::Info, "MCP config", &config);
            Ok(())
        }
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests;
