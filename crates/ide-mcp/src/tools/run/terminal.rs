// Ported from JetBrains intellij-community plugins/mcp-server
// (mcpserver.terminal/src/com/intellij/mcpserver/toolsets/terminal/TerminalToolset.kt), Apache-2.0.
//! `execute_terminal_command`.

use super::output::{MAX_TEXT_LENGTH, TRUNCATED_MARKER, TruncateMode, temp_output_file, truncate_text};
use super::process::{quote, run_process, split_words};
use crate::tool::{Param, ParamType, Tool};
use crate::tools::run::timeout;
use ide_core::IdeError;
use ide_core::mcp::McpToolKind;
use serde_json::{Map, Value};
use std::io::Write as _;
use std::path::Path;

const DEFAULT_TIMEOUT_MS: usize = 60_000;
/// No limit in JetBrains, whose command keeps running in a visible terminal tab; ours runs
/// hidden and is killed on timeout, so a forgotten command cannot hang the call for long.
const MAX_TIMEOUT_MS: usize = 600_000;
const DEFAULT_MAX_LINES: usize = 1000;

/// The shell of Settings › Tools › Terminal (its arguments too), else the user's login shell.
fn shell(configured: &str) -> ide_core::IdeResult<Vec<String>> {
    let words = split_words(configured)?;
    Ok(if words.is_empty() { vec![ide_terminal::default_shell_path()] } else { words })
}

/// What the user approves besides the command: the directory, the shell of Settings ›
/// Tools › Terminal (`shell`, with `args` ending in `-c <command>`) and its variables.
fn confirmation_detail(root: &Path, shell: Option<&str>, args: &[String], env: &[(String, String)]) -> String {
    let mut detail = format!("in {}", root.display());
    if let Some(shell) = shell {
        let options = &args[..args.len().saturating_sub(2)];
        let line: Vec<String> = std::iter::once(shell).chain(options.iter().map(String::as_str)).map(quote).collect();
        detail.push_str(&format!("\nshell: {}", line.join(" ")));
    }
    for (k, v) in env {
        detail.push_str(&format!("\n{k}={v}"));
    }
    detail
}

pub fn execute_terminal_command() -> Tool {
    Tool::new(
        "execute_terminal_command",
        McpToolKind::Execute,
        "Executes a specified shell command in the IDE's integrated terminal.
Use this tool to run terminal commands within the IDE environment.
Requires a command parameter containing the shell command to execute.
Important features and limitations:
- Checks if process is running before collecting output
- Limits output to 2000 lines (truncates excess)
- Times out after specified timeout with notification
- Requires user confirmation unless \"Brave Mode\" is enabled in settings
Returns possible responses:
- Terminal output (truncated if > 2000 lines)
- Output with interruption notice if timed out
- Error messages for various failure cases
In OpenIDEA the command runs in the project root without a visible terminal tab, with the environment variables of \
Settings › Tools › Terminal (`$PROJECT_DIR$` expands to the project root); stdin is empty. On timeout the command and \
its child processes are killed; the timeout is at most 10 minutes (600000 ms), and 0 times out at once without \
running the command. When the output was cut, `fullOutputPath` names a private temporary file with all of \
it (deleted after a day).",
        |call| async move {
            let command = call.str("command")?;
            if command.trim().is_empty() {
                return Err(IdeError::invalid("`command` is empty"));
            }
            let in_shell = call.flag("executeInShell", false)?;
            // Accepted for compatibility: there is no terminal tab to reuse.
            let _ = call.flag("reuseExistingTerminalWindow", true)?;
            let limit = timeout(&call, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)?;
            let max_lines = call.count("maxLinesCount", DEFAULT_MAX_LINES, usize::MAX)?;
            if max_lines <= 2 {
                return Err(IdeError::invalid("maxLinesCount must be greater than 2"));
            }
            let mode = TruncateMode::parse(call.opt_str("truncateMode")?.as_deref())?;
            let settings = call.project().settings.effective();
            let root = call.root().to_path_buf();
            let project_dir = root.to_string_lossy().into_owned();
            let env: Vec<(String, String)> = settings
                .terminal
                .env
                .iter()
                .map(|(k, v)| (k.clone(), v.replace("$PROJECT_DIR$", &project_dir)))
                .collect();
            let (program, args, raw) = if in_shell {
                if cfg!(windows) {
                    let comspec =
                        std::env::var("COMSPEC").ok().filter(|c| !c.is_empty()).unwrap_or_else(|| "cmd.exe".into());
                    // `/S` strips exactly the outer quotes, so the line's own quoting survives.
                    (comspec, vec!["/D".into(), "/S".into(), "/C".into(), format!("\"{command}\"")], true)
                } else {
                    let mut words = shell(&settings.terminal.shell_path)?;
                    let program = words.remove(0);
                    words.extend(["-c".to_owned(), command.clone()]);
                    (program, words, false)
                }
            } else {
                let mut words = split_words(&command)?;
                if words.is_empty() {
                    return Err(IdeError::invalid("`command` is empty"));
                }
                let program = words.remove(0);
                (program, words, false)
            };
            if limit.is_zero() {
                // JetBrains' zero timeout returns before any output; here nothing is started.
                return crate::tool::Output::json(serde_json::json!({ "is_timed_out": true, "command_output": "" }));
            }
            let configured_shell = in_shell && !cfg!(windows) && !settings.terminal.shell_path.trim().is_empty();
            let detail = confirmation_detail(&root, configured_shell.then_some(program.as_str()), &args, &env);
            call.confirm(command.trim(), Some(detail)).await?;
            let out = run_process(&program, &args, raw, &root, &env, limit, &call.cancel).await?;

            let output = truncate_text(&out.text, max_lines, MAX_TEXT_LENGTH, mode, TRUNCATED_MARKER);
            let mut result = Map::new();
            if out.timed_out {
                result.insert("is_timed_out".into(), true.into());
            }
            if let Some(code) = out.code {
                result.insert("command_exit_code".into(), code.into());
            }
            if let Some(path) = &out.full_output {
                result.insert("fullOutputPath".into(), path.to_string_lossy().into_owned().into());
            } else if output != out.text {
                let (path, mut file) = temp_output_file("terminal")?;
                file.write_all(out.text.as_bytes())?;
                result.insert("fullOutputPath".into(), path.to_string_lossy().into_owned().into());
            }
            result.insert("command_output".into(), output.into());
            crate::tool::Output::json(Value::Object(result))
        },
    )
    .param(Param::required("command", ParamType::String, "Shell command to execute"))
    .param(Param::optional(
        "executeInShell",
        ParamType::Boolean,
        "Whether to execute the command in a default user's shell (bash, zsh, etc.). \nUseful if the command is not a \
commandline but a shell script, or if it's important to preserve real environment of the user's terminal. \nIn the case \
of 'false' value the command will be started as a process",
    ))
    .param(Param::optional(
        "reuseExistingTerminalWindow",
        ParamType::Boolean,
        "Whether to reuse an existing terminal window. Allows to avoid creating multiple terminals",
    ))
    .param(Param::optional("timeout", ParamType::Integer, "Timeout in milliseconds"))
    .param(Param::optional("maxLinesCount", ParamType::Integer, "Maximum number of lines to return"))
    .param(Param::optional(
        "truncateMode",
        ParamType::Enum(&["START", "MIDDLE", "END", "NONE"]),
        "How to truncate the text: from the start, in the middle, at the end, or don't truncate at all \
(START keeps the first lines, END the last ones)",
    ))
}
