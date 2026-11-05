// Ported from JetBrains intellij-community plugins/mcp-server (src/com/intellij/mcpserver/elicitation/McpElicitationMappers.kt, mcpserver.toolsets/src/general/IdeScriptToolset.kt), Apache-2.0.
//! Confirmations as MCP elicitations: a form with one required single-select field,
//! `decision`, whose `allow` lets the call go on; any other answer (deny, decline,
//! cancel) refuses it.

use serde_json::{Value, json};

const DECISION_FIELD: &str = "decision";
const ALLOW: &str = "allow";
const DENY: &str = "deny";

/// The `elicitation/create` params asking to allow what `message` describes. Clients
/// of protocol revisions before 2025-11-25 know titled options only as `enumNames`.
pub(crate) fn confirm_params(protocol: &str, message: String) -> Value {
    let options = [(ALLOW, "Allow"), (DENY, "Deny")];
    let decision = if protocol >= "2025-11-25" {
        json!({ "type": "string", "oneOf": options.map(|(v, t)| json!({ "const": v, "title": t })) })
    } else {
        json!({ "type": "string", "enum": options.map(|(v, _)| v), "enumNames": options.map(|(_, t)| t) })
    };
    json!({
        "message": message,
        "requestedSchema": {
            "type": "object",
            "properties": { DECISION_FIELD: decision },
            "required": [DECISION_FIELD],
        },
    })
}

/// Whether an `elicitation/create` result allows the call.
pub(crate) fn allowed(result: &Value) -> bool {
    result.get("action").and_then(Value::as_str) == Some("accept")
        && result.pointer("/content/decision").and_then(Value::as_str) == Some(ALLOW)
}

/// The message: who asks, for which tool, and what will happen.
pub(crate) fn confirm_message(client: &str, tool: &str, subject: &str, detail: Option<&str>) -> String {
    let mut message = format!("MCP client {client} wants to run {tool}:\n{subject}");
    if let Some(detail) = detail.filter(|d| !d.is_empty()) {
        message.push('\n');
        message.push_str(detail);
    }
    message
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_forms_and_reads_answers() {
        let new = confirm_params("2025-11-25", "m".into());
        assert_eq!(new["requestedSchema"]["required"], json!(["decision"]));
        assert_eq!(
            new["requestedSchema"]["properties"]["decision"]["oneOf"][0],
            json!({ "const": "allow", "title": "Allow" })
        );
        let old = confirm_params("2025-06-18", "m".into());
        assert_eq!(old["requestedSchema"]["properties"]["decision"]["enum"], json!(["allow", "deny"]));

        assert!(allowed(&json!({ "action": "accept", "content": { "decision": "allow" } })));
        assert!(!allowed(&json!({ "action": "accept", "content": { "decision": "deny" } })));
        assert!(!allowed(&json!({ "action": "decline" })));
        assert!(!allowed(&json!({ "action": "cancel" })));
        assert_eq!(confirm_message("c", "t", "s", Some("d")), "MCP client c wants to run t:\ns\nd");
    }
}
