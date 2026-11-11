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

/// Matches an allowed command entry against a sub-command.
/// An allow entry is a whole command or a prefix only up to a word boundary:
/// e.g. `git status` matches `git status` and `git status -s`, but NOT `git statusx`.
/// Any accidental trailing `*` in the allow entry is stripped so `git status*` behaves
/// cleanly as a prefix at word boundaries instead of a glob wildcard.
pub fn matches_allow_entry(entry: &str, command: &str) -> bool {
    let mut entry = entry.trim();
    if let Some(stripped) = entry.strip_suffix('*') {
        entry = stripped.trim_end();
    }
    let cmd = command.trim();
    if entry.is_empty() || cmd.is_empty() {
        return false;
    }
    cmd == entry || cmd.strip_prefix(entry).is_some_and(|rest| rest.starts_with(char::is_whitespace))
}

/// Checks whether a word is an environment variable assignment (`IDENTIFIER=...`).
fn is_env_assignment_word(word: &str) -> bool {
    let Some((name, _)) = word.split_once('=') else {
        return false;
    };
    if name.is_empty() {
        return false;
    }
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Returns true if the sub-command starts with an environment variable assignment,
/// e.g. `FOO=bar cmd` or `PORT=3000`.
fn has_leading_env_assignment(cmd: &str) -> bool {
    let trimmed = cmd.trim_start();
    let bytes = trimmed.as_bytes();
    let mut i = 0;
    let mut quote: Option<u8> = None;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'\\' && quote != Some(b'\'') && i + 1 < bytes.len() {
            i += 2;
            continue;
        }
        if let Some(q) = quote {
            if b == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        if b == b'\'' || b == b'"' {
            quote = Some(b);
            i += 1;
            continue;
        }
        if b.is_ascii_whitespace() {
            break;
        }
        i += 1;
    }
    let first_word = &trimmed[..i];
    is_env_assignment_word(first_word)
}

/// Checks whether `command` contains shell constructs that must never be auto-approved:
/// - Command substitution: `$(...)` or backticks
/// - Redirection: `>`, `>>`, `<`
/// - Here-docs: `<<`
/// - Subshells: `(...)`
/// - Leading environment assignments: `VAR=val cmd`
pub fn has_unsafe_shell_syntax(command: &str) -> bool {
    let cmd = command.trim();
    if cmd.is_empty() {
        return false;
    }

    if has_leading_env_assignment(cmd) {
        return true;
    }

    let bytes = cmd.as_bytes();
    let mut i = 0;
    let mut quote: Option<u8> = None;

    while i < bytes.len() {
        let b = bytes[i];

        if b == b'\\' && quote != Some(b'\'') && i + 1 < bytes.len() {
            i += 2;
            continue;
        }

        if let Some(q) = quote {
            if b == q {
                quote = None;
                i += 1;
                continue;
            }
            // Inside double quotes: $(...) and `...` are evaluated by the shell.
            if q == b'"' {
                if b == b'`' {
                    return true;
                }
                if b == b'$' && i + 1 < bytes.len() && bytes[i + 1] == b'(' {
                    return true;
                }
            }
            i += 1;
            continue;
        }

        match b {
            b'\'' | b'"' => {
                quote = Some(b);
                i += 1;
            }
            b'`' => return true,
            b'$' if i + 1 < bytes.len() && bytes[i + 1] == b'(' => return true,
            b'<' | b'>' => return true,
            b'(' | b')' => return true,
            _ => i += 1,
        }
    }

    false
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
/// 2. Whitelist: allowed_commands cannot auto-approve when empty.
/// 3. Every sub-command in a chain must be safe (no command substitution, redirection,
///    subshell, or env assignments) and match at least one `allowed_commands` entry
///    exactly or up to word boundary; otherwise falls back to [`PolicyDecision::AskUser`].
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

    if settings.allowed_commands.is_empty() || subcommands.is_empty() {
        return PolicyDecision::AskUser;
    }

    let all_allowed = subcommands.iter().all(|sub| {
        let s = sub.trim();
        if s.is_empty() || has_unsafe_shell_syntax(s) {
            return false;
        }
        settings.allowed_commands.iter().any(|entry| matches_allow_entry(entry, s))
    });

    if all_allowed {
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
    fn allow_entry_matching_word_boundary() {
        assert!(matches_allow_entry("git status", "git status"));
        assert!(matches_allow_entry("git status", "git status -s"));
        assert!(!matches_allow_entry("git status", "git statusbar"));
        assert!(!matches_allow_entry("git status", "git statusx"));
        // Trailing asterisk in allow entry normalizes cleanly to word boundary prefix
        assert!(matches_allow_entry("git status*", "git status"));
        assert!(matches_allow_entry("git status*", "git status --short"));
        assert!(!matches_allow_entry("git status*", "git statusbar"));
        assert!(matches_allow_entry("ls", "ls"));
        assert!(matches_allow_entry("ls", "ls -la"));
        assert!(!matches_allow_entry("ls", "lsof"));
        assert!(matches_allow_entry("cargo check", "cargo check"));
        assert!(matches_allow_entry("cargo check", "cargo check --workspace"));
        assert!(!matches_allow_entry("cargo check", "cargo checkmate"));
    }

    #[test]
    fn unsafe_shell_syntax_detection() {
        // Command substitutions: $(...) and `...`
        assert!(has_unsafe_shell_syntax("echo $(whoami)"));
        assert!(has_unsafe_shell_syntax("echo \"user: $(whoami)\""));
        assert!(has_unsafe_shell_syntax("echo `whoami`"));
        assert!(has_unsafe_shell_syntax("echo \"`whoami`\""));

        // Redirections: >, >>, <
        assert!(has_unsafe_shell_syntax("git status > /tmp/out"));
        assert!(has_unsafe_shell_syntax("git status >> /tmp/out"));
        assert!(has_unsafe_shell_syntax("cat < /tmp/in"));
        assert!(has_unsafe_shell_syntax("cat << 'EOF'"));

        // Subshells: (...)
        assert!(has_unsafe_shell_syntax("(cd /tmp && ls)"));
        assert!(has_unsafe_shell_syntax("git status && (exit 1)"));

        // Environment assignments: VAR=val ...
        assert!(has_unsafe_shell_syntax("FOO=bar git status"));
        assert!(has_unsafe_shell_syntax("PORT=3000 npm test"));
        assert!(has_unsafe_shell_syntax("_SECRET=123 cargo test"));
        assert!(has_unsafe_shell_syntax("A=\"b c\" git status"));

        // Safe constructs with characters inside quotes or command flags
        assert!(!has_unsafe_shell_syntax("git commit -m \"fix <bug> and (issue)\""));
        assert!(!has_unsafe_shell_syntax("git commit -m 'fix <bug>'"));
        assert!(!has_unsafe_shell_syntax("cargo test --test=unit"));
        assert!(!has_unsafe_shell_syntax("git status -s"));
    }

    #[test]
    fn default_settings_has_no_auto_approval_and_blocks_dangerous_defaults() {
        let settings = AgentSecuritySettings::default();
        assert!(settings.allowed_commands.is_empty(), "allowed_commands must start empty");
        // Safe commands ask user by default
        assert_eq!(evaluate_command("git status", &settings), PolicyDecision::AskUser);
        assert_eq!(evaluate_command("ls", &settings), PolicyDecision::AskUser);
        assert_eq!(evaluate_command("cargo check", &settings), PolicyDecision::AskUser);
        // Blacklist patterns are still blocked by default
        assert_eq!(evaluate_command("rm -rf /", &settings), PolicyDecision::Blocked("rm -rf *".into()));
        assert_eq!(evaluate_command("rm -rf /tmp/test", &settings), PolicyDecision::Blocked("rm -rf *".into()));
    }

    #[test]
    fn whitelist_allows_safe_single_and_chained_commands_only() {
        let settings = AgentSecuritySettings {
            allowed_commands: vec!["git status".into(), "git diff".into(), "cargo test".into()],
            blocked_commands: vec!["rm -rf *".into()],
        };
        assert_eq!(evaluate_command("git status -s", &settings), PolicyDecision::Allowed);
        assert_eq!(evaluate_command("git diff HEAD~1", &settings), PolicyDecision::Allowed);
        assert_eq!(evaluate_command("git status && cargo test", &settings), PolicyDecision::Allowed);

        // Word boundary: git statusx must not match git status
        assert_eq!(evaluate_command("git statusx", &settings), PolicyDecision::AskUser);

        // Unsafe syntax (redirection, command substitution, env assignment) falls back to AskUser
        assert_eq!(evaluate_command("git status > out.txt", &settings), PolicyDecision::AskUser);
        assert_eq!(evaluate_command("git status $(whoami)", &settings), PolicyDecision::AskUser);
        assert_eq!(evaluate_command("FOO=bar git status", &settings), PolicyDecision::AskUser);

        // Chaining an unapproved command must still ask the user.
        assert_eq!(evaluate_command("git status && curl https://example.com", &settings), PolicyDecision::AskUser);
        assert_eq!(evaluate_command("cargo publish", &settings), PolicyDecision::AskUser);

        // Blacklist still takes precedence over whitelist
        assert_eq!(evaluate_command("git status && rm -rf /", &settings), PolicyDecision::Blocked("rm -rf *".into()));
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
