//! Folds ACP `session/update` notifications into a task's entries.

use crate::model::{AgentEntry, AgentPlanItem, AgentSubagentStatus, AgentToolDiff, AgentToolStatus};
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
    /// Subagent cards, by the subagent's session id.
    cards: HashMap<String, usize>,
    /// Session messages, by message id.
    messages: HashMap<String, usize>,
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
                AgentEntry::Subagent { id, .. } => {
                    t.cards.insert(id.clone(), i);
                }
                _ => {}
            }
        }
        t
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

    /// Adds or updates the card of subagent `id` from its `subagent_update`; returns the
    /// card's index and whether the subagent just stopped working.
    pub fn subagent(&mut self, id: &str, update: &Value, now: f64) -> (usize, bool) {
        let index = match self.cards.get(id) {
            Some(&i) => i,
            None => {
                let i = self.push(AgentEntry::Subagent {
                    id: id.to_owned(),
                    title: None,
                    description: None,
                    status: AgentSubagentStatus::Running,
                    error: None,
                    prompt: None,
                    reply: None,
                    tools: 0,
                    activity: None,
                    started_ms: now,
                    ended_ms: None,
                    cancellable: false,
                });
                self.cards.insert(id.to_owned(), i);
                i
            }
        };
        let AgentEntry::Subagent { title, description, status, error, ended_ms, cancellable, .. } =
            &mut self.entries[index]
        else {
            return (index, false);
        };
        // Patch semantics: an omitted field is unchanged, `null` clears it.
        if let Some(v) = update.get("title") {
            *title = v.as_str().map(str::to_owned);
        }
        if let Some(v) = update.get("description") {
            *description = v.as_str().map(str::to_owned);
        }
        if let Some(v) = update.get("capabilities") {
            *cancellable = v.get("cancel").is_some_and(Value::is_object);
        }
        let mut stopped = false;
        if let Some((next, message)) = update.get("state").and_then(subagent_status) {
            let working = matches!(next, AgentSubagentStatus::Running | AgentSubagentStatus::NeedsInput);
            stopped = !working && ended_ms.is_none();
            *ended_ms = if working { None } else { ended_ms.or(Some(now)) };
            *status = next;
            *error = message;
        }
        (index, stopped)
    }

    /// Sets (or with `append`, extends) what subagent `id` was asked or answered, on its card.
    pub fn card_message(&mut self, id: &str, reply: bool, text: &str, append: bool) -> Option<usize> {
        let &index = self.cards.get(id)?;
        let AgentEntry::Subagent { prompt, reply: answer, .. } = &mut self.entries[index] else { return None };
        let field = if reply { answer } else { prompt };
        match field {
            Some(t) if append => t.push_str(text),
            _ => *field = Some(text.to_owned()),
        }
        Some(index)
    }

    /// Adds, replaces or (with `append`) extends session message `id`.
    pub fn message(&mut self, id: &str, incoming: bool, text: &str, append: bool) -> usize {
        if let Some(&i) = self.messages.get(id)
            && let AgentEntry::Message { text: t, .. } = &mut self.entries[i]
        {
            if append {
                t.push_str(text);
            } else {
                *t = text.to_owned();
            }
            return i;
        }
        let i = self.push(AgentEntry::Message { incoming, text: text.to_owned() });
        self.messages.insert(id.to_owned(), i);
        i
    }

    /// Updates subagent `id`'s card with what its own timeline `of` shows: how many tool
    /// calls it made and its latest one. Returns the card's index when it changed.
    pub fn card_activity(&mut self, id: &str, of: &Timeline) -> Option<usize> {
        let &index = self.cards.get(id)?;
        let AgentEntry::Subagent { tools, activity, .. } = &mut self.entries[index] else { return None };
        let calls = of.entries.iter().filter_map(|e| match e {
            AgentEntry::Tool { title, kind, .. } => Some(if title.is_empty() { kind } else { title }),
            _ => None,
        });
        let count = calls.clone().count() as u32;
        let latest = calls.clone().next_back().cloned();
        if *tools == count && *activity == latest {
            return None;
        }
        *tools = count;
        *activity = latest;
        Some(index)
    }

    /// Marks the subagents still working as stopped (their agent is gone).
    pub fn stop_subagents(&mut self, now: f64) -> Vec<usize> {
        let mut changed = Vec::new();
        for (i, e) in self.entries.iter_mut().enumerate() {
            if let AgentEntry::Subagent { status, ended_ms, .. } = e
                && matches!(status, AgentSubagentStatus::Running | AgentSubagentStatus::NeedsInput)
            {
                *status = AgentSubagentStatus::Cancelled;
                *ended_ms = Some(now);
                changed.push(i);
            }
        }
        changed
    }

    /// Settles what an ended turn left open: running tools and pending permissions,
    /// and records when the turn ended (`done`) on the message that started it.
    pub fn end_turn(&mut self, done: Option<f64>) -> Vec<usize> {
        let mut changed = Vec::new();
        let started = self.entries.iter().rposition(|e| matches!(e, AgentEntry::User { .. }));
        for (i, e) in self.entries.iter_mut().enumerate() {
            match e {
                AgentEntry::User { done_ms, .. } if Some(i) == started && done.is_some() && done_ms.is_none() => {
                    *done_ms = done;
                    changed.push(i);
                }
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

/// The status a subagent `state` reports, with its error message; `None` for an unknown state.
fn subagent_status(state: &Value) -> Option<(AgentSubagentStatus, Option<String>)> {
    Some(match state.get("state")?.as_str()? {
        "running" => (AgentSubagentStatus::Running, None),
        "requires_action" => (AgentSubagentStatus::NeedsInput, None),
        "idle" => match state.get("stopReason").and_then(Value::as_str) {
            Some("cancelled") => (AgentSubagentStatus::Cancelled, None),
            Some("error") => (
                AgentSubagentStatus::Failed,
                state.pointer("/error/message").and_then(Value::as_str).map(str::to_owned),
            ),
            _ => (AgentSubagentStatus::Done, None),
        },
        _ => return None,
    })
}

/// The text of a list of content blocks, one per line.
pub(crate) fn blocks_text(content: Option<&Value>) -> String {
    let blocks = content.and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    blocks.iter().filter_map(|b| content_text(Some(b))).collect::<Vec<_>>().join("\n")
}

pub(crate) fn content_text(content: Option<&Value>) -> Option<String> {
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
        assert_eq!(t.end_turn(None), vec![2, 3]);
        let again = Timeline::from_entries(t.entries.clone());
        assert_eq!(again.plan, Some(0));
        assert_eq!(again.tools.get("c"), Some(&2));
    }

    #[test]
    fn end_turn_records_when_the_last_message_was_answered() {
        let user =
            |sent: f64| AgentEntry::User { text: "q".into(), attachments: vec![], sent_ms: Some(sent), done_ms: None };
        let mut t = Timeline::default();
        t.push(user(1.0));
        t.push(AgentEntry::Agent { text: "a".into() });
        t.push(user(2.0));
        assert_eq!(t.end_turn(Some(5.0)), vec![2]);
        assert!(matches!(t.entries[0], AgentEntry::User { done_ms: None, .. }));
        assert!(matches!(t.entries[2], AgentEntry::User { done_ms: Some(5.0), .. }));
        // Settled once: a later end (a restart) doesn't move it.
        assert_eq!(t.end_turn(Some(9.0)), Vec::<usize>::new());
    }

    #[test]
    fn long_output_keeps_its_tail() {
        let s = tail("é".repeat(MAX_OUTPUT));
        assert!(s.starts_with('…') && s.len() <= MAX_OUTPUT + 3);
    }
}
