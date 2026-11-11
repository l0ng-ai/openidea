//! Claude Code's session transcripts (`<config>/projects/<escaped cwd>/<id>.jsonl`): the
//! conversation of a session, where to cut it to drop turns, and its title.
//!
//! A transcript is a tree: every entry names its parent (`parentUuid`), and resuming at an
//! earlier entry (`--resume-session-at`) starts a branch there. The conversation is the
//! path from the newest leaf to the root.

use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// The last group of the uuid of a message sent into a running turn (a steer), so a
/// transcript tells them from the messages that started turns.
pub(super) const STEER_MARK: &str = "57ee";

/// The transcript of session `id` started in `cwd`.
pub(super) fn transcript(config_dir: &Path, cwd: &Path, id: &str) -> PathBuf {
    let projects = config_dir.join("projects");
    let direct = projects.join(escape(cwd)).join(format!("{id}.jsonl"));
    if direct.exists() {
        return direct;
    }
    // Long paths are shortened; the session id is unique anyway.
    std::fs::read_dir(&projects)
        .into_iter()
        .flatten()
        .flatten()
        .map(|d| d.path().join(format!("{id}.jsonl")))
        .find(|p| p.exists())
        .unwrap_or(direct)
}

/// The project directory name Claude Code uses for `cwd`.
pub(crate) fn escape(cwd: &Path) -> String {
    cwd.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

pub(crate) fn read(path: &Path) -> std::io::Result<Vec<Value>> {
    let text = std::fs::read_to_string(path)?;
    Ok(text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect())
}

fn uuid(e: &Value) -> Option<&str> {
    e.get("uuid").and_then(Value::as_str)
}

fn parent(e: &Value) -> Option<&str> {
    e.get("parentUuid").and_then(Value::as_str)
}

fn kind(e: &Value) -> &str {
    e.get("type").and_then(Value::as_str).unwrap_or_default()
}

fn in_chain(e: &Value) -> bool {
    uuid(e).is_some()
        && matches!(kind(e), "user" | "assistant" | "system" | "attachment")
        && e.get("isSidechain").and_then(Value::as_bool) != Some(true)
}

/// The conversation: the entries from the root to `upto` (default: the newest leaf), with
/// tool results that branched off it put back after their calls.
pub(super) fn chain<'a>(entries: &'a [Value], upto: Option<&str>) -> Vec<&'a Value> {
    let by_id: HashMap<&str, &Value> =
        entries.iter().filter(|e| in_chain(e)).filter_map(|e| Some((uuid(e)?, e))).collect();
    let leaf = match upto {
        Some(u) => by_id.get(u).copied(),
        None => {
            let parents: HashSet<&str> = entries.iter().filter(|e| in_chain(e)).filter_map(parent).collect();
            entries.iter().rev().filter(|e| in_chain(e)).find(|e| !parents.contains(uuid(e).unwrap_or_default()))
        }
    };
    let mut path = Vec::new();
    let mut seen = HashSet::new();
    let mut at = leaf;
    while let Some(e) = at {
        if !seen.insert(uuid(e).unwrap_or_default()) {
            break;
        }
        path.push(e);
        at = parent(e).and_then(|p| by_id.get(p).copied());
    }
    path.reverse();
    // Results of parallel tool calls can hang off another branch of the same message.
    let answered: HashSet<&str> = path.iter().flat_map(|e| block_ids(e, "tool_result", "tool_use_id")).collect();
    let mut out = Vec::with_capacity(path.len());
    for e in path {
        out.push(e);
        for call in block_ids(e, "tool_use", "id") {
            if answered.contains(call) {
                continue;
            }
            if let Some(r) = entries.iter().find(|r| {
                kind(r) == "user" && in_chain(r) && block_ids(r, "tool_result", "tool_use_id").any(|id| id == call)
            }) {
                out.push(r);
            }
        }
    }
    out
}

fn block_ids<'a>(e: &'a Value, ty: &'a str, key: &'a str) -> impl Iterator<Item = &'a str> + 'a {
    e.pointer("/message/content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(move |b| b.get("type").and_then(Value::as_str) == Some(ty))
        .filter_map(move |b| b.get(key).and_then(Value::as_str))
}

/// Whether `e` is a message that started a turn: the user's own, not a tool result, a
/// steer, or text Claude Code added.
pub(crate) fn is_turn_start(e: &Value) -> bool {
    if kind(e) != "user" || e.get("isMeta").and_then(Value::as_bool) == Some(true) {
        return false;
    }
    if uuid(e).is_some_and(|u| u.ends_with(STEER_MARK)) {
        return false;
    }
    if e.pointer("/origin/kind").and_then(Value::as_str).is_some_and(|k| k != "human") {
        return false;
    }
    match e.pointer("/message/content") {
        Some(Value::String(s)) => !s.starts_with("<local-command") && !s.starts_with("[Request interrupted"),
        Some(Value::Array(blocks)) => {
            !blocks.is_empty()
                && blocks.iter().all(|b| b.get("type").and_then(Value::as_str) != Some("tool_result"))
                && !blocks.iter().any(|b| {
                    b.get("text").and_then(Value::as_str).is_some_and(|t| t.starts_with("[Request interrupted"))
                })
        }
        _ => false,
    }
}

/// Where to resume `chain` to drop its last `turns` turns: the entry before the first
/// dropped turn's message. `Ok(None)`: nothing is left.
pub(super) fn cut(chain: &[&Value], turns: usize) -> Result<Option<String>, String> {
    if turns == 0 {
        return Ok(chain.last().and_then(|e| uuid(e)).map(str::to_owned));
    }
    let starts: Vec<&Value> = chain.iter().copied().filter(|e| is_turn_start(e)).collect();
    if turns > starts.len() {
        return Err(format!("the session has only {} turns", starts.len()));
    }
    let first_dropped = starts[starts.len() - turns];
    Ok(parent(first_dropped).map(str::to_owned))
}

/// The newest title Claude Code gave the session.
pub(crate) fn title(entries: &[Value]) -> Option<String> {
    entries
        .iter()
        .rev()
        .find(|e| kind(e) == "ai-title" || kind(e) == "custom-title")
        .and_then(|e| e.get("aiTitle").or_else(|| e.get("customTitle")).and_then(Value::as_str))
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn user(id: &str, parent: Option<&str>, text: &str) -> Value {
        json!({"type": "user", "uuid": id, "parentUuid": parent, "message": {"role": "user", "content": [{"type": "text", "text": text}]}})
    }

    fn assistant(id: &str, parent: &str, content: Value) -> Value {
        json!({"type": "assistant", "uuid": id, "parentUuid": parent, "message": {"role": "assistant", "content": content}})
    }

    #[test]
    fn the_newest_branch_is_the_conversation() {
        let entries = vec![
            json!({"type": "attachment", "uuid": "h", "parentUuid": null}),
            user("u1", Some("h"), "one"),
            assistant("a1", "u1", json!([{"type": "text", "text": "ok"}])),
            user("u2", Some("a1"), "two"),
            assistant("a2", "u2", json!([{"type": "text", "text": "ok"}])),
            json!({"type": "ai-title", "aiTitle": "Words"}),
            // Resumed at a1: a new branch.
            user("u3", Some("a1"), "three"),
            assistant("a3", "u3", json!([{"type": "text", "text": "ok"}])),
        ];
        let ids = |c: Vec<&Value>| c.iter().map(|e| e["uuid"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
        assert_eq!(ids(chain(&entries, None)), ["h", "u1", "a1", "u3", "a3"]);
        assert_eq!(ids(chain(&entries, Some("u2"))), ["h", "u1", "a1", "u2"]);
        let c = chain(&entries, None);
        assert_eq!(cut(&c, 1), Ok(Some("a1".into())));
        assert_eq!(cut(&c, 2), Ok(Some("h".into())));
        assert!(cut(&c, 3).is_err());
        assert_eq!(cut(&c, 0), Ok(Some("a3".into())));
        assert_eq!(title(&entries).as_deref(), Some("Words"));
    }

    #[test]
    fn steers_tool_results_and_interruptions_start_no_turn() {
        let steer = format!("aaaaaaaa-0000-4000-8000-00000000{STEER_MARK}");
        let entries = vec![
            user("u1", None, "go"),
            assistant(
                "a1",
                "u1",
                json!([{"type": "tool_use", "id": "t1", "name": "Bash", "input": {}},
                {"type": "tool_use", "id": "t2", "name": "Bash", "input": {}}]),
            ),
            json!({"type": "user", "uuid": "r1", "parentUuid": "a1", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1"}]}}),
            // The second result on a branch of its own.
            json!({"type": "user", "uuid": "r2", "parentUuid": "a1", "message": {"content": [{"type": "tool_result", "tool_use_id": "t2"}]}}),
            user(&steer, Some("r1"), "also this"),
            user("i", Some(&steer), "[Request interrupted by user]"),
        ];
        let c = chain(&entries, None);
        let ids: Vec<&str> = c.iter().map(|e| e["uuid"].as_str().unwrap()).collect();
        assert_eq!(ids, ["u1", "a1", "r2", "r1", steer.as_str(), "i"]);
        assert_eq!(c.iter().filter(|e| is_turn_start(e)).count(), 1);
        assert_eq!(cut(&c, 1), Ok(None));
    }

    #[test]
    fn project_directory_names() {
        assert_eq!(escape(Path::new("/private/tmp/a.b/c_d")), "-private-tmp-a-b-c-d");
    }
}
