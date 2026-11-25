//! Codex's built-in slash commands. `codex app-server` has no command-list API, so the
//! native adapter owns this stable compatibility table; skills stay dynamic via `skills/list`.

use serde_json::Value;

/// Menu metadata shared by agent_commands and the prompt dispatcher.
pub(crate) struct BuiltinCommandSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub hint: Option<&'static str>,
}

pub(crate) const BUILTIN_COMMANDS: &[BuiltinCommandSpec] = &[
    BuiltinCommandSpec { name: "plan", description: "Turn plan mode on or off.", hint: None },
    BuiltinCommandSpec {
        name: "mcp",
        description: "Show the status of the MCP servers, or reconnect them.",
        hint: Some("[reconnect]"),
    },
    BuiltinCommandSpec { name: "skills", description: "List available skills.", hint: None },
    BuiltinCommandSpec { name: "status", description: "Display session configuration and token usage.", hint: None },
    BuiltinCommandSpec {
        name: "review",
        description: "Review uncommitted changes, or review with custom instructions.",
        hint: Some("optional review instructions"),
    },
    BuiltinCommandSpec {
        name: "review-branch",
        description: "Review changes relative to a base branch.",
        hint: Some("branch name"),
    },
    BuiltinCommandSpec { name: "review-commit", description: "Review a specific commit.", hint: Some("commit sha") },
    BuiltinCommandSpec {
        name: "compact",
        description: "Summarize conversation to avoid hitting the context limit.",
        hint: None,
    },
    BuiltinCommandSpec {
        name: "goal",
        description: "Set a goal to keep pursuing.",
        hint: Some("[<objective>|clear|pause|resume]"),
    },
    BuiltinCommandSpec { name: "rename", description: "Rename the current session.", hint: Some("new name") },
    BuiltinCommandSpec {
        name: "logout",
        description: "Sign out of Codex. This option is available when you are logged in via ChatGPT.",
        hint: None,
    },
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum BuiltinCommand {
    Plan,
    Mcp,
    Skills,
    Status,
    Review,
    ReviewBranch,
    ReviewCommit,
    Compact,
    Goal,
    Rename,
    Logout,
}

impl BuiltinCommand {
    fn from_name(name: &str) -> Option<Self> {
        Some(match name {
            "plan" => Self::Plan,
            "mcp" => Self::Mcp,
            "skills" => Self::Skills,
            "status" => Self::Status,
            "review" => Self::Review,
            "review-branch" => Self::ReviewBranch,
            "review-commit" => Self::ReviewCommit,
            "compact" => Self::Compact,
            "goal" => Self::Goal,
            "rename" => Self::Rename,
            "logout" => Self::Logout,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ParsedCommand {
    pub command: BuiltinCommand,
    /// Everything after the command name, trimmed but otherwise unchanged.
    pub rest: String,
}

impl ParsedCommand {
    /// Commands that Codex completes as a turn. Missing review arguments stay local so the
    /// adapter can print the command's usage without starting an unnecessary model request.
    pub fn starts_turn(&self) -> bool {
        matches!(self.command, BuiltinCommand::Compact | BuiltinCommand::Review)
            || (matches!(self.command, BuiltinCommand::ReviewBranch | BuiltinCommand::ReviewCommit)
                && !self.rest.is_empty())
    }
}

/// A recognized Codex builtin at the start of the prompt. Unknown slash commands and
/// `$skill` invocations return `None`, so they continue through Codex as ordinary prompts.
pub(super) fn parse(prompt: &Value) -> Option<ParsedCommand> {
    let text = prompt.as_array()?.first()?.get("text")?.as_str()?.trim();
    let command_text = text.strip_prefix('/')?.trim();
    let (name, rest) = command_text.split_once(char::is_whitespace).unwrap_or((command_text, ""));
    let command = BuiltinCommand::from_name(&name.to_ascii_lowercase())?;
    Some(ParsedCommand { command, rest: rest.trim().to_owned() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn text(value: &str) -> Value {
        json!([{ "type": "text", "text": value }])
    }

    #[test]
    fn every_builtin_is_registered_and_parsed() {
        let expected = [
            "plan",
            "mcp",
            "skills",
            "status",
            "review",
            "review-branch",
            "review-commit",
            "compact",
            "goal",
            "rename",
            "logout",
        ];
        assert_eq!(BUILTIN_COMMANDS.iter().map(|c| c.name).collect::<Vec<_>>(), expected);
        for name in expected {
            assert!(parse(&text(&format!("/{name}"))).is_some(), "{name}");
        }
    }

    #[test]
    fn parsing_keeps_arguments_and_leaves_non_builtins_alone() {
        let parsed = parse(&text("  /review-branch origin/main  ")).unwrap();
        assert_eq!(parsed.command, BuiltinCommand::ReviewBranch);
        assert_eq!(parsed.rest, "origin/main");
        assert!(parsed.starts_turn());
        assert!(!parse(&text("/review-branch")).unwrap().starts_turn());
        assert!(parse(&text("/$review check this")).is_none());
        assert!(parse(&text("review")).is_none());

        let prompt = json!([{ "type": "text", "text": "/compact" }, { "type": "image", "data": "AA==" }]);
        assert_eq!(parse(&prompt).unwrap().command, BuiltinCommand::Compact);
    }
}
