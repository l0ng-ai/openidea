//! `run_command` and the tools that follow its tab up: `wait_for_run`, `read_run_output`,
//! `get_run_status`, `send_run_input`, `stop_run` and `list_runs` (see [`super::agent`]).

use super::agent::{AgentRun, INTERVENTION_ADVICE, TruncateMode, clean_output, tab_name, truncate_lines};
use super::output::RUN_PREVIEW_MAX_LENGTH;
use crate::mcp::run::timeout;
use crate::mcp::tool::{Call, Output, Param, ParamType, Tool};
use ide_core::{IdeError, IdeResult};
use serde_json::{Map, Value};
use std::sync::Arc;

const RUN_TIMEOUT_MS: usize = 10_000;
const WAIT_TIMEOUT_MS: usize = 30_000;
const STOP_TIMEOUT_MS: usize = 10_000;
/// Lines of output returned at most, by default (as JetBrains' `execute_terminal_command`).
const DEFAULT_MAX_LINES: usize = 2000;
/// Bytes of the log read for one result at most.
const READ_CAP: usize = 1 << 20;
/// Lines of output quoted when a name is still running.
const BUSY_TAIL_LINES: usize = 20;

const NAME: &str = "Tab name. OpenIDEA shows the tab as `_agent_<name>`; passing the prefixed name works too.";
const SEQUENCE: &str = "\n\nUsing the same name for every command of one task reuses its tab: a name whose command \
has finished starts the next command in the same tab. A name whose command is still running is refused (with that \
command and its last output); stop it with `stop_run` first or use another name. Nothing is stopped implicitly.";
const INTERVENTIONS: &str = "\n\nThe user sees every tab and can type into it, rerun or stop its command, or close \
it. Results then carry `interventions` (for example `User input: …` or `The user reran this command at …`) and \
`advice`: unless the user asked otherwise, stop what you are doing, tell the user you received the intervention and \
wait for their confirmation before you continue.";
const OUTPUT: &str = "\n\nThe command runs on pipes, not a terminal, so programs print plain lines (no progress \
bars). `output` is that text cleaned of escape sequences, at most `maxLinesCount` lines (default 2000): beyond it, \
`truncateMode` START (default) keeps the end, END the start, MIDDLE both ends, NONE everything, with a \
`<<<...content truncated...>>>` line where lines were left out and `truncatedLines` saying how many. `outputStart` \
and `nextOffset` are positions in the tab's raw output log; pass `nextOffset` as `offset` to read on.";
const MAX_LINES: &str = "Lines of output to return at most (default 2000)";
const TRUNCATE_MODE: &str = "Which lines to leave out beyond maxLinesCount: START (default, keeps the end), END \
(keeps the start), MIDDLE (keeps both ends) or NONE";

fn find(call: &Call) -> IdeResult<Arc<AgentRun>> {
    let name = tab_name(&call.str("name")?)?;
    call.host()
        .mcp_agent_runs
        .get(call.root(), &name)
        .ok_or_else(|| IdeError::not_found(format!("no agent tab named `{name}` (see list_runs)")))
}

/// `status` of `run`, with interventions not told yet.
fn result(run: &AgentRun, extra: Map<String, Value>) -> IdeResult<Output> {
    let mut out = run.status();
    out.extend(extra);
    let interventions = run.take_interventions();
    if !interventions.is_empty() {
        out.insert("interventions".into(), interventions.into());
        out.insert("advice".into(), INTERVENTION_ADVICE.into());
    }
    Output::json(Value::Object(out))
}

/// The output from `from` as the agent reads it: cleaned, then cut to `maxLinesCount` lines
/// as `truncateMode` says.
fn output_view(call: &Call, run: &AgentRun, from: u64) -> IdeResult<Map<String, Value>> {
    let max_lines = match call.opt_i64("maxLinesCount")? {
        Some(n) if n < 1 => return Err(IdeError::invalid("maxLinesCount must be > 0")),
        Some(n) => n as usize,
        None => DEFAULT_MAX_LINES,
    };
    let mode = match call.opt_str("truncateMode")? {
        Some(name) => TruncateMode::parse(&name)
            .ok_or_else(|| IdeError::invalid("truncateMode must be START, MIDDLE, END or NONE"))?,
        None => TruncateMode::Start,
    };
    let len = run.log_len();
    let from = from.min(len);
    // A long output is read from the end that stays.
    let start = if mode == TruncateMode::Start && len - from > READ_CAP as u64 { len - READ_CAP as u64 } else { from };
    let (raw, start, end) = run.read(start, READ_CAP)?;
    let (text, truncated) = truncate_lines(&clean_output(&raw), max_lines, mode);
    let mut out = Map::new();
    out.insert("output".into(), text.into());
    if truncated > 0 {
        out.insert("truncatedLines".into(), truncated.into());
    }
    out.insert("outputStart".into(), start.into());
    out.insert("nextOffset".into(), end.into());
    Ok(out)
}

fn deadline(call: &Call, default: usize) -> IdeResult<tokio::time::Instant> {
    Ok(tokio::time::Instant::now() + timeout(call, default)?)
}

fn pattern(call: &Call) -> IdeResult<Option<regex_lite::Regex>> {
    call.opt_str("pattern")?
        .filter(|p| !p.is_empty())
        .map(|p| regex_lite::Regex::new(&p).map_err(|e| IdeError::invalid(format!("invalid pattern: {e}"))))
        .transpose()
}

fn offset(call: &Call, name: &str) -> IdeResult<Option<u64>> {
    match call.opt_i64(name)? {
        Some(n) if n < 0 => Err(IdeError::invalid(format!("{name} must not be negative"))),
        n => Ok(n.map(|n| n as u64)),
    }
}

fn busy(run: &AgentRun) -> IdeError {
    let tail = run.tail(run.process_offset(), BUSY_TAIL_LINES, RUN_PREVIEW_MAX_LENGTH).map(|t| t.0).unwrap_or_default();
    IdeError::invalid(format!(
        "`{}` is still running `{}`. Stop it with stop_run first, or use another name.\nLast output:\n{}",
        run.name,
        run.command(),
        clean_output(&tail).trim_end()
    ))
}

pub fn run_command() -> Tool {
    Tool::new(
        "run_command",
        &format!(
            "Runs a shell command line in a new or reused tab of OpenIDEA's Run tool window, with the shell of \
Settings › Tools › Terminal. The user is asked first (unless the IDE runs tools without \
confirmation). Waits up to `timeout` milliseconds (default {RUN_TIMEOUT_MS}) for the command to finish; a command \
still running then keeps running, and `wait_for_run`, `read_run_output`, `get_run_status`, `send_run_input` and \
`stop_run` follow it up by name. Returns the tab's status (`state`: starting, running, stopping, succeeded, failed, \
crashed, stoppedByAgent, stoppedByUser or startFailed; `exitCode`; `crash` with the signal or exception of a crashed \
process) and its output so far.{OUTPUT}{SEQUENCE}{INTERVENTIONS}"
        ),
        |call| async move {
            let name = tab_name(&call.str("name")?)?;
            let command = call.str("command")?;
            if command.trim().is_empty() {
                return Err(IdeError::invalid("command must not be empty"));
            }
            let cwd = match call.opt_str("workingDirectory")?.filter(|d| !d.trim().is_empty()) {
                Some(dir) => {
                    let path = call.resolve_inside(&dir)?;
                    if !path.is_dir() {
                        return Err(IdeError::not_found(format!("workingDirectory {} is not a directory", dir)));
                    }
                    path
                }
                None => call.root().to_path_buf(),
            };
            let env = call.args.get("envs").filter(|v| !v.is_null()).map(|_| call.str_map("envs")).transpose()?;
            let deadline = deadline(&call, RUN_TIMEOUT_MS)?;
            let host = call.host();
            let runs = &host.mcp_agent_runs;
            if let Some(run) = runs.get(call.root(), &name).filter(|r| r.running()) {
                return Err(busy(&run));
            }
            let shown_cwd = call.display(&cwd);
            let mut detail = format!(
                "{command}\n\nTab: {name}\nWorking directory: {}",
                if shown_cwd.is_empty() { ".".to_owned() } else { shown_cwd.clone() }
            );
            for (key, value) in env.iter().flatten() {
                detail.push_str(&format!("\n{key}={value}"));
            }
            call.confirm(&name, Some(detail)).await?;
            let run = runs.prepare(call.root(), call.window(), &name, &command, &shown_cwd).map_err(|r| busy(&r))?;
            let request = ide_core::event::McpUiRequest::AgentRun {
                name: name.clone(),
                command: command.clone(),
                cwd: cwd.into(),
                env: env.unwrap_or_default().into_iter().collect(),
            };
            if let Err(e) = call.ask(request).await {
                let error = run.start_error();
                runs.abandon(&run);
                return Err(match error {
                    Some(error) => IdeError::invalid(format!("`{name}` did not start: {error}")),
                    None => e,
                });
            }
            if let Some(error) = run.start_error() {
                return Err(IdeError::invalid(format!("`{name}` did not start: {error}")));
            }
            let from = run.process_offset();
            let end = run.wait(deadline, None, from, &call.cancel).await?;
            let mut extra = output_view(&call, &run, from)?;
            extra.insert("waitEnded".into(), end.as_str().into());
            result(&run, extra)
        },
    )
    .write()
    .param(Param::required("name", ParamType::String, NAME))
    .param(Param::required(
        "command",
        ParamType::String,
        "Shell command line, e.g. `npm test -- --watch=false` or `cargo build && ./target/debug/app`",
    ))
    .param(Param::optional(
        "workingDirectory",
        ParamType::String,
        "Directory inside the project to run in, relative to the project root; default: the project root",
    ))
    .param(Param::optional("envs", ParamType::StringMap, "Environment variables added for this command"))
    .param(Param::optional(
        "timeout",
        ParamType::Integer,
        "Milliseconds to wait for the command to finish before returning (0 returns once it started); the command \
keeps running after it",
    ))
    .param(Param::optional("maxLinesCount", ParamType::Integer, MAX_LINES))
    .param(Param::optional("truncateMode", ParamType::String, TRUNCATE_MODE))
}

pub fn wait_for_run() -> Tool {
    Tool::new(
        "wait_for_run",
        &format!(
            "Waits until the command of an agent tab finishes, its output matches `pattern`, the user intervenes, or \
`timeout` milliseconds pass (default {WAIT_TIMEOUT_MS}). Cancelling the wait leaves the command running. Returns \
`waitEnded` (exited, matched, userIntervened or timedOut), the tab's status and the output since `offset`. Use \
`pattern` to wait for a server to be ready, e.g. `Listening on|Started .* in`.{OUTPUT}{INTERVENTIONS}"
        ),
        |call| async move {
            let run = find(&call)?;
            let deadline = deadline(&call, WAIT_TIMEOUT_MS)?;
            let pattern = pattern(&call)?;
            let from = offset(&call, "offset")?.unwrap_or_else(|| run.process_offset());
            let end = run.wait(deadline, pattern.as_ref(), from, &call.cancel).await?;
            let mut extra = output_view(&call, &run, from)?;
            extra.insert("waitEnded".into(), end.as_str().into());
            result(&run, extra)
        },
    )
    .param(Param::required("name", ParamType::String, NAME))
    .param(Param::optional("timeout", ParamType::Integer, "Milliseconds to wait at most"))
    .param(Param::optional(
        "pattern",
        ParamType::String,
        "Regular expression to wait for in the output after `offset` (as the command wrote it)",
    ))
    .param(Param::optional(
        "offset",
        ParamType::Integer,
        "Where in the tab's output log to start: a `nextOffset` from an earlier result. Default: where the current \
command's output starts",
    ))
    .param(Param::optional("maxLinesCount", ParamType::Integer, MAX_LINES))
    .param(Param::optional("truncateMode", ParamType::String, TRUNCATE_MODE))
}

pub fn read_run_output() -> Tool {
    Tool::new(
        "read_run_output",
        &format!(
            "Reads the output log of an agent tab, which goes on across the commands and reruns of the tab: from \
`offset` (a `nextOffset` from an earlier result), or from its start. Also returns the tab's status.\
{OUTPUT}{INTERVENTIONS}"
        ),
        |call| async move {
            let run = find(&call)?;
            let from = offset(&call, "offset")?.unwrap_or(0);
            let extra = output_view(&call, &run, from)?;
            result(&run, extra)
        },
    )
    .param(Param::required("name", ParamType::String, NAME))
    .param(Param::optional("offset", ParamType::Integer, "Where in the log to read from"))
    .param(Param::optional("maxLinesCount", ParamType::Integer, MAX_LINES))
    .param(Param::optional("truncateMode", ParamType::String, TRUNCATE_MODE))
}

pub fn get_run_status() -> Tool {
    Tool::new(
        "get_run_status",
        &format!(
            "Returns the status of an agent tab: its command, `state` (starting, running, stopping, succeeded, \
failed, crashed, stoppedByAgent, stoppedByUser or startFailed), `startedBy` (agent, or user when the user reran \
it), times, `exitCode`, `crash`, `outputLength`, `lastOutputAt` (a running command silent for long may be waiting \
for input) and `tabClosedAt` when the user closed the tab.{INTERVENTIONS}"
        ),
        |call| async move {
            let run = find(&call)?;
            result(&run, Map::new())
        },
    )
    .param(Param::required("name", ParamType::String, NAME))
}

pub fn list_runs() -> Tool {
    Tool::new(
        "list_runs",
        "Lists the agent tabs of the project (those started by `run_command`) with their status.",
        |call| async move {
            let runs: Vec<Value> =
                call.host().mcp_agent_runs.list(call.root()).iter().map(|r| Value::Object(r.status())).collect();
            Output::json(serde_json::json!({ "runs": runs }))
        },
    )
}

/// What a key does to a command on pipes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Key {
    /// Writes this text to its input.
    Text(&'static str),
    /// Ctrl+C: stops it, as `stop_run` does.
    Interrupt,
    /// Ctrl+D: ends its input.
    EndOfInput,
}

fn key(name: &str) -> IdeResult<Key> {
    Ok(match name.trim().to_ascii_lowercase().replace(' ', "").as_str() {
        "enter" | "return" => Key::Text("\n"),
        "tab" => Key::Text("\t"),
        "ctrl+c" => Key::Interrupt,
        "ctrl+d" => Key::EndOfInput,
        "escape" | "esc" | "backspace" | "ctrl+z" | "ctrl+\\" | "ctrl+l" | "up" | "down" | "left" | "right" => {
            return Err(IdeError::invalid(format!(
                "`{name}` is a terminal key, and the command runs on pipes, not a terminal: send text and Enter, \
Ctrl+C to stop it or Ctrl+D to end its input"
            )));
        }
        _ => return Err(IdeError::invalid(format!("unknown key `{name}`"))),
    })
}

pub fn send_run_input() -> Tool {
    Tool::new(
        "send_run_input",
        "Writes to the input of the running command of an agent tab, which runs on pipes: `text` as it is, then \
`keys` in order: Enter (a line break), Tab, Ctrl+C (stops the command, as `stop_run` does) and Ctrl+D (ends its \
input). Terminal keys (arrows, Escape, Backspace, Ctrl+Z…) are refused. To answer a prompt, pass the answer as \
`text` and `keys: [\"Enter\"]`. The user sees the command's output in the tab. Returns the tab's status.",
        |call| async move {
            let run = find(&call)?;
            let text = call.opt_str("text")?.unwrap_or_default();
            let keys = call.str_list("keys")?.iter().map(|k| key(k)).collect::<IdeResult<Vec<_>>>()?;
            if text.is_empty() && keys.is_empty() {
                return Err(IdeError::invalid("pass `text`, `keys` or both"));
            }
            let id = run.live_process().ok_or_else(|| IdeError::invalid(format!("`{}` is not running", run.name)))?;
            call.project().require_trust()?;
            let host = call.host();
            let mut data = text;
            for key in keys {
                match key {
                    Key::Text(text) => data.push_str(text),
                    Key::EndOfInput | Key::Interrupt => {
                        if !data.is_empty() {
                            host.processes.write_stdin(id, &std::mem::take(&mut data))?;
                        }
                        if key == Key::EndOfInput {
                            crate::ops::run::close_stdin(&host, id)?;
                        } else {
                            run.agent_stopping();
                            crate::ops::run::stop(&host, &run.window(), id)?;
                            break;
                        }
                    }
                }
            }
            if !data.is_empty() {
                host.processes.write_stdin(id, &data)?;
            }
            result(&run, Map::new())
        },
    )
    .write()
    .param(Param::required("name", ParamType::String, NAME))
    .param(Param::optional("text", ParamType::String, "Text to type"))
    .param(Param::optional("keys", ParamType::StringList, "Keys to press after `text`"))
}

pub fn stop_run() -> Tool {
    Tool::new(
        "stop_run",
        &format!(
            "Stops the running command of an agent tab, the way the Run tool window's Stop does: it asks the \
process tree to exit and, with `force`, kills it. Waits up to `timeout` milliseconds (default {STOP_TIMEOUT_MS}) \
for it to end and returns the tab's status (`stoppedByAgent` once it ended). A process that ignores the request \
keeps `stopping`: call again with `force`. The tab stays open with its output."
        ),
        |call| async move {
            let run = find(&call)?;
            let id = run.live_process().ok_or_else(|| IdeError::invalid(format!("`{}` is not running", run.name)))?;
            let force = call.flag("force", false)?;
            let deadline = deadline(&call, STOP_TIMEOUT_MS)?;
            let host = call.host();
            run.agent_stopping();
            crate::ops::run::stop(&host, &run.window(), id)?;
            if force {
                // A second Stop kills the tree.
                crate::ops::run::stop(&host, &run.window(), id)?;
            }
            let end = run.wait(deadline, None, run.log_len(), &call.cancel).await?;
            let mut extra = Map::new();
            extra.insert("waitEnded".into(), end.as_str().into());
            result(&run, extra)
        },
    )
    .write()
    .param(Param::required("name", ParamType::String, NAME))
    .param(Param::optional("force", ParamType::Boolean, "Kill the process tree instead of asking it to exit"))
    .param(Param::optional("timeout", ParamType::Integer, "Milliseconds to wait for the command to end"))
}

pub fn tools() -> Vec<Tool> {
    vec![run_command(), wait_for_run(), read_run_output(), get_run_status(), send_run_input(), stop_run(), list_runs()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_what_pipes_can_take() {
        assert_eq!(key(" enter ").unwrap(), Key::Text("\n"));
        assert_eq!(key("Ctrl+C").unwrap(), Key::Interrupt);
        assert_eq!(key("ctrl+d").unwrap(), Key::EndOfInput);
        assert!(key("Up").unwrap_err().message.contains("runs on pipes"));
        assert!(key("F13").unwrap_err().message.contains("unknown key"));
    }
}
