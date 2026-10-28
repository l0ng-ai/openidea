//! A task's conversation and those of its subagents.
//!
//! An agent that supports ACP subagent sessions runs each subagent (Claude Code's Agent
//! tool, Codex's spawned agents) as a child session: `subagent_update` on the parent
//! announces it and reports its state, its own updates carry its session id, and
//! `session_message`s carry what it was asked and what it answered. The parent's
//! timeline shows a card per subagent; each subagent keeps its own timeline.

use crate::model::AgentEntry;
use crate::timeline::{Timeline, blocks_text, content_text};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Where an entry lives: the task's own conversation (`None`) or a subagent's session.
pub(crate) type Session = Option<String>;

#[derive(Default)]
pub(crate) struct Conversation {
    pub main: Timeline,
    /// In the order they started.
    subagents: Vec<Subagent>,
}

struct Subagent {
    id: String,
    /// The session that started it.
    parent: Session,
    timeline: Timeline,
}

/// A subagent's conversation, as saved with its task.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedSubagent {
    pub id: String,
    pub parent: Option<String>,
    pub entries: Vec<AgentEntry>,
}

impl Conversation {
    pub fn restore(main: Vec<AgentEntry>, subagents: Vec<SavedSubagent>) -> Self {
        Self {
            main: Timeline::from_entries(main),
            subagents: subagents
                .into_iter()
                .map(|s| Subagent { id: s.id, parent: s.parent, timeline: Timeline::from_entries(s.entries) })
                .collect(),
        }
    }

    pub fn saved_subagents(&self) -> Vec<SavedSubagent> {
        self.subagents
            .iter()
            .map(|s| SavedSubagent { id: s.id.clone(), parent: s.parent.clone(), entries: s.timeline.entries.clone() })
            .collect()
    }

    pub fn timeline(&self, session: &Session) -> Option<&Timeline> {
        match session {
            None => Some(&self.main),
            Some(id) => self.subagents.iter().find(|s| &s.id == id).map(|s| &s.timeline),
        }
    }

    fn timeline_mut(&mut self, session: &Session) -> Option<&mut Timeline> {
        match session {
            None => Some(&mut self.main),
            Some(id) => self.subagents.iter_mut().find(|s| &s.id == id).map(|s| &mut s.timeline),
        }
    }

    fn parent_of(&self, id: &str) -> Option<&Session> {
        self.subagents.iter().find(|s| s.id == id).map(|s| &s.parent)
    }

    /// The session an update for session id `session` belongs to: a known subagent's, else the task's.
    pub fn owner(&self, session: Option<&str>) -> Session {
        session.filter(|s| self.parent_of(s).is_some()).map(str::to_owned)
    }

    /// The parent's title (or description) for subagent `id`.
    pub fn label(&self, id: &str) -> Option<String> {
        let parent = self.parent_of(id)?;
        self.timeline(parent)?.entries.iter().find_map(|e| match e {
            AgentEntry::Subagent { id: card, title, description, .. } if card == id => {
                title.clone().or_else(|| description.clone())
            }
            _ => None,
        })
    }

    /// Applies one `session/update` of session id `session` (the task's own when unknown);
    /// returns the entries it added or changed.
    pub fn apply(&mut self, session: Option<&str>, update: &Value, now: f64) -> Vec<(Session, usize)> {
        let owner = self.owner(session);
        let kind = update.get("sessionUpdate").and_then(Value::as_str).unwrap_or_default();
        let mut out = Vec::new();
        match kind {
            "subagent_update" => {
                let Some(id) = update.get("sessionId").and_then(Value::as_str) else { return out };
                if self.parent_of(id).is_none() {
                    self.subagents.push(Subagent { id: id.to_owned(), parent: owner, timeline: Timeline::default() });
                }
                let parent = self.parent_of(id).cloned().flatten();
                let Some(timeline) = self.timeline_mut(&parent) else { return out };
                let (index, stopped) = timeline.subagent(id, update, now);
                out.push((parent, index));
                if stopped && let Some(child) = self.timeline_mut(&Some(id.to_owned())) {
                    let id = Some(id.to_owned());
                    out.extend(child.end_turn(None).into_iter().map(|i| (id.clone(), i)));
                }
            }
            "session_message" | "session_message_chunk" => {
                let append = kind == "session_message_chunk";
                let text = if append {
                    content_text(update.get("content")).unwrap_or_default()
                } else {
                    blocks_text(update.get("content"))
                };
                let field = |k: &str| update.get(k).and_then(Value::as_str).map(str::to_owned);
                let (sender, recipient) = (field("senderSessionId"), field("recipientSessionId"));
                let ours =
                    |s: &Option<String>| s.as_deref().filter(|s| self.parent_of(s) == Some(&owner)).map(str::to_owned);
                // Between this session and a subagent of it: the subagent's task or answer, on its card.
                let card = ours(&recipient).map(|c| (c, false)).or_else(|| ours(&sender).map(|c| (c, true)));
                let Some(timeline) = self.timeline_mut(&owner) else { return out };
                let index = match card {
                    Some((child, reply)) => timeline.card_message(&child, reply, &text, append),
                    None => {
                        let id = field("messageId").unwrap_or_default();
                        Some(timeline.message(&id, sender != owner, &text, append))
                    }
                };
                out.extend(index.map(|i| (owner, i)));
            }
            _ => {
                let Some(timeline) = self.timeline_mut(&owner) else { return out };
                out.extend(timeline.apply(update).changed.into_iter().map(|i| (owner.clone(), i)));
                if let Some(id) = owner.as_deref()
                    && matches!(kind, "tool_call" | "tool_call_update")
                {
                    out.extend(self.refresh_card(id));
                }
            }
        }
        out
    }

    /// Updates subagent `id`'s card from its timeline.
    fn refresh_card(&mut self, id: &str) -> Option<(Session, usize)> {
        let parent = self.parent_of(id)?.clone();
        let child = self.subagents.iter().position(|s| s.id == id)?;
        let timeline = std::mem::take(&mut self.subagents[child].timeline);
        let changed = self.timeline_mut(&parent).and_then(|p| p.card_activity(id, &timeline));
        self.subagents[child].timeline = timeline;
        changed.map(|i| (parent, i))
    }

    /// Settles what an ended turn of the task left open. Subagents work on (in the background).
    pub fn end_turn(&mut self, done: Option<f64>) -> Vec<(Session, usize)> {
        self.main.end_turn(done).into_iter().map(|i| (None, i)).collect()
    }

    /// Settles everything left open once the agent is gone, subagents included.
    pub fn settle(&mut self, now: f64) -> Vec<(Session, usize)> {
        let mut out: Vec<(Session, usize)> = self.main.end_turn(None).into_iter().map(|i| (None, i)).collect();
        out.extend(self.main.stop_subagents(now).into_iter().map(|i| (None, i)));
        for s in &mut self.subagents {
            let id = Some(s.id.clone());
            let mut changed = s.timeline.end_turn(None);
            changed.extend(s.timeline.stop_subagents(now));
            out.extend(changed.into_iter().map(|i| (id.clone(), i)));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AgentSubagentStatus, AgentToolStatus};
    use serde_json::json;

    fn card(c: &Conversation, session: &Session, index: usize) -> AgentEntry {
        c.timeline(session).unwrap().entries[index].clone()
    }

    /// Claude Code's Agent tool, as `claude-agent-acp` reports it to a client with subagent sessions.
    #[test]
    fn a_subagent_gets_a_card_in_its_parent_and_its_own_timeline() {
        let mut c = Conversation::default();
        let sub = Some("child".to_owned());
        let announce = json!({"sessionUpdate": "subagent_update", "sessionId": "child", "title": "Explore",
            "description": "Find the parser", "capabilities": {"cancel": {}}, "state": {"state": "running"}});
        assert_eq!(c.apply(Some("root"), &announce, 10.0), vec![(None, 0)]);
        // The launch prompt: the parent's outgoing view, then the child's incoming one.
        let prompt = json!({"sessionUpdate": "session_message", "messageId": "toolu_1",
            "senderSessionId": "root", "recipientSessionId": "child",
            "content": [{"type": "text", "text": "Look for it"}]});
        assert_eq!(c.apply(Some("root"), &prompt, 11.0), vec![(None, 0)]);
        assert_eq!(c.apply(Some("child"), &prompt, 11.0), vec![(sub.clone(), 0)]);
        assert_eq!(card(&c, &sub, 0), AgentEntry::Message { incoming: true, text: "Look for it".into() });

        // The child's own work stays out of the parent's timeline; its card follows it.
        c.apply(
            Some("child"),
            &json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "hm"}}),
            12.0,
        );
        let changed = c.apply(
            Some("child"),
            &json!({"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "Read lib.rs", "kind": "read", "status": "in_progress"}),
            12.0,
        );
        assert_eq!(changed, vec![(sub.clone(), 2), (None, 0)]);
        assert_eq!(c.main.entries.len(), 1);
        // Settings of the child session don't touch the task.
        assert_eq!(c.owner(Some("child")), sub);
        assert_eq!(c.owner(Some("root")), None);

        let done = json!({"sessionUpdate": "subagent_update", "sessionId": "child", "state": {"state": "idle", "stopReason": "end_turn"}});
        let changed = c.apply(Some("root"), &done, 20.0);
        // Its tool calls left open are settled when it stops.
        assert_eq!(changed, vec![(None, 0), (sub.clone(), 2)]);
        let reply = json!({"sessionUpdate": "session_message", "messageId": "toolu_1:reply", "senderSessionId": "child",
            "recipientSessionId": "root", "content": [{"type": "text", "text": "In "}, {"type": "text", "text": "parser.rs"}]});
        c.apply(Some("root"), &reply, 20.0);
        assert_eq!(
            c.main.entries[0],
            AgentEntry::Subagent {
                id: "child".into(),
                title: Some("Explore".into()),
                description: Some("Find the parser".into()),
                status: AgentSubagentStatus::Done,
                error: None,
                prompt: Some("Look for it".into()),
                reply: Some("In \nparser.rs".into()),
                tools: 1,
                activity: Some("Read lib.rs".into()),
                started_ms: 10.0,
                ended_ms: Some(20.0),
                cancellable: true,
            }
        );
        assert_eq!(c.label("child").as_deref(), Some("Explore"));
    }

    #[test]
    fn nested_subagents_and_failures() {
        let mut c = Conversation::default();
        c.apply(
            None,
            &json!({"sessionUpdate": "subagent_update", "sessionId": "a", "state": {"state": "running"}}),
            1.0,
        );
        c.apply(
            Some("a"),
            &json!({"sessionUpdate": "subagent_update", "sessionId": "b", "description": "deeper"}),
            2.0,
        );
        let a = Some("a".to_owned());
        assert!(matches!(card(&c, &a, 0), AgentEntry::Subagent { ref id, .. } if id == "b"));
        let failed = json!({"sessionUpdate": "subagent_update", "sessionId": "b",
            "state": {"state": "idle", "stopReason": "error", "error": {"code": -32603, "message": "boom"}}});
        assert_eq!(c.apply(Some("a"), &failed, 3.0), vec![(a.clone(), 0)]);
        assert!(matches!(card(&c, &a, 0),
            AgentEntry::Subagent { status: AgentSubagentStatus::Failed, error: Some(ref e), ended_ms: Some(3.0), .. } if e == "boom"));

        // Saved and restored, then the agent is gone: what still works is stopped.
        let mut c = Conversation::restore(c.main.entries.clone(), c.saved_subagents());
        c.apply(
            Some("a"),
            &json!({"sessionUpdate": "tool_call", "toolCallId": "t", "title": "Run", "status": "in_progress"}),
            4.0,
        );
        let settled = c.settle(9.0);
        assert_eq!(settled, vec![(None, 0), (a.clone(), 1)]);
        assert!(matches!(c.main.entries[0], AgentEntry::Subagent { status: AgentSubagentStatus::Cancelled, .. }));
        assert!(matches!(card(&c, &a, 1), AgentEntry::Tool { status: AgentToolStatus::Failed, .. }));
    }
}
