use super::*;
use serde_json::json;

fn frame(channel: Channel, parent: &str, kind: &str, content: Value) -> Frame {
    Frame { channel, parent: parent.into(), kind: kind.into(), content, bytes: 1, _permit: None }
}

#[test]
fn completion_requires_both_channels_in_either_order_and_ignores_old_requests() {
    for idle_first in [false, true] {
        let mut completion = Completion::default();
        let idle = frame(Channel::Iopub, "current", "status", json!({"execution_state":"idle"}));
        let reply = frame(Channel::Shell, "current", "execute_reply", json!({"status":"error","execution_count":7}));
        let old_idle = frame(Channel::Iopub, "old-generation", "status", json!({"execution_state":"idle"}));
        let old_reply =
            frame(Channel::Shell, "old-generation", "execute_reply", json!({"status":"ok","execution_count":99}));
        completion.observe(&old_reply, "current").unwrap();
        completion.observe(&old_idle, "current").unwrap();
        assert!(!completion.complete());
        let (first, second) = if idle_first { (&idle, &reply) } else { (&reply, &idle) };
        completion.observe(first, "current").unwrap();
        assert!(!completion.complete(), "one channel cannot finalize execution");
        completion.observe(second, "current").unwrap();
        assert!(completion.complete());
        let result = completion.reply.unwrap();
        assert_eq!(result.status, "error");
        assert_eq!(result.execution_count, Some(7));
    }
}

#[test]
fn wrong_channel_cannot_forge_execution_completion() {
    let mut completion = Completion::default();
    completion
        .observe(&frame(Channel::Iopub, "run", "execute_reply", json!({"status":"ok","execution_count":2})), "run")
        .unwrap();
    completion.observe(&frame(Channel::Shell, "run", "status", json!({"execution_state":"idle"})), "run").unwrap();
    assert!(!completion.complete());
    assert!(completion.reply.is_none());
    assert!(!completion.idle);
}

#[test]
fn malformed_reply_is_rejected_instead_of_reported_as_success() {
    for content in [
        json!({"status":"unexpected"}),
        json!({"execution_count":1}),
        json!({"status":"ok","execution_count":-1}),
        json!({"status":"ok","execution_count":4294967296_u64}),
    ] {
        let mut completion = Completion::default();
        let error = completion.observe(&frame(Channel::Shell, "run", "execute_reply", content), "run").unwrap_err();
        assert_eq!(error.kind, ide_core::error::ErrorKind::Protocol);
        assert!(!completion.complete());
    }
}

#[test]
fn output_budget_stops_at_byte_or_message_boundary_without_wrapping() {
    let mut bytes = Budget::default();
    bytes.add(MAX_OUTPUT_BYTES).unwrap();
    assert_eq!(bytes.add(1).unwrap_err().kind, ide_core::error::ErrorKind::Unavailable);
    let mut messages = Budget::default();
    for _ in 0..MAX_OUTPUT_MESSAGES {
        messages.add(0).unwrap();
    }
    assert_eq!(messages.add(0).unwrap_err().kind, ide_core::error::ErrorKind::Unavailable);
    let mut overflow = Budget::default();
    assert_eq!(overflow.add(usize::MAX).unwrap_err().kind, ide_core::error::ErrorKind::Unavailable);
    assert_eq!(overflow.add(1).unwrap_err().kind, ide_core::error::ErrorKind::Unavailable);
}
