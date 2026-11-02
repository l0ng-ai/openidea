//! Command execution security policy (Whitelist / Blacklist) for coding agents.

use ide_core::settings::AgentSecuritySettings;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PolicyDecision {
    /// Command matched a blacklist pattern (`pattern`).
    Blocked(String),
    /// Command matched the whitelist and no blacklist pattern.
    Allowed,
    /// Neither matched; prompt the user as usual.
    AskUser,
}

/// Extracts the shell command string from an ACP `session/request_permission` payload
/// when the request is for executing a command.
pub fn extract_command(params: &Value) -> Option<String> {
    let tool = params.get("toolCall").or_else(|| params.pointer("/subject/toolCall"))?;
    let raw_cmd = tool.pointer("/rawInput/command").or_else(|| tool.pointer("/rawInput/cmd"));
    if let Some(cmd) = raw_cmd.and_then(command_from_value) {
        return Some(cmd);
    }
    let kind = tool.get("kind").and_then(Value::as_str).unwrap_or_default();
    let name = tool.get("name").and_then(Value::as_str).unwrap_or_default();
    let title =
        tool.get("title").and_then(Value::as_str).or_else(|| params.get("title").and_then(Value::as_str))?.trim();
    if let Some(cmd) = title.strip_prefix("Run ").map(str::trim).filter(|s| !s.is_empty()) {
        return Some(cmd.to_owned());
    }
    if (kind == "execute" || matches!(name, "Bash" | "PowerShell" | "Execute" | "Run" | "terminal"))
        && !title.is_empty()
        && title != "Terminal"
        && title != "Run a command"
    {
        return Some(title.to_owned());
    }
    None
}

fn command_from_value(val: &Value) -> Option<String> {
    match val {
        Value::String(s) => {
            let trimmed = s.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_owned())
        }
        Value::Array(items) => {
            let words: Vec<&str> = items.iter().filter_map(Value::as_str).collect();
            if words.is_empty() {
                return None;
            }
            let cmd = match words.as_slice() {
                [_, flag, script] if flag.starts_with('-') && flag.ends_with('c') => (*script).trim().to_owned(),
                _ => words.join(" ").trim().to_owned(),
            };
            (!cmd.is_empty()).then_some(cmd)
        }
        _ => None,
    }
}

/// Checks whether a single pattern matches `command` using prefix + glob rules:
/// - If `pattern` contains `*` or `?`, matches using glob wildcards (where `*` matches
///   any sequence of characters). A trailing ` *` in the pattern also matches the bare
///   command without arguments (e.g. `git status *` matches `git status`).
/// - Otherwise, matches when `command` equals `pattern` or starts with `pattern` followed
///   by whitespace (prefix match at word boundary).
pub fn matches_command(pattern: &str, command: &str) -> bool {
    let pat = pattern.trim();
    let cmd = command.trim();
    if pat.is_empty() || cmd.is_empty() {
        return false;
    }
    if pat.contains('*') || pat.contains('?') {
        if let Some(stem) = pat.strip_suffix(" *")
            && cmd == stem.trim()
        {
            return true;
        }
        wildcard_match(pat.as_bytes(), cmd.as_bytes())
    } else {
        cmd == pat || cmd.strip_prefix(pat).is_some_and(|rest| rest.starts_with(char::is_whitespace))
    }
}

fn wildcard_match(pat: &[u8], text: &[u8]) -> bool {
    let (mut p, mut t) = (0, 0);
    let (mut star_p, mut star_t) = (None, 0);
    while t < text.len() {
        if p < pat.len() && (pat[p] == b'?' || pat[p] == text[t]) {
            p += 1;
            t += 1;
        } else if p < pat.len() && pat[p] == b'*' {
            star_p = Some(p);
            p += 1;
            star_t = t;
        } else if let Some(sp) = star_p {
            p = sp + 1;
            star_t += 1;
            t = star_t;
        } else {
            return false;
        }
    }
    while p < pat.len() && pat[p] == b'*' {
        p += 1;
    }
    p == pat.len()
}

/// Splits a shell command into sub-commands separated by `;`, `&&`, `||`, `|`, or `\n`
/// (outside single/double quotes) so compound commands cannot bypass policy checks.
fn split_subcommands(command: &str) -> Vec<&str> {
    let bytes = command.as_bytes();
    let mut out = Vec::new();
    let mut start = 0;
    let mut i = 0;
    let mut quote: Option<u8> = None;

    while i < bytes.len() {
        let b = bytes[i];
        if let Some(q) = quote {
            if b == b'\\' && q == b'"' && i + 1 < bytes.len() {
                i += 2;
                continue;
            }
            if b == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        match b {
            b'\'' | b'"' => {
                quote = Some(b);
                i += 1;
            }
            b'\\' if i + 1 < bytes.len() => {
                i += 2;
            }
            b';' | b'\n' => {
                let seg = command[start..i].trim();
                if !seg.is_empty() {
                    out.push(seg);
                }
                i += 1;
                start = i;
            }
            b'&' | b'|' => {
                let seg = command[start..i].trim();
                if !seg.is_empty() {
                    out.push(seg);
                }
                if i + 1 < bytes.len() && bytes[i + 1] == b {
                    i += 2;
                } else {
                    i += 1;
                }
                start = i;
            }
            _ => i += 1,
        }
    }
    let tail = command[start..].trim();
    if !tail.is_empty() {
        out.push(tail);
    }
    out
}

/// Evaluates `command` against `settings`:
/// 1. Blacklist takes precedence: if the full command or any sub-command matches a
///    `blocked_commands` entry, returns [`PolicyDecision::Blocked`].
/// 2. Whitelist: if every sub-command (or the whole command) matches at least one
///    `allowed_commands` entry, returns [`PolicyDecision::Allowed`].
/// 3. Otherwise returns [`PolicyDecision::AskUser`].
pub fn evaluate_command(command: &str, settings: &AgentSecuritySettings) -> PolicyDecision {
    let cmd = command.trim();
    if cmd.is_empty() {
        return PolicyDecision::AskUser;
    }
    let subcommands = split_subcommands(cmd);

    for pat in &settings.blocked_commands {
        let pat = pat.trim();
        if pat.is_empty() {
            continue;
        }
        if matches_command(pat, cmd) || subcommands.iter().any(|sub| matches_command(pat, sub)) {
            return PolicyDecision::Blocked(pat.to_owned());
        }
    }

    if !subcommands.is_empty()
        && subcommands.iter().all(|sub| settings.allowed_commands.iter().any(|pat| matches_command(pat, sub)))
    {
        return PolicyDecision::Allowed;
    }

    if settings.allowed_commands.iter().any(|pat| matches_command(pat, cmd)) && subcommands.len() <= 1 {
        return PolicyDecision::Allowed;
    }

    PolicyDecision::AskUser
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn prefix_and_glob_matching() {
        assert!(matches_command("git status", "git status"));
        assert!(matches_command("git status", "git status -s"));
        assert!(!matches_command("git status", "git statusbar"));
        assert!(matches_command("git status*", "git status"));
        assert!(matches_command("git status*", "git status --short"));
        assert!(matches_command("npm test *", "npm test"));
        assert!(matches_command("npm test *", "npm test unit"));
        assert!(matches_command("rm -rf *", "rm -rf /tmp/foo"));
        assert!(matches_command("rm -rf *", "rm -rf /"));
    }

    #[test]
    fn blacklist_takes_precedence_and_catches_chained_commands() {
        let settings = AgentSecuritySettings::default();
        assert_eq!(evaluate_command("rm -rf /tmp/build", &settings), PolicyDecision::Blocked("rm -rf *".into()));
        assert_eq!(evaluate_command("git status && rm -rf /", &settings), PolicyDecision::Blocked("rm -rf *".into()));
        assert_eq!(evaluate_command(":(){ :|:& };:", &settings), PolicyDecision::Blocked(":(){ :|:& };:".into()));
    }

    #[test]
    fn whitelist_allows_safe_single_and_chained_commands_only() {
        let settings = AgentSecuritySettings::default();
        assert_eq!(evaluate_command("git status -s", &settings), PolicyDecision::Allowed);
        assert_eq!(evaluate_command("git diff HEAD~1", &settings), PolicyDecision::Allowed);
        assert_eq!(evaluate_command("pwd && ls -la", &settings), PolicyDecision::Allowed);
        // Chaining an unapproved command must still ask the user.
        assert_eq!(evaluate_command("git status && curl https://example.com", &settings), PolicyDecision::AskUser);
        assert_eq!(evaluate_command("cargo publish", &settings), PolicyDecision::AskUser);
    }

    #[test]
    fn extracts_command_from_v1_v2_and_codex_payloads() {
        let claude = json!({
            "toolCall": {
                "title": "git status",
                "kind": "execute",
                "rawInput": { "command": "git status --short" }
            }
        });
        assert_eq!(extract_command(&claude).as_deref(), Some("git status --short"));

        let codex = json!({
            "toolCall": {
                "title": "Run cargo test",
                "kind": "execute",
                "rawInput": { "command": ["/bin/zsh", "-lc", "cargo test --workspace"] }
            }
        });
        assert_eq!(extract_command(&codex).as_deref(), Some("cargo test --workspace"));

        let write = json!({
            "toolCall": {
                "title": "Write foo.txt",
                "kind": "edit",
                "rawInput": { "file_path": "foo.txt" }
            }
        });
        assert_eq!(extract_command(&write), None);
    }
}
