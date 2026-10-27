//! Folds ACP `session/update` notifications into a task's entries.

use crate::model::{AgentEntry, AgentPlanItem, AgentToolDiff, AgentToolStatus};
use ide_core::IpcPath;
use serde_json::Value;
use std::collections::HashMap;

/// Tool output kept per call; longer output keeps its tail.
const MAX_OUTPUT: usize = 64 * 1024;

#[derive(Default)]
pub(crate) struct Timeline {
    pub entries: Vec<AgentEntry>,
    tools: HashMap<String, usize>,
    plan: Option<usize>,
}

/// What a `session/update` changed in the timeline.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Applied {
    /// Indices of the entries added or changed.
    pub changed: Vec<usize>,
}

impl Timeline {
    pub fn from_entries(entries: Vec<AgentEntry>) -> Self {
        let mut t = Self { entries, ..Self::default() };
        for (i, e) in t.entries.iter().enumerate() {
            match e {
                AgentEntry::Tool { id, .. } => {
                    t.tools.insert(id.clone(), i);
                }
                AgentEntry::Plan { .. } => t.plan = Some(i),
                _ => {}
            }
        }
        t
    }

    pub fn has_tool(&self, id: &str) -> bool {
        self.tools.contains_key(id)
    }

    pub fn push(&mut self, entry: AgentEntry) -> usize {
        self.entries.push(entry);
        self.entries.len() - 1
    }

    /// Applies one `session/update` `update` object.
    pub fn apply(&mut self, update: &Value) -> Applied {
        let mut out = Applied::default();
        let kind = update.get("sessionUpdate").and_then(Value::as_str).unwrap_or_default();
        match kind {
            "agent_message_chunk" | "agent_thought_chunk" => {
                let Some(text) = content_text(update.get("content")) else { return out };
                out.changed.push(self.append_text(kind == "agent_thought_chunk", &text));
            }
            "tool_call" => {
                let id = str_field(update, "toolCallId");
                let entry = AgentEntry::Tool {
                    id: id.clone(),
                    title: str_field(update, "title"),
                    kind: update.get("kind").and_then(Value::as_str).unwrap_or("other").to_owned(),
                    status: tool_status(update.get("status")).unwrap_or(AgentToolStatus::Pending),
                    locations: locations(update.get("locations")),
                    output: None,
                    diffs: Vec::new(),
                };
                let index = match self.tools.get(&id) {
                    Some(&i) => {
                        self.entries[i] = entry;
                        i
                    }
                    None => {
                        let i = self.push(entry);
                        self.tools.insert(id, i);
                        i
                    }
                };
                self.merge_tool(index, update);
                out.changed.push(index);
            }
            "tool_call_update" => {
                let Some(&index) = self.tools.get(&str_field(update, "toolCallId")) else { return out };
                self.merge_tool(index, update);
                out.changed.push(index);
            }
            "plan" => {
                let items = update
                    .get("entries")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .map(|e| AgentPlanItem { content: str_field(e, "content"), status: str_field(e, "status") })
                            .collect()
                    })
                    .unwrap_or_default();
                let entry = AgentEntry::Plan { items };
                let index = match self.plan {
                    Some(i) => {
                        self.entries[i] = entry;
                        i
                    }
                    None => self.push(entry),
                };
                self.plan = Some(index);
                out.changed.push(index);
            }
            _ => {}
        }
        out
    }

    fn append_text(&mut self, thought: bool, text: &str) -> usize {
        match self.entries.last_mut() {
            Some(AgentEntry::Agent { text: t }) if !thought => t.push_str(text),
            Some(AgentEntry::Thought { text: t }) if thought => t.push_str(text),
            _ => {
                let text = text.to_owned();
                return self.push(if thought { AgentEntry::Thought { text } } else { AgentEntry::Agent { text } });
            }
        }
        self.entries.len() - 1
    }

    fn merge_tool(&mut self, index: usize, update: &Value) {
        let AgentEntry::Tool { title, kind, status, locations: locs, output, diffs, .. } = &mut self.entries[index]
        else {
            return;
        };
        if let Some(t) = update.get("title").and_then(Value::as_str) {
            *title = t.to_owned();
        }
        if let Some(k) = update.get("kind").and_then(Value::as_str) {
            *kind = k.to_owned();
        }
        if let Some(s) = tool_status(update.get("status")) {
            *status = s;
        }
        if update.get("locations").is_some_and(Value::is_array) {
            *locs = locations(update.get("locations"));
        }
        let Some(content) = update.get("content").and_then(Value::as_array) else { return };
        let mut text = String::new();
        let mut new_diffs = Vec::new();
        for item in content {
            match item.get("type").and_then(Value::as_str) {
                Some("content") => {
                    if let Some(t) = content_text(item.get("content")) {
                        if !text.is_empty() {
                            text.push('\n');
                        }
                        text.push_str(&t);
                    }
                }
                Some("diff") => {
                    let old = item.get("oldText").and_then(Value::as_str).unwrap_or_default();
                    let new = item.get("newText").and_then(Value::as_str).unwrap_or_default();
                    let (added, removed) = line_stats(old, new);
                    new_diffs.push(AgentToolDiff { path: IpcPath(str_field(item, "path").into()), added, removed });
                }
                _ => {}
            }
        }
        if !text.is_empty() {
            *output = Some(tail(text));
        }
        if !new_diffs.is_empty() {
            *diffs = new_diffs;
        }
    }

    /// Settles what an ended turn left open: running tools and pending permissions.
    pub fn end_turn(&mut self) -> Vec<usize> {
        let mut changed = Vec::new();
        for (i, e) in self.entries.iter_mut().enumerate() {
            match e {
                AgentEntry::Tool { status, .. }
                    if matches!(status, AgentToolStatus::Pending | AgentToolStatus::Running) =>
                {
                    *status = AgentToolStatus::Failed;
                    changed.push(i);
                }
                AgentEntry::Permission { chosen, .. } if chosen.is_none() => {
                    *chosen = Some("Cancelled".into());
                    changed.push(i);
                }
                _ => {}
            }
        }
        changed
    }
}

fn str_field(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_owned()
}

fn content_text(content: Option<&Value>) -> Option<String> {
    let c = content?;
    match c.get("type").and_then(Value::as_str) {
        Some("text") => c.get("text").and_then(Value::as_str).map(str::to_owned),
        Some("resource_link") => c.get("uri").and_then(Value::as_str).map(str::to_owned),
        Some("resource") => c.pointer("/resource/text").and_then(Value::as_str).map(str::to_owned),
        _ => None,
    }
}

fn tool_status(v: Option<&Value>) -> Option<AgentToolStatus> {
    Some(match v?.as_str()? {
        "pending" => AgentToolStatus::Pending,
        "in_progress" => AgentToolStatus::Running,
        "completed" => AgentToolStatus::Completed,
        "failed" => AgentToolStatus::Failed,
        _ => return None,
    })
}

fn locations(v: Option<&Value>) -> Vec<IpcPath> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|l| l.get("path")?.as_str()).map(|p| IpcPath(p.into())).collect())
        .unwrap_or_default()
}

fn line_stats(old: &str, new: &str) -> (u32, u32) {
    ide_vcs::diff_hunks(old, new).iter().fold((0, 0), |(a, r), h| (a + h.lines, r + h.old_lines))
}

fn tail(mut text: String) -> String {
    if text.len() > MAX_OUTPUT {
        let mut cut = text.len() - MAX_OUTPUT;
        while !text.is_char_boundary(cut) {
            cut += 1;
        }
        text.replace_range(..cut, "…");
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn chunks_merge_into_one_message_until_another_entry_comes() {
        let mut t = Timeline::default();
        let chunk = |s: &str| json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": s}});
        assert_eq!(t.apply(&chunk("Hel")).changed, vec![0]);
        assert_eq!(t.apply(&chunk("lo")).changed, vec![0]);
        t.apply(&json!({"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "hmm"}}));
        t.apply(&chunk("again"));
        assert_eq!(
            t.entries,
            vec![
                AgentEntry::Agent { text: "Hello".into() },
                AgentEntry::Thought { text: "hmm".into() },
                AgentEntry::Agent { text: "again".into() },
            ]
        );
    }

    #[test]
    fn tool_calls_update_in_place() {
        let mut t = Timeline::default();
        t.apply(&json!({"sessionUpdate": "tool_call", "toolCallId": "c1", "title": "Edit a.rs", "kind": "edit",
            "status": "pending", "locations": [{"path": "/p/a.rs", "line": 3}]}));
        let applied = t.apply(&json!({"sessionUpdate": "tool_call_update", "toolCallId": "c1", "status": "completed",
        "content": [
            {"type": "diff", "path": "/p/a.rs", "oldText": "a\nb\n", "newText": "a\nB\nc\n"},
            {"type": "content", "content": {"type": "text", "text": "done"}}
        ]}));
        assert_eq!(applied.changed, vec![0]);
        let AgentEntry::Tool { status, diffs, output, locations, .. } = &t.entries[0] else { panic!() };
        assert_eq!(*status, AgentToolStatus::Completed);
        assert_eq!(diffs, &vec![AgentToolDiff { path: IpcPath("/p/a.rs".into()), added: 2, removed: 1 }]);
        assert_eq!(output.as_deref(), Some("done"));
        assert_eq!(locations, &vec![IpcPath("/p/a.rs".into())]);
        // Unknown calls are ignored.
        assert!(t.apply(&json!({"sessionUpdate": "tool_call_update", "toolCallId": "zz"})).changed.is_empty());
    }

    #[test]
    fn plan_is_one_entry_and_end_turn_settles_open_items() {
        let mut t = Timeline::default();
        let plan =
            |s: &str| json!({"sessionUpdate": "plan", "entries": [{"content": "x", "priority": "high", "status": s}]});
        t.apply(&plan("pending"));
        t.push(AgentEntry::Agent { text: "between".into() });
        assert_eq!(t.apply(&plan("completed")).changed, vec![0]);
        t.apply(&json!({"sessionUpdate": "tool_call", "toolCallId": "c", "title": "Run", "status": "in_progress"}));
        t.push(AgentEntry::Permission { id: 1, title: "Run?".into(), options: vec![], chosen: None });
        assert_eq!(t.end_turn(), vec![2, 3]);
        let again = Timeline::from_entries(t.entries.clone());
        assert_eq!(again.plan, Some(0));
        assert_eq!(again.tools.get("c"), Some(&2));
    }

    #[test]
    fn long_output_keeps_its_tail() {
        let s = tail("é".repeat(MAX_OUTPUT));
        assert!(s.starts_with('…') && s.len() <= MAX_OUTPUT + 3);
    }
}
