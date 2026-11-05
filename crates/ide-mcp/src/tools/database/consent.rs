//! Asking the user before a database tool reads or changes a database.
//!
//! In order: a read-only data source refuses anything but reads; an operation type the user
//! always allows ([`McpDatabaseConsents`]) goes ahead; otherwise the MCP client asks its
//! user through an elicitation with an "Always allow" checkbox (when client confirmations
//! are on and the client supports elicitation and is a known one other than Codex), else
//! OpenIDEA shows the consent dialog with a "do not ask again" checkbox.

use super::safety::DbOperationType;
use crate::tool::Call;
use ide_core::mcp::{McpDatabaseConsents, McpUiRequest};
use ide_core::{IdeError, IdeResult};
use ide_db::DataSource;
use ide_workspace::SettingsScope;
use serde_json::{Value, json};

pub const USER_REJECTED_QUERY: &str = "User rejected query.";
pub const READ_ONLY: &str = "Schema or data modification queries are not allowed on read-only data sources.";

/// The settings key of the consent flag of `op` (none for unknown statements: never remembered).
fn consent_key(op: DbOperationType) -> Option<&'static str> {
    Some(match op {
        DbOperationType::ReadData => "readData",
        DbOperationType::WriteData => "writeData",
        DbOperationType::ReadSchema => "readSchema",
        DbOperationType::WriteSchema => "writeSchema",
        DbOperationType::Unknown => return None,
    })
}

fn has_existing_consent(consents: &McpDatabaseConsents, op: DbOperationType) -> bool {
    match op {
        DbOperationType::ReadData => consents.read_data,
        DbOperationType::WriteData => consents.write_data,
        DbOperationType::ReadSchema => consents.read_schema,
        DbOperationType::WriteSchema => consents.write_schema,
        DbOperationType::Unknown => false,
    }
}

/// The known MCP clients by base name.
const KNOWN_CLIENTS: &[&str] = &[
    "VSCode",
    "Claude App",
    "Windsurf",
    "Cursor",
    "Claude Code",
    "Junie",
    "Codex",
    "Air",
    "GitHub Copilot (IDE Plugin)",
    "GitHub Copilot CLI",
];

fn normalize(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// The known client `raw` (an `initialize` client name such as `claude-code`) is, by base name.
pub fn resolve_client_name(raw: &str) -> Option<&'static str> {
    let raw_lower = raw.to_lowercase();
    KNOWN_CLIENTS.iter().copied().find(|base| {
        let n = normalize(base);
        normalize(raw) == n || raw_lower.contains(&n)
    })
}

/// The texts of a consent, `{0}` being the client's name.
struct Texts {
    title: String,
    /// The elicitation's (plain text) description.
    cli_message: String,
    /// The dialog's description.
    dialog_message: String,
    /// The "always allow" checkbox; empty for unknown statements (never remembered).
    remember: String,
}

fn texts(op: DbOperationType, client: &str, whole_database: bool) -> Texts {
    let (title, cli, dialog, remember) = match op {
        DbOperationType::ReadData => (
            "Allow {0} to Read Database Data",
            "This statement will read database data. {0} will send the data to the AI model. Allow {0} to read data in this schema? For example, by running SELECT queries.",
            "This statement will read database data. {0} will send the data to the AI model.\nAllow {0} to read data in this schema? For example, by running SELECT queries.",
            "Always allow {0} to read database data",
        ),
        DbOperationType::WriteData => (
            "Allow {0} to Modify Database Data",
            "This statement will modify database data. Allow {0} to modify data in this schema? For example, by running INSERT, UPDATE, or DELETE statements, or by calling a routine.",
            "This statement will modify database data.\nAllow {0} to modify data in this schema? For example, by running INSERT, UPDATE, or DELETE statements, or by calling a routine.",
            "Always allow {0} to modify database data",
        ),
        DbOperationType::ReadSchema if whole_database => (
            "Allow {0} to Read Database Schema",
            "{0} will read the database schemas. Allow {0} to read these schemas?",
            "{0} will read the database schemas.\nAllow {0} to read these schemas?",
            "Always allow {0} to read database schemas",
        ),
        DbOperationType::ReadSchema => (
            "Allow {0} to Read Database Schema",
            "{0} will read the database schema. Allow {0} to read this schema?",
            "{0} will read the database schema.\nAllow {0} to read this schema?",
            "Always allow {0} to read database schemas",
        ),
        DbOperationType::WriteSchema => (
            "Allow {0} to Modify Database Schema",
            "This statement will modify the database schema. Allow {0} to modify this schema? For example, by running CREATE, ALTER, or DROP statements.",
            "This statement will modify the database schema.\nAllow {0} to modify this schema? For example, by running CREATE, ALTER, or DROP statements.",
            "Always allow {0} to modify database schemas",
        ),
        DbOperationType::Unknown => (
            "Allow {0} to Execute Statement",
            "This statement may read or modify database data. Safety analysis is not available for this SQL dialect. Allow {0} to execute this statement?",
            "This statement may read or modify database data. Safety analysis is not available for this SQL dialect.\nAllow {0} to execute this statement?",
            "",
        ),
    };
    let fill = |s: &str| s.replace("{0}", client);
    Texts { title: fill(title), cli_message: fill(cli), dialog_message: fill(dialog), remember: fill(remember) }
}

/// What a consent is about: the data source, the schema (`None`: all of them) and the statement.
pub struct ConsentContext<'a> {
    pub source: &'a DataSource,
    /// The schema's display name (`db.schema`).
    pub schema: Option<String>,
    pub query: &'a str,
}

/// Asks to read the schema (all of them for `None`): `schema` is the schema's path
/// (`DATABASE:db/SCHEMA:public`), used only in the refusal, and its display name.
pub async fn read_schema_or_fail(call: &Call, source: &DataSource, schema: Option<(String, String)>) -> IdeResult<()> {
    let target = match &schema {
        Some((path, _)) => format!("{path} schema"),
        None => "database schemas".to_owned(),
    };
    let error = format!("User does not allow to read {target} in {}", source.name);
    let ctx = ConsentContext { source, schema: schema.map(|(_, display)| display), query: "" };
    check(call, &ctx, DbOperationType::ReadSchema, &error).await
}

/// Asks to run a statement of kind `op`.
pub async fn query_or_fail(call: &Call, ctx: &ConsentContext<'_>, op: DbOperationType) -> IdeResult<()> {
    check(call, ctx, op, USER_REJECTED_QUERY).await
}

/// The consent check: read-only guard, saved consent, then the client or the IDE asks.
async fn check(call: &Call, ctx: &ConsentContext<'_>, op: DbOperationType, error: &str) -> IdeResult<()> {
    if ctx.source.read_only && !matches!(op, DbOperationType::ReadData | DbOperationType::ReadSchema) {
        return Err(IdeError::invalid(READ_ONLY));
    }
    let consents = call.host().global_settings.effective().mcp.database_consents;
    if has_existing_consent(&consents, op) {
        return Ok(());
    }
    let resolved = resolve_client_name(&call.client);
    let client = resolved.unwrap_or(&call.client).to_owned();
    let texts = texts(op, &client, ctx.schema.is_none());
    let answer = match resolved.filter(|c| *c != "Codex") {
        Some(_) => elicit(call, ctx, op, &texts).await?,
        None => None,
    };
    let (allowed, remember) = match answer {
        Some(a) => a,
        None => ask_in_ide(call, ctx, op, &texts).await?,
    };
    if !allowed {
        return Err(IdeError::new(ide_core::error::ErrorKind::PermissionDenied, error));
    }
    if remember {
        persist(call, op);
    }
    Ok(())
}

/// The elicitation form: the title, the data
/// source and the schema, the statement and what it does, and an "Always allow" checkbox.
fn elicitation_params(ctx: &ConsentContext<'_>, texts: &Texts) -> Value {
    let mut message = format!("{}\n{}\n{}\n", texts.title, ctx.source.name, ctx.schema.as_deref().unwrap_or(""));
    if !ctx.query.trim().is_empty() {
        message.push_str(&format!("```sql\n{}\n```\n {}\n", ctx.query, texts.cli_message));
    }
    json!({
        "message": message,
        "requestedSchema": {
            "type": "object",
            "properties": {
                "alwaysAllow": {
                    "type": "boolean",
                    "title": "Always allow",
                    "description": texts.remember,
                    "default": false,
                },
            },
        },
    })
}

/// The client's answer `(allowed, always allow)`, or `None` when it cannot ask.
async fn elicit(
    call: &Call,
    ctx: &ConsentContext<'_>,
    _op: DbOperationType,
    texts: &Texts,
) -> IdeResult<Option<(bool, bool)>> {
    let params = elicitation_params(ctx, texts);
    let Some(result) = call.elicit(move |_| params).await? else { return Ok(None) };
    let accepted = result.get("action").and_then(Value::as_str) == Some("accept");
    let always = result.pointer("/content/alwaysAllow").and_then(Value::as_bool).unwrap_or(false);
    Ok(Some((accepted, accepted && always)))
}

/// The IDE's consent dialog.
async fn ask_in_ide(
    call: &Call,
    ctx: &ConsentContext<'_>,
    op: DbOperationType,
    texts: &Texts,
) -> IdeResult<(bool, bool)> {
    let mut detail = texts.dialog_message.clone();
    detail.push_str(&format!("\n\nData source: {}", ctx.source.name));
    if let Some(schema) = ctx.schema.as_deref().filter(|s| !s.is_empty()) {
        detail.push_str(&format!("\nSchema: {schema}"));
    }
    let subject = if ctx.query.trim().is_empty() { ctx.source.name.clone() } else { ctx.query.to_owned() };
    let request = McpUiRequest::Confirm {
        client: call.client.clone(),
        tool: call.tool.into(),
        subject,
        detail: Some(detail),
        title: Some(texts.title.clone()),
        remember: (consent_key(op).is_some() && !texts.remember.is_empty()).then(|| texts.remember.clone()),
    };
    let answer = call.ask(request).await?;
    Ok(match answer {
        Value::Bool(allow) => (allow, false),
        v => (
            v.get("allow").and_then(Value::as_bool).unwrap_or(false),
            v.get("remember").and_then(Value::as_bool).unwrap_or(false),
        ),
    })
}

/// "Always allow": saves the flag of `op` in the global settings.
fn persist(call: &Call, op: DbOperationType) {
    let Some(key) = consent_key(op) else { return };
    let key = format!("mcp.databaseConsents.{key}");
    let host = call.host();
    if let Err(e) = host.global_settings.set(SettingsScope::Global, &key, Value::Bool(true)) {
        tracing::warn!("could not save the database consent {key}: {}", e.message);
        return;
    }
    for project in host.projects() {
        project.settings.reload();
        project.sink.emit(ide_core::IdeEvent::SettingsChanged { key: key.clone() });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_known_clients() {
        assert_eq!(resolve_client_name("claude-code"), Some("Claude Code"));
        assert_eq!(resolve_client_name("Cursor"), Some("Cursor"));
        assert_eq!(resolve_client_name("codex-mcp-client"), Some("Codex"));
        assert_eq!(resolve_client_name("Visual Studio Code"), None);
        assert_eq!(resolve_client_name("my-tool"), None);
    }

    #[test]
    fn texts_name_the_client() {
        let t = texts(DbOperationType::WriteSchema, "Claude Code", false);
        assert_eq!(t.title, "Allow Claude Code to Modify Database Schema");
        assert_eq!(t.remember, "Always allow Claude Code to modify database schemas");
        assert!(texts(DbOperationType::Unknown, "c", false).remember.is_empty());
        assert_eq!(
            texts(DbOperationType::ReadSchema, "c", true).cli_message,
            "c will read the database schemas. Allow c to read these schemas?"
        );
    }

    #[test]
    fn elicitation_has_an_always_allow_checkbox() {
        let source = DataSource { name: "app".into(), ..Default::default() };
        let ctx = ConsentContext { source: &source, schema: Some("public".into()), query: "select 1" };
        let p = elicitation_params(&ctx, &texts(DbOperationType::ReadData, "Cursor", false));
        let m = p["message"].as_str().unwrap();
        assert!(
            m.starts_with("Allow Cursor to Read Database Data\napp\npublic\n```sql\nselect 1\n```\n This statement")
        );
        assert_eq!(p["requestedSchema"]["properties"]["alwaysAllow"]["type"], "boolean");
        assert_eq!(p["requestedSchema"]["properties"]["alwaysAllow"]["default"], false);
    }
}
